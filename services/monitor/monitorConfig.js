/**
 * TempEdge Monitor — Configuration Management
 *
 * Centralized config with defaults, overridden by data-svc /api/config.
 * Extracted from orchestrator.js to reduce its scope.
 */

import { createLogger } from '../../shared/logger.js';
import { svcGet, DATA_SVC } from './svcClients.js';

const log = createLogger('monitor-config');

// ── Config defaults (overridden by data-svc /api/config) ───────────────

const _config = {
    monitor: {
        intervalMinutes: 15,
        rebalanceThreshold: 3,
        forecastShiftThreshold: 2,
        priceSpikeThreshold: 0.05,
        buyHourEST: 9.5,
    },
    liquidity: {
        wsEnabled: true,
        checkIntervalSecs: 30,
        buyDeadlineHour: 10.5,
        requireAllLiquid: false,
    },
    phases: {
        scoutDaysMax: 4,
        trendThreshold: 2,
    },
};

/**
 * Refresh config from data-svc. Failures are intentionally silent
 * (use defaults until data-svc is reachable).
 */
export async function refreshConfig() {
    try {
        const remote = await svcGet(DATA_SVC, '/api/config');
        if (remote) {
            if (remote.monitor) Object.assign(_config.monitor, remote.monitor);
            if (remote.liquidity) Object.assign(_config.liquidity, remote.liquidity);
            if (remote.phases) Object.assign(_config.phases, remote.phases);
            log.info('config_refreshed', { keys: Object.keys(remote) });
        }
    } catch {
        /* intentional: config fetch may fail at startup, use defaults */
    }
}

/**
 * Get the current config snapshot (read-only reference).
 * @returns {typeof _config}
 */
export function getConfig() {
    return _config;
}
