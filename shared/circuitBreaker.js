/**
 * TempEdge — Circuit Breaker
 *
 * Simple circuit breaker for external API calls. When a service accumulates
 * too many consecutive failures, the breaker "opens" and fails fast for a
 * configurable reset period, then transitions to "half-open" to let a
 * single request through as a health probe.
 *
 * States:
 *   - CLOSED:    Normal operation. Failures increment the counter.
 *   - OPEN:      Fast-fail. All calls throw immediately without hitting the service.
 *   - HALF_OPEN: One call is allowed through. Success → CLOSED, failure → OPEN.
 *
 * Usage:
 *   import { CircuitBreaker } from '../../shared/circuitBreaker.js';
 *
 *   const wcBreaker = new CircuitBreaker('weather-company', { failureThreshold: 3, resetTimeMs: 60_000 });
 *
 *   const data = await wcBreaker.call(() => fetchWCForecast(date));
 */

const STATE = {
    CLOSED: 'closed',
    OPEN: 'open',
    HALF_OPEN: 'half-open',
};

export class CircuitBreaker {
    /**
     * @param {string} name - Identifier for logging/stats
     * @param {Object} [opts]
     * @param {number} [opts.failureThreshold=3] - Consecutive failures to trip the breaker
     * @param {number} [opts.resetTimeMs=60000] - Time in OPEN state before trying HALF_OPEN
     * @param {Function} [opts.onStateChange] - Optional callback: (name, oldState, newState) => void
     */
    constructor(name, { failureThreshold = 3, resetTimeMs = 60_000, onStateChange } = {}) {
        this.name = name;
        this._failureThreshold = failureThreshold;
        this._resetTimeMs = resetTimeMs;
        this._onStateChange = onStateChange;

        this._state = STATE.CLOSED;
        this._failures = 0;
        this._lastFailureTime = 0;
        this._totalTrips = 0;
        this._totalCalls = 0;
        this._totalFailures = 0;
    }

    /**
     * Execute a function through the circuit breaker.
     *
     * @param {Function} fn - Async function to execute
     * @returns {Promise<any>} - Result from fn
     * @throws {Error} - If circuit is OPEN, or if fn throws and breaker stays CLOSED
     */
    async call(fn) {
        this._totalCalls++;

        if (this._state === STATE.OPEN) {
            if (Date.now() - this._lastFailureTime >= this._resetTimeMs) {
                this._transitionTo(STATE.HALF_OPEN);
            } else {
                throw new CircuitOpenError(this.name, this._resetTimeMs - (Date.now() - this._lastFailureTime));
            }
        }

        try {
            const result = await fn();
            this._onSuccess();
            return result;
        } catch (err) {
            this._onFailure();
            throw err;
        }
    }

    /**
     * Check if the breaker would allow a call right now.
     * Useful for fast-path decisions without try/catch.
     * @returns {boolean}
     */
    isAvailable() {
        if (this._state === STATE.CLOSED || this._state === STATE.HALF_OPEN) return true;
        if (Date.now() - this._lastFailureTime >= this._resetTimeMs) return true;
        return false;
    }

    /**
     * Manually reset the breaker (e.g. after a config change or recovery).
     */
    reset() {
        this._transitionTo(STATE.CLOSED);
        this._failures = 0;
    }

    /**
     * Current breaker statistics for health/debug endpoints.
     * @returns {{ state, failures, totalTrips, totalCalls, totalFailures }}
     */
    stats() {
        return {
            name: this.name,
            state: this._state,
            failures: this._failures,
            totalTrips: this._totalTrips,
            totalCalls: this._totalCalls,
            totalFailures: this._totalFailures,
        };
    }

    // ── Internal ─────────────────────────────────────────────────────

    _onSuccess() {
        if (this._state === STATE.HALF_OPEN) {
            // Probe succeeded — close the circuit
            this._transitionTo(STATE.CLOSED);
        }
        this._failures = 0;
    }

    _onFailure() {
        this._failures++;
        this._totalFailures++;
        this._lastFailureTime = Date.now();

        if (this._state === STATE.HALF_OPEN) {
            // Probe failed — re-open
            this._transitionTo(STATE.OPEN);
            this._totalTrips++;
        } else if (this._failures >= this._failureThreshold) {
            this._transitionTo(STATE.OPEN);
            this._totalTrips++;
        }
    }

    _transitionTo(newState) {
        if (this._state === newState) return;
        const oldState = this._state;
        this._state = newState;
        if (this._onStateChange) {
            try {
                this._onStateChange(this.name, oldState, newState);
            } catch {
                /* don't let callback errors break the breaker */
            }
        }
    }
}

/**
 * Custom error for circuit breaker open state.
 * Includes metadata about when the circuit will try again.
 */
export class CircuitOpenError extends Error {
    /**
     * @param {string} name - Breaker name
     * @param {number} retryAfterMs - Milliseconds until half-open probe
     */
    constructor(name, retryAfterMs) {
        super(`${name}: circuit open (retry in ${Math.ceil(retryAfterMs / 1000)}s)`);
        this.name = 'CircuitOpenError';
        this.breakerName = name;
        this.retryAfterMs = retryAfterMs;
    }
}
