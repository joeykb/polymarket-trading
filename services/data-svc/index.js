/**
 * TempEdge Data Service — Centralized data access layer
 *
 * Sole owner of:
 *   - SQLite database (sessions, trades, positions, snapshots, alerts)
 *   - Session JSON files (monitor-YYYY-MM-DD.json)
 *   - Config overrides file (config-overrides.json)
 *   - Daily spend tracking (spend-YYYY-MM-DD.json)
 *
 * All other services read/write through this HTTP API.
 * This eliminates SQLite concurrency issues (SQLITE_BUSY).
 *
 * Route handling → routes.js
 * File I/O       → storage.js
 * DB queries     → queries.js
 * DB connection  → db.js
 *
 * Port: 3005
 */

import 'dotenv/config';
import http from 'http';
import { createLogger, requestLogger } from '../../shared/logger.js';
import { getDb, closeDb } from './db.js';
import { compressExistingFiles, listSessionFiles, OUTPUT_DIR } from './storage.js';
import { handleRequest } from './routes.js';

const PORT = parseInt(process.env.DATA_SVC_PORT || '3005');

// Initialize DB on startup
getDb();

// ── Server ──────────────────────────────────────────────────────────────

const log = createLogger('data-svc');
const server = http.createServer(requestLogger(log, handleRequest));

server.listen(PORT, () => {
    log.info('started', { port: PORT, outputDir: OUTPUT_DIR, sessions: listSessionFiles().length });
    compressExistingFiles();
});

// Graceful shutdown
function shutdown() {
    log.info('shutting down');
    closeDb();
    server.close();
    process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
