/**
 * Tests for shared/circuitBreaker.js
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CircuitBreaker, CircuitOpenError } from '../shared/circuitBreaker.js';

describe('CircuitBreaker', () => {
    let breaker;

    beforeEach(() => {
        breaker = new CircuitBreaker('test', { failureThreshold: 3, resetTimeMs: 1000 });
    });

    it('allows calls in CLOSED state', async () => {
        const result = await breaker.call(() => 'ok');
        expect(result).toBe('ok');
        expect(breaker.stats().state).toBe('closed');
    });

    it('stays CLOSED on success after failures below threshold', async () => {
        const fn = vi.fn().mockRejectedValueOnce(new Error('fail')).mockRejectedValueOnce(new Error('fail')).mockResolvedValue('ok');

        await expect(breaker.call(fn)).rejects.toThrow('fail');
        await expect(breaker.call(fn)).rejects.toThrow('fail');
        expect(breaker.stats().state).toBe('closed'); // 2 failures < 3 threshold

        const result = await breaker.call(fn);
        expect(result).toBe('ok');
        expect(breaker.stats().failures).toBe(0); // reset on success
    });

    it('opens after failureThreshold consecutive failures', async () => {
        const fn = vi.fn().mockRejectedValue(new Error('fail'));

        for (let i = 0; i < 3; i++) {
            await expect(breaker.call(fn)).rejects.toThrow('fail');
        }

        expect(breaker.stats().state).toBe('open');
        expect(breaker.stats().totalTrips).toBe(1);
    });

    it('throws CircuitOpenError when open', async () => {
        const fn = vi.fn().mockRejectedValue(new Error('fail'));
        for (let i = 0; i < 3; i++) {
            await expect(breaker.call(fn)).rejects.toThrow('fail');
        }

        await expect(breaker.call(() => 'nope')).rejects.toThrow(CircuitOpenError);
        await expect(breaker.call(() => 'nope')).rejects.toThrow(/circuit open/);
    });

    it('transitions to HALF_OPEN after resetTimeMs', async () => {
        vi.useFakeTimers();
        const fn = vi.fn().mockRejectedValue(new Error('fail'));

        for (let i = 0; i < 3; i++) {
            await expect(breaker.call(fn)).rejects.toThrow();
        }
        expect(breaker.stats().state).toBe('open');

        vi.advanceTimersByTime(1500);
        fn.mockResolvedValue('recovered');

        const result = await breaker.call(fn);
        expect(result).toBe('recovered');
        expect(breaker.stats().state).toBe('closed');
        vi.useRealTimers();
    });

    it('re-opens on HALF_OPEN failure', async () => {
        vi.useFakeTimers();
        const fn = vi.fn().mockRejectedValue(new Error('fail'));

        for (let i = 0; i < 3; i++) {
            await expect(breaker.call(fn)).rejects.toThrow();
        }
        expect(breaker.stats().state).toBe('open');

        vi.advanceTimersByTime(1500);
        // HALF_OPEN probe fails
        await expect(breaker.call(fn)).rejects.toThrow('fail');
        expect(breaker.stats().state).toBe('open');
        expect(breaker.stats().totalTrips).toBe(2);
        vi.useRealTimers();
    });

    it('isAvailable reflects state correctly', async () => {
        expect(breaker.isAvailable()).toBe(true);

        const fn = vi.fn().mockRejectedValue(new Error('fail'));
        for (let i = 0; i < 3; i++) {
            await expect(breaker.call(fn)).rejects.toThrow();
        }

        expect(breaker.isAvailable()).toBe(false);
    });

    it('reset() closes the breaker', async () => {
        const fn = vi.fn().mockRejectedValue(new Error('fail'));
        for (let i = 0; i < 3; i++) {
            await expect(breaker.call(fn)).rejects.toThrow();
        }
        expect(breaker.stats().state).toBe('open');

        breaker.reset();
        expect(breaker.stats().state).toBe('closed');
        expect(breaker.stats().failures).toBe(0);
    });

    it('calls onStateChange callback on transitions', async () => {
        const onChange = vi.fn();
        const b = new CircuitBreaker('cb-test', { failureThreshold: 2, resetTimeMs: 500, onStateChange: onChange });
        const fn = vi.fn().mockRejectedValue(new Error('fail'));

        await expect(b.call(fn)).rejects.toThrow();
        await expect(b.call(fn)).rejects.toThrow();

        expect(onChange).toHaveBeenCalledWith('cb-test', 'closed', 'open');
    });

    it('tracks stats correctly', async () => {
        const fn = vi.fn().mockResolvedValueOnce('a').mockRejectedValueOnce(new Error('b')).mockResolvedValueOnce('c');

        await breaker.call(fn);
        await expect(breaker.call(fn)).rejects.toThrow();
        await breaker.call(fn);

        const stats = breaker.stats();
        expect(stats.totalCalls).toBe(3);
        expect(stats.totalFailures).toBe(1);
        expect(stats.totalTrips).toBe(0);
    });
});

describe('CircuitOpenError', () => {
    it('includes breaker name and retry timing', () => {
        const err = new CircuitOpenError('test-svc', 30000);
        expect(err.message).toContain('test-svc');
        expect(err.message).toContain('30s');
        expect(err.breakerName).toBe('test-svc');
        expect(err.retryAfterMs).toBe(30000);
    });
});
