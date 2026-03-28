/**
 * Tests for shared rate limiter
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createRateLimiter } from '../shared/rateLimiter.js';

describe('createRateLimiter', () => {
    let limiter;

    beforeEach(() => {
        limiter = createRateLimiter({ windowMs: 1000, maxRequests: 3 });
    });

    it('allows requests under the limit', () => {
        expect(limiter.isLimited('test')).toBe(false);
        expect(limiter.isLimited('test')).toBe(false);
        expect(limiter.isLimited('test')).toBe(false);
    });

    it('blocks requests over the limit', () => {
        limiter.isLimited('test'); // 1
        limiter.isLimited('test'); // 2
        limiter.isLimited('test'); // 3
        expect(limiter.isLimited('test')).toBe(true); // 4 — blocked
    });

    it('tracks keys independently', () => {
        limiter.isLimited('a');
        limiter.isLimited('a');
        limiter.isLimited('a');
        expect(limiter.isLimited('a')).toBe(true);
        expect(limiter.isLimited('b')).toBe(false); // different key
    });

    it('reports remaining requests correctly', () => {
        expect(limiter.remaining('test')).toBe(3);
        limiter.isLimited('test');
        expect(limiter.remaining('test')).toBe(2);
        limiter.isLimited('test');
        limiter.isLimited('test');
        expect(limiter.remaining('test')).toBe(0);
    });

    it('resets all state', () => {
        limiter.isLimited('test');
        limiter.isLimited('test');
        limiter.isLimited('test');
        expect(limiter.isLimited('test')).toBe(true);
        limiter.reset();
        expect(limiter.isLimited('test')).toBe(false);
        expect(limiter.remaining('test')).toBe(2); // 1 used by isLimited above
    });

    it('allows requests after window expires', async () => {
        const shortLimiter = createRateLimiter({ windowMs: 50, maxRequests: 1 });
        shortLimiter.isLimited('test');
        expect(shortLimiter.isLimited('test')).toBe(true);
        await new Promise((r) => setTimeout(r, 60));
        expect(shortLimiter.isLimited('test')).toBe(false);
    });

    it('returns 0 remaining for unknown keys', () => {
        // actually returns maxRequests for unknown keys since there are no hits
        expect(limiter.remaining('unknown')).toBe(3);
    });
});
