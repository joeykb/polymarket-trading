/**
 * Shared HTTP client for inter-service communication.
 * Lightweight wrapper around native fetch() with JSON handling,
 * timeouts, and structured error responses.
 *
 * Two flavors:
 *   - svcRequest / createClient: throws on error (for callers that handle errors)
 *   - svcGet / svcPost / createSoftClient: returns null on error (for resilient callers)
 */

const DEFAULT_TIMEOUT_MS = 10000;

/** Service auth key — injected into all outbound requests */
const SERVICE_KEY = process.env.SERVICE_AUTH_KEY || '';

/**
 * Make an HTTP request to another service. Throws on error.
 * @param {string} url
 * @param {Object} [options]
 * @param {string} [options.method='GET']
 * @param {Object} [options.body]
 * @param {number} [options.timeoutMs]
 * @param {string} [options.requestId] - Correlation ID to forward as X-Request-Id
 * @returns {Promise<any>}
 */
export async function svcRequest(url, { method = 'GET', body, timeoutMs = DEFAULT_TIMEOUT_MS, requestId } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const headers = { 'Content-Type': 'application/json' };
        if (requestId) headers['X-Request-Id'] = requestId;
        if (SERVICE_KEY) headers['x-service-key'] = SERVICE_KEY;

        const opts = {
            method,
            signal: controller.signal,
            headers,
        };
        if (body && method !== 'GET') {
            opts.body = JSON.stringify(body);
        }

        const res = await fetch(url, opts);

        if (!res.ok) {
            const text = await res.text().catch(() => '');
            throw new Error(`${method} ${url} → ${res.status}: ${text.slice(0, 200)}`);
        }

        const contentType = res.headers.get('content-type') || '';
        if (contentType.includes('application/json')) {
            return await res.json();
        }
        return await res.text();
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Create a service client bound to a base URL. Methods throw on error.
 * @param {string} baseUrl - e.g. "http://data-svc:3005"
 * @returns {{ get, post, put, patch, del }}
 */
export function createClient(baseUrl) {
    const base = baseUrl.replace(/\/$/, '');
    return {
        get: (path, opts) => svcRequest(`${base}${path}`, { method: 'GET', ...opts }),
        post: (path, body, opts) => svcRequest(`${base}${path}`, { method: 'POST', body, ...opts }),
        put: (path, body, opts) => svcRequest(`${base}${path}`, { method: 'PUT', body, ...opts }),
        patch: (path, body, opts) => svcRequest(`${base}${path}`, { method: 'PATCH', body, ...opts }),
        del: (path, opts) => svcRequest(`${base}${path}`, { method: 'DELETE', ...opts }),
    };
}

// ── Soft (non-throwing) variants ────────────────────────────────────────
// Return data on success, null on any error. Ideal for resilient callers
// that can fall back to defaults.

/**
 * GET with null-on-error semantics.
 * @param {string} url - Full URL
 * @param {Object} [options]
 * @param {number} [options.timeoutMs]
 * @returns {Promise<any|null>}
 */
export async function svcGet(url, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    try {
        return await svcRequest(url, { method: 'GET', timeoutMs });
    } catch {
        /* intentional: null-on-error by design */
        return null;
    }
}

/**
 * POST with null-on-error semantics.
 * @param {string} url - Full URL
 * @param {Object} body
 * @param {Object} [options]
 * @param {number} [options.timeoutMs]
 * @returns {Promise<any|null>}
 */
export async function svcPost(url, body, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    try {
        return await svcRequest(url, { method: 'POST', body, timeoutMs });
    } catch {
        /* intentional: null-on-error by design */
        return null;
    }
}

/**
 * Create a soft client bound to a base URL. Methods return null on error.
 * @param {string} baseUrl
 * @returns {{ get: (path, opts?) => Promise<any|null>, post: (path, body, opts?) => Promise<any|null> }}
 */
export function createSoftClient(baseUrl) {
    const base = baseUrl.replace(/\/$/, '');
    return {
        get: (path, opts) => svcGet(`${base}${path}`, opts),
        post: (path, body, opts) => svcPost(`${base}${path}`, body, opts),
    };
}
