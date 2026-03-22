/**
 * TempEdge — Standardized Health Check Response
 *
 * Usage:
 *   import { healthResponse } from '../../shared/health.js';
 *   return jsonRes(res, healthResponse('weather-svc', { sources: ['wc', 'om'] }));
 */

const startedAt = new Date().toISOString();

/**
 * Build a standardized health response with common fields.
 * Service-specific extras are merged in.
 *
 * @param {string} service - Service name (e.g. 'weather-svc')
 * @param {object} [extra={}] - Service-specific health fields
 * @returns {object} Health response object
 */
export function healthResponse(service, extra = {}) {
    return {
        status: 'ok',
        service,
        uptime: Math.round(process.uptime()),
        startedAt,
        timestamp: new Date().toISOString(),
        ...extra,
    };
}
