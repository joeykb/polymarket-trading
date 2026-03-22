/**
 * TempEdge Dashboard — HTTP Server (Microservice Edition)
 *
 * No direct DB access, no filesystem I/O, no trading.js imports.
 * All data comes from:
 *   - data-svc (sessions, trades, config, analytics)
 *   - trading-svc (retry, sell)
 *   - liquidity-svc (order book data)
 *
 * Port: 3000
 */

import 'dotenv/config';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { services } from '../../shared/services.js';
import {
    loadSessionData, listAvailableDates, fetchLiquidityData,
    fetchLiquidityBids, globalCurrentTemp,
    getConfigSnapshot, updateConfig, resetConfigValue, resetAllOverrides,
    signalRestart,
} from './data.js';
import { overlayLivePrices, enrichBuyOrderWithDbIds, computeLivePnL } from './pnl.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const STATIC_DIR = path.join(__dirname, 'static');

const DATA_SVC = services.dataSvc;
const TRADING_SVC = services.tradingSvc;
const LIQUIDITY_SVC = services.liquiditySvc;

// ── MIME types ──────────────────────────────────────────────────────────

const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
};

// ── Date utilities (inlined) ────────────────────────────────────────────

function getTodayET() {
    return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

function getDateOffsetET(offset) {
    const d = new Date();
    d.setDate(d.getDate() + offset);
    return d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

function getTomorrowET() { return getDateOffsetET(1); }
function getTargetDateET() { return getDateOffsetET(2); }

function daysUntil(dateStr) {
    const today = getTodayET();
    const target = new Date(dateStr + 'T12:00:00');
    const now = new Date(today + 'T12:00:00');
    return Math.round((target - now) / (1000 * 60 * 60 * 24));
}

function getPhase(targetDate) {
    const days = daysUntil(targetDate);
    if (days <= 0) return 'resolve';
    if (days === 1) return 'monitor';
    if (days === 2) return 'buy';
    if (days === 3) return 'track';
    return 'scout';
}

// ── CLI Arguments ───────────────────────────────────────────────────────

const args = process.argv.slice(2);
let port = parseInt(process.env.DASHBOARD_PORT || '3000');
let targetDate = null;

for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' && args[i + 1]) { port = parseInt(args[i + 1]); i++; }
    else if (args[i] === '--date' && args[i + 1]) { targetDate = args[i + 1]; i++; }
    else if (/^\d{4}-\d{2}-\d{2}$/.test(args[i])) { targetDate = args[i]; }
}
if (!targetDate) targetDate = getTargetDateET();

// ── Helpers ─────────────────────────────────────────────────────────────

function json(res, data, status = 200) {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(data));
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch { reject(new Error('Invalid JSON')); } });
        req.on('error', reject);
    });
}

async function svcPost(base, path, body) {
    const res = await fetch(`${base}${path}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(60000),
    });
    return res.json();
}

// ── Config (loaded from data-svc on startup + cached) ───────────────────

let _cachedConfig = null;
let _configFetchedAt = 0;

async function getCachedConfig() {
    if (_cachedConfig && (Date.now() - _configFetchedAt) < 30000) return _cachedConfig;
    _cachedConfig = await getConfigSnapshot() || {};
    _configFetchedAt = Date.now();
    return _cachedConfig;
}

// ── Static file serving ─────────────────────────────────────────────────

async function serveStaticFile(filePath, res) {
    const ext = path.extname(filePath);
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    try {
        let content = fs.readFileSync(filePath);

        if (filePath.endsWith('index.html')) {
            const cfg = await getCachedConfig();
            let html = content.toString('utf-8');
            html = html.replace('{{DEFAULT_DATE}}', targetDate);
            html = html.replace('{{REFRESH_INTERVAL}}', String(cfg.dashboard?.refreshInterval || 30000));
            html = html.replace('{{LIQUIDITY_POLL_MS}}', String(cfg.dashboard?.liquidityPollMs || 10000));
            html = html.replace('{{MANUAL_SELL_ENABLED}}', cfg.dashboard?.manualSellEnabled ? 'true' : 'false');
            content = html;
        }

        res.writeHead(200, { 'Content-Type': contentType });
        res.end(content);
    } catch {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
    }
}

// ── HTTP Server ─────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);

    try {

        // ─── API: GET /api/status ───────────────────────────────────
        if (url.pathname === '/api/status') {
            const date = url.searchParams.get('date') || targetDate;
            const session = await loadSessionData(date);
            const liveData = await fetchLiquidityData(date);
            const latestSnap = session?.snapshots?.[session.snapshots.length - 1] || null;
            if (latestSnap) overlayLivePrices(latestSnap, liveData);
            if (session) session.pnl = computeLivePnL(session.buyOrder, latestSnap, liveData.bids);
            const cfg = await getCachedConfig();

            let sessionLight = null;
            if (session) {
                const recentSnaps = session.snapshots ? session.snapshots.slice(-20) : [];
                sessionLight = {
                    id: session.id, status: session.status, phase: session.phase,
                    initialForecastTempF: session.initialForecastTempF,
                    initialTargetRange: session.initialTargetRange,
                    forecastSource: session.forecastSource,
                    rebalanceThreshold: session.rebalanceThreshold,
                    resolution: session.resolution || null,
                    buyOrder: await enrichBuyOrderWithDbIds(session.buyOrder, date),
                    manualSellEnabled: !!cfg.dashboard?.manualSellEnabled,
                    pnl: session.pnl,
                    redeemExecuted: session.redeemExecuted || false,
                    redeemResult: session.redeemResult || null,
                    awaitingLiquidity: session.awaitingLiquidity || false,
                    liquidityWaitStart: session.liquidityWaitStart || null,
                    snapshots: recentSnaps, alerts: session.alerts || [],
                };
            }

            if (sessionLight?.snapshots?.length > 0 && globalCurrentTemp.tempF != null) {
                const lastSnap = sessionLight.snapshots[sessionLight.snapshots.length - 1];
                lastSnap.currentTempF = globalCurrentTemp.tempF;
                lastSnap.currentConditions = globalCurrentTemp.conditions;
                lastSnap.maxTodayF = globalCurrentTemp.maxTodayF;
            }

            return json(res, { targetDate: date, session: sessionLight, observation: null, availableDates: await listAvailableDates(), serverTime: new Date().toISOString() });
        }

        // ─── API: GET /api/snapshots ────────────────────────────────
        if (url.pathname === '/api/snapshots') {
            const date = url.searchParams.get('date') || targetDate;
            const session = await loadSessionData(date);
            return json(res, session?.snapshots || []);
        }

        // ─── API: GET /api/portfolio ────────────────────────────────
        if (url.pathname === '/api/portfolio') {
            const portfolioDates = [getTodayET(), getTomorrowET(), getTargetDateET()];
            const cfg = await getCachedConfig();
            const plays = await Promise.all(portfolioDates.map(async date => {
                const session = await loadSessionData(date);
                const phase = getPhase(date);
                const days = daysUntil(date);
                const latest = session?.snapshots?.[session.snapshots.length - 1] || null;
                const liveData = await fetchLiquidityData(date);
                if (latest) overlayLivePrices(latest, liveData);
                return {
                    date, phase, daysUntil: days,
                    session: session ? {
                        id: session.id, status: session.status, phase: session.phase,
                        initialForecastTempF: session.initialForecastTempF,
                        initialTargetRange: session.initialTargetRange,
                        forecastSource: session.forecastSource,
                        rebalanceThreshold: session.rebalanceThreshold,
                        snapshotCount: session.snapshots?.length || 0,
                        alertCount: session.alerts?.length || 0,
                        resolution: session.resolution || null,
                        buyOrder: await enrichBuyOrderWithDbIds(session.buyOrder, date),
                        manualSellEnabled: !!cfg.dashboard?.manualSellEnabled,
                        pnl: computeLivePnL(session.buyOrder, latest, liveData.bids),
                    } : null,
                    latest: latest ? {
                        timestamp: latest.timestamp, phase: latest.phase,
                        forecastTempF: latest.forecastTempF, forecastChange: latest.forecastChange,
                        forecastSource: latest.forecastSource,
                        currentTempF: latest.currentTempF, currentConditions: latest.currentConditions,
                        maxTodayF: latest.maxTodayF,
                        target: latest.target, below: latest.below, above: latest.above,
                        totalCost: latest.totalCost, eventClosed: latest.eventClosed,
                        daysUntilTarget: latest.daysUntilTarget, _liveOverlay: latest._liveOverlay,
                    } : null,
                    hasData: !!session,
                };
            }));

            if (globalCurrentTemp.tempF != null) {
                for (const play of plays) {
                    if (play.latest) {
                        play.latest.currentTempF = globalCurrentTemp.tempF;
                        play.latest.currentConditions = globalCurrentTemp.conditions;
                        play.latest.maxTodayF = globalCurrentTemp.maxTodayF;
                    }
                }
            }

            return json(res, { plays, availableDates: await listAvailableDates(), serverTime: new Date().toISOString() });
        }

        // ─── API: GET /api/dates ────────────────────────────────────
        if (url.pathname === '/api/dates') {
            return json(res, await listAvailableDates());
        }

        // ─── API: GET /api/trades ───────────────────────────────────
        if (url.pathname === '/api/trades') {
            try {
                // Single call to data-svc for lightweight trade summaries
                const summaryRes = await fetch(`${DATA_SVC}/api/trade-summary?limit=15`, { signal: AbortSignal.timeout(15000) });
                if (!summaryRes.ok) throw new Error('trade-summary failed');
                const { trades: summaries } = await summaryRes.json();

                const trades = [];
                for (const s of summaries) {
                    const bo = s.buyOrder;
                    if (!bo) continue;

                    // Only fetch live liquidity for active sessions
                    let pnl = null;
                    if (s.status === 'active') {
                        try {
                            const liquidityBids = await fetchLiquidityBids(s.date);
                            pnl = computeLivePnL(bo, s.latestSnapshot, liquidityBids);
                        } catch { }
                    }

                    trades.push({
                        date: s.date, placedAt: bo.placedAt,
                        mode: bo.mode || (bo.simulated ? 'dry-run' : 'live'),
                        positions: (bo.positions || []).map(p => ({
                            label: p.label, question: p.question, buyPrice: p.buyPrice,
                            shares: p.shares, status: p.status || 'placed',
                            orderId: p.orderId || null, error: p.error || null,
                            positionId: p.positionId || p.dbPositionId || null,
                            soldAt: p.soldAt || null, soldStatus: p.soldStatus || null,
                            sellPrice: (p.soldAt && p.soldStatus === 'placed') ? (typeof p.soldAt === 'number' ? p.soldAt : parseFloat(p.soldAt) || 0) : null,
                        })),
                        totalCost: bo.totalCost, maxProfit: bo.maxProfit,
                        pnl: pnl ? { totalPnL: pnl.totalPnL, totalPnLPct: pnl.totalPnLPct, totalBuyCost: pnl.totalBuyCost, totalCurrentValue: pnl.totalCurrentValue } : null,
                        sessionStatus: s.status, phase: s.phase || getPhase(s.date),
                        resolution: s.resolution ? { keep: s.resolution.keep, discardLabels: s.resolution.discardLabels } : null,
                    });
                }

                return json(res, { trades, count: trades.length, serverTime: new Date().toISOString(), source: 'session' });
            } catch (err) {
                console.error('❌ /api/trades error:', err.message);
                return json(res, { trades: [], count: 0, serverTime: new Date().toISOString(), error: err.message });
            }
        }

        // ─── API: GET /api/analytics ────────────────────────────────
        if (url.pathname === '/api/analytics') {
            try {
                const analyticsRes = await fetch(`${DATA_SVC}/api/forecast-accuracy`, { signal: AbortSignal.timeout(10000) });
                if (analyticsRes.ok) return json(res, await analyticsRes.json());
            } catch { }
            return json(res, { pnlByDate: [], totals: {} });
        }

        // ─── API: GET /api/pipeline ─────────────────────────────────
        if (url.pathname === '/api/pipeline') {
            const pipeline = [];
            const dates = await listAvailableDates();
            for (const date of dates) {
                const session = await loadSessionData(date);
                if (!session) continue;
                const phase = session.phase || getPhase(date);
                if (phase !== 'scout' && phase !== 'track') continue;
                pipeline.push({
                    date, phase,
                    forecastHistory: session.forecastHistory || [],
                    trend: session.trend || null,
                    latestForecast: session.snapshots?.length ? session.snapshots[session.snapshots.length - 1].forecastTempF : null,
                    targetRange: session.snapshots?.length ? session.snapshots[session.snapshots.length - 1].target?.question?.match(/(\d+-\d+)/)?.[1] || null : null,
                });
            }
            return json(res, { pipeline });
        }

        // ─── API: GET /api/liquidity (proxy) ────────────────────────
        if (url.pathname === '/api/liquidity') {
            const date = url.searchParams.get('date');
            const liqUrl = date ? `${LIQUIDITY_SVC}/api/liquidity?date=${date}` : `${LIQUIDITY_SVC}/api/liquidity`;
            try {
                const liqRes = await fetch(liqUrl, { signal: AbortSignal.timeout(3000) });
                if (liqRes.ok) {
                    const data = await liqRes.json();
                    return json(res, data);
                }
            } catch { }
            return json(res, { status: 'service-unavailable', tokens: [], tokenCount: 0, timestamp: new Date().toISOString() });
        }

        // ─── API: GET /api/config ───────────────────────────────────
        if (url.pathname === '/api/config' && req.method === 'GET') {
            const config = await getConfigSnapshot();
            return json(res, { config, serverTime: new Date().toISOString() });
        }

        // ─── API: PUT /api/config ───────────────────────────────────
        if (url.pathname === '/api/config' && req.method === 'PUT') {
            const body = await readBody(req);
            const result = await updateConfig(body);
            _cachedConfig = null; // bust cache
            const config = await getConfigSnapshot();
            return json(res, { success: true, ...result, config });
        }

        // ─── API: DELETE /api/config/reset/:section/:field ──────────
        if (url.pathname.startsWith('/api/config/reset/') && req.method === 'DELETE') {
            const parts = url.pathname.replace('/api/config/reset/', '').split('/');
            if (parts.length === 2) {
                await resetConfigValue(parts[0], parts[1]);
                _cachedConfig = null;
                const config = await getConfigSnapshot();
                return json(res, { success: true, config });
            }
            return json(res, { error: 'Invalid path' }, 400);
        }

        // ─── API: DELETE /api/config/reset ──────────────────────────
        if (url.pathname === '/api/config/reset' && req.method === 'DELETE') {
            await resetAllOverrides();
            _cachedConfig = null;
            const config = await getConfigSnapshot();
            return json(res, { success: true, config });
        }

        // ─── API: POST /api/retry-position → trading-svc ────────────
        if (url.pathname === '/api/retry-position' && req.method === 'POST') {
            const body = await readBody(req);
            if (!body.positionId) return json(res, { success: false, error: 'positionId is required' }, 400);

            // Look up position data from the session (via data-svc)
            let position = body;
            if (!position.question) {
                // Need to get position details — the frontend might only send positionId
                // Fetch from data-svc
                try {
                    const posRes = await fetch(`${DATA_SVC}/api/positions/${body.positionId}`, { signal: AbortSignal.timeout(5000) });
                    if (posRes.ok) position = { ...body, ...(await posRes.json()) };
                } catch { }
            }

            // Forward to trading-svc
            try {
                const result = await svcPost(TRADING_SVC, '/api/retry', { position, liqTokenData: null });
                return json(res, result);
            } catch (err) {
                return json(res, { success: false, error: err.message }, 500);
            }
        }

        // ─── API: POST /api/sell-position → trading-svc ─────────────
        if (url.pathname === '/api/sell-position' && req.method === 'POST') {
            const cfg = await getCachedConfig();
            if (!cfg.dashboard?.manualSellEnabled) {
                return json(res, { success: false, error: 'Manual sell is disabled' }, 403);
            }

            const body = await readBody(req);
            if (!body.positionId) return json(res, { success: false, error: 'positionId is required' }, 400);

            // Get position details from session data
            let position = body;
            if (!position.question) {
                try {
                    const posRes = await fetch(`${DATA_SVC}/api/positions/${body.positionId}`, { signal: AbortSignal.timeout(5000) });
                    if (posRes.ok) position = { ...body, ...(await posRes.json()) };
                } catch { }
            }

            // Resolve token IDs from session snapshot if needed
            if (!position.clobTokenId && position.target_date) {
                const session = await loadSessionData(position.target_date);
                if (session) {
                    const latestSnap = session.snapshots?.[session.snapshots.length - 1];
                    if (latestSnap) {
                        for (const rangeKey of ['target', 'below', 'above']) {
                            const range = latestSnap[rangeKey];
                            if (range && range.question === position.question) {
                                position.conditionId = position.conditionId || range.conditionId;
                                position.clobTokenId = range.clobTokenIds?.[0];
                                break;
                            }
                        }
                    }
                }
            }

            // Forward to trading-svc
            try {
                const sellResult = await svcPost(TRADING_SVC, '/api/sell', {
                    positions: [{
                        label: position.label, question: position.question,
                        clobTokenId: position.clobTokenId || position.token_id,
                        conditionId: position.conditionId || position.condition_id,
                        shares: position.shares || 1,
                    }],
                    context: {
                        sessionId: position.session_id,
                        targetDate: position.target_date,
                        marketId: position.market_id || 'nyc',
                    },
                });

                if (sellResult?.positions?.length > 0) {
                    const soldPos = sellResult.positions[0];
                    if (soldPos.status === 'filled' || soldPos.status === 'placed') {
                        return json(res, { success: true, sellPrice: soldPos.sellPrice, proceeds: sellResult.totalProceeds, orderId: soldPos.orderId });
                    }
                    return json(res, { success: false, error: soldPos.error || 'Sell order did not fill' });
                }
                return json(res, { success: false, error: 'Sell returned no results' });
            } catch (err) {
                return json(res, { success: false, error: err.message }, 500);
            }
        }

        // ─── API: POST /api/restart → data-svc ─────────────────────
        if (url.pathname === '/api/restart' && req.method === 'POST') {
            const success = await signalRestart();
            return json(res, { success, message: success ? 'Restart signal sent.' : 'Failed' });
        }

        // ─── CORS preflight ─────────────────────────────────────────
        if (req.method === 'OPTIONS') {
            res.writeHead(204, {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type',
            });
            res.end();
            return;
        }

        // ─── Static files ───────────────────────────────────────────
        if (url.pathname === '/' || url.pathname === '/index.html') {
            await serveStaticFile(path.join(STATIC_DIR, 'index.html'), res); return;
        }
        if (url.pathname === '/admin') {
            await serveStaticFile(path.join(STATIC_DIR, 'admin.html'), res); return;
        }
        if (url.pathname.startsWith('/static/')) {
            const relativePath = url.pathname.slice('/static/'.length);
            if (relativePath.includes('..') || relativePath.includes('\\')) {
                res.writeHead(403, { 'Content-Type': 'text/plain' }); res.end('Forbidden'); return;
            }
            await serveStaticFile(path.join(STATIC_DIR, ...relativePath.split('/')), res); return;
        }

        // ─── 404 ────────────────────────────────────────────────────
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');

    } catch (err) {
        console.error(`❌ ${req.method} ${url.pathname}:`, err.message);
        json(res, { error: err.message }, 500);
    }
});

server.listen(port, () => {
    console.log(`\n🌡️  TempEdge Dashboard (Microservice Edition)`);
    console.log('═══════════════════════════════════════');
    console.log(`  URL:       http://localhost:${port}`);
    console.log(`  Date:      ${targetDate}`);
    console.log(`  Data:      ${DATA_SVC}`);
    console.log(`  Trading:   ${TRADING_SVC}`);
    console.log(`  Liquidity: ${LIQUIDITY_SVC}`);
    console.log(`  Static:    ${STATIC_DIR}`);
    console.log('═══════════════════════════════════════\n');
});
