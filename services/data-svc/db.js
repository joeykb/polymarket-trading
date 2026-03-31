/**
 * TempEdge Database — SQLite connection and lifecycle management
 *
 * Uses better-sqlite3 for synchronous, high-performance SQLite access.
 * WAL mode enables concurrent reads (dashboard) + writes (monitor).
 *
 * Usage:
 *   import { getDb, closeDb } from './db/index.js';
 *   const db = getDb();
 *   db.prepare('SELECT * FROM trades WHERE target_date = ?').all('2026-03-20');
 */

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createLogger } from '../../shared/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// DB file lives on the PVC — data-svc is the sole owner
const DB_DIR = process.env.OUTPUT_DIR || path.resolve(__dirname, '../output');
const DB_PATH = process.env.DB_PATH || path.join(DB_DIR, 'tempedge.db');
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

const log = createLogger('data-svc-db');

let _db = null;

/**
 * Get or create the database connection (singleton).
 * Automatically runs schema migrations on first connect.
 * @returns {import('better-sqlite3').Database}
 */
export function getDb() {
    if (_db) return _db;

    // Ensure output directory exists
    const dir = path.dirname(DB_PATH);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }

    _db = new Database(DB_PATH);

    // ── Performance & Safety Pragmas ────────────────────────────────
    _db.pragma('journal_mode = WAL'); // Multi-process safe reads
    _db.pragma('busy_timeout = 5000'); // Wait up to 5s for locks
    _db.pragma('foreign_keys = ON'); // Enforce FK constraints
    _db.pragma('synchronous = NORMAL'); // Good balance of safety + speed

    // ── Run Schema ──────────────────────────────────────────────────
    const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
    // Split on statements and execute (skip PRAGMA lines — already set above)
    const statements = schema
        .split(';')
        .map((s) => s.trim())
        .filter((s) => s.length > 0 && !s.startsWith('PRAGMA'));

    for (const stmt of statements) {
        try {
            _db.exec(stmt);
        } catch (err) {
            // Ignore "already exists" — schema is idempotent via IF NOT EXISTS
            if (!err.message.includes('already exists')) {
                log.warn('schema_warning', { error: err.message });
            }
        }
    }

    // ── Migrate: add timezone column if missing ───────────────────────
    try {
        _db.exec("ALTER TABLE markets ADD COLUMN timezone TEXT NOT NULL DEFAULT 'America/New_York'");
        log.info('migration_applied', { column: 'markets.timezone' });
    } catch {
        /* intentional: column already exists */
    }

    // ── Migrate: add daily_budget column if missing ──────────────────
    try {
        _db.exec("ALTER TABLE markets ADD COLUMN daily_budget REAL NOT NULL DEFAULT 3.0");
        log.info('migration_applied', { column: 'markets.daily_budget' });
    } catch {
        /* intentional: column already exists */
    }

    // ── Seed all temperature markets ────────────────────────────────
    const MARKETS = [
        { id: 'nyc',       name: 'New York City', slugTemplate: 'highest-temperature-in-nyc-on-{date}',       unit: 'F', lat: 40.7769,   lon: -73.8740,   station: 'KLGA', tz: 'America/New_York' },
        { id: 'seoul',     name: 'Seoul',         slugTemplate: 'highest-temperature-in-seoul-on-{date}',     unit: 'C', lat: 37.5665,   lon: 126.9780,   station: 'RKSS', tz: 'Asia/Seoul' },
        { id: 'shanghai',  name: 'Shanghai',      slugTemplate: 'highest-temperature-in-shanghai-on-{date}',  unit: 'C', lat: 31.2304,   lon: 121.4737,   station: 'ZSSS', tz: 'Asia/Shanghai' },
        { id: 'madrid',    name: 'Madrid',        slugTemplate: 'highest-temperature-in-madrid-on-{date}',    unit: 'C', lat: 40.4168,   lon: -3.7038,    station: 'LEMD', tz: 'Europe/Madrid' },
        { id: 'shenzhen',  name: 'Shenzhen',      slugTemplate: 'highest-temperature-in-shenzhen-on-{date}',  unit: 'C', lat: 22.5431,   lon: 114.0579,   station: 'ZGSZ', tz: 'Asia/Shanghai' },
        { id: 'london',    name: 'London',        slugTemplate: 'highest-temperature-in-london-on-{date}',    unit: 'C', lat: 51.4700,   lon: -0.4543,    station: 'EGLL', tz: 'Europe/London' },
        { id: 'tokyo',     name: 'Tokyo',         slugTemplate: 'highest-temperature-in-tokyo-on-{date}',     unit: 'C', lat: 35.5494,   lon: 139.7798,   station: 'RJTT', tz: 'Asia/Tokyo' },
        { id: 'wellington', name: 'Wellington',    slugTemplate: 'highest-temperature-in-wellington-on-{date}', unit: 'C', lat: -41.3276, lon: 174.8050,   station: 'NZWN', tz: 'Pacific/Auckland' },
    ];

    const insertMarket = _db.prepare(`
        INSERT OR IGNORE INTO markets (id, name, slug_template, unit, station_lat, station_lon, station_name, timezone)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const seedMarkets = _db.transaction((markets) => {
        for (const m of markets) {
            insertMarket.run(m.id, m.name, m.slugTemplate, m.unit, m.lat, m.lon, m.station, m.tz);
        }
    });
    seedMarkets(MARKETS);

    // Update existing NYC row to have timezone if it was seeded before migration
    _db.prepare("UPDATE markets SET timezone = 'America/New_York' WHERE id = 'nyc' AND timezone IS NULL").run();

    log.info('db_connected', { path: DB_PATH });
    return _db;
}

/**
 * Close the database connection gracefully.
 * Call this on process exit.
 */
export function closeDb() {
    if (_db) {
        _db.close();
        _db = null;
        log.info('db_closed');
    }
}

/**
 * Get the database path (for logging/debugging)
 */
export function getDbPath() {
    return DB_PATH;
}
