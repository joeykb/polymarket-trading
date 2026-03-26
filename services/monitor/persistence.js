/**
 * TempEdge Monitor — Database Persistence Layer
 *
 * Wraps all data-svc API calls for session, snapshot, and alert persistence.
 * Extracted from orchestrator.js to separate concerns and enable testing.
 *
 * All functions are resilient: they catch errors and log warnings rather than
 * crashing the monitoring cycle, since DB persistence is non-critical for
 * trade execution.
 */

import { svcPost, svcGet, svcPut } from './svcClients.js';
import { services } from '../../shared/services.js';

const DATA_SVC = services.dataSvc;

// ── Session Persistence (file-backed) ───────────────────────────────────

export async function loadSession(targetDate) {
    try {
        const data = await svcGet(DATA_SVC, `/api/session-files/${targetDate}`);
        return data;
    } catch {
        return null; /* intentional: session may not exist yet */
    }
}

export async function saveSession(session) {
    try {
        await svcPut(DATA_SVC, `/api/session-files/${session.targetDate}`, session);
    } catch (err) {
        console.warn(`  ⚠️  Session save failed: ${err.message}`);
    }
}

// ── Database Persistence (SQLite via data-svc) ──────────────────────────

export async function dbUpsertSession(data) {
    try {
        const result = await svcPost(DATA_SVC, '/api/db/sessions', data);
        return result; // { upserted: true, existingId: ... }
    } catch (err) {
        console.warn(`  ⚠️  DB session upsert failed: ${err.message}`);
        return null;
    }
}

export async function dbInsertSnapshot(data, session) {
    try {
        // If session was never successfully upserted to DB, retry now
        if (session && !session._dbSessionReady) {
            const retryResult = await dbUpsertSession({
                id: session.id,
                marketId: 'nyc',
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
        await svcPost(DATA_SVC, '/api/snapshots', data);
    } catch (err) {
        console.warn(`  ⚠️  DB snapshot insert failed: ${err.message}`);
    }
}

export async function dbInsertAlert(data) {
    try {
        await svcPost(DATA_SVC, '/api/alerts', data);
    } catch (err) {
        console.warn(`  ⚠️  DB alert insert failed: ${err.message}`);
    }
}

export async function dbInsertAlertsBatch(alerts) {
    if (!alerts || alerts.length === 0) return;
    try {
        await svcPost(DATA_SVC, '/api/alerts/batch', { alerts });
    } catch (err) {
        // Fallback to sequential inserts if batch endpoint is unavailable
        console.warn(`  ⚠️  Batch alert insert failed (${err.message}), falling back to sequential`);
        for (const a of alerts) await dbInsertAlert(a);
    }
}
