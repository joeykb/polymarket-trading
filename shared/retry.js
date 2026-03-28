/**
 * TempEdge — Exponential Backoff Retry Utility
 *
 * Retries async operations with exponential backoff and jitter.
 * Designed for DB writes and inter-service calls that may fail
 * transiently (network blip, data-svc restart, SQLITE_BUSY).
 *
 * Features:
 *   - Exponential backoff: delay doubles each attempt
 *   - Jitter: ±25% randomization to prevent thundering herd
 *   - Configurable max retries and base delay
 *   - Optional abort signal for cancellation
 *   - Returns { success, data, attempts, error } for observability
 *
 * Usage:
 *   import { withRetry } from '../../shared/retry.js';
 *
 *   const result = await withRetry(() => svcPost(url, data), {
 *       maxRetries: 3,
 *       baseDelayMs: 200,
 *       label: 'snapshot_insert',
 *   });
 *   if (!result.success) log.warn('gave_up', { error: result.error });
 */

import { createLogger } from './logger.js';

const log = createLogger('retry');

/**
 * Add jitter to a delay (±25% random variation).
 * Prevents thundering herd when multiple pods retry simultaneously.
 * @param {number} delayMs - Base delay
 * @returns {number} Jittered delay
 */
function addJitter(delayMs) {
    const jitterFactor = 0.75 + Math.random() * 0.5; // 0.75–1.25
    return Math.round(delayMs * jitterFactor);
}

/**
 * Sleep for a given duration (ms).
 * @param {number} ms
 * @param {AbortSignal} [signal] - Optional abort signal
 * @returns {Promise<void>}
 */
function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, ms);
        if (signal) {
            signal.addEventListener('abort', () => {
                clearTimeout(timer);
                reject(new Error('Retry aborted'));
            }, { once: true });
        }
    });
}

/**
 * Execute an async function with exponential backoff retry.
 *
 * @param {Function} fn - Async function to execute. Must throw on failure.
 * @param {Object} [options]
 * @param {number} [options.maxRetries=3] - Maximum number of retries (0 = no retries)
 * @param {number} [options.baseDelayMs=200] - Initial delay before first retry
 * @param {number} [options.maxDelayMs=5000] - Maximum delay cap
 * @param {string} [options.label='operation'] - Label for log messages
 * @param {boolean} [options.silent=false] - Suppress retry log messages
 * @param {AbortSignal} [options.signal] - Abort signal for cancellation
 * @param {Function} [options.shouldRetry] - (error, attempt) => boolean. Return false to stop retrying.
 * @returns {Promise<{ success: boolean, data?: any, attempts: number, error?: string }>}
 */
export async function withRetry(fn, options = {}) {
    const {
        maxRetries = 3,
        baseDelayMs = 200,
        maxDelayMs = 5000,
        label = 'operation',
        silent = false,
        signal,
        shouldRetry,
    } = options;

    let lastError;
    const totalAttempts = maxRetries + 1; // 1 initial + N retries

    for (let attempt = 1; attempt <= totalAttempts; attempt++) {
        try {
            if (signal?.aborted) {
                return { success: false, attempts: attempt - 1, error: 'Aborted before attempt' };
            }

            const data = await fn();
            return { success: true, data, attempts: attempt };
        } catch (err) {
            lastError = err;

            // Check if we should retry this specific error
            if (shouldRetry && !shouldRetry(err, attempt)) {
                return { success: false, attempts: attempt, error: err.message };
            }

            // Last attempt — don't sleep, just fail
            if (attempt >= totalAttempts) break;

            // Exponential backoff: baseDelay * 2^(attempt-1), capped at maxDelay
            const rawDelay = Math.min(baseDelayMs * Math.pow(2, attempt - 1), maxDelayMs);
            const delay = addJitter(rawDelay);

            if (!silent) {
                log.warn('retry_scheduled', {
                    label,
                    attempt,
                    maxRetries,
                    delayMs: delay,
                    error: err.message?.slice(0, 100),
                });
            }

            try {
                await sleep(delay, signal);
            } catch {
                // Aborted during sleep
                return { success: false, attempts: attempt, error: 'Aborted during backoff' };
            }
        }
    }

    if (!silent) {
        log.error('retry_exhausted', {
            label,
            attempts: totalAttempts,
            error: lastError?.message?.slice(0, 100),
        });
    }

    return { success: false, attempts: totalAttempts, error: lastError?.message };
}

/**
 * Create a retry-wrapped version of an async function.
 * Useful for wrapping service clients.
 *
 * @param {Function} fn - Async function to wrap
 * @param {Object} retryOptions - Options passed to withRetry
 * @returns {Function} Wrapped function that retries on failure
 */
export function withRetryWrap(fn, retryOptions = {}) {
    return async (...args) => {
        const result = await withRetry(() => fn(...args), retryOptions);
        return result.success ? result.data : null;
    };
}
