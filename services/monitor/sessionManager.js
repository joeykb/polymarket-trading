/**
 * TempEdge Monitor — Session Manager
 *
 * Handles creation, resumption, and DB reconciliation of monitoring sessions.
 * Extracted from orchestrator.js to isolate session lifecycle from trading logic.
 *
 * Responsibilities:
 *   - Create new sessions with initial snapshots
 *   - Resume existing sessions (active or stopped)
 *   - Clean up failed buy/sell orders on resume
 *   - Hydrate buy orders from chain-backfill DB data
 *   - Reconcile session IDs between file and DB (FK integrity)
 */

import { createLogger } from '../../shared/logger.js';
import { nowISO, getPhase, getPhaseInTz } from '../../shared/dates.js';
import { svcGet, DATA_SVC, tryPlaceBuyOrder, fetchLiquidityFromService } from './svcClients.js';
import { loadSession, saveSession, dbUpsertSession, dbInsertSnapshot } from './persistence.js';
import { getConfig } from './monitorConfig.js';
import { attachSessionContext } from './buyFlow.js';

const log = createLogger('monitor-session');

// ── DB Upsert Helper ────────────────────────────────────────────────────

/**
 * Upsert a session to the DB and reconcile the ID.
 * Returns the (possibly updated) session ID.
 */
async function upsertAndReconcile(session, extra = {}) {
    const config = getConfig();
    const upsertResult = await dbUpsertSession({
        id: session.id,
        marketId: session.marketId || 'nyc',
        targetDate: session.targetDate,
        status: session.status,
        phase: session.phase,
        initialForecastTemp: session.initialForecastTempF,
        initialTargetRange: session.initialTargetRange,
        forecastSource: session.forecastSource,
        intervalMinutes: parseInt(session.intervalMinutes) || 5,
        rebalanceThreshold: session.rebalanceThreshold || config.monitor.rebalanceThreshold,
        ...extra,
    });
    if (upsertResult?.existingId && upsertResult.existingId !== session.id) {
        session.id = upsertResult.existingId;
    }
    if (upsertResult) session._dbSessionReady = true;
    return upsertResult;
}

// ── Failed Order Cleanup ────────────────────────────────────────────────

function cleanupFailedBuyOrder(session, targetDate) {
    if (!session.buyOrder || session.buyOrder.totalCost !== 0) return;
    const allFailed = session.buyOrder.positions?.every((p) => p.status === 'failed');
    if (allFailed) {
        log.info('clearing_failed_buy', { targetDate });
        session.buyOrder = null;
        session.pnl = null;
    }
}

function cleanupFailedResolveSell(session, targetDate) {
    if (!session.resolveSellExecuted || !session.sellOrders?.length) return;
    const lastSell = session.sellOrders[session.sellOrders.length - 1];
    const allSellsFailed = lastSell.positions?.every((p) => p.status === 'failed');
    if (allSellsFailed) {
        log.info('resolve_sell_reset', { targetDate });
        session.resolveSellExecuted = false;
        session.sellOrders.pop();
        for (const p of session.buyOrder?.positions || []) {
            if (p.soldStatus === 'failed') {
                p.soldAt = undefined;
                p.soldStatus = undefined;
                p.soldOrderId = undefined;
            }
        }
    }
}

// ── Chain Backfill Hydration ────────────────────────────────────────────

async function hydrateBuyOrderFromChain(session, targetDate) {
    try {
        const dbPositions = await svcGet(DATA_SVC, `/api/positions/active?date=${targetDate}`);
        if (dbPositions && dbPositions.length > 0) {
            const positions = dbPositions.map((p) => ({
                question: p.question,
                label: p.label || 'chain',
                buyPrice: p.price,
                shares: p.shares,
                tokenId: p.token_id,
                conditionId: p.condition_id,
                clobTokenIds: p.clob_token_ids ? JSON.parse(p.clob_token_ids) : undefined,
                positionId: p.id,
                status: p.status || 'filled',
                soldAt: p.sold_at || null,
            }));
            const totalCost = positions.reduce((sum, p) => sum + (p.buyPrice || 0) * (p.shares || 0), 0);
            session.buyOrder = {
                positions,
                totalCost: parseFloat(totalCost.toFixed(4)),
                mode: 'live',
                source: 'chain-backfill',
                placedAt: dbPositions[0].created_at,
            };
            log.info('chain_backfill_hydrated', { targetDate, positions: positions.length, cost: totalCost.toFixed(3) });
        } else {
            log.info('no_buy_order', { targetDate, action: 'will_trigger_normal_flow' });
        }
    } catch (err) {
        log.warn('chain_backfill_failed', { targetDate, error: err.message });
        log.info('no_buy_order', { targetDate, action: 'will_trigger_normal_flow' });
    }
}

// ── DB Reconciliation ───────────────────────────────────────────────────

async function reconcileSessionId(session, targetDate) {
    const marketId = session.marketId || 'nyc';
    try {
        const dbSession = await svcGet(DATA_SVC, `/api/db/sessions/${marketId}/${targetDate}`);
        if (dbSession && dbSession.id && dbSession.id !== session.id) {
            session.id = dbSession.id;
        }
        session._dbSessionReady = true;
    } catch {
        await upsertAndReconcile(session);
    }
}

// ── Public API ──────────────────────────────────────────────────────────

/**
 * Resume an existing session or create a new one.
 *
 * @param {string} targetDate - YYYY-MM-DD
 * @param {number} intervalMinutes - monitoring interval
 * @param {Function} takeSnapshotFn - async (date, prev) => snapshot
 * @returns {Promise<Object>} session
 */
export async function createOrResumeSession(targetDate, intervalMinutes, takeSnapshotFn, marketOpts = {}) {
    const config = getConfig();
    const marketId = marketOpts.marketId || 'nyc';
    const tz = marketOpts.marketCtx?.tz || 'America/New_York';
    const existing = await loadSession(targetDate, marketId);

    if (existing && existing.status === 'completed') {
        log.info('session_completed', { marketId, targetDate });
        return existing;
    }

    if (existing && (existing.status === 'active' || existing.status === 'stopped')) {
        existing.status = 'active';
        existing.marketId = existing.marketId || marketId;
        existing.phase = tz !== 'America/New_York' ? getPhaseInTz(targetDate, tz) : getPhase(targetDate);

        cleanupFailedBuyOrder(existing, targetDate);

        if (!existing.buyOrder) {
            await hydrateBuyOrderFromChain(existing, targetDate);
        }

        if (existing.awaitingLiquidity && !existing.buyOrder) {
            existing.awaitingLiquidity = false;
            log.info('liquidity_wait_reset', { marketId, targetDate });
        }

        cleanupFailedResolveSell(existing, targetDate);

        await saveSession(existing);
        await reconcileSessionId(existing, targetDate);

        log.info('session_resumed', { marketId, targetDate, snapshots: existing.snapshots.length, phase: existing.phase });
        return existing;
    }

    // New session
    log.info('initial_snapshot', { marketId, targetDate });
    const snapshot = await takeSnapshotFn(targetDate, null);
    const phase = tz !== 'America/New_York' ? getPhaseInTz(targetDate, tz) : getPhase(targetDate);

    let buyOrder = null;
    if (snapshot.eventClosed) {
        log.info('event_closed', { targetDate, action: 'deferring_buy' });
    } else {
        const shouldGate = config.liquidity.wsEnabled && phase === 'buy';
        if (!shouldGate) {
            const initLiq = await fetchLiquidityFromService(targetDate, marketId);
            buyOrder = await tryPlaceBuyOrder(snapshot, initLiq?.tokens || [], { targetDate, marketId });
            if (buyOrder) {
                log.info('initial_buy_success', { targetDate, cost: buyOrder.totalCost.toFixed(3), mode: buyOrder.mode || 'live' });
            } else {
                log.warn('initial_buy_failed', { targetDate, action: 'retry_next_cycle' });
            }
        } else {
            log.info('buy_deferred', { targetDate, reason: 'liquidity_gate' });
        }
    }

    const sessionId = crypto.randomUUID();
    if (buyOrder) {
        buyOrder._sessionId = sessionId;
        buyOrder._targetDate = targetDate;
        buyOrder._marketId = marketId;
    }

    const session = {
        id: sessionId,
        targetDate,
        marketId,
        startedAt: nowISO(),
        status: 'active',
        phase,
        intervalMinutes,
        initialForecastTempF: snapshot.forecastTempF,
        initialTargetRange: snapshot.target.question,
        forecastSource: snapshot.forecastSource,
        rebalanceThreshold: config.monitor.rebalanceThreshold,
        buyOrder,
        pnl: null,
        snapshots: [snapshot],
        alerts: [],
    };

    await saveSession(session);
    await upsertAndReconcile(session, {
        phase,
        initialForecastTemp: snapshot.forecastTempF,
        initialTargetRange: snapshot.target?.question,
        forecastSource: snapshot.forecastSource,
        intervalMinutes,
    });
    await dbInsertSnapshot({ sessionId: session.id, ...snapshot }, session);

    return session;
}

/**
 * Upsert session to DB (debounced — only when phase or status changes).
 */
export async function syncSessionToDb(session) {
    const phaseChanged = session.phase !== session._lastDbPhase;
    const statusChanged = session.status !== session._lastDbStatus;
    if (!session._dbSessionReady || phaseChanged || statusChanged) {
        const upsertResult = await upsertAndReconcile(session);
        if (upsertResult) {
            session._lastDbPhase = session.phase;
            session._lastDbStatus = session.status;
        }
    }
}

export async function stopSession(session) {
    session.status = 'stopped';
    await saveSession(session);
}
