/**
 * TempEdge — Simple In-Memory Rate Limiter
 *
 * Sliding window rate limiter for HTTP endpoints.
 * No external dependencies (no Redis needed for single-pod services).
 *
 * Usage:
 *   import { createRateLimiter } from '../../shared/rateLimiter.js';
 *
 *   const limiter = createRateLimiter({ windowMs: 60_000, maxRequests: 10 });
 *
 *   // In request handler:
 *   if (limiter.isLimited(clientKey)) {
 *       return errorResponse(res, 'Rate limit exceeded', 429);
 *   }
 */

/**
 * Create a rate limiter instance.
 *
 * @param {Object} opts
 * @param {number} [opts.windowMs=60000]    - Time window in milliseconds
 * @param {number} [opts.maxRequests=10]    - Max requests per window
 * @param {number} [opts.cleanupIntervalMs] - Interval to purge expired entries (default: windowMs * 2)
 * @returns {{ isLimited: (key: string) => boolean, remaining: (key: string) => number, reset: () => void }}
 */
export function createRateLimiter({ windowMs = 60_000, maxRequests = 10, cleanupIntervalMs } = {}) {
    /** @type {Map<string, number[]>} */
    const hits = new Map();

    // Periodic cleanup to prevent memory leak from stale keys
    const cleanupMs = cleanupIntervalMs ?? windowMs * 2;
    const cleanupTimer = setInterval(() => {
        const cutoff = Date.now() - windowMs;
        for (const [key, timestamps] of hits) {
            const filtered = timestamps.filter((t) => t > cutoff);
            if (filtered.length === 0) {
                hits.delete(key);
            } else {
                hits.set(key, filtered);
            }
        }
    }, cleanupMs);
    cleanupTimer.unref(); // Don't prevent process exit

    return {
        /**
         * Check if a key is rate-limited. Records the request if not limited.
         * @param {string} key - Client identifier (IP, path, service name, etc.)
         * @returns {boolean} true if rate-limited (should reject), false if allowed
         */
        isLimited(key) {
            const now = Date.now();
            const cutoff = now - windowMs;
            const timestamps = (hits.get(key) || []).filter((t) => t > cutoff);

            if (timestamps.length >= maxRequests) {
                hits.set(key, timestamps);
                return true;
            }

            timestamps.push(now);
            hits.set(key, timestamps);
            return false;
        },

        /**
         * Get remaining requests for a key in the current window.
         * @param {string} key
         * @returns {number}
         */
        remaining(key) {
            const cutoff = Date.now() - windowMs;
            const count = (hits.get(key) || []).filter((t) => t > cutoff).length;
            return Math.max(0, maxRequests - count);
        },

        /**
         * Reset all rate limit state.
         */
        reset() {
            hits.clear();
        },
    };
}
