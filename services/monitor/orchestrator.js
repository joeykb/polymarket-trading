/**
 * TempEdge Monitor — Orchestrator (Microservice Edition)
 *
 * This is the core monitoring logic from the original services/monitor.js,
 * fully refactored to call microservice APIs instead of importing local modules.
 *
 * Dependencies (all via HTTP):
 *   weather-svc  → forecast + current conditions
 *   market-svc   → market discovery + range selection
 *   trading-svc  → buy, sell, redeem
 *   data-svc     → session files, DB writes, config, spend tracking
 *   liquidity    → WebSocket order book streaming (port 3001 on monolith until extracted)
 */

import 'dotenv/config';
import { createLogger } from '../../shared/logger.js';
import { nowISO, getTodayET, getDateOffsetET, daysUntil, getPhase } from '../../shared/dates.js';
import { takeSnapshot } from './snapshot.js';
import { detectAlerts } from './alerts.js';
import { analyzeTrend, resolveRanges, shouldPlaceBuy, computePnL, checkStopLoss, computeEdge, analyzeTrajectory } from './strategy.js';
import {
    svcGet,
    fetchWeatherData, discoverMarket, selectRanges,
    tryPlaceBuyOrder, tryRedeemPositions, fetchLiquidityFromService,
    DATA_SVC,
} from './svcClients.js';
import { loadSession, saveSession, dbUpsertSession, dbInsertSnapshot, dbInsertAlertsBatch } from './persistence.js';
import { executeResolveDaySell, executeRebalanceSell, executeStopLossSell } from './sellFlow.js';

const log = createLogger('monitor');

// ── Config defaults (overridden by data-svc /api/config) ───────────────

const _config = {
    monitor: {
        intervalMinutes: 15,
        rebalanceThreshold: 3,
        forecastShiftThreshold: 2,
        priceSpikeThreshold: 0.05,
        buyHourEST: 9.5,
    },
    liquidity: {
        wsEnabled: true,
        checkIntervalSecs: 30,
        buyDeadlineHour: 10.5,
        requireAllLiquid: false,
    },
    phases: {
        scoutDaysMax: 4,
        trendThreshold: 2,
    },
};

async function refreshConfig() {
    try {
        const remote = await svcGet(DATA_SVC, '/api/config');
        if (remote) {
            if (remote.monitor) Object.assign(_config.monitor, remote.monitor);
            if (remote.liquidity) Object.assign(_config.liquidity, remote.liquidity);
            if (remote.phases) Object.assign(_config.phases, remote.phases);
        }
    } catch {
        /* intentional: config fetch may fail at startup, use defaults */
    }
}

function getConfigVal() {
    return _config;
}

// ── Snapshot (delegated to snapshot.js) ─────────────────────────────────
// takeSnapshot is imported from ./snapshot.js and called with injected service functions.
// See _takeSnapshot() wrapper below.

const _svcFns = {
    fetchWeatherData,
    discoverMarket,
    selectRanges,
};

async function _takeSnapshot(targetDate, previous) {
    return takeSnapshot(targetDate, previous, _svcFns);
}

// ── Alert Detection (delegated to alerts.js) ────────────────────────────
// detectAlerts is imported from ./alerts.js

function _detectAlerts(current, previous, session) {
    return detectAlerts(current, previous, session, _config.monitor);
}

// ── Strategy (delegated to strategy.js) ──────────────────────────────────
// analyzeTrend, resolveRanges, shouldPlaceBuy, computePnL imported from ./strategy.js

function _shouldPlaceBuy(session, snapshot) {
    return shouldPlaceBuy(session, snapshot, {
        buyHourEST: _config.monitor.buyHourEST,
        wsEnabled: _config.liquidity.wsEnabled,
    });
}

// ── Snapshot Filtering by Confidence Tier ────────────────────────────────

/**
 * Create a filtered snapshot containing only the ranges specified by rangesToBuy.
 * This controls which positions the trading service will buy.
 *
 * @param {Object} snapshot - Full snapshot with target/below/above
 * @param {Array<string>} rangesToBuy - e.g. ['target'] or ['target', 'below']
 * @returns {Object} Filtered snapshot
 */
function _filterSnapshotByTier(snapshot, rangesToBuy) {
    const rangeSet = new Set(rangesToBuy);
    return {
        ...snapshot,
        target: rangeSet.has('target') ? snapshot.target : null,
        below: rangeSet.has('below') ? snapshot.below : null,
        above: rangeSet.has('above') ? snapshot.above : null,
    };
}

// ── Liquidity-Gated Buy Flow ────────────────────────────────────────────

function attachSessionContext(order, session) {
    if (!order) return;
    order._sessionId = session.id;
    order._targetDate = session.targetDate;
    order._marketId = 'nyc';
}

function startLiquidityGatedBuy(session, snapshot) {
    session.awaitingLiquidity = true;
    session.liquidityWaitStart = nowISO();
    saveSession(session);

    const targetDate = session.targetDate;
    const pollIntervalMs = (_config.liquidity.checkIntervalSecs || 30) * 1000;
    const deadlineHour = _config.liquidity.buyDeadlineHour || 10.5;
    const deadlineH = Math.floor(deadlineHour);
    const deadlineM = Math.round((deadlineHour - deadlineH) * 60);

    console.log(`\n  ⏳ Liquidity gate activated for ${targetDate}`);
    console.log(`     Polling:   every ${pollIntervalMs / 1000}s`);
    console.log(`     Deadline:  ${deadlineH}:${String(deadlineM).padStart(2, '0')} ET`);

    // Mutex: prevents TOCTOU race where two interval ticks could both
    // pass the guard before either completes the async buy operation.
    let bought = false;
    let _buyInProgress = false;

    const pollTimer = setInterval(async () => {
        // Fast exit: already bought or buy currently executing
        if (bought || session.buyOrder || _buyInProgress) {
            if (bought || session.buyOrder) clearInterval(pollTimer);
            return;
        }

        // Acquire lock
        _buyInProgress = true;

        try {
            const nowET = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
            const nowDate = new Date(nowET);
            const currentDecimalHour = nowDate.getHours() + nowDate.getMinutes() / 60;

            if (currentDecimalHour >= deadlineHour) {
                clearInterval(pollTimer);
                if (bought || session.buyOrder) return;
                bought = true;
                session.awaitingLiquidity = false;

                const waitMs = Date.now() - new Date(session.liquidityWaitStart).getTime();
                const waitStr = `${(waitMs / 60000).toFixed(1)}m`;
                console.log(`\n  ⏰ DEADLINE — forcing buy after ${waitStr}`);

                const deadlineLiq = await fetchLiquidityFromService(targetDate);
                // Take fresh snapshot so buy uses latest forecast
                let freshSnapshot;
                try {
                    freshSnapshot = await _takeSnapshot(targetDate, null);
                } catch {
                    freshSnapshot = snapshot; /* intentional: use last known snapshot */
                }
                // Re-evaluate edge with fresh data (deadline still forces buy but respects tier)
                const edge =
                    session.pendingEdge ||
                    computeEdge(
                        freshSnapshot,
                        session.trend,
                        {
                            evThreshold: _config.monitor.evThreshold ?? 0.05,
                        },
                        session.trajectory,
                    );
                const filteredSnapshot = _filterSnapshotByTier(freshSnapshot, edge.rangesToBuy);
                const order = await tryPlaceBuyOrder(filteredSnapshot, deadlineLiq?.tokens || [], {
                    sessionId: session.id,
                    targetDate: session.targetDate,
                    marketId: 'nyc',
                });
                if (!order) {
                    console.warn('  ⚠️  Deadline buy failed');
                    return;
                }
                order.edge = edge;
                attachSessionContext(order, session);
                order.liquidityWait = waitStr;
                order.forcedByDeadline = true;
                session.buyOrder = order;
                session.pnl = computePnL(order, snapshot);
                session.alerts.push({
                    timestamp: nowISO(),
                    type: 'buy_executed',
                    message: `Buy forced at deadline after ${waitStr}`,
                    data: { waitMs, forced: true },
                });
                await saveSession(session);
                console.log(`  💰 Deadline buy: $${order.totalCost.toFixed(3)}`);
                return;
            }

            const liqData = await fetchLiquidityFromService(targetDate);
            if (!liqData || !liqData.tokens || liqData.tokens.length === 0) return;

            const requireAll = _config.liquidity.requireAllLiquid;
            const liquidCount = liqData.liquidCount || 0;
            const totalCount = liqData.tokenCount || liqData.tokens.length;
            const allLiquid = liqData.allLiquid || false;
            const conditionMet = requireAll ? allLiquid : liquidCount > 0;

            if (!conditionMet) return;

            clearInterval(pollTimer);
            if (bought || session.buyOrder) return;
            bought = true;
            session.awaitingLiquidity = false;

            const waitMs = Date.now() - new Date(session.liquidityWaitStart).getTime();
            const waitStr = `${(waitMs / 60000).toFixed(1)}m`;
            console.log(`\n  ✅ LIQUIDITY MET — buying (${liquidCount}/${totalCount} liquid, waited ${waitStr})`);

            // Take fresh snapshot so buy uses latest forecast
            let freshSnapshot;
            try {
                freshSnapshot = await _takeSnapshot(targetDate, null);
            } catch {
                freshSnapshot = snapshot; /* intentional: use last known snapshot */
            }
            // Re-evaluate edge with fresh data
            const edge = computeEdge(
                freshSnapshot,
                session.trend,
                {
                    evThreshold: _config.monitor.evThreshold ?? 0.05,
                    maxEntryPrice: _config.monitor.maxEntryPrice ?? 0.40,
                    maxHedgeCost: _config.monitor.maxHedgeCost ?? 0.10,
                },
                session.trajectory,
            );
            if (edge.action === 'skip') {
                console.log(`  ⏭️  SKIP BUY (liquidity-gated): ${edge.reason}`);
                session.awaitingLiquidity = false;
                session.lastEdge = edge;
                await saveSession(session);
                return;
            }
            const filteredSnapshot = _filterSnapshotByTier(freshSnapshot, edge.rangesToBuy);
            const order = await tryPlaceBuyOrder(filteredSnapshot, liqData.tokens, {
                sessionId: session.id,
                targetDate: session.targetDate,
                marketId: 'nyc',
            });
            if (!order) {
                console.warn('  ⚠️  Liquidity-gated buy failed');
                return;
            }
            order.edge = edge;
            attachSessionContext(order, session);
            order.liquidityWait = waitStr;
            session.buyOrder = order;
            session.lastEdge = edge;
            session.pnl = computePnL(order, snapshot);
            session.alerts.push({
                timestamp: nowISO(),
                type: 'buy_executed',
                message: `Buy after ${waitStr} liquidity wait (EV: $${edge.ev.toFixed(3)}, tier: ${edge.tier})`,
                data: { waitMs, liquidCount, totalCount, edge },
            });
            await saveSession(session);
            console.log(`  💰 Buy order placed: $${order.totalCost.toFixed(3)} [waited ${waitStr}, tier: ${edge.tier}]`);
        } finally {
            // Release lock
            _buyInProgress = false;
        }
    }, pollIntervalMs);
}

// ── Session Management (Exported) ───────────────────────────────────────

export async function createOrResumeSession(targetDate, intervalMinutes) {
    const existing = await loadSession(targetDate);

    if (existing && existing.status === 'completed') {
        log.info('session_completed', { targetDate });
        return existing;
    }

    if (existing && (existing.status === 'active' || existing.status === 'stopped')) {
        existing.status = 'active';
        existing.phase = getPhase(targetDate);

        // Clean up failed buy orders
        if (existing.buyOrder && existing.buyOrder.totalCost === 0) {
            const allFailed = existing.buyOrder.positions?.every((p) => p.status === 'failed');
            if (allFailed) {
                console.log(`  🧹 Clearing failed buy order`);
                existing.buyOrder = null;
                existing.pnl = null;
            }
        }
        if (!existing.buyOrder) {
            // Try to hydrate buyOrder from chain-backfilled DB data
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
                    existing.buyOrder = {
                        positions,
                        totalCost: parseFloat(totalCost.toFixed(4)),
                        mode: 'live',
                        source: 'chain-backfill',
                        placedAt: dbPositions[0].created_at,
                    };
                    console.log(`  🔗 Hydrated buyOrder from chain data: ${positions.length} positions, $${totalCost.toFixed(3)}`);
                } else {
                    console.log(`  ⏳ No buy order yet — will trigger via normal buy flow`);
                }
            } catch (err) {
                console.warn(`  ⚠️  Chain-backfill hydration failed: ${err.message}`);
                console.log(`  ⏳ No buy order yet — will trigger via normal buy flow`);
            }
        }
        if (existing.awaitingLiquidity && !existing.buyOrder) {
            existing.awaitingLiquidity = false;
            console.log(`  🔄 Resetting liquidity wait`);
        }

        // Reset failed resolve sell
        if (existing.resolveSellExecuted && existing.sellOrders?.length > 0) {
            const lastSell = existing.sellOrders[existing.sellOrders.length - 1];
            const allSellsFailed = lastSell.positions?.every((p) => p.status === 'failed');
            if (allSellsFailed) {
                console.log(`  🔄 Resetting failed resolve sell`);
                existing.resolveSellExecuted = false;
                existing.sellOrders.pop();
                for (const p of existing.buyOrder?.positions || []) {
                    if (p.soldStatus === 'failed') {
                        p.soldAt = undefined;
                        p.soldStatus = undefined;
                        p.soldOrderId = undefined;
                    }
                }
            }
        }

        await saveSession(existing);
        // Reconcile session ID with DB — the DB may hold a different ID, or no session at all
        try {
            const dbSession = await svcGet(DATA_SVC, `/api/db/sessions/nyc/${targetDate}`);
            if (dbSession && dbSession.id && dbSession.id !== existing.id) {
                existing.id = dbSession.id;
            }
            existing._dbSessionReady = true;
        } catch {
            // Session not in DB — upsert it so snapshots/alerts have a valid FK target
            const upsertResult = await dbUpsertSession({
                id: existing.id,
                marketId: 'nyc',
                targetDate,
                status: existing.status,
                phase: existing.phase,
                initialForecastTemp: existing.initialForecastTempF,
                initialTargetRange: existing.initialTargetRange,
                forecastSource: existing.forecastSource,
                intervalMinutes: parseInt(existing.intervalMinutes) || 5,
                rebalanceThreshold: parseFloat(existing.rebalanceThreshold) || 3.0,
            });
            if (upsertResult?.existingId && upsertResult.existingId !== existing.id) {
                existing.id = upsertResult.existingId;
            }
            if (upsertResult) existing._dbSessionReady = true;
        }
        log.info('session_resumed', { targetDate, snapshots: existing.snapshots.length, phase: existing.phase });
        return existing;
    }

    // New session
    console.log('  📸 Taking initial snapshot...');
    const snapshot = await _takeSnapshot(targetDate, null);
    const phase = getPhase(targetDate);

    let buyOrder = null;
    if (snapshot.eventClosed) {
        console.log('  ⏳ Event is closed/not yet created — deferring buy');
    } else {
        const shouldGate = _config.liquidity.wsEnabled && phase === 'buy';
        if (!shouldGate) {
            const initLiq = await fetchLiquidityFromService(targetDate);
            buyOrder = await tryPlaceBuyOrder(snapshot, initLiq?.tokens || [], { targetDate, marketId: 'nyc' });
            if (buyOrder) {
                console.log(`  💰 Buy order placed: $${buyOrder.totalCost.toFixed(3)} [${buyOrder.mode || 'live'}]`);
            } else {
                console.log('  ⚠️ Buy attempted but failed — will retry next cycle');
            }
        } else {
            console.log('  ⏳ Buy deferred — liquidity gate will handle');
        }
    }

    const sessionId = crypto.randomUUID();
    if (buyOrder) {
        buyOrder._sessionId = sessionId;
        buyOrder._targetDate = targetDate;
        buyOrder._marketId = 'nyc';
    }

    const session = {
        id: sessionId,
        targetDate,
        startedAt: nowISO(),
        status: 'active',
        phase,
        intervalMinutes,
        initialForecastTempF: snapshot.forecastTempF,
        initialTargetRange: snapshot.target.question,
        forecastSource: snapshot.forecastSource,
        rebalanceThreshold: _config.monitor.rebalanceThreshold,
        buyOrder,
        pnl: null,
        snapshots: [snapshot],
        alerts: [],
    };

    await saveSession(session);

    // DB persist — upsert returns existingId if session already existed
    const upsertResult = await dbUpsertSession({
        id: session.id,
        marketId: 'nyc',
        targetDate,
        status: session.status,
        phase,
        initialForecastTemp: snapshot.forecastTempF,
        initialTargetRange: snapshot.target?.question,
        forecastSource: snapshot.forecastSource,
        intervalMinutes,
        rebalanceThreshold: _config.monitor.rebalanceThreshold,
    });
    // If DB already had a session for this date, adopt its ID for FK integrity
    if (upsertResult?.existingId && upsertResult.existingId !== session.id) {
        session.id = upsertResult.existingId;
    }
    if (upsertResult) session._dbSessionReady = true;
    await dbInsertSnapshot({ sessionId: session.id, ...snapshot }, session);

    return session;
}

// ── Monitoring Cycle (Exported) ─────────────────────────────────────────

export async function runMonitoringCycle(session) {
    const previousSnapshot = session.snapshots[session.snapshots.length - 1] || null;
    const snapshot = await _takeSnapshot(session.targetDate, previousSnapshot);
    const alerts = _detectAlerts(snapshot, previousSnapshot, session);

    session.phase = snapshot.phase;

    // Record forecast history for trend analysis
    if (!session.forecastHistory) session.forecastHistory = [];
    const todayET = getTodayET();
    const alreadyRecordedToday = session.forecastHistory.some((h) => h.date === todayET);
    if (!alreadyRecordedToday && snapshot.forecastTempF != null) {
        session.forecastHistory.push({
            date: todayET,
            daysOut: snapshot.daysUntilTarget,
            forecast: snapshot.forecastTempF,
            source: snapshot.forecastSource,
            timestamp: nowISO(),
        });
    }
    session.trend = analyzeTrend(session.forecastHistory);
    session.trajectory = analyzeTrajectory(session.forecastHistory);

    if (session.trajectory && session.trajectory.pointCount >= 2) {
        const t = session.trajectory;
        console.log(
            `  🔮 Trajectory: ${t.rangeStability} | drift=${t.driftMagnitude}°F ${t.driftDirection} | accel=${t.acceleration} | ${t.pointCount} pts`,
        );
    }

    // Scout/Track: observation only
    if (snapshot.phase === 'scout' || snapshot.phase === 'track') {
        session.snapshots.push(snapshot);
        // Cap in-memory snapshots (older ones are persisted to DB)
        if (session.snapshots.length > 96) session.snapshots = session.snapshots.slice(-96);
        session.alerts = [...(session.alerts || []), ...alerts];
        await saveSession(session);
        await dbInsertSnapshot({ sessionId: session.id, ...snapshot }, session);
        await dbInsertAlertsBatch(alerts.map((a) => ({ sessionId: session.id, ...a })));
        return { snapshot, alerts };
    }

    // Buy logic
    const buySignal = _shouldPlaceBuy(session, snapshot);
    if (buySignal === true || buySignal === 'await-liquidity') {
        // ── EV Filter: compute edge before committing capital ────────
        const edge = computeEdge(
            snapshot,
            session.trend,
            {
                evThreshold: _config.monitor.evThreshold ?? 0.05,
                maxEntryPrice: _config.monitor.maxEntryPrice ?? 0.40,
                maxHedgeCost: _config.monitor.maxHedgeCost ?? 0.10,
            },
            session.trajectory,
        );
        session.lastEdge = edge;
        log.info('edge_computed', { ev: edge.ev, confidence: edge.confidence, tier: edge.tier, action: edge.action, targetDate: session.targetDate });

        if (edge.action === 'skip') {
            log.info('buy_skipped', { reason: edge.reason, ev: edge.ev, tier: edge.tier });
            alerts.push({
                timestamp: nowISO(),
                type: 'ev_skip',
                message: `Buy skipped: ${edge.reason}`,
                data: { ev: edge.ev, confidence: edge.confidence, tier: edge.tier, targetPrice: snapshot.target?.yesPrice },
            });
        } else if (buySignal === true) {
            // Build a filtered snapshot with only the ranges we want to buy
            const filteredSnapshot = _filterSnapshotByTier(snapshot, edge.rangesToBuy);
            const immLiq = await fetchLiquidityFromService(session.targetDate);
            session.buyOrder = await tryPlaceBuyOrder(filteredSnapshot, immLiq?.tokens || [], {
                sessionId: session.id,
                targetDate: session.targetDate,
                marketId: 'nyc',
            });
            if (session.buyOrder) {
                session.buyOrder.edge = edge;
                session.initialForecastTempF = session.initialForecastTempF ?? snapshot.forecastTempF;
            }
            attachSessionContext(session.buyOrder, session);
        } else if (buySignal === 'await-liquidity' && !session.awaitingLiquidity) {
            session.pendingEdge = edge; // Store edge for use when liquidity gate fires
            startLiquidityGatedBuy(session, snapshot);
        }
    }

    // ── Sell Strategy (delegated to sellFlow.js) ───────────────────────────

    // Resolve-day: sell hedge positions when target range clarifies
    const resolveSellAlerts = await executeResolveDaySell(session, snapshot, _config.monitor);
    alerts.push(...resolveSellAlerts);

    // Rebalance: sell out-of-range positions when forecast shifts
    const rebalanceAlerts = await executeRebalanceSell(session, snapshot, _config.monitor);
    alerts.push(...rebalanceAlerts);

    // P&L update
    if (session.buyOrder) {
        const liqData = await fetchLiquidityFromService(session.targetDate);
        const liquidityBids = {};
        if (liqData?.tokens) {
            for (const t of liqData.tokens) {
                if (t.question && t.bestBid > 0) liquidityBids[t.question] = t.bestBid;
            }
        }
        session.pnl = computePnL(session.buyOrder, snapshot, liquidityBids);

        // Stop-loss: sell all positions when P&L breaches floor
        const stopLoss = checkStopLoss(session, snapshot, {
            stopLossEnabled: _config.monitor.stopLossEnabled,
            stopLossPct: _config.monitor.stopLossPct,
            stopLossFloor: _config.monitor.stopLossFloor,
        });
        const stopLossAlerts = await executeStopLossSell(session, snapshot, stopLoss);
        alerts.push(...stopLossAlerts);
    }

    session.snapshots.push(snapshot);
    // Cap in-memory snapshots (older ones are persisted to DB)
    if (session.snapshots.length > 96) session.snapshots = session.snapshots.slice(-96);
    session.alerts.push(...alerts);

    let resolution = null;
    if (snapshot.phase === 'resolve' && !snapshot.eventClosed) {
        resolution = resolveRanges(snapshot);
        session.resolution = resolution;
    }

    // Auto-redeem
    if (snapshot.eventClosed && session.status !== 'completed') {
        session.status = 'completed';
        if (session.buyOrder && !session.redeemExecuted) {
            const redeemResult = await tryRedeemPositions(session);
            if (redeemResult) {
                session.redeemExecuted = true;
                session.redeemResult = redeemResult;
                alerts.push({
                    timestamp: nowISO(),
                    type: 'redeem',
                    message: `Redeemed ${redeemResult.redeemed} positions for $${redeemResult.totalValue.toFixed(2)}`,
                    data: redeemResult,
                });
            }
        }
    }

    await saveSession(session);

    // DB writes — only upsert session when state changes or not yet synced (debounced)
    const phaseChanged = session.phase !== session._lastDbPhase;
    const statusChanged = session.status !== session._lastDbStatus;
    if (!session._dbSessionReady || phaseChanged || statusChanged) {
        const upsertResult = await dbUpsertSession({
            id: session.id,
            marketId: 'nyc',
            targetDate: session.targetDate,
            status: session.status,
            phase: session.phase,
            initialForecastTemp: session.initialForecastTempF,
            initialTargetRange: session.initialTargetRange,
            forecastSource: session.forecastSource,
            intervalMinutes: parseInt(session.intervalMinutes) || 5,
            rebalanceThreshold: session.rebalanceThreshold,
        });
        if (upsertResult?.existingId && upsertResult.existingId !== session.id) {
            session.id = upsertResult.existingId;
        }
        if (upsertResult) {
            session._dbSessionReady = true;
            session._lastDbPhase = session.phase;
            session._lastDbStatus = session.status;
        }
    }
    await dbInsertSnapshot({ sessionId: session.id, ...snapshot }, session);
    await dbInsertAlertsBatch(alerts.map((a) => ({ sessionId: session.id, ...a })));

    return { snapshot, alerts, resolution };
}

export async function stopSession(session) {
    session.status = 'stopped';
    await saveSession(session);
}

export { getConfigVal as getConfig, getPhase, getDateOffsetET, daysUntil, refreshConfig, loadSession };
