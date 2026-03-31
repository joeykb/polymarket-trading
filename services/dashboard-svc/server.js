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
import { createLogger, requestLogger } from '../../shared/logger.js';
import { getTodayET, getTargetDateET, getTomorrowET, daysUntil, getPhase, getTodayInTz, getDateOffsetInTz, getPhaseInTz } from '../../shared/dates.js';
import { jsonResponse as json, readJsonBody as readBody, handleCors } from '../../shared/httpServer.js';
import { createClient } from '../../shared/httpClient.js';
import { healthResponse, checkDependencies } from '../../shared/health.js';
import { createMetrics, createHttpMetrics } from '../../shared/metrics.js';
import { SERVICE_AUTH_HEADER } from '../../shared/serviceAuth.js';

const metrics = createMetrics('dashboard_svc');
const { wrapHandler } = createHttpMetrics(metrics);
import {
    loadSessionData,
    listAvailableDates,
    fetchLiquidityData,
    fetchLiquidityBids,
    fetchMarkets,
    invalidateMarketsCache,
    fetchSpendData,
    globalCurrentTemp,
    getConfigSnapshot,
    updateConfig,
    resetConfigValue,
    resetAllOverrides,
    signalRestart,
} from './data.js';
import { overlayLivePrices, enrichBuyOrderWithDbIds, computeLivePnL } from './pnl.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const STATIC_DIR = path.join(__dirname, 'static');

const DATA_SVC = services.dataSvc;
const TRADING_SVC = services.tradingSvc;
const LIQUIDITY_SVC = services.liquiditySvc;
const SERVICE_AUTH_KEY = process.env.SERVICE_AUTH_KEY || '';

/** Build headers for write operations (include service auth key if configured). */
function proxyWriteHeaders() {
    const h = { 'Content-Type': 'application/json' };
    if (SERVICE_AUTH_KEY) h[SERVICE_AUTH_HEADER] = SERVICE_AUTH_KEY;
    return h;
}

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

// (Date utilities now imported from shared/dates.js)

// ── CLI Arguments ───────────────────────────────────────────────────────

const args = process.argv.slice(2);
let port = parseInt(process.env.DASHBOARD_PORT || '3000');
let targetDate = null;

for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' && args[i + 1]) {
        port = parseInt(args[i + 1]);
        i++;
    } else if (args[i] === '--date' && args[i + 1]) {
        targetDate = args[i + 1];
        i++;
    } else if (/^\d{4}-\d{2}-\d{2}$/.test(args[i])) {
        targetDate = args[i];
    }
}
if (!targetDate) targetDate = getTargetDateET();

// (HTTP helpers now imported from shared/httpServer.js)

const tradingClient = createClient(TRADING_SVC);

// ── Config (loaded from data-svc on startup + cached) ───────────────────

let _cachedConfig = null;
let _configFetchedAt = 0;

async function getCachedConfig() {
    if (_cachedConfig && Date.now() - _configFetchedAt < 30000) return _cachedConfig;
    _cachedConfig = (await getConfigSnapshot()) || {};
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
        /* intentional: file not found → 404 */
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
    }
}

// ── HTTP Server ─────────────────────────────────────────────────────────

const server = http.createServer(
    wrapHandler(requestLogger(createLogger('dashboard-svc-http'), async (req, res) => {
        const url = new URL(req.url, `http://localhost:${port}`);

        try {
            // ─── Metrics ──────────────────────────────────────────────
            if (url.pathname === '/metrics') {
                return metrics.handleRequest(res);
            }

            // ─── Health Check ──────────────────────────────────────────
            if (url.pathname === '/health') {
                const deps = await checkDependencies({
                    dataSvc: DATA_SVC,
                    tradingSvc: TRADING_SVC,
                    liquiditySvc: LIQUIDITY_SVC,
                });
                return json(res, healthResponse('dashboard-svc', { dependencies: deps }));
            }

            // ─── API: GET /api/status ───────────────────────────────────
            if (url.pathname === '/api/status') {
                const date = url.searchParams.get('date') || targetDate;
                const marketId = url.searchParams.get('market') || 'nyc';
                const session = await loadSessionData(date, marketId);
                const liveData = await fetchLiquidityData(date, marketId);
                const latestSnap = session?.snapshots?.[session.snapshots.length - 1] || null;
                if (latestSnap) overlayLivePrices(latestSnap, liveData);
                if (session) session.pnl = computeLivePnL(session.buyOrder, latestSnap, liveData.bids);
                const cfg = await getCachedConfig();

                let sessionLight = null;
                if (session) {
                    const recentSnaps = session.snapshots ? session.snapshots.slice(-20) : [];
                    sessionLight = {
                        id: session.id,
                        marketId: session.marketId || marketId,
                        status: session.status,
                        phase: session.phase,
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
                        lastEdge: session.lastEdge || null,
                        trajectory: session.trajectory || null,
                        snapshots: recentSnaps,
                        alerts: session.alerts || [],
                    };
                }

                if (marketId === 'nyc' && sessionLight?.snapshots?.length > 0 && globalCurrentTemp.tempF != null) {
                    const lastSnap = sessionLight.snapshots[sessionLight.snapshots.length - 1];
                    lastSnap.currentTempF = globalCurrentTemp.tempF;
                    lastSnap.currentConditions = globalCurrentTemp.conditions;
                    lastSnap.maxTodayF = globalCurrentTemp.maxTodayF;
                }

                const allSessions = await listAvailableDates(marketId);
                const availableDates = [...new Set(allSessions.map(s => s.date))].sort().reverse();

                return json(res, {
                    targetDate: date,
                    marketId,
                    session: sessionLight,
                    observation: null,
                    availableDates,
                    serverTime: new Date().toISOString(),
                });
            }

            // ─── API: GET /api/snapshots ────────────────────────────────
            if (url.pathname === '/api/snapshots') {
                const date = url.searchParams.get('date') || targetDate;
                const session = await loadSessionData(date);
                return json(res, session?.snapshots || []);
            }

            // ─── API: GET /api/portfolio ────────────────────────────────
            if (url.pathname === '/api/portfolio') {
                const marketFilter = url.searchParams.get('market') || 'all';
                const markets = await fetchMarkets(); // already filtered to active=1 from DB
                const cfg = await getCachedConfig(); // still needed for manualSellEnabled

                // If no markets in DB yet, fall back to NYC-only
                const marketsToUse = markets.length > 0
                    ? (marketFilter !== 'all' ? markets.filter(m => m.id === marketFilter) : markets)
                    : [{ id: 'nyc', name: 'NYC Temperature', unit: 'F', timezone: 'America/New_York' }];

                const allPlays = [];
                for (const market of marketsToUse) {
                    const tz = market.timezone || 'America/New_York';
                    const isNY = tz === 'America/New_York';
                    const portfolioDates = isNY
                        ? [getTodayET(), getTomorrowET(), getTargetDateET()]
                        : [getDateOffsetInTz(0, tz), getDateOffsetInTz(1, tz), getDateOffsetInTz(2, tz)];

                    for (const date of portfolioDates) {
                        const session = await loadSessionData(date, market.id);
                        const phase = isNY ? getPhase(date) : getPhaseInTz(date, tz);
                        const days = daysUntil(date);
                        const latest = session?.snapshots?.[session.snapshots.length - 1] || null;
                        const liveData = await fetchLiquidityData(date, market.id);
                        if (latest) overlayLivePrices(latest, liveData);

                        allPlays.push({
                            date,
                            marketId: market.id,
                            marketName: market.name || market.id.toUpperCase(),
                            unit: market.unit || 'F',
                            timezone: tz,
                            phase,
                            daysUntil: days,
                            session: session ? {
                                id: session.id,
                                status: session.status,
                                phase: session.phase,
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
                                lastEdge: session.lastEdge || null,
                                trajectory: session.trajectory || null,
                            } : null,
                            latest: latest ? {
                                timestamp: latest.timestamp,
                                phase: latest.phase,
                                forecastTempF: latest.forecastTempF,
                                forecastChange: latest.forecastChange,
                                forecastSource: latest.forecastSource,
                                currentTempF: latest.currentTempF,
                                currentConditions: latest.currentConditions,
                                maxTodayF: latest.maxTodayF,
                                target: latest.target,
                                below: latest.below,
                                above: latest.above,
                                totalCost: latest.totalCost,
                                eventClosed: latest.eventClosed,
                                daysUntilTarget: latest.daysUntilTarget,
                                _liveOverlay: latest._liveOverlay,
                            } : null,
                            hasData: !!session,
                        });
                    }
                }

                // Apply NYC current temp overlay
                if (globalCurrentTemp.tempF != null) {
                    for (const play of allPlays) {
                        if (play.marketId === 'nyc' && play.latest) {
                            play.latest.currentTempF = globalCurrentTemp.tempF;
                            play.latest.currentConditions = globalCurrentTemp.conditions;
                            play.latest.maxTodayF = globalCurrentTemp.maxTodayF;
                        }
                    }
                }

                // Fetch spend data
                const spend = await fetchSpendData();

                return json(res, {
                    plays: allPlays,
                    markets: markets.map(m => ({ id: m.id, name: m.name, unit: m.unit, timezone: m.timezone })),
                    spend,
                    serverTime: new Date().toISOString(),
                });
            }

            // ─── API: GET /api/markets ─────────────────────────────────
            if (url.pathname === '/api/markets' && req.method === 'GET') {
                return json(res, await fetchMarkets());
            }

            // ─── API: GET /api/markets/all (admin — includes inactive) ───
            if (url.pathname === '/api/markets/all' && req.method === 'GET') {
                try {
                    const proxyRes = await fetch(`${DATA_SVC}/api/markets/all`, { signal: AbortSignal.timeout(5000) });
                    if (proxyRes.ok) return json(res, await proxyRes.json());
                } catch {}
                return json(res, await fetchMarkets()); // fallback
            }

            // ─── API: POST /api/markets (admin — create new market) ──────
            if (url.pathname === '/api/markets' && req.method === 'POST') {
                const body = await readBody(req);
                try {
                    const proxyRes = await fetch(`${DATA_SVC}/api/markets`, {
                        method: 'POST',
                        headers: proxyWriteHeaders(),
                        body: JSON.stringify(body),
                        signal: AbortSignal.timeout(5000),
                    });
                    const data = await proxyRes.json();
                    return json(res, data, proxyRes.status);
                } catch (err) {
                    return json(res, { error: err.message }, 502);
                }
            }

            // ─── API: PUT /api/markets/:id (admin update) ────────────────
            {
                const mktMatch = url.pathname.match(/^\/api\/markets\/([a-z0-9_-]+)$/);
                if (mktMatch && req.method === 'PUT') {
                    const body = await readBody(req);
                    try {
                        const proxyRes = await fetch(`${DATA_SVC}/api/markets/${mktMatch[1]}`, {
                            method: 'PUT',
                            headers: proxyWriteHeaders(),
                            body: JSON.stringify(body),
                            signal: AbortSignal.timeout(5000),
                        });
                        if (proxyRes.ok) {
                            invalidateMarketsCache(); // bust cache so dashboard reflects toggle immediately
                            return json(res, await proxyRes.json());
                        }
                        return json(res, { error: `data-svc ${proxyRes.status}` }, proxyRes.status);
                    } catch (err) {
                        return json(res, { error: err.message }, 502);
                    }
                }
            }

            // ─── API: GET /api/spend ──────────────────────────────────
            if (url.pathname === '/api/spend') {
                return json(res, await fetchSpendData());
            }

            // ─── API: GET /api/dates ────────────────────────────────────
            if (url.pathname === '/api/dates') {
                return json(res, await listAvailableDates());
            }

            // ─── API: GET /api/trades ───────────────────────────────────
            if (url.pathname === '/api/trades') {
                try {
                    // Forward market filter if provided
                    const marketFilter = url.searchParams.get('market') || '';
                    const summaryUrl = `${DATA_SVC}/api/trade-summary?limit=15${marketFilter ? '&market=' + encodeURIComponent(marketFilter) : ''}`;
                    // Single call to data-svc for lightweight trade summaries
                    const summaryRes = await fetch(summaryUrl, { signal: AbortSignal.timeout(15000) });
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
                                const liquidityBids = await fetchLiquidityBids(s.date, s.marketId);
                                pnl = computeLivePnL(bo, s.latestSnapshot, liquidityBids);
                            } catch {
                                /* intentional: liquidity fetch best-effort */
                            }
                        }

                        trades.push({
                            date: s.date,
                            marketId: s.marketId || 'nyc',
                            placedAt: bo.placedAt,
                            mode: bo.mode || (bo.simulated ? 'dry-run' : 'live'),
                            positions: (bo.positions || []).map((p) => ({
                                label: p.label,
                                question: p.question,
                                buyPrice: p.buyPrice,
                                shares: p.shares,
                                status: p.status || 'placed',
                                orderId: p.orderId || null,
                                error: p.error || null,
                                positionId: p.positionId || p.dbPositionId || null,
                                soldAt: p.soldAt || null,
                                soldStatus: p.soldStatus || null,
                                sellPrice: p.sellPrice || (p.sellProceeds && p.shares ? p.sellProceeds / p.shares : null),
                            })),
                            totalCost: bo.totalCost,
                            maxProfit: bo.maxProfit,
                            pnl: pnl
                                ? {
                                      totalPnL: pnl.totalPnL,
                                      totalPnLPct: pnl.totalPnLPct,
                                      totalBuyCost: pnl.totalBuyCost,
                                      totalCurrentValue: pnl.totalCurrentValue,
                                  }
                                : null,
                            sessionStatus: s.status,
                            phase: s.phase || getPhase(s.date),
                            resolution: s.resolution ? { keep: s.resolution.keep, discardLabels: s.resolution.discardLabels } : null,
                        });
                    }

                    return json(res, { trades, count: trades.length, serverTime: new Date().toISOString(), source: 'session' });
                } catch (err) {
                    log.error('trades_error', { error: err.message });
                    return json(res, { trades: [], count: 0, serverTime: new Date().toISOString(), error: err.message });
                }
            }

            // ─── API: GET /api/analytics ────────────────────────────────
            if (url.pathname === '/api/analytics') {
                try {
                    const analyticsRes = await fetch(`${DATA_SVC}/api/forecast-accuracy`, { signal: AbortSignal.timeout(10000) });
                    if (analyticsRes.ok) return json(res, await analyticsRes.json());
                } catch {
                    /* intentional: analytics proxy best-effort */
                }
                return json(res, { pnlByDate: [], totals: {} });
            }

            // ─── API: GET /api/analytics/performance → data-svc ─────
            if (url.pathname === '/api/analytics/performance') {
                try {
                    const from = url.searchParams.get('from') || '';
                    const to = url.searchParams.get('to') || '';
                    const qs = [from && `from=${from}`, to && `to=${to}`].filter(Boolean).join('&');
                    const perfUrl = `${DATA_SVC}/api/analytics/performance${qs ? '?' + qs : ''}`;
                    const perfRes = await fetch(perfUrl, { signal: AbortSignal.timeout(15000) });
                    if (perfRes.ok) return json(res, await perfRes.json());
                } catch { /* intentional: analytics proxy best-effort */ }
                return json(res, { trades: [], summary: {} });
            }

            // ─── API: GET /api/analytics/forecast-timeline/:id → data-svc
            if (url.pathname.startsWith('/api/analytics/forecast-timeline/')) {
                const sessionId = url.pathname.split('/').pop();
                try {
                    const tlRes = await fetch(`${DATA_SVC}/api/analytics/forecast-timeline/${sessionId}`, { signal: AbortSignal.timeout(10000) });
                    if (tlRes.ok) return json(res, await tlRes.json());
                } catch { /* intentional: timeline proxy best-effort */ }
                return json(res, { timeline: [] });
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
                        date,
                        phase,
                        forecastHistory: session.forecastHistory || [],
                        trend: session.trend || null,
                        latestForecast: session.snapshots?.length ? session.snapshots[session.snapshots.length - 1].forecastTempF : null,
                        targetRange: session.snapshots?.length
                            ? session.snapshots[session.snapshots.length - 1].target?.question?.match(/(\d+-\d+)/)?.[1] || null
                            : null,
                    });
                }
                return json(res, { pipeline });
            }

            // ─── API: GET /api/liquidity (proxy) ────────────────────────
            if (url.pathname === '/api/liquidity') {
                const date = url.searchParams.get('date');
                const market = url.searchParams.get('market');
                const liqParams = new URLSearchParams();
                if (date) liqParams.set('date', date);
                if (market) liqParams.set('market', market);
                const liqUrl = liqParams.toString() ? `${LIQUIDITY_SVC}/api/liquidity?${liqParams}` : `${LIQUIDITY_SVC}/api/liquidity`;
                try {
                    const liqRes = await fetch(liqUrl, { signal: AbortSignal.timeout(3000) });
                    if (liqRes.ok) {
                        const data = await liqRes.json();
                        return json(res, data);
                    }
                } catch {
                    /* intentional: liquidity proxy best-effort */
                }
                return json(res, { status: 'service-unavailable', tokens: [], tokenCount: 0, timestamp: new Date().toISOString() });
            }

            // ─── API: GET /api/config ───────────────────────────────────
            if (url.pathname === '/api/config' && req.method === 'GET') {
                const isAdmin = url.searchParams.get('admin') === '1';
                const configUrl = isAdmin ? '/api/config?admin=1' : '/api/config';
                let config = {};
                try {
                    const cfgRes = await fetch(`${DATA_SVC}${configUrl}`, { signal: AbortSignal.timeout(5000) });
                    if (cfgRes.ok) config = await cfgRes.json();
                } catch {
                    /* intentional: config fetch best-effort */
                }
                return json(res, { config, serverTime: new Date().toISOString() });
            }

            // ─── API: PUT /api/config ───────────────────────────────────
            if (url.pathname === '/api/config' && req.method === 'PUT') {
                const body = await readBody(req);
                const result = await updateConfig(body);
                _cachedConfig = null; // bust cache
                let config = {};
                try {
                    const cfgRes = await fetch(`${DATA_SVC}/api/config?admin=1`, { signal: AbortSignal.timeout(5000) });
                    if (cfgRes.ok) config = await cfgRes.json();
                } catch {
                    /* intentional: config fetch best-effort */
                }
                return json(res, { success: true, ...result, config });
            }

            // ─── API: DELETE /api/config/reset/:section/:field ──────────
            if (url.pathname.startsWith('/api/config/reset/') && req.method === 'DELETE') {
                const parts = url.pathname.replace('/api/config/reset/', '').split('/');
                if (parts.length === 2) {
                    await resetConfigValue(parts[0], parts[1]);
                    _cachedConfig = null;
                    let config = {};
                    try {
                        const cfgRes = await fetch(`${DATA_SVC}/api/config?admin=1`, { signal: AbortSignal.timeout(5000) });
                        if (cfgRes.ok) config = await cfgRes.json();
                    } catch {
                        /* intentional: config fetch best-effort */
                    }
                    return json(res, { success: true, config });
                }
                return json(res, { error: 'Invalid path' }, 400);
            }

            // ─── API: DELETE /api/config/reset ──────────────────────────
            if (url.pathname === '/api/config/reset' && req.method === 'DELETE') {
                await resetAllOverrides();
                _cachedConfig = null;
                let config = {};
                try {
                    const cfgRes = await fetch(`${DATA_SVC}/api/config?admin=1`, { signal: AbortSignal.timeout(5000) });
                    if (cfgRes.ok) config = await cfgRes.json();
                } catch {
                    /* intentional: config fetch best-effort */
                }
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
                    } catch {
                        /* intentional: position lookup best-effort */
                    }
                }

                // Forward to trading-svc
                try {
                    const result = await tradingClient.post('/api/retry', { position, liqTokenData: null }, { timeoutMs: 60000 });
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
                if (!body.positionId && !body.question)
                    return json(res, { success: false, error: 'positionId or question is required' }, 400);

                // Get position details — try DB first, then session file
                let position = { ...body };
                if (body.positionId && !position.question) {
                    try {
                        const posRes = await fetch(`${DATA_SVC}/api/positions/${body.positionId}`, { signal: AbortSignal.timeout(5000) });
                        if (posRes.ok) position = { ...body, ...(await posRes.json()) };
                    } catch {
                        /* intentional: position lookup best-effort */
                    }
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
                    const sellResult = await tradingClient.post('/api/sell', {
                        positions: [
                            {
                                label: position.label,
                                question: position.question,
                                clobTokenId: position.clobTokenId || position.token_id,
                                conditionId: position.conditionId || position.condition_id,
                                shares: position.shares || 1,
                                buyPositionId: body.positionId || position.id || null, // original buy position DB ID
                            },
                        ],
                        context: {
                            sessionId: position.session_id,
                            targetDate: position.target_date,
                            marketId: position.market_id || 'nyc',
                        },
                    });

                    if (sellResult?.positions?.length > 0) {
                        const soldPos = sellResult.positions[0];
                        if (soldPos.status === 'filled') {
                            return json(res, {
                                success: true,
                                verified: true,
                                sellPrice: soldPos.sellPrice,
                                proceeds: sellResult.totalProceeds,
                                orderId: soldPos.orderId,
                            });
                        }
                        if (soldPos.status === 'pending_verification') {
                            return json(res, {
                                success: true,
                                verified: false,
                                message: 'Sell order placed — fill price being verified on-chain',
                                orderId: soldPos.orderId,
                            });
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
                handleCors(res);
                return;
            }

            // ─── Static files ───────────────────────────────────────────
            if (url.pathname === '/' || url.pathname === '/index.html') {
                await serveStaticFile(path.join(STATIC_DIR, 'index.html'), res);
                return;
            }
            if (url.pathname === '/admin') {
                await serveStaticFile(path.join(STATIC_DIR, 'admin.html'), res);
                return;
            }
            if (url.pathname === '/analytics') {
                await serveStaticFile(path.join(STATIC_DIR, 'analytics.html'), res);
                return;
            }


            if (url.pathname.startsWith('/static/')) {
                const relativePath = url.pathname.slice('/static/'.length);
                if (relativePath.includes('..') || relativePath.includes('\\')) {
                    res.writeHead(403, { 'Content-Type': 'text/plain' });
                    res.end('Forbidden');
                    return;
                }
                await serveStaticFile(path.join(STATIC_DIR, ...relativePath.split('/')), res);
                return;
            }

            // ─── 404 ────────────────────────────────────────────────────
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('Not Found');
        } catch (err) {
            log.error('request_error', { method: req.method, path: url.pathname, error: err.message });
            json(res, { error: err.message }, 500);
        }
    })),
);

const log = createLogger('dashboard-svc');

server.listen(port, () => {
    log.info('started', { port, date: targetDate, dataSvc: DATA_SVC, tradingSvc: TRADING_SVC, liquiditySvc: LIQUIDITY_SVC });
});

function gracefulShutdown(signal) {
    log.info('shutdown_initiated', { signal });
    server.close(() => {
        log.info('shutdown_complete', { signal });
        process.exit(0);
    });
    setTimeout(() => {
        log.warn('shutdown_forced', { signal, reason: 'timeout after 10s' });
        process.exit(1);
    }, 10_000).unref();
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
