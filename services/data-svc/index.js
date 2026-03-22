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
 * Port: 3005
 */

import 'dotenv/config';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getDb, closeDb } from './db.js';
import * as queries from './queries.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.DATA_SVC_PORT || '3005');
const OUTPUT_DIR = process.env.OUTPUT_DIR || path.resolve(__dirname, '../output');
const CONFIG_OVERRIDES_PATH = process.env.CONFIG_OVERRIDES_PATH || path.join(OUTPUT_DIR, 'config-overrides.json');

// Ensure output dir exists
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

// Initialize DB on startup
getDb();

// ── Route helpers ───────────────────────────────────────────────────────

function json(res, data, status = 200) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
}

function error(res, message, status = 400) {
    json(res, { error: message }, status);
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try { resolve(body ? JSON.parse(body) : {}); }
            catch (e) { reject(new Error('Invalid JSON')); }
        });
        req.on('error', reject);
    });
}

function parseUrl(urlStr) {
    const url = new URL(urlStr, 'http://localhost');
    return { pathname: url.pathname, params: Object.fromEntries(url.searchParams) };
}

// ── Route Matching ──────────────────────────────────────────────────────

/**
 * Match a path pattern like '/api/sessions/:id' against an actual path.
 * Returns { match: true, params: { id: 'abc' } } or { match: false }.
 */
function matchRoute(pattern, pathname) {
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

// ── Session Files ───────────────────────────────────────────────────────

function getSessionFilePath(date) {
    return path.join(OUTPUT_DIR, `monitor-${date}.json`);
}

// ── Delta Compression ───────────────────────────────────────────────────
// Snapshots are 99% identical between entries (only timestamp changes).
// Delta format: { _deltaCompressed: true, base: {...}, deltas: [{...changed fields...}] }
// This reduces 16MB files to ~1-2MB.

function compressSnapshots(snapshots) {
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

function decompressSnapshots(compressed) {
    if (!compressed || !compressed._deltaCompressed) return compressed; // already full
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

function loadSessionFile(date) {
    const filePath = getSessionFilePath(date);
    if (!fs.existsSync(filePath)) return null;
    try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        // Decompress snapshots if delta-compressed
        if (data.snapshots && data.snapshots._deltaCompressed) {
            data.snapshots = decompressSnapshots(data.snapshots);
        }
        return data;
    }
    catch { return null; }
}

function saveSessionFile(date, data) {
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

function listSessionFiles() {
    if (!fs.existsSync(OUTPUT_DIR)) return [];
    return fs.readdirSync(OUTPUT_DIR)
        .filter(f => f.startsWith('monitor-') && f.endsWith('.json'))
        .map(f => f.replace('monitor-', '').replace('.json', ''))
        .sort();
}

// Auto-compress existing session files on startup
function compressExistingFiles() {
    const dates = listSessionFiles();
    let compressed = 0;
    for (const date of dates) {
        const filePath = getSessionFilePath(date);
        try {
            const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
            // Skip if already compressed or no snapshots
            if (!raw.snapshots || !Array.isArray(raw.snapshots) || raw.snapshots.length < 2) continue;
            const beforeSize = fs.statSync(filePath).size;
            const writeData = { ...raw };
            writeData.snapshots = compressSnapshots(raw.snapshots);
            fs.writeFileSync(filePath, JSON.stringify(writeData, null, 2), 'utf-8');
            const afterSize = fs.statSync(filePath).size;
            const pct = ((1 - afterSize / beforeSize) * 100).toFixed(0);
            console.log(`  📦 Compressed ${date}: ${(beforeSize/1024/1024).toFixed(1)}MB → ${(afterSize/1024/1024).toFixed(1)}MB (${pct}% reduction)`);
            compressed++;
        } catch (err) {
            console.warn(`  ⚠️  Failed to compress ${date}: ${err.message}`);
        }
    }
    if (compressed > 0) console.log(`  📦 Compressed ${compressed} session files`);
}

// ── Spend Tracking ──────────────────────────────────────────────────────

function getSpendLogPath(date) {
    const d = date || new Date().toISOString().slice(0, 10);
    return path.join(OUTPUT_DIR, `spend-${d}.json`);
}

function getSpendData(date) {
    const p = getSpendLogPath(date);
    if (!fs.existsSync(p)) return { totalSpent: 0, orders: [] };
    try { return JSON.parse(fs.readFileSync(p, 'utf-8')); }
    catch { return { totalSpent: 0, orders: [] }; }
}

function recordSpend(date, amount, orderDetails) {
    const data = getSpendData(date);
    data.totalSpent = parseFloat((data.totalSpent + amount).toFixed(4));
    data.orders.push({
        timestamp: new Date().toISOString(),
        amount,
        ...orderDetails,
    });
    fs.writeFileSync(getSpendLogPath(date), JSON.stringify(data, null, 2));
    return data;
}

// ── Config Overrides ────────────────────────────────────────────────────

function loadConfigOverrides() {
    if (!fs.existsSync(CONFIG_OVERRIDES_PATH)) return {};
    try { return JSON.parse(fs.readFileSync(CONFIG_OVERRIDES_PATH, 'utf-8')); }
    catch { return {}; }
}

function saveConfigOverrides(overrides) {
    fs.writeFileSync(CONFIG_OVERRIDES_PATH, JSON.stringify(overrides, null, 2));
}

// ── Request Handler ─────────────────────────────────────────────────────

async function handleRequest(req, res) {
    const { pathname, params: query } = parseUrl(req.url);
    const method = req.method;

    try {
        // ── Health ───────────────────────────────────────
        if (pathname === '/health' && method === 'GET') {
            const dbPath = process.env.DB_PATH || path.join(OUTPUT_DIR, 'tempedge.db');
            const dbSize = fs.existsSync(dbPath) ? fs.statSync(dbPath).size : 0;
            return json(res, { status: 'ok', dbSizeBytes: dbSize, sessionFiles: listSessionFiles().length });
        }

        // ── Session Files ───────────────────────────────
        if (pathname === '/api/session-files' && method === 'GET') {
            return json(res, { dates: listSessionFiles() });
        }

        // ── Trade Summary (lightweight — no snapshots) ──
        if (pathname === '/api/trade-summary' && method === 'GET') {
            const dates = listSessionFiles();
            const limit = parseInt(query.limit || '15');
            const recent = dates.slice(-limit).reverse();
            const trades = [];
            for (const date of recent) {
                const data = loadSessionFile(date);
                if (!data?.buyOrder) continue;
                const latest = data.snapshots?.[data.snapshots.length - 1];
                trades.push({
                    date: data.targetDate || date,
                    buyOrder: data.buyOrder,
                    status: data.status,
                    phase: data.phase,
                    resolution: data.resolution || null,
                    latestSnapshot: latest ? {
                        timestamp: latest.timestamp,
                        target: latest.target, below: latest.below, above: latest.above,
                        forecastTempF: latest.forecastTempF,
                    } : null,
                });
            }
            return json(res, { trades });
        }

        {
            const m = matchRoute('/api/session-files/:date', pathname);
            if (m.match && method === 'GET') {
                const data = loadSessionFile(m.params.date);
                if (!data) return error(res, 'Session file not found', 404);

                // slim mode: only return the last N snapshots (avoids 16MB responses)
                if (query.slim) {
                    const limit = parseInt(query.slim) || 20;
                    if (data.snapshots && data.snapshots.length > limit) {
                        const lastSnaps = data.snapshots.slice(-limit);
                        // Strip allRanges from older snapshots to save bandwidth
                        for (const snap of lastSnaps) {
                            if (snap.allRanges && lastSnaps.indexOf(snap) < lastSnaps.length - 1) {
                                delete snap.allRanges;
                            }
                        }
                        data.snapshots = lastSnaps;
                        data._slimmed = true;
                        data._totalSnapshots = data.snapshots.length + (data.snapshots.length - limit);
                    }
                }

                return json(res, data);
            }
            if (m.match && method === 'PUT') {
                const body = await readBody(req);
                saveSessionFile(m.params.date, body);
                return json(res, { saved: true });
            }
        }

        // ── DB Sessions ─────────────────────────────────
        if (pathname === '/api/sessions' && method === 'GET') {
            const limit = parseInt(query.limit || '30');
            return json(res, queries.getAllSessions(limit));
        }

        if (pathname === '/api/sessions/active' && method === 'GET') {
            // Return sessions that are still active (for liquidity-svc discovery)
            const all = queries.getAllSessions(100);
            const active = all.filter(s => s.status === 'active');
            return json(res, active);
        }

        {
            const m = matchRoute('/api/sessions/:id', pathname);
            if (m.match && method === 'GET') {
                // Try by date first (most common), then by ID
                const session = queries.getSession('nyc', m.params.id);
                if (!session) return error(res, 'Session not found', 404);
                return json(res, session);
            }
            if (m.match && method === 'PUT') {
                const body = await readBody(req);
                queries.upsertSession(body);
                return json(res, { upserted: true });
            }
            if (m.match && method === 'PATCH') {
                const body = await readBody(req);
                queries.updateSession(m.params.id, body);
                return json(res, { updated: true });
            }
        }

        // ── Trades ──────────────────────────────────────
        if (pathname === '/api/trades' && method === 'POST') {
            const body = await readBody(req);
            const result = queries.insertTrade(body);
            return json(res, result, 201);
        }

        if (pathname === '/api/trades' && method === 'GET') {
            if (query.date) {
                return json(res, queries.getTradesForDate(query.date));
            }
            return json(res, queries.getAllTrades(parseInt(query.limit || '50')));
        }

        if (pathname === '/api/trades/log' && method === 'GET') {
            return json(res, queries.getTradeLog(parseInt(query.limit || '30')));
        }

        if (pathname === '/api/trades/pnl' && method === 'GET') {
            return json(res, queries.getPnLSummary());
        }

        {
            const m = matchRoute('/api/trades/:id', pathname);
            if (m.match && method === 'PATCH') {
                const body = await readBody(req);
                queries.updateTrade(parseInt(m.params.id), body);
                return json(res, { updated: true });
            }
        }

        // ── Positions ───────────────────────────────────
        if (pathname === '/api/positions' && method === 'POST') {
            const body = await readBody(req);
            queries.insertPositions(body.tradeId, body.positions);
            return json(res, { inserted: body.positions.length }, 201);
        }

        if (pathname === '/api/positions/active' && method === 'GET') {
            if (!query.date) return error(res, 'date parameter required');
            return json(res, queries.getActivePositions(query.date));
        }

        {
            const m = matchRoute('/api/positions/:id', pathname);
            if (m.match && method === 'GET') {
                const db = getDb();
                const pos = db.prepare(`SELECT p.*, t.target_date, t.session_id, t.market_id, t.id as trade_id FROM positions p JOIN trades t ON p.trade_id = t.id WHERE p.id = ?`).get(parseInt(m.params.id));
                if (!pos) return error(res, 'Position not found', 404);
                return json(res, pos);
            }
            if (m.match && method === 'PATCH') {
                const body = await readBody(req);
                queries.updatePosition(parseInt(m.params.id), body);
                return json(res, { updated: true });
            }
        }

        // ── Analytics (for dashboard) ───────────────────
        if (pathname === '/api/analytics' && method === 'GET') {
            const db = getDb();
            try {
                const pnlByDate = db.prepare(`SELECT t.target_date, t.market_id, SUM(CASE WHEN t.type = 'buy' THEN COALESCE(t.actual_cost, t.total_cost) ELSE 0 END) as total_bought, SUM(CASE WHEN t.type = 'sell' THEN t.total_proceeds ELSE 0 END) as total_sold, SUM(CASE WHEN t.type = 'redeem' THEN t.total_proceeds ELSE 0 END) as total_redeemed, COUNT(DISTINCT t.id) as trade_count, COUNT(DISTINCT CASE WHEN t.type = 'buy' THEN t.id END) as buy_count, COUNT(DISTINCT CASE WHEN t.type = 'sell' THEN t.id END) as sell_count FROM trades t WHERE t.status != 'failed' GROUP BY t.target_date, t.market_id ORDER BY t.target_date DESC`).all();
                const totals = { totalInvested: pnlByDate.reduce((s, r) => s + r.total_bought, 0), totalSold: pnlByDate.reduce((s, r) => s + r.total_sold, 0), totalRedeemed: pnlByDate.reduce((s, r) => s + r.total_redeemed, 0), tradingDays: pnlByDate.length, totalTrades: db.prepare("SELECT COUNT(*) as c FROM trades WHERE status != 'failed'").get().c };
                totals.realizedPnL = (totals.totalSold + totals.totalRedeemed) - totals.totalInvested;
                return json(res, { pnlByDate, totals, serverTime: new Date().toISOString() });
            } catch (err) { return error(res, err.message, 500); }
        }

        {
            const m = matchRoute('/api/positions/:id/sold', pathname);
            if (m.match && method === 'PATCH') {
                const body = await readBody(req);
                queries.markPositionSold(parseInt(m.params.id), body);
                return json(res, { sold: true });
            }
        }

        {
            const m = matchRoute('/api/positions/:id/redeemed', pathname);
            if (m.match && method === 'PATCH') {
                const body = await readBody(req);
                queries.markPositionRedeemed(parseInt(m.params.id), body);
                return json(res, { redeemed: true });
            }
        }

        // ── Snapshots ───────────────────────────────────
        if (pathname === '/api/snapshots' && method === 'POST') {
            const body = await readBody(req);
            try {
                queries.insertSnapshot(body);
            } catch (err) {
                if (err.message.includes('FOREIGN KEY') && body.sessionId) {
                    // Session ID mismatch — resolve to existing session
                    const existing = queries.getSession('nyc', body.targetDate || '');
                    if (existing) {
                        body.sessionId = existing.id;
                        queries.insertSnapshot(body);
                    } else {
                        return error(res, err.message, 409);
                    }
                } else {
                    return error(res, err.message, 409);
                }
            }
            return json(res, { inserted: true }, 201);
        }

        {
            const m = matchRoute('/api/snapshots/:sessionId', pathname);
            if (m.match && method === 'GET') {
                const limit = parseInt(query.limit || '500');
                return json(res, queries.getSnapshots(m.params.sessionId, limit));
            }
        }

        // ── Alerts ──────────────────────────────────────
        if (pathname === '/api/alerts' && method === 'POST') {
            const body = await readBody(req);
            try {
                queries.insertAlert(body);
            } catch (err) {
                if (err.message.includes('FOREIGN KEY') && body.sessionId) {
                    const existing = queries.getSession('nyc', body.targetDate || '');
                    if (existing) {
                        body.sessionId = existing.id;
                        queries.insertAlert(body);
                    } else {
                        return error(res, err.message, 409);
                    }
                } else {
                    return error(res, err.message, 409);
                }
            }
            return json(res, { inserted: true }, 201);
        }

        // ── Spend Tracking ──────────────────────────────
        if (pathname === '/api/spend' && method === 'GET') {
            const date = query.date || new Date().toISOString().slice(0, 10);
            return json(res, getSpendData(date));
        }

        if (pathname === '/api/spend' && method === 'POST') {
            const body = await readBody(req);
            const result = recordSpend(body.date, body.amount, body.details || {});
            return json(res, result, 201);
        }

        // ── Config Overrides ────────────────────────────
        if (pathname === '/api/config/overrides' && method === 'GET') {
            return json(res, loadConfigOverrides());
        }

        if (pathname === '/api/config/overrides' && method === 'PUT') {
            const body = await readBody(req);
            saveConfigOverrides(body);
            return json(res, { saved: true });
        }

        {
            const m = matchRoute('/api/config/overrides/:section/:field', pathname);
            if (m.match && method === 'DELETE') {
                const overrides = loadConfigOverrides();
                if (overrides[m.params.section]) {
                    delete overrides[m.params.section][m.params.field];
                    if (Object.keys(overrides[m.params.section]).length === 0) {
                        delete overrides[m.params.section];
                    }
                    saveConfigOverrides(overrides);
                }
                return json(res, { reset: true });
            }
        }

        if (pathname === '/api/config/overrides' && method === 'DELETE') {
            saveConfigOverrides({});
            return json(res, { resetAll: true });
        }

        // ── Full Config (defaults + overrides) ──────────
        if (pathname === '/api/config' && method === 'GET') {
            const overrides = loadConfigOverrides();
            // Merge overrides on top of defaults
            const defaults = {
                monitor: {
                    intervalMinutes: 15,
                    rebalanceThreshold: 3,
                    forecastShiftThreshold: 2,
                    priceSpikeThreshold: 0.05,
                    buyHourEST: 7,
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
                trading: {},
            };
            for (const section of Object.keys(overrides)) {
                if (!defaults[section]) defaults[section] = {};
                Object.assign(defaults[section], overrides[section]);
            }
            return json(res, defaults);
        }

        // ── DB Sessions (upsert via POST) ───────────────
        if (pathname === '/api/db/sessions' && method === 'POST') {
            const body = await readBody(req);
            try {
                const result = queries.upsertSession(body);
                return json(res, { upserted: true, existingId: result?.existingId || null }, 201);
            } catch (err) {
                console.error(`❌ POST /api/db/sessions: ${err.message}`);
                return error(res, err.message, 409);
            }
        }

        // ── Restart Signal ──────────────────────────────
        if (pathname === '/api/restart-signal' && method === 'GET') {
            const signalPath = path.join(OUTPUT_DIR, '.restart-requested');
            const requested = fs.existsSync(signalPath);
            return json(res, { requested });
        }
        if (pathname === '/api/restart-signal' && method === 'DELETE') {
            const signalPath = path.join(OUTPUT_DIR, '.restart-requested');
            if (fs.existsSync(signalPath)) {
                try { fs.unlinkSync(signalPath); } catch { }
            }
            return json(res, { cleared: true });
        }
        if (pathname === '/api/restart-signal' && method === 'POST') {
            const signalPath = path.join(OUTPUT_DIR, '.restart-requested');
            fs.writeFileSync(signalPath, new Date().toISOString());
            return json(res, { signaled: true }, 201);
        }

        // ── Markets ─────────────────────────────────────
        if (pathname === '/api/markets' && method === 'GET') {
            return json(res, queries.getActiveMarkets());
        }

        // ── Forecast Accuracy ───────────────────────────
        if (pathname === '/api/forecast-accuracy' && method === 'GET') {
            return json(res, queries.getForecastAccuracy());
        }

        // ── 404 ─────────────────────────────────────────
        error(res, `Not found: ${method} ${pathname}`, 404);

    } catch (err) {
        console.error(`❌ ${method} ${pathname}:`, err.message);
        error(res, err.message, 500);
    }
}

// ── Server ──────────────────────────────────────────────────────────────

const server = http.createServer(handleRequest);

server.listen(PORT, () => {
    console.log(`\n📦 TempEdge Data Service`);
    console.log(`   Port:       ${PORT}`);
    console.log(`   Output dir: ${OUTPUT_DIR}`);
    console.log(`   Sessions:   ${listSessionFiles().length} files`);
    compressExistingFiles();
    console.log(`   Ready.\n`);
});

// Graceful shutdown
function shutdown() {
    console.log('\n📦 Shutting down data-svc...');
    closeDb();
    server.close();
    process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
