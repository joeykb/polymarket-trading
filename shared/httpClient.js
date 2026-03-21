/**
 * Shared HTTP client for inter-service communication.
 * Lightweight wrapper around native fetch() with JSON handling,
 * timeouts, and structured error responses.
 */

const DEFAULT_TIMEOUT_MS = 10000;

/**
 * Make an HTTP request to another service.
 * @param {string} url
 * @param {Object} [options]
 * @param {string} [options.method='GET']
 * @param {Object} [options.body]
 * @param {number} [options.timeoutMs]
 * @returns {Promise<any>}
 */
export async function svcRequest(url, { method = 'GET', body, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const opts = {
            method,
            signal: controller.signal,
            headers: { 'Content-Type': 'application/json' },
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
 * Create a service client bound to a base URL.
 * @param {string} baseUrl - e.g. "http://data-svc:3005"
 * @returns {{ get, post, put, patch, del }}
 */
export function createClient(baseUrl) {
    const base = baseUrl.replace(/\/$/, '');
    return {
        get:   (path, opts) => svcRequest(`${base}${path}`, { method: 'GET', ...opts }),
        post:  (path, body, opts) => svcRequest(`${base}${path}`, { method: 'POST', body, ...opts }),
        put:   (path, body, opts) => svcRequest(`${base}${path}`, { method: 'PUT', body, ...opts }),
        patch: (path, body, opts) => svcRequest(`${base}${path}`, { method: 'PATCH', body, ...opts }),
        del:   (path, opts) => svcRequest(`${base}${path}`, { method: 'DELETE', ...opts }),
    };
}
