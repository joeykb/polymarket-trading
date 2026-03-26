/**
 * TempEdge Monitor — Snapshot Construction
 *
 * Builds a market snapshot by fetching weather + market data from
 * their respective microservices, then computing deltas from the
 * previous snapshot.
 *
 * Extracted from orchestrator.js for testability and readability.
 */

import { nowISO, daysUntil, getPhase } from '../../shared/dates.js';

// ── Range Builder ───────────────────────────────────────────────────────

export function buildSnapshotRange(range, previous) {
    const priceChange = previous ? parseFloat((range.yesPrice - previous.yesPrice).toFixed(4)) : 0;

    return {
        marketId: range.marketId,
        conditionId: range.conditionId,
        clobTokenIds: range.clobTokenIds,
        question: range.question,
        yesPrice: range.yesPrice,
        noPrice: range.noPrice || 0,
        bestBid: range.bestBid || 0,
        bestAsk: range.bestAsk || 0,
        priceChange,
        impliedProbability: range.impliedProbability,
        volume: range.volume,
    };
}

// ── Full Snapshot ────────────────────────────────────────────────────────

/**
 * Take a full market snapshot by calling weather-svc and market-svc.
 *
 * @param {string} targetDate       - ISO date string (e.g. '2026-03-25')
 * @param {Object|null} previous    - Previous snapshot for delta computation
 * @param {Object} svcFns           - Service fetch functions injected from orchestrator
 * @param {Function} svcFns.fetchWeatherData   - (date) => { forecast, current }
 * @param {Function} svcFns.discoverMarket     - (date) => event
 * @param {Function} svcFns.selectRanges       - (forecastF, ranges, date) => selection
 * @returns {Object} snapshot
 */
export async function takeSnapshot(targetDate, previous, { fetchWeatherData, discoverMarket, selectRanges }) {
    const days = daysUntil(targetDate);

    // For past dates, weather APIs won't have forecast data — use last known values
    let weatherData, event;
    if (days < 0 && previous) {
        const [weatherResult, eventResult] = await Promise.allSettled([
            fetchWeatherData(targetDate),
            discoverMarket(targetDate),
        ]);
        event = eventResult.status === 'fulfilled' ? eventResult.value : null;
        if (!event) throw new Error(`Market discovery failed for past date ${targetDate}`);
        weatherData = weatherResult.status === 'fulfilled'
            ? weatherResult.value
            : {
                  forecast: { highTempF: previous.forecastTempF, source: previous.forecastSource || 'cached' },
                  current: { tempF: previous.currentTempF, maxSince7amF: previous.maxTodayF, conditions: previous.currentConditions },
              };
    } else {
        [weatherData, event] = await Promise.all([fetchWeatherData(targetDate), discoverMarket(targetDate)]);
    }

    const { forecast, current } = weatherData;
    const selection = await selectRanges(forecast.highTempF, event.ranges, targetDate);

    const forecastChange = previous ? parseFloat((forecast.highTempF - previous.forecastTempF).toFixed(1)) : 0;
    const rangeShifted = previous ? selection.target.question !== previous.target.question : false;
    const shiftedFrom = rangeShifted ? previous.target.question : null;

    const phase = getPhase(targetDate);

    return {
        timestamp: nowISO(),
        forecastTempF: forecast.highTempF,
        forecastSource: forecast.source,
        forecastChange,
        currentTempF: current.tempF,
        maxTodayF: current.maxSince7amF,
        currentConditions: current.conditions,
        phase,
        daysUntilTarget: days,
        target: buildSnapshotRange(selection.target, previous?.target ?? null),
        below: selection.below ? buildSnapshotRange(selection.below, previous?.below ?? null) : null,
        above: selection.above ? buildSnapshotRange(selection.above, previous?.above ?? null) : null,
        totalCost: selection.totalCost,
        rangeShifted,
        shiftedFrom,
        allRanges: event.ranges.map((r) => ({
            marketId: r.marketId,
            question: r.question,
            clobTokenIds: r.clobTokenIds || [],
            yesPrice: r.yesPrice,
            impliedProbability: r.impliedProbability,
            volume: r.volume,
        })),
        eventActive: event.active,
        eventClosed: event.closed,
    };
}
