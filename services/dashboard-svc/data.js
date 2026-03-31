/**
 * TempEdge Dashboard — Data Loading (Microservice Edition)
 *
 * All data comes from data-svc and liquidity-svc HTTP APIs.
 * No direct filesystem or DB access.
 */

import { services } from '../../shared/services.js';
import { createSoftClient } from '../../shared/httpClient.js';
import { SERVICE_AUTH_HEADER } from '../../shared/serviceAuth.js';

const DATA_SVC = services.dataSvc;
const LIQUIDITY_SVC = services.liquiditySvc;
const SERVICE_AUTH_KEY = process.env.SERVICE_AUTH_KEY || '';

/** Headers for write operations (include service auth key if configured). */
function authHeaders() {
    const h = { 'Content-Type': 'application/json' };
    if (SERVICE_AUTH_KEY) h[SERVICE_AUTH_HEADER] = SERVICE_AUTH_KEY;
    return h;
}

// ── In-memory caches ────────────────────────────────────────────────────

const sessionCache = new Map(); // "marketId:date" → { data, fetchedAt }
const CACHE_TTL_MS = 5000;

export let globalCurrentTemp = { tempF: null, conditions: null, maxTodayF: null, timestamp: '' };

// ── data-svc client (null-on-error via shared httpClient) ────────────

const dataSvcClient = createSoftClient(DATA_SVC);
const liquiditySvcClient = createSoftClient(LIQUIDITY_SVC);

async function svcGet(base, urlPath) {
    const client = base === LIQUIDITY_SVC ? liquiditySvcClient : dataSvcClient;
    return client.get(urlPath, { timeoutMs: 15000 });
}

export async function loadSessionData(date, marketId = 'nyc') {
    const now = Date.now();
    const cacheKey = `${marketId}:${date}`;
    const cached = sessionCache.get(cacheKey);
    if (cached && now - cached.fetchedAt < CACHE_TTL_MS) return cached.data;

    try {
        const data = await svcGet(DATA_SVC, `/api/session-files/${date}?slim=20&market=${marketId}`);
        if (data) {
            sessionCache.set(cacheKey, { data, fetchedAt: now });
            // Update global current temp (only from NYC to avoid confusion)
            if (marketId === 'nyc') {
                const snap = data.snapshots?.[data.snapshots.length - 1];
                if (snap && snap.timestamp > globalCurrentTemp.timestamp && snap.currentTempF != null) {
                    globalCurrentTemp = {
                        tempF: snap.currentTempF,
                        conditions: snap.currentConditions,
                        maxTodayF: snap.maxTodayF,
                        timestamp: snap.timestamp,
                    };
                }
            }
            // Evict old cache entries
            if (sessionCache.size > 30) {
                const oldest = [...sessionCache.keys()].sort()[0];
                sessionCache.delete(oldest);
            }
        }
        return data;
    } catch {
        return null;
    }
}

export async function listAvailableDates(marketId) {
    const qs = marketId ? `?market=${marketId}&format=full` : '?format=full';
    const data = await svcGet(DATA_SVC, `/api/session-files${qs}`);
    if (!data) return [];
    // New format returns { sessions: [{ marketId, date }] }
    if (data.sessions) return data.sessions;
    // Legacy format
    if (data.dates) return data.dates.reverse().map(d => ({ marketId: 'nyc', date: d }));
    return [];
}

// ── Market registry ─────────────────────────────────────────────────────

let _marketsCache = null;
let _marketsCacheAt = 0;
const MARKETS_CACHE_TTL = 60000; // 1 minute

export async function fetchMarkets() {
    const now = Date.now();
    if (_marketsCache && now - _marketsCacheAt < MARKETS_CACHE_TTL) return _marketsCache;
    const data = await svcGet(DATA_SVC, '/api/markets');
    if (data && Array.isArray(data)) {
        _marketsCache = data;
        _marketsCacheAt = now;
    }
    return _marketsCache || [];
}

/** Bust the markets cache (called after admin toggles active/inactive). */
export function invalidateMarketsCache() {
    _marketsCache = null;
    _marketsCacheAt = 0;
}

export async function fetchSpendData() {
    return (await svcGet(DATA_SVC, '/api/spend')) || {};
}

// ── Liquidity service ───────────────────────────────────────────────────

export async function fetchLiquidityData(date, marketId) {
    const result = { bids: {}, asks: {}, tokens: [], live: false };
    try {
        const qs = marketId ? `date=${date}&market=${marketId}` : `date=${date}`;
        const data = await svcGet(LIQUIDITY_SVC, `/api/liquidity?${qs}`);
        if (data?.tokens) {
            result.tokens = data.tokens;
            for (const t of result.tokens) {
                if (t.question) {
                    if (t.bestBid > 0) result.bids[t.question] = t.bestBid;
                    if (t.bestAsk > 0) result.asks[t.question] = t.bestAsk;
                }
            }
            result.live = result.tokens.length > 0;
        }
    } catch {
        /* intentional: liquidity-svc may be unavailable */
    }
    return result;
}

export async function fetchLiquidityBids(date, marketId) {
    const { bids } = await fetchLiquidityData(date, marketId);
    return bids;
}

// ── DB proxy reads (via data-svc) ───────────────────────────────────────

export async function getTradesFromDb() {
    const data = await svcGet(DATA_SVC, '/api/trades?limit=100');
    return data || [];
}

export async function getPositionsForTrade(tradeId) {
    const data = await svcGet(DATA_SVC, `/api/positions?tradeId=${tradeId}`);
    return data || [];
}

export async function getAnalytics() {
    return (await svcGet(DATA_SVC, '/api/analytics')) || { pnlByDate: [], totals: {} };
}

export async function getConfigSnapshot() {
    return (await svcGet(DATA_SVC, '/api/config')) || {};
}

export async function updateConfig(updates) {
    try {
        const overrides = (await svcGet(DATA_SVC, '/api/config/overrides')) || {};
        // Deep merge at section level: merge each section's fields individually
        // so updating trading.maxSpreadPct doesn't wipe out trading.mode
        const merged = { ...overrides };
        for (const [section, fields] of Object.entries(updates)) {
            merged[section] = { ...(merged[section] || {}), ...fields };
        }
        const res = await fetch(`${DATA_SVC}/api/config/overrides`, {
            method: 'PUT',
            headers: authHeaders(),
            body: JSON.stringify(merged),
            signal: AbortSignal.timeout(5000),
        });
        return res.ok ? await res.json() : { error: 'Update failed' };
    } catch (err) {
        return { error: err.message };
    }
}

export async function resetConfigValue(section, field) {
    try {
        const headers = {};
        if (SERVICE_AUTH_KEY) headers[SERVICE_AUTH_HEADER] = SERVICE_AUTH_KEY;
        const res = await fetch(`${DATA_SVC}/api/config/overrides/${section}/${field}`, {
            method: 'DELETE',
            headers,
            signal: AbortSignal.timeout(5000),
        });
        return res.ok;
    } catch {
        return false;
    }
}

export async function resetAllOverrides() {
    try {
        const headers = {};
        if (SERVICE_AUTH_KEY) headers[SERVICE_AUTH_HEADER] = SERVICE_AUTH_KEY;
        const res = await fetch(`${DATA_SVC}/api/config/overrides`, {
            method: 'DELETE',
            headers,
            signal: AbortSignal.timeout(5000),
        });
        return res.ok;
    } catch {
        return false;
    }
}

export async function signalRestart() {
    try {
        const res = await fetch(`${DATA_SVC}/api/restart-signal`, {
            method: 'POST',
            signal: AbortSignal.timeout(5000),
        });
        return res.ok;
    } catch {
        return false;
    }
}
