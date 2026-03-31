/**
 * Data Service — File Storage Operations
 *
 * Handles session JSON files, delta compression, spend tracking,
 * and config overrides. All file I/O is centralized here.
 *
 * Extracted from the monolithic data-svc/index.js.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createLogger } from '../../shared/logger.js';

const log = createLogger('data-svc-storage');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const OUTPUT_DIR = process.env.OUTPUT_DIR || path.resolve(__dirname, '../output');
export const CONFIG_OVERRIDES_PATH = process.env.CONFIG_OVERRIDES_PATH || path.join(OUTPUT_DIR, 'config-overrides.json');

// Ensure output dir exists
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

// ── Session Files ───────────────────────────────────────────────────────

function getSessionFilePath(date, marketId = 'nyc') {
    // New: market-scoped directory
    const dir = path.join(OUTPUT_DIR, marketId);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, `monitor-${date}.json`);
}

/** Legacy flat path for backwards compatibility */
function getLegacySessionPath(date) {
    return path.join(OUTPUT_DIR, `monitor-${date}.json`);
}

// ── Delta Compression ───────────────────────────────────────────────────
// Snapshots are 99% identical between entries (only timestamp changes).
// Delta format: { _deltaCompressed: true, base: {...}, deltas: [{...changed fields...}] }
// This reduces 16MB files to ~1-2MB.

import deepEqual from 'fast-deep-equal';

export function compressSnapshots(snapshots) {
    if (!snapshots || snapshots.length === 0) return snapshots;
    const base = snapshots[0];
    const deltas = [];
    for (let i = 1; i < snapshots.length; i++) {
        const delta = {};
        let hasChanges = false;
        for (const key of Object.keys(snapshots[i])) {
            if (!deepEqual(snapshots[i][key], snapshots[i - 1][key])) {
                delta[key] = snapshots[i][key];
                hasChanges = true;
            }
        }
        // Check for removed keys
        for (const key of Object.keys(snapshots[i - 1])) {
            if (!(key in snapshots[i])) {
                delta[key] = null;
                hasChanges = true;
            }
        }
        deltas.push(hasChanges ? delta : { timestamp: snapshots[i].timestamp });
    }
    return { _deltaCompressed: true, base, deltas };
}

export function decompressSnapshots(compressed) {
    if (!compressed || !compressed._deltaCompressed) return compressed;
    const { base, deltas } = compressed;
    const snapshots = [base];
    let current = { ...base };
    for (const delta of deltas) {
        current = { ...current };
        for (const [key, val] of Object.entries(delta)) {
            if (val === null) {
                delete current[key];
            } else {
                current[key] = val;
            }
        }
        snapshots.push(current);
    }
    return snapshots;
}

export function loadSessionFile(date, marketId = 'nyc') {
    // Try new market-scoped path first
    let filePath = getSessionFilePath(date, marketId);
    if (!fs.existsSync(filePath)) {
        // Fallback to legacy flat path ONLY for NYC (all legacy files are NYC data)
        if (marketId === 'nyc') {
            const legacyPath = getLegacySessionPath(date);
            if (fs.existsSync(legacyPath)) {
                filePath = legacyPath;
            } else {
                return null;
            }
        } else {
            return null;
        }
    }
    try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        if (data.snapshots && data.snapshots._deltaCompressed) {
            data.snapshots = decompressSnapshots(data.snapshots);
        }

        // ── Content validation: reject contaminated session files ──────
        // Before multi-market fixes, the monitor wrote NYC data into all
        // market-scoped directories.  Detect this by checking:
        //   1. The file's own marketId field (if present) must match
        //   2. The target question must reference the correct city
        //   3. The snapshot's unit must not be °F for a °C-based market
        if (marketId !== 'nyc') {
            // Check file-level marketId mismatch
            if (data.marketId && data.marketId !== marketId) {
                log.info('session_market_mismatch', { date, expected: marketId, found: data.marketId });
                return null;
            }
            const snaps = Array.isArray(data.snapshots) ? data.snapshots : [];
            const lastSnap = snaps[snaps.length - 1];
            if (lastSnap) {
                const q = (lastSnap.target?.question || '').toLowerCase();
                // If a non-NYC market's target question mentions NYC/New York, it's contaminated
                if (q.includes('new york') || q.includes('in nyc ')) {
                    log.info('session_contaminated', { date, marketId, reason: 'nyc_target', target: q.slice(0, 80) });
                    return null;
                }
                // If the snapshot has °F unit or °F in the question for a non-F market, it's contaminated
                // (catches London files from before the unit fix)
                if (q.includes('°f') && !q.includes('°c')) {
                    log.info('session_contaminated', { date, marketId, reason: 'wrong_unit', target: q.slice(0, 80) });
                    return null;
                }
                // If forecast temp is unreasonably high for a °C market (> 60), likely °F data
                if (lastSnap.forecastTempF > 60 && (!lastSnap.unit || lastSnap.unit === 'F')) {
                    log.info('session_contaminated', { date, marketId, reason: 'f_temp_in_c_market', forecast: lastSnap.forecastTempF });
                    return null;
                }
            }
        }

        return data;
    } catch {
        return null; /* intentional: file may not exist */
    }
}

export function saveSessionFile(date, data, marketId) {
    // Determine marketId from data if not explicitly passed
    const mId = marketId || data?.marketId || 'nyc';
    // Apply hot-patch if present
    const patchPath = path.join(OUTPUT_DIR, `patch-${date}.json`);
    if (fs.existsSync(patchPath)) {
        try {
            const patch = JSON.parse(fs.readFileSync(patchPath, 'utf-8'));
            Object.assign(data, patch);
            fs.unlinkSync(patchPath);
            log.info('hot_patch_applied', { date });
        } catch (err) {
            log.warn('hot_patch_failed', { date, error: err.message });
        }
    }
    // Delta-compress snapshots before writing
    const writeData = { ...data };
    if (writeData.snapshots && Array.isArray(writeData.snapshots) && writeData.snapshots.length > 1) {
        writeData.snapshots = compressSnapshots(writeData.snapshots);
    }
    fs.writeFileSync(getSessionFilePath(date, mId), JSON.stringify(writeData, null, 2), 'utf-8');
}

export function listSessionFiles(marketId) {
    if (!fs.existsSync(OUTPUT_DIR)) return [];
    const results = [];

    // Scan legacy flat files (pre-multi-market)
    const legacyFiles = fs.readdirSync(OUTPUT_DIR)
        .filter((f) => f.startsWith('monitor-') && f.endsWith('.json'))
        .map((f) => ({ marketId: 'nyc', date: f.replace('monitor-', '').replace('.json', '') }));
    results.push(...legacyFiles);

    // Scan market-scoped directories
    const entries = fs.readdirSync(OUTPUT_DIR, { withFileTypes: true });
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith('.')) continue; // skip hidden dirs
        const dirPath = path.join(OUTPUT_DIR, entry.name);
        const files = fs.readdirSync(dirPath)
            .filter((f) => f.startsWith('monitor-') && f.endsWith('.json'))
            .map((f) => ({ marketId: entry.name, date: f.replace('monitor-', '').replace('.json', '') }));
        results.push(...files);
    }

    // Filter by market if requested
    const filtered = marketId ? results.filter((r) => r.marketId === marketId) : results;

    // Deduplicate (legacy + scoped may overlap for nyc)
    const seen = new Set();
    return filtered.filter((r) => {
        const key = `${r.marketId}:${r.date}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    }).sort((a, b) => a.date.localeCompare(b.date));
}

export function compressExistingFiles() {
    const dates = listSessionFiles();
    let compressed = 0;
    for (const date of dates) {
        const filePath = getSessionFilePath(date);
        try {
            const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
            if (!raw.snapshots) continue;
            if (raw.snapshots._deltaCompressed) continue;
            if (!Array.isArray(raw.snapshots) || raw.snapshots.length < 2) continue;
            const beforeSize = fs.statSync(filePath).size;
            const writeData = { ...raw };
            writeData.snapshots = compressSnapshots(raw.snapshots);
            fs.writeFileSync(filePath, JSON.stringify(writeData, null, 2), 'utf-8');
            const afterSize = fs.statSync(filePath).size;
            const pct = ((1 - afterSize / beforeSize) * 100).toFixed(0);
            log.info('file_compressed', { date, beforeMB: (beforeSize / 1024 / 1024).toFixed(1), afterMB: (afterSize / 1024 / 1024).toFixed(1), reductionPct: pct });
            compressed++;
        } catch (err) {
            log.warn('compress_failed', { date, error: err.message });
        }
    }
    if (compressed > 0) log.info('compression_complete', { count: compressed });
}

// ── Spend Tracking ──────────────────────────────────────────────────────

function getSpendLogPath(date) {
    if (!date) date = new Date().toISOString().slice(0, 10);
    return path.join(OUTPUT_DIR, `spend-${date}.json`);
}

export function getSpendData(date) {
    const p = getSpendLogPath(date);
    if (!fs.existsSync(p)) return { date, entries: [], totalSpent: 0 };
    try {
        return JSON.parse(fs.readFileSync(p, 'utf-8'));
    } catch {
        return { date, entries: [], totalSpent: 0 }; /* intentional: file may not exist */
    }
}

export function recordSpend(date, amount, orderDetails) {
    const data = getSpendData(date);
    data.entries.push({
        timestamp: new Date().toISOString(),
        amount,
        details: orderDetails,
    });
    data.totalSpent = data.entries.reduce((sum, e) => sum + (e.amount || 0), 0);
    data.date = date;
    fs.writeFileSync(getSpendLogPath(date), JSON.stringify(data, null, 2));
    return data;
}

// ── Config Overrides (DB-backed) ────────────────────────────────────────
// Previously stored in config-overrides.json, now in the config_overrides
// table for reliable persistence. Auto-migrates from JSON file on first load.

let _overridesMigrated = false;

function _migrateJsonToDb(db) {
    if (_overridesMigrated) return;
    _overridesMigrated = true;

    // Check if JSON file exists and DB table is empty → migrate
    if (fs.existsSync(CONFIG_OVERRIDES_PATH)) {
        const count = db.prepare('SELECT COUNT(*) as n FROM config_overrides').get().n;
        if (count === 0) {
            try {
                const jsonOverrides = JSON.parse(fs.readFileSync(CONFIG_OVERRIDES_PATH, 'utf-8'));
                const insert = db.prepare('INSERT OR REPLACE INTO config_overrides (section, field, value) VALUES (?, ?, ?)');
                const migrate = db.transaction(() => {
                    for (const [section, fields] of Object.entries(jsonOverrides)) {
                        if (typeof fields === 'object' && fields !== null) {
                            for (const [field, value] of Object.entries(fields)) {
                                insert.run(section, field, String(value));
                            }
                        }
                    }
                });
                migrate();
                log.info('config_migrated_to_db');
            } catch (err) {
                log.warn('config_migration_failed', { error: err.message });
            }
        }
        // Rename old file as backup (don't delete immediately)
        try {
            fs.renameSync(CONFIG_OVERRIDES_PATH, CONFIG_OVERRIDES_PATH + '.bak');
            log.info('config_json_renamed_to_bak');
        } catch {
            /* intentional: rename may fail if read-only */
        }
    }
}

/**
 * Load config overrides from the DB, returning them in the legacy
 * section-keyed format: { trading: { mode: 'live' }, monitor: { ... } }
 * @param {import('better-sqlite3').Database} db
 * @returns {Object}
 */
export function loadConfigOverrides(db) {
    _migrateJsonToDb(db);
    const rows = db.prepare('SELECT section, field, value FROM config_overrides').all();
    const result = {};
    for (const row of rows) {
        if (!result[row.section]) result[row.section] = {};
        result[row.section][row.field] = row.value;
    }
    return result;
}

/**
 * Save config overrides to the DB (full replacement).
 * @param {import('better-sqlite3').Database} db
 * @param {Object} overrides - Section-keyed overrides
 */
export function saveConfigOverrides(db, overrides) {
    const clear = db.prepare('DELETE FROM config_overrides');
    const insert = db.prepare('INSERT INTO config_overrides (section, field, value) VALUES (?, ?, ?)');
    const save = db.transaction(() => {
        clear.run();
        for (const [section, fields] of Object.entries(overrides)) {
            if (typeof fields === 'object' && fields !== null) {
                for (const [field, value] of Object.entries(fields)) {
                    insert.run(section, field, String(value));
                }
            }
        }
    });
    save();
}

// ── Route Matching ──────────────────────────────────────────────────────

/**
 * Match a path pattern like '/api/sessions/:id' against an actual path.
 * Returns { match: true, params: { id: 'abc' } } or { match: false }.
 */
export function matchRoute(pattern, pathname) {
    const patternParts = pattern.split('/');
    const pathParts = pathname.split('/');
    if (patternParts.length !== pathParts.length) return { match: false };

    const params = {};
    for (let i = 0; i < patternParts.length; i++) {
        if (patternParts[i].startsWith(':')) {
            params[patternParts[i].slice(1)] = decodeURIComponent(pathParts[i]);
        } else if (patternParts[i] !== pathParts[i]) {
            return { match: false };
        }
    }
    return { match: true, params };
}
