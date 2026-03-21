/**
 * TempEdge Dashboard — Data Loading & Caching
 *
 * Extracted from the monolithic dashboard.js.
 * Handles session/observation JSON file I/O with mtime-based caching,
 * and liquidity microservice communication.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const OUTPUT_DIR = path.resolve(__dirname, '../../output');

// ── Mtime-based caches ──────────────────────────────────────────────────

const sessionCache = new Map();     // date → { data, mtimeMs }
const observationCache = new Map(); // date → { data, mtimeMs }

/** Global current-temp cache — updated whenever any session is loaded */
export let globalCurrentTemp = { tempF: null, conditions: null, maxTodayF: null, timestamp: '' };

export function loadSessionData(date) {
    const sessionPath = path.join(OUTPUT_DIR, `monitor-${date}.json`);
    try {
        const stat = fs.statSync(sessionPath);
        const cached = sessionCache.get(date);
        if (cached && cached.mtimeMs === stat.mtimeMs) return cached.data;

        const data = JSON.parse(fs.readFileSync(sessionPath, 'utf-8'));
        sessionCache.set(date, { data, mtimeMs: stat.mtimeMs });

        // Update global current temp if this session's latest snapshot is newer
        const snap = data.snapshots?.[data.snapshots.length - 1];
        if (snap && snap.timestamp > globalCurrentTemp.timestamp && snap.currentTempF != null) {
            globalCurrentTemp = {
                tempF: snap.currentTempF,
                conditions: snap.currentConditions,
                maxTodayF: snap.maxTodayF,
                timestamp: snap.timestamp,
            };
        }

        // Evict old cache entries (keep max 10)
        if (sessionCache.size > 10) {
            const oldest = [...sessionCache.keys()].sort()[0];
            sessionCache.delete(oldest);
        }

        return data;
    } catch {
        return null;
    }
}

export function loadObservationData(date) {
    const obsPath = path.join(OUTPUT_DIR, `${date}.json`);
    try {
        const stat = fs.statSync(obsPath);
        const cached = observationCache.get(date);
        if (cached && cached.mtimeMs === stat.mtimeMs) return cached.data;

        const data = JSON.parse(fs.readFileSync(obsPath, 'utf-8'));
        observationCache.set(date, { data, mtimeMs: stat.mtimeMs });

        if (observationCache.size > 10) {
            const oldest = [...observationCache.keys()].sort()[0];
            observationCache.delete(oldest);
        }

        return data;
    } catch {
        return null;
    }
}

export function listAvailableDates() {
    if (!fs.existsSync(OUTPUT_DIR)) return [];
    return fs.readdirSync(OUTPUT_DIR)
        .filter(f => f.startsWith('monitor-') && f.endsWith('.json'))
        .map(f => f.replace('monitor-', '').replace('.json', ''))
        .sort()
        .reverse();
}

// ── Liquidity Microservice ──────────────────────────────────────────────

const LIQUIDITY_SERVICE_URL = `http://localhost:${process.env.LIQUIDITY_PORT || 3001}`;

/**
 * Fetch live CLOB order book data for a specific date from the liquidity microservice.
 * @param {string} date
 * @returns {Promise<{bids: Object, asks: Object, tokens: Array, live: boolean}>}
 */
export async function fetchLiquidityData(date) {
    const result = { bids: {}, asks: {}, tokens: [], live: false };
    try {
        const resp = await fetch(`${LIQUIDITY_SERVICE_URL}/api/liquidity?date=${date}`);
        if (resp.ok) {
            const data = await resp.json();
            result.tokens = data.tokens || [];
            for (const t of result.tokens) {
                if (t.question) {
                    if (t.bestBid > 0) result.bids[t.question] = t.bestBid;
                    if (t.bestAsk > 0) result.asks[t.question] = t.bestAsk;
                }
            }
            result.live = result.tokens.length > 0;
        }
    } catch {
        // Liquidity service unavailable — will fall back to snapshot prices
    }
    return result;
}

/** Backward-compat wrapper (used by /api/trades) */
export async function fetchLiquidityBids(date) {
    const { bids } = await fetchLiquidityData(date);
    return bids;
}
