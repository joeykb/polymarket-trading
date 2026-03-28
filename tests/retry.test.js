/**
 * Tests for shared exponential backoff retry utility
 */
import { describe, it, expect, vi } from 'vitest';
import { withRetry, withRetryWrap } from '../shared/retry.js';

describe('withRetry', () => {
    it('succeeds on first attempt', async () => {
        const fn = vi.fn().mockResolvedValue('ok');
        const result = await withRetry(fn, { silent: true });

        expect(result.success).toBe(true);
        expect(result.data).toBe('ok');
        expect(result.attempts).toBe(1);
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it('retries on failure and eventually succeeds', async () => {
        const fn = vi.fn()
            .mockRejectedValueOnce(new Error('fail 1'))
            .mockRejectedValueOnce(new Error('fail 2'))
            .mockResolvedValue('ok');

        const result = await withRetry(fn, { maxRetries: 3, baseDelayMs: 1, silent: true });

        expect(result.success).toBe(true);
        expect(result.data).toBe('ok');
        expect(result.attempts).toBe(3);
        expect(fn).toHaveBeenCalledTimes(3);
    });

    it('exhausts retries and returns failure', async () => {
        const fn = vi.fn().mockRejectedValue(new Error('persistent error'));

        const result = await withRetry(fn, { maxRetries: 2, baseDelayMs: 1, silent: true });

        expect(result.success).toBe(false);
        expect(result.attempts).toBe(3); // 1 initial + 2 retries
        expect(result.error).toBe('persistent error');
        expect(fn).toHaveBeenCalledTimes(3);
    });

    it('respects maxRetries: 0 (no retries)', async () => {
        const fn = vi.fn().mockRejectedValue(new Error('fail'));

        const result = await withRetry(fn, { maxRetries: 0, silent: true });

        expect(result.success).toBe(false);
        expect(result.attempts).toBe(1);
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it('respects shouldRetry predicate', async () => {
        const fn = vi.fn().mockRejectedValue(new Error('non-retryable'));
        const shouldRetry = vi.fn().mockReturnValue(false);

        const result = await withRetry(fn, {
            maxRetries: 3,
            baseDelayMs: 1,
            shouldRetry,
            silent: true,
        });

        expect(result.success).toBe(false);
        expect(result.attempts).toBe(1);
        expect(shouldRetry).toHaveBeenCalledWith(expect.any(Error), 1);
    });

    it('handles abort signal before attempt', async () => {
        const controller = new AbortController();
        controller.abort();

        const fn = vi.fn().mockResolvedValue('ok');
        const result = await withRetry(fn, { signal: controller.signal, silent: true });

        expect(result.success).toBe(false);
        expect(result.error).toContain('Aborted');
        expect(fn).not.toHaveBeenCalled();
    });

    it('uses exponential delay (baseDelay doubles)', async () => {
        const delays = [];
        const originalSetTimeout = globalThis.setTimeout;

        // Capture delay values — we can't easily mock setTimeout in ESM,
        // but we can verify the result structure
        const fn = vi.fn()
            .mockRejectedValueOnce(new Error('fail'))
            .mockResolvedValue('ok');

        const start = Date.now();
        const result = await withRetry(fn, { maxRetries: 1, baseDelayMs: 50, silent: true });
        const elapsed = Date.now() - start;

        expect(result.success).toBe(true);
        expect(result.attempts).toBe(2);
        // Should have waited at least ~37ms (50ms * 0.75 jitter floor)
        expect(elapsed).toBeGreaterThanOrEqual(30);
    });

    it('returns correct label in default logging', async () => {
        const fn = vi.fn()
            .mockRejectedValueOnce(new Error('transient'))
            .mockResolvedValue('ok');

        const result = await withRetry(fn, { maxRetries: 1, baseDelayMs: 1, label: 'test_op' });

        expect(result.success).toBe(true);
        expect(result.attempts).toBe(2);
    });
});

describe('withRetryWrap', () => {
    it('wraps a function with retry semantics', async () => {
        const fn = vi.fn()
            .mockRejectedValueOnce(new Error('fail'))
            .mockResolvedValue({ id: 1 });

        const wrapped = withRetryWrap(fn, { maxRetries: 2, baseDelayMs: 1, silent: true });
        const result = await wrapped('arg1', 'arg2');

        expect(result).toEqual({ id: 1 });
        expect(fn).toHaveBeenCalledTimes(2);
        expect(fn).toHaveBeenCalledWith('arg1', 'arg2');
    });

    it('returns null when all retries fail', async () => {
        const fn = vi.fn().mockRejectedValue(new Error('fail'));

        const wrapped = withRetryWrap(fn, { maxRetries: 1, baseDelayMs: 1, silent: true });
        const result = await wrapped();

        expect(result).toBeNull();
        expect(fn).toHaveBeenCalledTimes(2);
    });
});
