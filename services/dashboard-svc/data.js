/**
 * TempEdge Dashboard — Data Loading (Microservice Edition)
 *
 * All data comes from data-svc and liquidity-svc HTTP APIs.
 * No direct filesystem or DB access.
 */

import { services } from '../../shared/services.js';
import { createSoftClient } from '../../shared/httpClient.js';

const DATA_SVC = services.dataSvc;
const LIQUIDITY_SVC = services.liquiditySvc;

// ── In-memory caches ────────────────────────────────────────────────────

const sessionCache = new Map(); // date → { data, fetchedAt }
const CACHE_TTL_MS = 5000; // 5s cache to avoid hammering data-svc

export let globalCurrentTemp = { tempF: null, conditions: null, maxTodayF: null, timestamp: '' };

// ── data-svc client (null-on-error via shared httpClient) ────────────

const dataSvcClient = createSoftClient(DATA_SVC);
const liquiditySvcClient = createSoftClient(LIQUIDITY_SVC);

async function svcGet(base, urlPath) {
    const client = base === LIQUIDITY_SVC ? liquiditySvcClient : dataSvcClient;
    return client.get(urlPath, { timeoutMs: 15000 });
}

export async function loadSessionData(date) {
    const now = Date.now();
    const cached = sessionCache.get(date);
    if (cached && now - cached.fetchedAt < CACHE_TTL_MS) return cached.data;

    try {
        const data = await svcGet(DATA_SVC, `/api/session-files/${date}?slim=20`);
        if (data) {
            sessionCache.set(date, { data, fetchedAt: now });
            // Update global current temp
            const snap = data.snapshots?.[data.snapshots.length - 1];
            if (snap && snap.timestamp > globalCurrentTemp.timestamp && snap.currentTempF != null) {
                globalCurrentTemp = {
                    tempF: snap.currentTempF,
                    conditions: snap.currentConditions,
                    maxTodayF: snap.maxTodayF,
                    timestamp: snap.timestamp,
                };
            }
            // Evict old cache entries
            if (sessionCache.size > 10) {
                const oldest = [...sessionCache.keys()].sort()[0];
                sessionCache.delete(oldest);
            }
        }
        return data;
    } catch {
        return null;
    }
}

export async function listAvailableDates() {
    const data = await svcGet(DATA_SVC, '/api/session-files');
    return data?.dates?.reverse() || [];
}

// ── Liquidity service ───────────────────────────────────────────────────

export async function fetchLiquidityData(date) {
    const result = { bids: {}, asks: {}, tokens: [], live: false };
    try {
        const data = await svcGet(LIQUIDITY_SVC, `/api/liquidity?date=${date}`);
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

export async function fetchLiquidityBids(date) {
    const { bids } = await fetchLiquidityData(date);
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
        const overrides = await svcGet(DATA_SVC, '/api/config/overrides');
        const merged = { ...(overrides || {}), ...updates };
        const res = await fetch(`${DATA_SVC}/api/config/overrides`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
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
        const res = await fetch(`${DATA_SVC}/api/config/overrides/${section}/${field}`, {
            method: 'DELETE',
            signal: AbortSignal.timeout(5000),
        });
        return res.ok;
    } catch {
        return false;
    }
}

export async function resetAllOverrides() {
    try {
        const res = await fetch(`${DATA_SVC}/api/config/overrides`, {
            method: 'DELETE',
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
