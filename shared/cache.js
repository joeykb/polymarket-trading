/**
 * TempEdge — Shared TTL Cache
 *
 * Provides a simple async-safe TTL cache with periodic eviction.
 * Replaces the ad-hoc Map-based caches previously duplicated in:
 *   - services/weather-svc/index.js (sync/async hybrid)
 *   - services/market-svc/index.js (async-only)
 *
 * Features:
 *   - Always async (consistent interface)
 *   - Automatic eviction of stale entries (configurable interval)
 *   - Max size limit to prevent unbounded growth
 *   - Cache miss stats for observability
 *
 * Usage:
 *   import { TtlCache } from '../../shared/cache.js';
 *   const cache = new TtlCache({ evictIntervalMs: 60_000 });
 *
 *   const data = await cache.get('forecast:2026-03-23', 300_000, () => fetchForecast(date));
 */

const DEFAULT_EVICT_INTERVAL_MS = 60_000;
const DEFAULT_MAX_ENTRIES = 500;

export class TtlCache {
    /**
     * @param {Object} [opts]
     * @param {number} [opts.evictIntervalMs=60000] - How often to sweep stale entries
     * @param {number} [opts.maxEntries=500] - Max cache entries (oldest evicted first)
     */
    constructor({ evictIntervalMs = DEFAULT_EVICT_INTERVAL_MS, maxEntries = DEFAULT_MAX_ENTRIES } = {}) {
        /** @type {Map<string, { data: any, ts: number, ttlMs: number }>} */
        this._store = new Map();
        this._hits = 0;
        this._misses = 0;
        this._maxEntries = maxEntries;

        // Periodic eviction — unref() so it doesn't keep the process alive
        this._evictTimer = setInterval(() => this._evict(), evictIntervalMs);
        if (this._evictTimer.unref) this._evictTimer.unref();
    }

    /**
     * Get a cached value, or fetch and cache it.
     *
     * @param {string} key - Cache key
     * @param {number} ttlMs - Time-to-live in milliseconds
     * @param {Function} fetchFn - Async function to call on cache miss
     * @returns {Promise<any>} - Cached or freshly fetched data
     */
    async get(key, ttlMs, fetchFn) {
        const entry = this._store.get(key);
        if (entry && Date.now() - entry.ts < entry.ttlMs) {
            this._hits++;
            return entry.data;
        }

        this._misses++;
        try {
            const data = await fetchFn();
            this._store.set(key, { data, ts: Date.now(), ttlMs });
            this._enforceMaxSize();
            return data;
        } catch (err) {
            this._store.delete(key); // don't cache errors
            throw err;
        }
    }

    /**
     * Manually invalidate a cache entry.
     * @param {string} key
     */
    invalidate(key) {
        this._store.delete(key);
    }

    /**
     * Clear all cached entries.
     */
    clear() {
        this._store.clear();
    }

    /**
     * Cache stats for health/debug endpoints.
     * @returns {{ size: number, hits: number, misses: number, hitRate: string }}
     */
    stats() {
        const total = this._hits + this._misses;
        return {
            size: this._store.size,
            hits: this._hits,
            misses: this._misses,
            hitRate: total > 0 ? ((this._hits / total) * 100).toFixed(1) + '%' : 'N/A',
        };
    }

    /**
     * Stop the eviction timer (for graceful shutdown / tests).
     */
    destroy() {
        clearInterval(this._evictTimer);
    }

    // ── Internal ─────────────────────────────────────────────────────

    _evict() {
        const now = Date.now();
        for (const [key, entry] of this._store) {
            if (now - entry.ts >= entry.ttlMs * 2) {
                this._store.delete(key);
            }
        }
    }

    _enforceMaxSize() {
        if (this._store.size <= this._maxEntries) return;
        // Evict oldest entries first (Map preserves insertion order)
        const toRemove = this._store.size - this._maxEntries;
        let removed = 0;
        for (const key of this._store.keys()) {
            if (removed >= toRemove) break;
            this._store.delete(key);
            removed++;
        }
    }
}

/**
 * Convenience factory for a simple function-based cache (backward compatible).
 *
 * @param {Object} [opts] - TtlCache constructor options
 * @returns {{ get: (key, ttlMs, fetchFn) => Promise<any>, stats: () => Object }}
 */
export function createCache(opts) {
    const cache = new TtlCache(opts);
    return {
        get: (key, ttlMs, fetchFn) => cache.get(key, ttlMs, fetchFn),
        invalidate: (key) => cache.invalidate(key),
        clear: () => cache.clear(),
        stats: () => cache.stats(),
        destroy: () => cache.destroy(),
    };
}
