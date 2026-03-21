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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// DB file lives on the PVC — data-svc is the sole owner
const DB_DIR = process.env.OUTPUT_DIR || path.resolve(__dirname, '../output');
const DB_PATH = process.env.DB_PATH || path.join(DB_DIR, 'tempedge.db');
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

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
    _db.pragma('journal_mode = WAL');       // Multi-process safe reads
    _db.pragma('busy_timeout = 5000');      // Wait up to 5s for locks
    _db.pragma('foreign_keys = ON');        // Enforce FK constraints
    _db.pragma('synchronous = NORMAL');     // Good balance of safety + speed

    // ── Run Schema ──────────────────────────────────────────────────
    const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
    // Split on statements and execute (skip PRAGMA lines — already set above)
    const statements = schema
        .split(';')
        .map(s => s.trim())
        .filter(s => s.length > 0 && !s.startsWith('PRAGMA'));

    for (const stmt of statements) {
        try {
            _db.exec(stmt);
        } catch (err) {
            // Ignore "already exists" — schema is idempotent via IF NOT EXISTS
            if (!err.message.includes('already exists')) {
                console.warn(`DB schema warning: ${err.message}`);
            }
        }
    }

    // ── Seed default market (NYC) ───────────────────────────────────
    const insertMarket = _db.prepare(`
        INSERT OR IGNORE INTO markets (id, name, slug_template, unit, station_lat, station_lon, station_name)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    insertMarket.run('nyc', 'NYC Temperature', 'highest-temperature-in-nyc-on-{date}', 'F', 40.7769, -73.8740, 'KLGA');

    console.log(`📦 Database connected: ${DB_PATH}`);
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
        console.log('📦 Database closed');
    }
}

/**
 * Get the database path (for logging/debugging)
 */
export function getDbPath() {
    return DB_PATH;
}
