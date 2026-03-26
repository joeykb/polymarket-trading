/**
 * TempEdge Monitor — Sell Flow Logic
 *
 * Contains all sell strategy logic extracted from orchestrator.js:
 *   - Resolve-day sell (hedge liquidation)
 *   - Rebalance sell (forecast shift)
 *   - Stop-loss sell (P&L floor breach)
 *
 * Each function takes the session, snapshot, and dependencies, then returns
 * an array of alerts to be appended to the cycle's alert list.
 */

import { nowISO } from '../../shared/dates.js';
import { collectSellablePositions } from './positions.js';
import { executeSellOrder } from './svcClients.js';

// ── Sell Result Processor ───────────────────────────────────────────────

/**
 * Apply sell results back to the original buy order positions.
 * Marks each sold position with timing, price, order ID, and status.
 *
 * @param {Object} sellResult - Response from executeSellOrder
 * @param {Object} session - Session with buyOrder.positions[]
 */
function applySellResults(sellResult, session) {
    if (!sellResult?.positions) return;
    for (const sold of sellResult.positions) {
        const original = session.buyOrder.positions.find((p) => p.question === sold.question);
        if (original) {
            original.soldAt = nowISO();
            original.sellPrice = sold.sellPrice;
            original.soldOrderId = sold.orderId;
            original.soldStatus = sold.status;
        }
    }
}

// ── Resolve-Day Sell ────────────────────────────────────────────────────

/**
 * On resolve day, sell all hedge positions (positions that don't match the
 * current target range). Only executes once per session.
 *
 * @param {Object} session - Active session with buyOrder
 * @param {Object} snapshot - Current snapshot
 * @param {Object} config - { buyHourEST }
 * @returns {Promise<Array>} - Alerts generated
 */
export async function executeResolveDaySell(session, snapshot, config) {
    const alerts = [];

    if (!session.buyOrder || snapshot.eventClosed) return alerts;
    if (session.resolveSellExecuted) return alerts;
    if (snapshot.phase !== 'resolve') return alerts;

    const resolveSellHour = config.buyHourEST || 9.5;
    const nowET = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
    const nowDate = new Date(nowET);
    const currentHour = nowDate.getHours() + nowDate.getMinutes() / 60;

    if (currentHour < resolveSellHour) return alerts;

    const currentTargetQ = snapshot.target?.question;
    if (!currentTargetQ) return alerts;

    const positionsToSell = collectSellablePositions(
        session, snapshot,
        (pos) => pos.question !== currentTargetQ,
    );

    if (positionsToSell.length === 0) {
        session.resolveSellExecuted = true;
        return alerts;
    }

    console.log(`\n  🎯 RESOLVE-DAY SELL: selling ${positionsToSell.length} hedge position(s)`);
    const sellCtx = { sessionId: session.id, targetDate: session.targetDate, marketId: 'nyc' };
    const sellResult = await executeSellOrder(positionsToSell, sellCtx);

    if (sellResult) {
        if (!session.sellOrders) session.sellOrders = [];
        session.sellOrders.push(sellResult);
        session.resolveSellExecuted = true;
        applySellResults(sellResult, session);
        alerts.push({
            timestamp: nowISO(),
            type: 'resolve_sell',
            message: `Resolve-day sell: sold ${positionsToSell.length} hedge position(s)`,
            data: { forecast: snapshot.forecastTempF, sold: positionsToSell.map((p) => p.question) },
        });
    }

    return alerts;
}

// ── Rebalance Sell ──────────────────────────────────────────────────────

/**
 * During monitor/buy phase, sell positions that are no longer in the current
 * target/below/above range set when the forecast has shifted beyond the
 * dynamic threshold.
 *
 * @param {Object} session - Active session with buyOrder
 * @param {Object} snapshot - Current snapshot
 * @param {Object} config - { rebalanceThreshold }
 * @returns {Promise<Array>} - Alerts generated
 */
export async function executeRebalanceSell(session, snapshot, config) {
    const alerts = [];

    if (!session.buyOrder || snapshot.eventClosed) return alerts;
    if (snapshot.phase !== 'monitor' && snapshot.phase !== 'buy') return alerts;

    const rebalanceRef = session.lastRebalanceForecastF ?? session.initialForecastTempF;
    const totalShift = Math.abs(snapshot.forecastTempF - rebalanceRef);
    const daysOut = snapshot.daysUntilTarget ?? 2;
    const dynamicThreshold = daysOut <= 1 ? 1.0 : daysOut === 2 ? 2.0 : (config.rebalanceThreshold || 3);

    if (totalShift < dynamicThreshold) return alerts;

    console.log(`\n  🔄 REBALANCE: forecast shifted ${totalShift.toFixed(1)}°F from reference ${rebalanceRef.toFixed(1)}°F (threshold: ${dynamicThreshold}°F for T+${daysOut})`);

    const currentRangeQuestions = new Set(
        [snapshot.target?.question, snapshot.below?.question, snapshot.above?.question].filter(Boolean),
    );
    const positionsToSell = collectSellablePositions(
        session, snapshot,
        (pos) => !currentRangeQuestions.has(pos.question),
    );

    if (positionsToSell.length === 0) return alerts;

    const sellCtx = { sessionId: session.id, targetDate: session.targetDate, marketId: 'nyc' };
    const sellResult = await executeSellOrder(positionsToSell, sellCtx);

    if (sellResult) {
        if (!session.sellOrders) session.sellOrders = [];
        session.sellOrders.push(sellResult);
        session.lastRebalanceForecastF = snapshot.forecastTempF;
        applySellResults(sellResult, session);
        alerts.push({
            timestamp: nowISO(),
            type: 'rebalance_sell',
            message: `Sold ${positionsToSell.length} out-of-range positions (shift: ${totalShift.toFixed(1)}°F from ${rebalanceRef.toFixed(1)}°F)`,
            data: { shift: totalShift, rebalanceRef, proceeds: sellResult.totalProceeds },
        });
    }

    return alerts;
}

// ── Stop-Loss Sell ──────────────────────────────────────────────────────

/**
 * Execute a stop-loss sell when P&L hits the floor.
 *
 * @param {Object} session - Active session with buyOrder
 * @param {Object} snapshot - Current snapshot
 * @param {Object} stopLoss - Result from checkStopLoss() { triggered, reason, pnlPct, totalPnL }
 * @returns {Promise<Array>} - Alerts generated
 */
export async function executeStopLossSell(session, snapshot, stopLoss) {
    const alerts = [];

    if (!stopLoss.triggered) return alerts;

    console.log(`\n  🛑 STOP-LOSS TRIGGERED: ${stopLoss.reason}`);
    const positionsToSell = collectSellablePositions(session, snapshot);

    if (positionsToSell.length === 0) return alerts;

    const sellCtx = { sessionId: session.id, targetDate: session.targetDate, marketId: 'nyc' };
    const sellResult = await executeSellOrder(positionsToSell, sellCtx);

    if (sellResult) {
        if (!session.sellOrders) session.sellOrders = [];
        session.sellOrders.push(sellResult);
        session.stopLossExecuted = true;
        applySellResults(sellResult, session);
        alerts.push({
            timestamp: nowISO(),
            type: 'stop_loss',
            message: `🛑 Stop-loss: sold ${positionsToSell.length} positions — ${stopLoss.reason}`,
            data: {
                pnlPct: stopLoss.pnlPct,
                totalPnL: stopLoss.totalPnL,
                proceeds: sellResult.totalProceeds,
                positionsSold: positionsToSell.length,
            },
        });
    }

    return alerts;
}
