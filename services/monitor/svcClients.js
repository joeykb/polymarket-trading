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

// ── Domain-Specific Service Calls ───────────────────────────────────────

export async function fetchWeatherData(targetDate) {
    const [forecast, current] = await Promise.all([
        svcGet(WEATHER_SVC, `/api/forecast?date=${targetDate}`),
        svcGet(WEATHER_SVC, `/api/current`).catch(() => ({ tempF: null, maxSince7amF: null, conditions: null })),
    ]);
    return { forecast, current };
}

export async function discoverMarket(targetDate) {
    return svcGet(MARKET_SVC, `/api/market?date=${targetDate}`);
}

export async function selectRanges(forecastTempF, ranges, targetDate) {
    return svcGet(MARKET_SVC, `/api/ranges?date=${targetDate}&forecastF=${forecastTempF}`);
}

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

export async function fetchLiquidityFromService(date) {
    try {
        return await svcGet(LIQUIDITY_SVC, `/api/liquidity?date=${date}`);
    } catch {
        return null; /* intentional: liquidity-svc may not be ready */
    }
}

// Re-export service URL constants for use by other modules
export { WEATHER_SVC, MARKET_SVC, TRADING_SVC, DATA_SVC, LIQUIDITY_SVC };
