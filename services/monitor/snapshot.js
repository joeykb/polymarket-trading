/**
 * TempEdge Monitor — Snapshot Construction
 *
 * Builds a market snapshot by fetching weather + market data from
 * their respective microservices, then computing deltas from the
 * previous snapshot.
 *
 * Extracted from orchestrator.js for testability and readability.
 */

import { nowISO, daysUntil, getPhase, daysUntilInTz, getPhaseInTz } from '../../shared/dates.js';

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
 * @param {Object} [opts]           - Multi-market options
 * @param {Object} [opts.marketCtx] - { lat, lon, unit, tz, station } for weather-svc
 * @param {string} [opts.marketId]  - Market ID for market-svc (e.g. 'london')
 * @returns {Object} snapshot
 */
export async function takeSnapshot(targetDate, previous, { fetchWeatherData, discoverMarket, selectRanges }, opts = {}) {
    const { marketCtx = {}, marketId = 'nyc' } = opts;
    const tz = marketCtx.tz || 'America/New_York';
    const days = tz !== 'America/New_York' ? daysUntilInTz(targetDate, tz) : daysUntil(targetDate);

    // For past dates, weather APIs won't have forecast data — use last known values
    let weatherData, event;
    if (days < 0 && previous) {
        const [weatherResult, eventResult] = await Promise.allSettled([
            fetchWeatherData(targetDate, marketCtx),
            discoverMarket(targetDate, marketId),
        ]);
        event = eventResult.status === 'fulfilled' ? eventResult.value : null;
        if (!event) throw new Error(`Market discovery failed for past date ${targetDate}`);
        const highTempKey = marketCtx.unit === 'C' ? 'highTemp' : 'highTempF';
        weatherData = weatherResult.status === 'fulfilled'
            ? weatherResult.value
            : {
                  forecast: { highTempF: previous.forecastTempF, highTemp: previous.forecastTempF, source: previous.forecastSource || 'cached' },
                  current: { tempF: previous.currentTempF, temp: previous.currentTempF, maxSince7am: previous.maxTodayF, maxSince7amF: previous.maxTodayF, conditions: previous.currentConditions },
              };
    } else {
        [weatherData, event] = await Promise.all([fetchWeatherData(targetDate, marketCtx), discoverMarket(targetDate, marketId)]);
    }

    const { forecast, current } = weatherData;
    // Use highTemp (multi-market) or highTempF (legacy) for forecast value
    const forecastTemp = forecast.highTemp ?? forecast.highTempF;
    const selection = await selectRanges(forecastTemp, event.ranges, targetDate, marketId);

    const forecastChange = previous ? parseFloat((forecastTemp - previous.forecastTempF).toFixed(1)) : 0;
    const rangeShifted = previous ? selection.target.question !== previous.target.question : false;
    const shiftedFrom = rangeShifted ? previous.target.question : null;

    const phase = tz !== 'America/New_York' ? getPhaseInTz(targetDate, tz) : getPhase(targetDate);

    return {
        timestamp: nowISO(),
        forecastTempF: forecastTemp,  // Always store as forecastTempF for backwards compat
        forecastSource: forecast.source,
        forecastChange,
        currentTempF: current.temp ?? current.tempF,
        maxTodayF: current.maxSince7am ?? current.maxSince7amF,
        currentConditions: current.conditions,
        unit: forecast.unit || 'F',
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
