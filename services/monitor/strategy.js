/**
 * TempEdge Monitor — Strategy Functions
 *
 * Pure decision functions for trend analysis, buy decisions,
 * and resolve-phase range resolution. No I/O, no side effects.
 *
 * Extracted from orchestrator.js for testability.
 */

import { computePnL as _computePnLCore } from '../../shared/pnl.js';

// ── Trend Analysis ──────────────────────────────────────────────────────

/**
 * Analyze forecast trend from historical data points.
 *
 * @param {Array} forecastHistory - Array of { daysOut, forecast } points
 * @param {number} trendThreshold - °F change required to classify as warming/cooling
 * @returns {Object} { direction, magnitude, volatility, momentum, convergence, points }
 */
export function analyzeTrend(forecastHistory, trendThreshold = 2) {
    if (!forecastHistory || forecastHistory.length < 2) {
        return { direction: 'neutral', magnitude: 0, volatility: 0, momentum: 0, convergence: 'unknown', points: forecastHistory || [] };
    }
    const sorted = [...forecastHistory].sort((a, b) => b.daysOut - a.daysOut);
    const totalDelta = sorted[sorted.length - 1].forecast - sorted[0].forecast;
    let direction = 'neutral';
    if (totalDelta >= trendThreshold) direction = 'warming';
    if (totalDelta <= -trendThreshold) direction = 'cooling';

    // Volatility: standard deviation of forecast deltas
    const deltas = [];
    for (let i = 1; i < sorted.length; i++) {
        deltas.push(sorted[i].forecast - sorted[i - 1].forecast);
    }
    const meanDelta = deltas.reduce((a, b) => a + b, 0) / deltas.length;
    const variance = deltas.reduce((sum, d) => sum + Math.pow(d - meanDelta, 2), 0) / deltas.length;
    const volatility = parseFloat(Math.sqrt(variance).toFixed(2));

    // Momentum: weighted average of recent deltas (last 3 weighted 3x more)
    let weightedSum = 0;
    let weightTotal = 0;
    for (let i = 0; i < deltas.length; i++) {
        const recency = i >= deltas.length - 3 ? 3 : 1;
        weightedSum += deltas[i] * recency;
        weightTotal += recency;
    }
    const momentum = parseFloat((weightTotal > 0 ? weightedSum / weightTotal : 0).toFixed(2));

    // Convergence: is the forecast stabilizing? (are recent deltas smaller?)
    let convergence = 'unknown';
    if (deltas.length >= 4) {
        const firstHalf = deltas.slice(0, Math.floor(deltas.length / 2)).map(Math.abs);
        const secondHalf = deltas.slice(Math.floor(deltas.length / 2)).map(Math.abs);
        const avgFirst = firstHalf.reduce((a, b) => a + b, 0) / firstHalf.length;
        const avgSecond = secondHalf.reduce((a, b) => a + b, 0) / secondHalf.length;
        convergence = avgSecond < avgFirst * 0.7 ? 'converging' : avgSecond > avgFirst * 1.3 ? 'diverging' : 'stable';
    }

    return { direction, magnitude: totalDelta, volatility, momentum, convergence, points: sorted };
}

// ── Resolve Logic ───────────────────────────────────────────────────────

/**
 * Determine which ranges to keep and which to sell at resolution.
 *
 * @param {Object} snapshot - Current snapshot with target/below/above
 * @returns {Object} { keep, keepLabel, keepPrice, discard, discardLabels, reason }
 */
export function resolveRanges(snapshot) {
    const candidates = [];
    if (snapshot.target) candidates.push({ label: 'target', range: snapshot.target });
    if (snapshot.below) candidates.push({ label: 'below', range: snapshot.below });
    if (snapshot.above) candidates.push({ label: 'above', range: snapshot.above });

    candidates.sort((a, b) => b.range.yesPrice - a.range.yesPrice);
    const keep = candidates[0];
    const discard = candidates.slice(1);

    return {
        keep: keep.range.question,
        keepLabel: keep.label,
        keepPrice: keep.range.yesPrice,
        discard: discard.map((d) => d.range.question),
        discardLabels: discard.map((d) => d.label),
        reason: `${keep.range.question} has highest YES price (${(keep.range.yesPrice * 100).toFixed(1)}¢)`,
    };
}

// ── Buy Decision ────────────────────────────────────────────────────────

/**
 * Determine whether a buy should be placed.
 *
 * @param {Object} session            - Current session state
 * @param {Object} snapshot           - Latest snapshot
 * @param {Object} config             - { buyHourEST, wsEnabled }
 * @returns {boolean|string|false}    - true = buy now, 'await-liquidity' = gate, false = skip
 */
export function shouldPlaceBuy(session, snapshot, config = {}) {
    if (session.buyOrder) return false;
    if (session.awaitingLiquidity) return false;
    if (snapshot.eventClosed) return false;
    if (snapshot.phase && snapshot.phase !== 'buy') return false;

    const nowET = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
    const nowDate = new Date(nowET);
    const currentHourDecimal = nowDate.getHours() + nowDate.getMinutes() / 60;
    if (currentHourDecimal < (config.buyHourEST || 9.5)) return false;

    if (config.wsEnabled) return 'await-liquidity';
    return true;
}

// ── P&L Computation ─────────────────────────────────────────────────────

/**
 * Compute P&L for a buy order against current snapshot.
 * Delegates to shared/pnl.js.
 */
export function computePnL(buyOrder, snapshot, liquidityBids) {
    return _computePnLCore(buyOrder, snapshot, liquidityBids);
}
