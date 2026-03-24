/**
 * Shared HTTP server helpers for TempEdge microservices.
 *
 * Consolidates JSON response, error response, and body parsing
 * previously duplicated across:
 *   - services/trading-svc/index.js
 *   - services/data-svc/index.js
 *   - services/weather-svc/index.js
 *   - services/market-svc/index.js
 *   - services/dashboard-svc/server.js
 */

/**
 * Send a JSON response with optional status code and CORS header.
 * @param {import('http').ServerResponse} res
 * @param {any} data
 * @param {number} [status=200]
 */
export function jsonResponse(res, data, status = 200) {
    res.writeHead(status, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify(data));
}

/**
 * Send a JSON error response.
 * @param {import('http').ServerResponse} res
 * @param {string} message
 * @param {number} [status=400]
 */
export function errorResponse(res, message, status = 400) {
    jsonResponse(res, { error: message }, status);
}

/**
 * Parse JSON request body from an incoming request.
 * Returns empty object if body is empty.
 * @param {import('http').IncomingMessage} req
 * @returns {Promise<Object>}
 */
export function readJsonBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', (chunk) => (body += chunk));
        req.on('end', () => {
            try {
                resolve(body ? JSON.parse(body) : {});
            } catch {
                reject(new Error('Invalid JSON'));
            }
        });
        req.on('error', reject);
    });
}

/**
 * Parse a request URL into pathname and query params.
 * @param {string} urlStr - The raw req.url string
 * @returns {{ pathname: string, params: Record<string, string> }}
 */
export function parseUrl(urlStr) {
    const url = new URL(urlStr, 'http://localhost');
    return { pathname: url.pathname, params: Object.fromEntries(url.searchParams) };
}

/**
 * Handle CORS preflight (OPTIONS) requests.
 * @param {import('http').ServerResponse} res
 */
export function handleCors(res) {
    res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
}
