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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const OUTPUT_DIR = process.env.OUTPUT_DIR || path.resolve(__dirname, '../output');
export const CONFIG_OVERRIDES_PATH = process.env.CONFIG_OVERRIDES_PATH || path.join(OUTPUT_DIR, 'config-overrides.json');

// Ensure output dir exists
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

// ── Session Files ───────────────────────────────────────────────────────

function getSessionFilePath(date) {
    return path.join(OUTPUT_DIR, `monitor-${date}.json`);
}

// ── Delta Compression ───────────────────────────────────────────────────
// Snapshots are 99% identical between entries (only timestamp changes).
// Delta format: { _deltaCompressed: true, base: {...}, deltas: [{...changed fields...}] }
// This reduces 16MB files to ~1-2MB.

export function compressSnapshots(snapshots) {
    if (!snapshots || snapshots.length === 0) return snapshots;
    const base = snapshots[0];
    const deltas = [];
    for (let i = 1; i < snapshots.length; i++) {
        const delta = {};
        let hasChanges = false;
        for (const key of Object.keys(snapshots[i])) {
            if (JSON.stringify(snapshots[i][key]) !== JSON.stringify(snapshots[i - 1][key])) {
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

export function loadSessionFile(date) {
    const filePath = getSessionFilePath(date);
    if (!fs.existsSync(filePath)) return null;
    try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        if (data.snapshots && data.snapshots._deltaCompressed) {
            data.snapshots = decompressSnapshots(data.snapshots);
        }
        return data;
    } catch {
        return null; /* intentional: file may not exist */
    }
}

export function saveSessionFile(date, data) {
    // Apply hot-patch if present
    const patchPath = path.join(OUTPUT_DIR, `patch-${date}.json`);
    if (fs.existsSync(patchPath)) {
        try {
            const patch = JSON.parse(fs.readFileSync(patchPath, 'utf-8'));
            Object.assign(data, patch);
            fs.unlinkSync(patchPath);
            console.log(`  🔧 HOT-PATCH applied for ${date}`);
        } catch (err) {
            console.warn(`  ⚠️  Patch failed: ${err.message}`);
        }
    }
    // Delta-compress snapshots before writing
    const writeData = { ...data };
    if (writeData.snapshots && Array.isArray(writeData.snapshots) && writeData.snapshots.length > 1) {
        writeData.snapshots = compressSnapshots(writeData.snapshots);
    }
    fs.writeFileSync(getSessionFilePath(date), JSON.stringify(writeData, null, 2), 'utf-8');
}

export function listSessionFiles() {
    if (!fs.existsSync(OUTPUT_DIR)) return [];
    return fs
        .readdirSync(OUTPUT_DIR)
        .filter((f) => f.startsWith('monitor-') && f.endsWith('.json'))
        .map((f) => f.replace('monitor-', '').replace('.json', ''))
        .sort();
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
            console.log(
                `  📦 Compressed ${date}: ${(beforeSize / 1024 / 1024).toFixed(1)}MB → ${(afterSize / 1024 / 1024).toFixed(1)}MB (${pct}% reduction)`,
            );
            compressed++;
        } catch (err) {
            console.warn(`  ⚠️  Failed to compress ${date}: ${err.message}`);
        }
    }
    if (compressed > 0) console.log(`  📦 Compressed ${compressed} session files`);
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

// ── Config Overrides ────────────────────────────────────────────────────

export function loadConfigOverrides() {
    if (!fs.existsSync(CONFIG_OVERRIDES_PATH)) return {};
    try {
        return JSON.parse(fs.readFileSync(CONFIG_OVERRIDES_PATH, 'utf-8'));
    } catch {
        return {}; /* intentional: overrides file may not exist */
    }
}

export function saveConfigOverrides(overrides) {
    fs.writeFileSync(CONFIG_OVERRIDES_PATH, JSON.stringify(overrides, null, 2));
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
