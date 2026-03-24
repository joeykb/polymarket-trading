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

// ── Edge Computation & Confidence Sizing ─────────────────────────────────

/**
 * Compute forecast confidence and expected value for buy decision.
 *
 * Confidence is built from 5 independent signals:
 *   1. Trend convergence (+0.12 converging, -0.12 diverging)
 *   2. Volatility (low = +0.08, high = -0.08)
 *   3. Days to target (closer = higher confidence)
 *   4. Trend consistency (warming/cooling = +0.05, neutral = 0)
 *   5. Data points (more history = more reliable)
 *
 * Expected value: EV = (confidence × $1.00) - targetCost
 *
 * Position sizing tiers based on confidence:
 *   high   (≥0.55): target only — max ROI, forecast is strong
 *   medium (0.40-0.55): target + cheapest adjacent hedge
 *   low    (<0.40): target + both hedges — max coverage
 *
 * @param {Object} snapshot - Current snapshot with target/below/above ranges
 * @param {Object} trend    - Result from analyzeTrend()
 * @param {Object} config   - { evThreshold }
 * @returns {{ ev, confidence, tier, action, reason, rangesToBuy }}
 */
export function computeEdge(snapshot, trend, config = {}) {
    const evThreshold = config.evThreshold ?? 0.05;

    const result = {
        ev: 0,
        confidence: 0,
        tier: 'low',
        action: 'skip',
        reason: '',
        rangesToBuy: ['target', 'below', 'above'], // default: all 3
    };

    if (!snapshot?.target) {
        result.reason = 'No target range in snapshot';
        return result;
    }

    const daysOut = snapshot.daysUntilTarget ?? 2;
    const targetCost = snapshot.target.yesPrice ?? 0;

    if (targetCost <= 0 || targetCost >= 0.95) {
        result.reason = `Target price $${targetCost.toFixed(2)} is out of tradeable range`;
        return result;
    }

    // ── Build confidence from independent signals ────────────────────

    let confidence = 0.45; // base — slightly below coin-flip

    // Signal 1: Trend convergence (is forecast stabilizing?)
    if (trend?.convergence === 'converging') confidence += 0.12;
    else if (trend?.convergence === 'diverging') confidence -= 0.12;
    // 'stable' or 'unknown' = no adjustment

    // Signal 2: Volatility (low forecast jitter = more predictable)
    if (trend?.volatility != null) {
        if (trend.volatility < 1.0) confidence += 0.08;
        else if (trend.volatility < 2.0) confidence += 0.03;
        else if (trend.volatility > 3.0) confidence -= 0.08;
        else if (trend.volatility > 2.0) confidence -= 0.04;
    }

    // Signal 3: Days to target (closer = more accurate forecasts)
    if (daysOut <= 1) confidence += 0.12;
    else if (daysOut === 2) confidence += 0.05;
    else if (daysOut >= 4) confidence -= 0.1;
    else if (daysOut >= 3) confidence -= 0.05;

    // Signal 4: Trend direction consistency (clear signal vs. neutral)
    if (trend?.direction === 'warming' || trend?.direction === 'cooling') {
        confidence += 0.05; // clear directional signal is informative
    }

    // Signal 5: Data points — more forecast history = more reliable trend
    const pointCount = trend?.points?.length ?? 0;
    if (pointCount >= 5) confidence += 0.05;
    else if (pointCount <= 1) confidence -= 0.05;

    // Clamp to sensible range
    confidence = Math.max(0.15, Math.min(0.85, confidence));
    result.confidence = parseFloat(confidence.toFixed(2));

    // ── Expected value ──────────────────────────────────────────────

    const ev = confidence * 1.0 - targetCost;
    result.ev = parseFloat(ev.toFixed(4));

    // ── Position sizing tier ────────────────────────────────────────

    if (confidence >= 0.55) {
        result.tier = 'high';
        result.rangesToBuy = ['target']; // target only — max ROI
    } else if (confidence >= 0.4) {
        result.tier = 'medium';
        // Pick target + the cheaper adjacent hedge
        const belowCost = snapshot.below?.yesPrice ?? Infinity;
        const aboveCost = snapshot.above?.yesPrice ?? Infinity;
        if (belowCost <= aboveCost && snapshot.below) {
            result.rangesToBuy = ['target', 'below'];
        } else if (snapshot.above) {
            result.rangesToBuy = ['target', 'above'];
        } else {
            result.rangesToBuy = ['target'];
        }
    } else {
        result.tier = 'low';
        result.rangesToBuy = ['target', 'below', 'above']; // full coverage
    }

    // ── Action decision ─────────────────────────────────────────────

    if (ev > evThreshold) {
        result.action = 'buy';
        result.reason = `EV $${ev.toFixed(3)} at ${(confidence * 100).toFixed(0)}% confidence (tier: ${result.tier})`;
    } else {
        result.action = 'skip';
        result.reason = `EV $${ev.toFixed(3)} below $${evThreshold.toFixed(2)} threshold (${(confidence * 100).toFixed(0)}% confidence)`;
    }

    return result;
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

// ── Stop-Loss Guardrails ────────────────────────────────────────────────

/**
 * Check if current P&L breaches stop-loss thresholds.
 *
 * Two independent triggers (either one fires the stop-loss):
 *   1. Percentage: totalPnL / totalCost <= -stopLossPct%
 *   2. Absolute floor: totalPnL <= stopLossFloor
 *
 * @param {Object} session - Session with buyOrder and pnl
 * @param {Object} snapshot - Current snapshot
 * @param {Object} config - { stopLossEnabled, stopLossPct, stopLossFloor }
 * @returns {{ triggered: boolean, reason: string|null, pnlPct: number, totalPnL: number }}
 */
export function checkStopLoss(session, snapshot, config = {}) {
    const result = { triggered: false, reason: null, pnlPct: 0, totalPnL: 0 };

    // Guard: disabled, no positions, already sold/completed, or resolve phase
    if (!config.stopLossEnabled) return result;
    if (!session.buyOrder || !session.pnl) return result;
    if (session.stopLossExecuted) return result;
    if (session.status === 'completed') return result;
    if (snapshot.phase === 'resolve') return result; // Don't stop-loss on settle day

    const totalCost = session.buyOrder.totalCost || 0;
    const totalPnL = session.pnl.totalPnL ?? 0;
    result.totalPnL = totalPnL;

    if (totalCost <= 0) return result;

    const pnlPct = (totalPnL / totalCost) * 100;
    result.pnlPct = parseFloat(pnlPct.toFixed(1));

    // Check percentage threshold (e.g., -50%)
    const pctThreshold = -(config.stopLossPct || 50);
    if (pnlPct <= pctThreshold) {
        result.triggered = true;
        result.reason = `P&L ${result.pnlPct}% breached -${config.stopLossPct || 50}% stop-loss threshold`;
        return result;
    }

    // Check absolute floor (e.g., -$1.50)
    const floor = config.stopLossFloor ?? -1.5;
    if (totalPnL <= floor) {
        result.triggered = true;
        result.reason = `P&L $${totalPnL.toFixed(2)} breached $${floor.toFixed(2)} stop-loss floor`;
        return result;
    }

    return result;
}
