/**
 * TempEdge Monitor — Database Persistence Layer
 *
 * Wraps all data-svc API calls for session, snapshot, and alert persistence.
 * Extracted from orchestrator.js to separate concerns and enable testing.
 *
 * All DB write operations use exponential backoff retry to handle
 * transient failures (data-svc restart, SQLITE_BUSY, network blips).
 *
 * Session file operations (load/save) are NOT retried since they're
 * local hot-path operations that must not block the monitoring cycle.
 */

import { svcGet, svcPut } from './svcClients.js';
import { svcRequest } from '../../shared/httpClient.js';
import { services } from '../../shared/services.js';
import { createLogger } from '../../shared/logger.js';
import { withRetry } from '../../shared/retry.js';

const log = createLogger('monitor-persist');

const DATA_SVC = services.dataSvc;

/**
 * POST to data-svc with retry. Uses the throwing svcRequest so retry
 * can catch and re-attempt on failure.
 */
async function postWithRetry(path, body, label) {
    const result = await withRetry(
        () => svcRequest(`${DATA_SVC}${path}`, { method: 'POST', body }),
        {
            maxRetries: 3,
            baseDelayMs: 200,
            maxDelayMs: 3000,
            label,
            shouldRetry: (err) => {
                // Don't retry 4xx (client errors) — only 5xx and network errors
                const is4xx = err.message?.includes('→ 4');
                return !is4xx;
            },
        },
    );
    if (!result.success) {
        log.warn(`${label}_failed`, { error: result.error, attempts: result.attempts });
    }
    return result.success ? result.data : null;
}

// ── Session Persistence (file-backed, no retry) ─────────────────────────

export async function loadSession(targetDate, marketId = 'nyc') {
    try {
        const data = await svcGet(DATA_SVC, `/api/session-files/${targetDate}?market=${marketId}`);
        return data;
    } catch {
        return null; /* intentional: session may not exist yet */
    }
}

export async function saveSession(session) {
    try {
        const marketId = session.marketId || 'nyc';
        await svcPut(DATA_SVC, `/api/session-files/${session.targetDate}?market=${marketId}`, session);
    } catch (err) {
        log.warn('session_save_failed', { error: err.message });
    }
}

// ── Database Persistence (SQLite via data-svc, with retry) ──────────────

export async function dbUpsertSession(data) {
    return postWithRetry('/api/db/sessions', data, 'db_session_upsert');
}

export async function dbInsertSnapshot(data, session) {
    // If session was never successfully upserted to DB, retry now
    if (session && !session._dbSessionReady) {
        const retryResult = await dbUpsertSession({
            id: session.id,
            marketId: session.marketId || 'nyc',
            targetDate: session.targetDate,
            status: session.status,
            phase: session.phase,
            initialForecastTemp: session.initialForecastTempF,
            initialTargetRange: session.initialTargetRange,
            forecastSource: session.forecastSource,
            intervalMinutes: parseInt(session.intervalMinutes) || 5,
            rebalanceThreshold: parseFloat(session.rebalanceThreshold) || 3.0,
        });
        if (retryResult) session._dbSessionReady = true;
    }
    return postWithRetry('/api/snapshots', data, 'db_snapshot_insert');
}

export async function dbInsertAlert(data) {
    return postWithRetry('/api/alerts', data, 'db_alert_insert');
}

export async function dbInsertAlertsBatch(alerts) {
    if (!alerts || alerts.length === 0) return;

    const result = await postWithRetry('/api/alerts/batch', { alerts }, 'db_alert_batch');
    if (result) return result;

    // Fallback: batch endpoint failed after retries — try sequential inserts
    log.warn('batch_fallback_sequential', { count: alerts.length });
    for (const a of alerts) await dbInsertAlert(a);
}
