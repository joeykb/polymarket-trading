/**
 * TempEdge — Structured Logger & HTTP Request Logging
 *
 * Provides:
 *   1. createLogger(service)     — structured JSON logger
 *   2. requestLogger(logger)     — HTTP request/response logging wrapper
 *
 * Format auto-detection:
 *   - K8s / production: JSON lines (parseable by log aggregators)
 *   - Development: human-readable with emojis
 *
 * Usage:
 *   import { createLogger, requestLogger } from '../../shared/logger.js';
 *   const log = createLogger('weather-svc');
 *   log.info('Server started', { port: 3002 });
 *
 *   // Wrap HTTP handler for automatic request logging:
 *   const server = http.createServer(requestLogger(log, handler));
 */

const IS_K8S = !!process.env.KUBERNETES_SERVICE_HOST;
const LOG_JSON = process.env.LOG_FORMAT === 'json' || IS_K8S;

// ── Structured Logger ───────────────────────────────────────────────────

/**
 * Create a logger instance for a service.
 * @param {string} service - Service name (e.g. 'weather-svc')
 * @returns {{ info, warn, error, debug }}
 */
export function createLogger(service) {
    function emit(level, msg, data = {}) {
        const entry = {
            ts: new Date().toISOString(),
            level,
            service,
            msg,
            ...data,
        };

        if (LOG_JSON) {
            // Structured JSON — one line per log entry
            const stream = level === 'error' ? process.stderr : process.stdout;
            stream.write(JSON.stringify(entry) + '\n');
        } else {
            // Human-friendly — colored emoji output
            const prefix =
                {
                    info: 'ℹ️ ',
                    warn: '⚠️ ',
                    error: '❌',
                    debug: '🔍',
                }[level] || '  ';

            const extra =
                Object.keys(data).length > 0
                    ? ' ' +
                      Object.entries(data)
                          .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`)
                          .join(' ')
                    : '';

            const stream = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
            stream(`${prefix} [${service}] ${msg}${extra}`);
        }
    }

    return {
        info: (msg, data) => emit('info', msg, data),
        warn: (msg, data) => emit('warn', msg, data),
        error: (msg, data) => emit('error', msg, data),
        debug: (msg, data) => {
            if (process.env.LOG_DEBUG === '1') emit('debug', msg, data);
        },
    };
}

// ── HTTP Request Logger ─────────────────────────────────────────────────

/**
 * Wrap an HTTP request handler to log request/response metrics.
 * Logs method, path, status code, and response time for every request.
 * Health checks are logged at debug level to avoid noise.
 *
 * @param {object} log - Logger instance from createLogger()
 * @param {Function} handler - Original http.createServer handler
 * @returns {Function} Wrapped handler
 */
export function requestLogger(log, handler) {
    return async (req, res) => {
        const start = Date.now();
        const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

        // Capture status code when response finishes
        const originalEnd = res.end.bind(res);
        let logged = false;

        res.end = function (...args) {
            if (!logged) {
                logged = true;
                const ms = Date.now() - start;
                const entry = {
                    method: req.method,
                    path: url.pathname,
                    status: res.statusCode,
                    ms,
                };

                // Health checks at debug level to reduce noise
                if (url.pathname === '/health') {
                    log.debug('request', entry);
                } else {
                    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
                    log[level]('request', entry);
                }
            }
            return originalEnd(...args);
        };

        try {
            await handler(req, res);
        } catch (err) {
            const ms = Date.now() - start;
            log.error('unhandled error', { method: req.method, path: url.pathname, error: err.message, ms });
            if (!res.headersSent) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Internal server error' }));
            }
        }
    };
}
