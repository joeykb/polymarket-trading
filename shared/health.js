/**
 * TempEdge — Standardized Health Check Response with Dependency Checks
 *
 * Usage:
 *   import { healthResponse, checkDependencies } from '../../shared/health.js';
 *
 *   // Simple (no dependency checks):
 *   return jsonRes(res, healthResponse('weather-svc'));
 *
 *   // With dependency checks:
 *   const deps = await checkDependencies({ dataSvc: DATA_SVC_URL, tradingSvc: TRADING_SVC_URL });
 *   return jsonRes(res, healthResponse('dashboard-svc', { dependencies: deps }));
 */

const startedAt = new Date().toISOString();
const DEP_TIMEOUT_MS = 2000;

/**
 * Build a standardized health response with common fields.
 * If dependencies are provided and any are down, status becomes 'degraded'.
 *
 * @param {string} service - Service name (e.g. 'weather-svc')
 * @param {object} [extra={}] - Service-specific health fields
 * @returns {object} Health response object
 */
export function healthResponse(service, extra = {}) {
    let status = 'ok';

    // If dependencies were checked, derive overall status
    if (extra.dependencies) {
        const anyDown = Object.values(extra.dependencies).some((d) => d.status !== 'ok');
        if (anyDown) status = 'degraded';
    }

    return {
        status,
        service,
        uptime: Math.round(process.uptime()),
        startedAt,
        timestamp: new Date().toISOString(),
        ...extra,
    };
}

/**
 * Check a single dependency's health by hitting its /health endpoint.
 * @param {string} url - Base URL of the service (e.g. "http://data-svc:3005")
 * @param {number} [timeoutMs=2000]
 * @returns {Promise<{ status: 'ok'|'down', latencyMs: number, error?: string }>}
 */
export async function checkDependency(url, timeoutMs = DEP_TIMEOUT_MS) {
    const start = Date.now();
    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        const res = await fetch(`${url}/health`, { signal: controller.signal });
        clearTimeout(timer);
        const latencyMs = Date.now() - start;

        if (res.ok) {
            return { status: 'ok', latencyMs };
        }
        return { status: 'down', latencyMs, error: `HTTP ${res.status}` };
    } catch (err) {
        return { status: 'down', latencyMs: Date.now() - start, error: err.message };
    }
}

/**
 * Check multiple dependencies in parallel.
 * @param {Record<string, string>} deps - Map of name → base URL
 * @returns {Promise<Record<string, { status: 'ok'|'down', latencyMs: number, error?: string }>>}
 */
export async function checkDependencies(deps) {
    const entries = Object.entries(deps);
    const results = await Promise.all(entries.map(([, url]) => checkDependency(url)));
    const out = {};
    entries.forEach(([name], i) => {
        out[name] = results[i];
    });
    return out;
}
