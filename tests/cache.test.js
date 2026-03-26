/**
 * Tests for shared/cache.js — TtlCache
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TtlCache, createCache } from '../shared/cache.js';

describe('TtlCache', () => {
    let cache;

    beforeEach(() => {
        cache = new TtlCache({ evictIntervalMs: 100_000, maxEntries: 10 });
    });

    afterEach(() => {
        cache.destroy();
    });

    it('returns cached value on hit', async () => {
        const fetchFn = vi.fn().mockResolvedValue('data');
        const r1 = await cache.get('key', 60_000, fetchFn);
        const r2 = await cache.get('key', 60_000, fetchFn);
        expect(r1).toBe('data');
        expect(r2).toBe('data');
        expect(fetchFn).toHaveBeenCalledTimes(1);
    });

    it('re-fetches after TTL expires', async () => {
        vi.useFakeTimers();
        const fetchFn = vi.fn().mockResolvedValue('v1').mockResolvedValueOnce('v1');
        await cache.get('key', 100, fetchFn);

        vi.advanceTimersByTime(200);
        fetchFn.mockResolvedValue('v2');
        const v2 = await cache.get('key', 100, fetchFn);
        expect(v2).toBe('v2');
        expect(fetchFn).toHaveBeenCalledTimes(2);
        vi.useRealTimers();
    });

    it('does not cache errors', async () => {
        const fetchFn = vi.fn().mockRejectedValueOnce(new Error('fail')).mockResolvedValueOnce('ok');

        await expect(cache.get('key', 60_000, fetchFn)).rejects.toThrow('fail');
        const result = await cache.get('key', 60_000, fetchFn);
        expect(result).toBe('ok');
        expect(fetchFn).toHaveBeenCalledTimes(2);
    });

    it('tracks hit/miss stats', async () => {
        const fetchFn = vi.fn().mockResolvedValue('data');
        await cache.get('a', 60_000, fetchFn);
        await cache.get('a', 60_000, fetchFn);
        await cache.get('b', 60_000, fetchFn);

        const stats = cache.stats();
        expect(stats.hits).toBe(1);
        expect(stats.misses).toBe(2);
        expect(stats.size).toBe(2);
    });

    it('enforces maxEntries by evicting oldest', async () => {
        const smallCache = new TtlCache({ evictIntervalMs: 100_000, maxEntries: 3 });
        for (let i = 0; i < 5; i++) {
            await smallCache.get(`k${i}`, 60_000, () => i);
        }
        expect(smallCache.stats().size).toBe(3);
        smallCache.destroy();
    });

    it('invalidate removes a specific key', async () => {
        await cache.get('a', 60_000, () => 1);
        cache.invalidate('a');
        expect(cache.stats().size).toBe(0);
    });

    it('clear removes all entries', async () => {
        await cache.get('a', 60_000, () => 1);
        await cache.get('b', 60_000, () => 2);
        cache.clear();
        expect(cache.stats().size).toBe(0);
    });
});

describe('createCache', () => {
    it('provides a function-based interface', async () => {
        const c = createCache({ evictIntervalMs: 100_000 });
        const result = await c.get('key', 60_000, () => 'value');
        expect(result).toBe('value');
        expect(c.stats().size).toBe(1);
        c.destroy();
    });
});
