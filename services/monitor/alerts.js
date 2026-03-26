/**
 * TempEdge Monitor — Alert Detection
 *
 * Pure function: detects alerts by comparing the current snapshot
 * against the previous one and session context. No I/O.
 *
 * Extracted from orchestrator.js for testability.
 */

import { nowISO } from '../../shared/dates.js';

/**
 * Detect alerts by comparing current vs previous snapshot.
 *
 * @param {Object} current        - Current snapshot
 * @param {Object|null} previous  - Previous snapshot (null on first cycle)
 * @param {Object} session        - Session state
 * @param {Object} config         - Monitor config thresholds
 * @returns {Array} Array of alert objects
 */
export function detectAlerts(current, previous, session, config) {
    const alerts = [];
    const now = nowISO();
    const initialForecast = session.initialForecastTempF;
    const cfg = config || {};

    if (current.eventClosed) {
        alerts.push({ timestamp: now, type: 'market_closed', message: 'Market has been closed/resolved.', data: {} });
    }

    if (previous && current.phase !== previous.phase) {
        alerts.push({
            timestamp: now,
            type: 'phase_change',
            message: `Phase changed: ${previous.phase} → ${current.phase}`,
            data: { from: previous.phase, to: current.phase, daysUntil: current.daysUntilTarget },
        });
    }

    if (!previous) return alerts;

    const totalShift = Math.abs(current.forecastTempF - initialForecast);
    if (totalShift >= (cfg.forecastShiftThreshold || 2)) {
        const delta = parseFloat((current.forecastTempF - initialForecast).toFixed(1));
        const isDrastic = totalShift >= (cfg.rebalanceThreshold || 3);
        alerts.push({
            timestamp: now,
            type: 'forecast_shift',
            message: `Forecast shifted ${delta > 0 ? '+' : ''}${delta}°F from initial (${initialForecast}°F → ${current.forecastTempF}°F)${isDrastic ? ' ⚠️ DRASTIC' : ''}`,
            data: { initialForecast, currentForecast: current.forecastTempF, delta, isDrastic },
        });
    }

    if (current.rangeShifted) {
        alerts.push({
            timestamp: now,
            type: 'range_shift',
            message: `Target range shifted: "${current.shiftedFrom}" → "${current.target.question}"`,
            data: { from: current.shiftedFrom, to: current.target.question, newForecast: current.forecastTempF },
        });
    }

    for (const { label, range } of [
        { label: 'target', range: current.target },
        { label: 'below', range: current.below },
        { label: 'above', range: current.above },
    ]) {
        if (range && Math.abs(range.priceChange) >= (cfg.priceSpikeThreshold || 0.05)) {
            alerts.push({
                timestamp: now,
                type: 'price_spike',
                message: `${range.priceChange > 0 ? '📈' : '📉'} ${label.toUpperCase()} price ${(range.priceChange * 100).toFixed(1)}¢`,
                data: { label, question: range.question, priceChange: range.priceChange, currentPrice: range.yesPrice },
            });
        }
    }

    return alerts;
}
