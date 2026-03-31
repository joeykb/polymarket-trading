/**
 * TempEdge Monitor — Service Client Layer
 *
 * Centralizes all microservice HTTP client construction and convenience wrappers.
 * Extracted from orchestrator.js so that persistence.js, sellFlow.js, and the
 * orchestrator all share the same client instances.
 *
 * Each service gets a persistent client via createClient() with consistent
 * timeouts and error handling.
 */

import { services } from '../../shared/services.js';
import { createClient } from '../../shared/httpClient.js';
import { createLogger } from '../../shared/logger.js';

const log = createLogger('monitor-svc');

// ── Service URLs ────────────────────────────────────────────────────────

const WEATHER_SVC = services.weatherSvc;
const MARKET_SVC = services.marketSvc;
const TRADING_SVC = services.tradingSvc;
const DATA_SVC = services.dataSvc;
const LIQUIDITY_SVC = services.liquiditySvc;

// ── Persistent Client Instances ─────────────────────────────────────────

const weatherClient = createClient(WEATHER_SVC);
const marketClient = createClient(MARKET_SVC);
const tradingClient = createClient(TRADING_SVC);
const dataClient = createClient(DATA_SVC);
const liquidityClient = createClient(LIQUIDITY_SVC);

function clientForBase(base) {
    if (base === WEATHER_SVC) return weatherClient;
    if (base === MARKET_SVC) return marketClient;
    if (base === TRADING_SVC) return tradingClient;
    if (base === DATA_SVC) return dataClient;
    if (base === LIQUIDITY_SVC) return liquidityClient;
    return createClient(base);
}

// ── Convenience Wrappers ────────────────────────────────────────────────

export async function svcGet(base, path) {
    const client = clientForBase(base);
    return client.get(path, { timeoutMs: 30000 });
}

export async function svcPost(base, path, body) {
    const client = clientForBase(base);
    return client.post(path, body, { timeoutMs: 60000 });
}

export async function svcPut(base, path, body) {
    const client = clientForBase(base);
    return client.put(path, body, { timeoutMs: 15000 });
}

/**
 * Fetch weather data with optional market context for multi-market support.
 * @param {string} targetDate
 * @param {Object} [marketCtx] - { lat, lon, unit, tz, station }
 */
export async function fetchWeatherData(targetDate, marketCtx = {}) {
    const params = new URLSearchParams({ date: targetDate });
    if (marketCtx.lat) params.set('lat', marketCtx.lat);
    if (marketCtx.lon) params.set('lon', marketCtx.lon);
    if (marketCtx.unit) params.set('unit', marketCtx.unit);
    if (marketCtx.tz) params.set('tz', marketCtx.tz);
    if (marketCtx.station) params.set('station', marketCtx.station);
    const qs = params.toString();

    const [forecast, current] = await Promise.all([
        svcGet(WEATHER_SVC, `/api/forecast?${qs}`),
        svcGet(WEATHER_SVC, `/api/current?${qs.replace(/date=[^&]+&?/, '')}`).catch(() => ({
            tempF: null, temp: null, maxSince7am: null, maxSince7amF: null, conditions: null,
        })),
    ]);
    return { forecast, current };
}

/**
 * Discover a Polymarket event for a given date and market.
 * @param {string} targetDate
 * @param {string} [marketId='nyc']
 */
export async function discoverMarket(targetDate, marketId = 'nyc') {
    return svcGet(MARKET_SVC, `/api/market?date=${targetDate}&market=${marketId}`);
}

/**
 * Select ranges based on forecast temperature for a given market.
 * @param {number} forecastTemp - Forecast high temp in the market's native unit
 * @param {Array} ranges
 * @param {string} targetDate
 * @param {string} [marketId='nyc']
 */
export async function selectRanges(forecastTemp, ranges, targetDate, marketId = 'nyc') {
    return svcGet(MARKET_SVC, `/api/ranges?date=${targetDate}&forecastF=${forecastTemp}&market=${marketId}`);
}

// ── Domain-Specific Service Calls ───────────────────────────────────────

export async function tryPlaceBuyOrder(snapshot, liqTokens = [], context = {}) {
    try {
        const result = await svcPost(TRADING_SVC, '/api/buy', { snapshot, liqTokens, context });
        if (!result || result.error) {
            log.warn('buy_order_failed', { error: result?.error || 'unknown' });
            return null;
        }
        if (result.allUnfilled) {
            log.warn('buy_order_unfilled', { action: 'treating_as_failed' });
            return null;
        }
        return result;
    } catch (err) {
        log.warn('buy_order_error', { error: err.message });
        return null;
    }
}

export async function executeSellOrder(positions, context = {}) {
    try {
        const result = await svcPost(TRADING_SVC, '/api/sell', { positions, context });
        if (!result || result.error) return null;
        return result;
    } catch (err) {
        log.warn('sell_order_error', { error: err.message });
        return null;
    }
}

export async function tryRedeemPositions(session) {
    try {
        const result = await svcPost(TRADING_SVC, '/api/redeem', { session });
        if (!result || result.error) return null;
        return result;
    } catch (err) {
        log.warn('redeem_error', { error: err.message });
        return null;
    }
}

export async function fetchLiquidityFromService(date, marketId) {
    try {
        const qs = marketId ? `date=${date}&market=${marketId}` : `date=${date}`;
        return await svcGet(LIQUIDITY_SVC, `/api/liquidity?${qs}`);
    } catch {
        return null; /* intentional: liquidity-svc may not be ready */
    }
}

/**
 * Fetch today's spend per market from data-svc.
 * @returns {Object} Map of marketId → totalSpent (e.g. { nyc: 2.5, london: 1.3 })
 */
export async function fetchDailySpend() {
    try {
        return await svcGet(DATA_SVC, '/api/spend');
    } catch {
        return {}; /* intentional: spend tracking is best-effort */
    }
}

// Re-export service URL constants for use by other modules
export { WEATHER_SVC, MARKET_SVC, TRADING_SVC, DATA_SVC, LIQUIDITY_SVC };

