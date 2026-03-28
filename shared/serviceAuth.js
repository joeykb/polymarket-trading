/**
 * TempEdge — Inter-Service Authentication Middleware
 *
 * Protects internal service endpoints with a shared API key.
 * The key is set via the `SERVICE_AUTH_KEY` environment variable.
 *
 * Design decisions:
 *   - Constant-time comparison to prevent timing attacks.
 *   - Health/status endpoints are always public (K8s probes need them).
 *   - GET requests are optionally open (configurable per-service).
 *   - When no key is configured, auth is disabled (development mode).
 *
 * Usage:
 *   import { requireServiceAuth, SERVICE_AUTH_HEADER } from '../../shared/serviceAuth.js';
 *
 *   // In request handler:
 *   if (!requireServiceAuth(req, res, { allowPublicGet: true })) return;
 */

import { createLogger } from './logger.js';
import { errorResponse } from './httpServer.js';

const log = createLogger('service-auth');

/** Header name for the service authentication key */
export const SERVICE_AUTH_HEADER = 'x-service-key';

/** The configured service key (empty = auth disabled) */
const SERVICE_KEY = process.env.SERVICE_AUTH_KEY || '';

/**
 * Paths that are always unauthenticated (health probes, readiness checks).
 */
const PUBLIC_PATHS = new Set(['/health', '/healthz', '/ready', '/readyz']);

/**
 * Constant-time string comparison to prevent timing attacks.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function timingSafeEqual(a, b) {
    if (a.length !== b.length) return false;
    let result = 0;
    for (let i = 0; i < a.length; i++) {
        result |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return result === 0;
}

/**
 * Validate inter-service authentication.
 * Returns true if the request is authorized, false if it was rejected (response already sent).
 *
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {Object} [opts]
 * @param {boolean} [opts.allowPublicGet=false] - If true, GET requests are allowed without auth
 * @param {Set<string>} [opts.publicPaths]      - Additional paths to exempt from auth
 * @returns {boolean} true if authorized, false if rejected (res already sent)
 */
export function requireServiceAuth(req, res, { allowPublicGet = false, publicPaths } = {}) {
    // If no key configured, auth is disabled (dev mode)
    if (!SERVICE_KEY) return true;

    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;

    // Health/readiness endpoints are always public (K8s probes)
    if (PUBLIC_PATHS.has(path)) return true;
    if (publicPaths?.has(path)) return true;

    // Optionally allow unauthenticated GET requests (for read-only services)
    if (allowPublicGet && req.method === 'GET') return true;

    // Validate the service key header
    const providedKey = req.headers[SERVICE_AUTH_HEADER] || '';

    if (!providedKey) {
        log.warn('auth_missing', { method: req.method, path });
        errorResponse(res, 'Service authentication required', 401);
        return false;
    }

    if (!timingSafeEqual(providedKey, SERVICE_KEY)) {
        log.warn('auth_invalid', { method: req.method, path });
        errorResponse(res, 'Invalid service key', 403);
        return false;
    }

    return true;
}

/**
 * Check if service auth is configured (for health reporting).
 * @returns {{ enabled: boolean }}
 */
export function getAuthStatus() {
    return { enabled: !!SERVICE_KEY };
}
