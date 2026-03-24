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

// ── Forecast Trajectory Analysis ─────────────────────────────────────────

/**
 * Analyze the T+4 → T+3 → T+2 forecast trajectory for a single target date.
 *
 * Unlike analyzeTrend (which looks at raw forecast deltas), this function
 * extracts *structural* signals from the multi-day forecast path:
 *
 *   1. Range Stability — did the forecast stay in the same 2°F range?
 *   2. Acceleration     — is the drift speeding up or slowing down?
 *   3. Drift Magnitude  — how far has the forecast moved overall?
 *
 * These are independent signals that feed into computeEdge() confidence.
 *
 * @param {Array} forecastHistory - Array of { daysOut, forecast } points (from session)
 * @param {number} rangeWidth     - Width of Polymarket temperature ranges (default 2°F)
 * @returns {{ rangeStability, acceleration, driftMagnitude, driftDirection, rangesCrossed, pointCount }}
 */
export function analyzeTrajectory(forecastHistory, rangeWidth = 2) {
    const result = {
        rangeStability: 'unknown', // 'stable' | 'minor-drift' | 'volatile'
        acceleration: 0, // positive = speeding up, negative = settling
        driftMagnitude: 0, // total °F from first to last
        driftDirection: 'flat', // 'warming' | 'cooling' | 'flat'
        rangesCrossed: 0, // how many 2°F boundaries were crossed
        pointCount: 0,
    };

    if (!forecastHistory || forecastHistory.length < 2) {
        return result;
    }

    // Sort by daysOut descending (T+4 first, T+2 last = chronological order)
    const sorted = [...forecastHistory].sort((a, b) => b.daysOut - a.daysOut);
    result.pointCount = sorted.length;

    // ── Drift Magnitude & Direction ─────────────────────────────────
    const earliest = sorted[0].forecast;
    const latest = sorted[sorted.length - 1].forecast;
    result.driftMagnitude = parseFloat(Math.abs(latest - earliest).toFixed(1));
    if (latest - earliest >= 1.0) result.driftDirection = 'warming';
    else if (latest - earliest <= -1.0) result.driftDirection = 'cooling';
    else result.driftDirection = 'flat';

    // ── Range Stability ─────────────────────────────────────────────
    // Calculate which 2°F range each forecast falls into (e.g., 66-67 = range 33)
    const ranges = sorted.map((p) => Math.floor(p.forecast / rangeWidth));
    const uniqueRanges = new Set(ranges);
    result.rangesCrossed = uniqueRanges.size - 1; // 0 = stayed in same range

    if (result.rangesCrossed === 0) {
        result.rangeStability = 'stable'; // Forecast never left the range
    } else if (result.rangesCrossed === 1) {
        result.rangeStability = 'minor-drift'; // Crossed one boundary (normal)
    } else {
        result.rangeStability = 'volatile'; // Crossed 2+ ranges (red flag)
    }

    // ── Acceleration (second derivative) ────────────────────────────
    // Build per-step deltas, then compute how deltas are changing
    if (sorted.length >= 3) {
        const deltas = [];
        for (let i = 1; i < sorted.length; i++) {
            deltas.push(sorted[i].forecast - sorted[i - 1].forecast);
        }
        // Acceleration = change in absolute delta over time
        // If |delta[n]| < |delta[n-1]|, forecast is decelerating (settling)
        const absDeltas = deltas.map(Math.abs);
        let accelSum = 0;
        for (let i = 1; i < absDeltas.length; i++) {
            accelSum += absDeltas[i] - absDeltas[i - 1];
        }
        result.acceleration = parseFloat((accelSum / (absDeltas.length - 1)).toFixed(2));
        // Negative acceleration = decelerating = good (forecast is settling)
        // Positive acceleration = speeding up = bad (forecast is unstable)
    }

    return result;
}

// ── Edge Computation & Confidence Sizing ─────────────────────────────────

/**
 * Compute forecast confidence and expected value for buy decision.
 *
 * Confidence is built from 8 independent signals:
 *   1. Trend convergence (+0.12 converging, -0.12 diverging)
 *   2. Volatility (low = +0.08, high = -0.08)
 *   3. Days to target (closer = higher confidence)
 *   4. Trend consistency (warming/cooling = +0.05, neutral = 0)
 *   5. Data points (more history = more reliable)
 *   6. Range stability — T+4→T+2 stayed in same range (+0.15 stable, -0.10 volatile)
 *   7. Forecast acceleration — settling (+0.06) vs. speeding up (-0.06)
 *   8. Drift magnitude — small drift = reliable, large drift = unreliable
 *
 * Expected value: EV = (confidence × $1.00) - targetCost
 *
 * Position sizing tiers based on confidence:
 *   high   (≥0.55): target only — max ROI, forecast is strong
 *   medium (0.40-0.55): target + cheapest adjacent hedge
 *   low    (<0.40): target + both hedges — max coverage
 *
 * @param {Object} snapshot    - Current snapshot with target/below/above ranges
 * @param {Object} trend       - Result from analyzeTrend()
 * @param {Object} config      - { evThreshold }
 * @param {Object} [trajectory] - Result from analyzeTrajectory() (optional, enhances accuracy)
 * @returns {{ ev, confidence, tier, action, reason, rangesToBuy, trajectory }}
 */
export function computeEdge(snapshot, trend, config = {}, trajectory = null) {
    const evThreshold = config.evThreshold ?? 0.05;

    const result = {
        ev: 0,
        confidence: 0,
        tier: 'low',
        action: 'skip',
        reason: '',
        rangesToBuy: ['target', 'below', 'above'], // default: all 3
        trajectory: trajectory || null,
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

    // Hard cap: never buy a target priced above $0.40 — risk:reward is terrible
    const maxEntryPrice = config.maxEntryPrice ?? 0.40;
    if (targetCost > maxEntryPrice) {
        result.reason = `Target price $${targetCost.toFixed(2)} exceeds $${maxEntryPrice.toFixed(2)} max entry cap`;
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
    else if (daysOut === 2) confidence += 0.08;
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

    // ── Trajectory-based signals (T+4 → T+3 → T+2 path) ────────────

    if (trajectory && trajectory.pointCount >= 2) {
        // Signal 6: Range Stability — strongest single signal
        // If forecast stayed in the same 2°F range from T+4 to T+2,
        // the market is highly likely to settle there.
        if (trajectory.rangeStability === 'stable') {
            confidence += 0.15; // forecast never left the range — very strong
        } else if (trajectory.rangeStability === 'minor-drift') {
            confidence += 0.03; // crossed one boundary — normal, slight boost
        } else if (trajectory.rangeStability === 'volatile') {
            confidence -= 0.1; // crossed 2+ ranges — forecast is unreliable
        }

        // Signal 7: Forecast Acceleration (second derivative)
        // Negative = decelerating (settling down) = good
        // Positive = accelerating (getting less stable) = bad
        if (trajectory.acceleration < -0.5) {
            confidence += 0.06; // forecast is clearly settling
        } else if (trajectory.acceleration > 0.5) {
            confidence -= 0.06; // forecast is speeding up — unstable
        }

        // Signal 8: Drift Magnitude
        // Small total movement from first observation = reliable forecast
        if (trajectory.driftMagnitude < 1.0) {
            confidence += 0.04; // barely moved — very consistent
        } else if (trajectory.driftMagnitude > 4.0) {
            confidence -= 0.06; // moved 4+°F — forecast was way off initially
        } else if (trajectory.driftMagnitude > 2.0) {
            confidence -= 0.02; // moderate drift
        }
    }

    // Clamp to sensible range
    confidence = Math.max(0.15, Math.min(0.85, confidence));
    result.confidence = parseFloat(confidence.toFixed(2));

    // ── Position sizing tier (determines capital deployment) ─────────
    //
    // Tier is determined BEFORE EV so we can include hedge costs in the
    // expected-value calculation. This is critical: the old formula used
    // only targetCost, but medium-tier deploys target + hedge.

    const maxHedgeCost = config.maxHedgeCost ?? 0.10;

    if (confidence >= 0.50) {
        result.tier = 'high';
        result.rangesToBuy = ['target']; // target only — max ROI
    } else if (confidence >= 0.40) {
        result.tier = 'medium';
        // Only add a hedge if it's truly cheap (≤ $0.10 = lottery ticket)
        const belowCost = snapshot.below?.yesPrice ?? Infinity;
        const aboveCost = snapshot.above?.yesPrice ?? Infinity;
        const cheaperHedge = belowCost <= aboveCost ? 'below' : 'above';
        const cheaperCost = Math.min(belowCost, aboveCost);
        if (cheaperCost <= maxHedgeCost && snapshot[cheaperHedge]) {
            result.rangesToBuy = ['target', cheaperHedge];
        } else {
            result.rangesToBuy = ['target']; // hedge too expensive, skip it
        }
    } else {
        // Low confidence = SKIP entirely. Buying all 3 adjacent ranges
        // sums to ~$0.85-$0.96, guaranteeing near-zero profit.
        result.tier = 'low';
        result.action = 'skip';
        result.reason = `Confidence ${(confidence * 100).toFixed(0)}% below 40% minimum — skipping`;
        return result;
    }

    // ── Expected value (uses TOTAL deployed capital) ─────────────────
    //
    // EV = (confidence × payout) − totalCostOfAllRangesBeingBought
    // Previously this only subtracted targetCost, which hid the true
    // cost of medium-tier trades that include a hedge.

    let totalDeployedCost = targetCost;
    for (const label of result.rangesToBuy) {
        if (label === 'target') continue; // already counted
        totalDeployedCost += snapshot[label]?.yesPrice ?? 0;
    }

    const ev = confidence * 1.0 - totalDeployedCost;
    result.ev = parseFloat(ev.toFixed(4));
    result.totalDeployedCost = parseFloat(totalDeployedCost.toFixed(4));

    // ── Action decision ─────────────────────────────────────────────

    if (ev > evThreshold) {
        result.action = 'buy';
        result.reason = `EV $${ev.toFixed(3)} on $${totalDeployedCost.toFixed(2)} deployed at ${(confidence * 100).toFixed(0)}% confidence (tier: ${result.tier})`;
    } else {
        result.action = 'skip';
        result.reason = `EV $${ev.toFixed(3)} below $${evThreshold.toFixed(2)} threshold ($${totalDeployedCost.toFixed(2)} deployed, ${(confidence * 100).toFixed(0)}% confidence)`;
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
