/**
 * TempEdge Monitor — Orchestrator (Microservice Edition)
 *
 * Thin coordinator that delegates to focused modules:
 *   - monitorConfig.js  → config defaults + remote refresh
 *   - sessionManager.js → session creation, resumption, DB sync
 *   - buyFlow.js        → liquidity-gated buy, tier filtering
 *   - sellFlow.js       → resolve-day, rebalance, stop-loss sells
 *   - snapshot.js       → market snapshot assembly
 *   - alerts.js         → alert detection
 *   - strategy.js       → trend analysis, edge computation, P&L
 *   - persistence.js    → session file + DB writes
 *   - svcClients.js     → HTTP clients for all microservices
 *
 * Dependencies (all via HTTP):
 *   weather-svc  → forecast + current conditions
 *   market-svc   → market discovery + range selection
 *   trading-svc  → buy, sell, redeem
 *   data-svc     → session files, DB writes, config, spend tracking
 *   liquidity    → WebSocket order book streaming
 */

import 'dotenv/config';
import { createLogger } from '../../shared/logger.js';
import { nowISO, getTodayET, getDateOffsetET, daysUntil, getPhase, getDateOffsetInTz, getPhaseInTz } from '../../shared/dates.js';
import { takeSnapshot } from './snapshot.js';
import { detectAlerts } from './alerts.js';
import { analyzeTrend, resolveRanges, shouldPlaceBuy, computePnL, checkStopLoss, computeEdge, analyzeTrajectory } from './strategy.js';
import { fetchWeatherData, discoverMarket, selectRanges, tryPlaceBuyOrder, tryRedeemPositions, fetchLiquidityFromService, fetchDailySpend } from './svcClients.js';
import { loadSession, saveSession, dbInsertSnapshot, dbInsertAlertsBatch } from './persistence.js';
import { executeResolveDaySell, executeRebalanceSell, executeStopLossSell } from './sellFlow.js';
import { getConfig, refreshConfig } from './monitorConfig.js';
import { filterSnapshotByTier, attachSessionContext, startLiquidityGatedBuy } from './buyFlow.js';
import { createOrResumeSession, syncSessionToDb, stopSession } from './sessionManager.js';
import { checkBudget } from './budget.js';

const log = createLogger('monitor');

// ── Snapshot Wrappers (inject service functions) ────────────────────────

const _svcFns = { fetchWeatherData, discoverMarket, selectRanges };

/**
 * @param {string} targetDate
 * @param {Object|null} previous
 * @param {Object} [opts] - { marketCtx, marketId }
 */
async function _takeSnapshot(targetDate, previous, opts = {}) {
    return takeSnapshot(targetDate, previous, _svcFns, opts);
}

function _detectAlerts(current, previous, session) {
    const config = getConfig();
    return detectAlerts(current, previous, session, config.monitor);
}

function _shouldPlaceBuy(session, snapshot) {
    const config = getConfig();
    return shouldPlaceBuy(session, snapshot, {
        buyHourEST: config.monitor.buyHourEST,
        wsEnabled: config.liquidity.wsEnabled,
    });
}

// ── Session Management (re-export with snapshot injection) ──────────────

async function _createOrResumeSession(targetDate, intervalMinutes, marketOpts = {}) {
    return createOrResumeSession(targetDate, intervalMinutes, (date, prev) => _takeSnapshot(date, prev, marketOpts), marketOpts);
}

// ── Monitoring Cycle ────────────────────────────────────────────────────

async function runMonitoringCycle(session, marketOpts = {}) {
    const config = getConfig();
    const previousSnapshot = session.snapshots[session.snapshots.length - 1] || null;
    const snapshot = await _takeSnapshot(session.targetDate, previousSnapshot, marketOpts);
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
        log.info('trajectory', { stability: t.rangeStability, drift: t.driftMagnitude, direction: t.driftDirection, acceleration: t.acceleration, points: t.pointCount });
    }

    // Scout/Track: observation only
    if (snapshot.phase === 'scout' || snapshot.phase === 'track') {
        session.snapshots.push(snapshot);
        if (session.snapshots.length > 96) session.snapshots = session.snapshots.slice(-96);
        session.alerts = [...(session.alerts || []), ...alerts];
        await saveSession(session);
        await dbInsertSnapshot({ sessionId: session.id, ...snapshot }, session);
        await dbInsertAlertsBatch(alerts.map((a) => ({ sessionId: session.id, ...a })));
        return { snapshot, alerts };
    }

    // ── Buy Logic ───────────────────────────────────────────────────────
    const buySignal = _shouldPlaceBuy(session, snapshot);
    if (buySignal === true || buySignal === 'await-liquidity') {
        const edge = computeEdge(
            snapshot,
            session.trend,
            {
                evThreshold: config.monitor.evThreshold ?? 0.05,
                maxEntryPrice: config.monitor.maxEntryPrice ?? 0.40,
                maxHedgeCost: config.monitor.maxHedgeCost ?? 0.10,
            },
            session.trajectory,
        );
        session.lastEdge = edge;
        log.info('edge_computed', { ev: edge.ev, confidence: edge.confidence, tier: edge.tier, action: edge.action, targetDate: session.targetDate, marketId: session.marketId });

        if (edge.action === 'skip') {
            log.info('buy_skipped', { reason: edge.reason, ev: edge.ev, tier: edge.tier });
            alerts.push({
                timestamp: nowISO(),
                type: 'ev_skip',
                message: `Buy skipped: ${edge.reason}`,
                data: { ev: edge.ev, confidence: edge.confidence, tier: edge.tier, targetPrice: snapshot.target?.yesPrice },
            });
        } else {
            // Budget check before buy
            const estimatedCost = snapshot.totalCost || 0;
            const spendData = await fetchDailySpend();
            const budgetCheck = await checkBudget(session.marketId || 'nyc', estimatedCost, config, spendData);

            if (!budgetCheck.allowed) {
                log.info('buy_budget_blocked', { marketId: session.marketId, reason: budgetCheck.reason, remaining: budgetCheck.remaining, cost: estimatedCost });
                alerts.push({
                    timestamp: nowISO(),
                    type: 'budget_blocked',
                    message: `Buy blocked: ${budgetCheck.reason}`,
                    data: { remaining: budgetCheck.remaining, estimatedCost, marketId: session.marketId },
                });
            } else if (buySignal === true) {
                const filteredSnapshot = filterSnapshotByTier(snapshot, edge.rangesToBuy);
                const immLiq = await fetchLiquidityFromService(session.targetDate, session.marketId);
                session.buyOrder = await tryPlaceBuyOrder(filteredSnapshot, immLiq?.tokens || [], {
                    sessionId: session.id,
                    targetDate: session.targetDate,
                    marketId: session.marketId || 'nyc',
                });
                if (session.buyOrder) {
                    session.buyOrder.edge = edge;
                    session.initialForecastTempF = session.initialForecastTempF ?? snapshot.forecastTempF;
                }
                attachSessionContext(session.buyOrder, session);
            } else if (buySignal === 'await-liquidity' && !session.awaitingLiquidity) {
                session.pendingEdge = edge;
                startLiquidityGatedBuy(session, snapshot, (date, prev) => _takeSnapshot(date, prev, marketOpts));
            }
        }
    }

    // ── Sell Strategy ───────────────────────────────────────────────────
    const resolveSellAlerts = await executeResolveDaySell(session, snapshot, config.monitor);
    alerts.push(...resolveSellAlerts);

    const rebalanceAlerts = await executeRebalanceSell(session, snapshot, config.monitor);
    alerts.push(...rebalanceAlerts);

    // ── P&L + Stop-Loss ─────────────────────────────────────────────────
    if (session.buyOrder) {
        const liqData = await fetchLiquidityFromService(session.targetDate, session.marketId);
        const liquidityBids = {};
        if (liqData?.tokens) {
            for (const t of liqData.tokens) {
                if (t.question && t.bestBid > 0) liquidityBids[t.question] = t.bestBid;
            }
        }
        session.pnl = computePnL(session.buyOrder, snapshot, liquidityBids);

        const stopLoss = checkStopLoss(session, snapshot, {
            stopLossEnabled: config.monitor.stopLossEnabled,
            stopLossPct: config.monitor.stopLossPct,
            stopLossFloor: config.monitor.stopLossFloor,
        });
        const stopLossAlerts = await executeStopLossSell(session, snapshot, stopLoss);
        alerts.push(...stopLossAlerts);
    }

    // ── Finalize ────────────────────────────────────────────────────────
    session.snapshots.push(snapshot);
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
    await syncSessionToDb(session);
    await dbInsertSnapshot({ sessionId: session.id, ...snapshot }, session);
    await dbInsertAlertsBatch(alerts.map((a) => ({ sessionId: session.id, ...a })));

    return { snapshot, alerts, resolution };
}

// ── Exports ─────────────────────────────────────────────────────────────

export {
    _createOrResumeSession as createOrResumeSession,
    runMonitoringCycle,
    stopSession,
    getConfig,
    refreshConfig,
    loadSession,
    getPhase,
    getPhaseInTz,
    getDateOffsetET,
    getDateOffsetInTz,
    daysUntil,
};
