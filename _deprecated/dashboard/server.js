/**
 * TempEdge Dashboard — HTTP Server
 *
 * Thin orchestrator that:
 *   1. Parses CLI args
 *   2. Serves static files from ./static/
 *   3. Delegates to API route handlers
 *   4. Injects runtime config into index.html
 *
 * Usage:
 *   node src/dashboard/server.js                     # Default port 3000
 *   node src/dashboard/server.js --port 8080         # Custom port
 *   node src/dashboard/server.js --date 2026-03-08   # Specific date
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getTodayET, getTomorrowET, getTargetDateET, daysUntil, getPhase } from '../utils/dateUtils.js';
import { config, getConfigSnapshot, updateConfig, resetConfigValue, resetAllOverrides } from '../config.js';
import { getDb } from '../db/index.js';
import { getAllTrades, getPositionsForTrade, getAllSessions, getSession, insertTrade, insertPositions } from '../db/queries.js';
import { retrySinglePosition, executeSellOrder } from '../services/trading.js';
import { loadSessionData, loadObservationData, listAvailableDates, fetchLiquidityData, fetchLiquidityBids, globalCurrentTemp, OUTPUT_DIR } from './data.js';
import { overlayLivePrices, enrichBuyOrderWithDbIds, computeLivePnL } from './pnl.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const STATIC_DIR = path.join(__dirname, 'static');

// ── MIME types for static file serving ──────────────────────────────────
const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
};

// ── CLI Arguments ───────────────────────────────────────────────────────
const args = process.argv.slice(2);
let port = config.dashboard.port;
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

if (!targetDate) {
    targetDate = getTargetDateET();
}

// ── Liquidity service URL (used by proxy route) ─────────────────────────
const LIQUIDITY_SERVICE_URL = `http://localhost:${process.env.LIQUIDITY_PORT || 3001}`;

// ── Static file serving ─────────────────────────────────────────────────

/**
 * Serve a static file from the /static directory.
 * For index.html, injects runtime config values via placeholder replacement.
 */
function serveStaticFile(filePath, res) {
    const ext = path.extname(filePath);
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    try {
        let content = fs.readFileSync(filePath);

        // Inject runtime config into index.html
        if (filePath.endsWith('index.html')) {
            let html = content.toString('utf-8');
            html = html.replace('{{DEFAULT_DATE}}', targetDate);
            html = html.replace('{{REFRESH_INTERVAL}}', String(config.dashboard.refreshInterval));
            html = html.replace('{{LIQUIDITY_POLL_MS}}', String(config.dashboard.liquidityPollMs));
            html = html.replace('{{MANUAL_SELL_ENABLED}}', config.dashboard.manualSellEnabled ? 'true' : 'false');
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

    // ─── API: GET /api/status ───────────────────────────────────────
    if (url.pathname === '/api/status') {
        const date = url.searchParams.get('date') || targetDate;
        const session = loadSessionData(date);
        const observation = loadObservationData(date);
        const liveData = await fetchLiquidityData(date);
        const latestSnap = session?.snapshots?.[session.snapshots.length - 1] || null;
        if (latestSnap) overlayLivePrices(latestSnap, liveData);
        if (session) session.pnl = computeLivePnL(session.buyOrder, latestSnap, liveData.bids);

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
                buyOrder: enrichBuyOrderWithDbIds(session.buyOrder, date),
                manualSellEnabled: !!config.dashboard.manualSellEnabled,
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

        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ targetDate: date, session: sessionLight, observation, availableDates: listAvailableDates(), serverTime: new Date().toISOString() }));
        return;
    }

    // ─── API: GET /api/snapshots ────────────────────────────────────
    if (url.pathname === '/api/snapshots') {
        const date = url.searchParams.get('date') || targetDate;
        const session = loadSessionData(date);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify(session?.snapshots || []));
        return;
    }

    // ─── API: GET /api/portfolio ────────────────────────────────────
    if (url.pathname === '/api/portfolio') {
        const portfolioDates = [getTodayET(), getTomorrowET(), getTargetDateET()];
        const plays = await Promise.all(portfolioDates.map(async date => {
            const session = loadSessionData(date);
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
                    buyOrder: enrichBuyOrderWithDbIds(session.buyOrder, date),
                    manualSellEnabled: !!config.dashboard.manualSellEnabled,
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
                hasData: !!session || !!loadObservationData(date),
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

        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ plays, availableDates: listAvailableDates(), serverTime: new Date().toISOString() }));
        return;
    }

    // ─── API: GET /api/dates ────────────────────────────────────────
    if (url.pathname === '/api/dates') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify(listAvailableDates()));
        return;
    }

    // ─── API: GET /api/trades ───────────────────────────────────────
    if (url.pathname === '/api/trades') {
        let trades = [];
        try {
            const db = getDb();
            const dbTrades = db.prepare(`SELECT t.*, s.phase, s.status as session_status, s.initial_forecast_temp FROM trades t LEFT JOIN sessions s ON t.session_id = s.id WHERE t.type = 'buy' ORDER BY t.target_date DESC`).all();
            if (dbTrades.length > 0) {
                for (const dbt of dbTrades) {
                    const positions = db.prepare('SELECT * FROM positions WHERE trade_id = ?').all(dbt.id);
                    let latestSnap = null;
                    if (dbt.session_id) {
                        const dbSnap = db.prepare('SELECT * FROM snapshots WHERE session_id = ? ORDER BY id DESC LIMIT 1').get(dbt.session_id);
                        if (dbSnap) {
                            latestSnap = {
                                target: dbSnap.target_question ? { question: dbSnap.target_question, yesPrice: dbSnap.target_price } : null,
                                below: dbSnap.below_question ? { question: dbSnap.below_question, yesPrice: dbSnap.below_price } : null,
                                above: dbSnap.above_question ? { question: dbSnap.above_question, yesPrice: dbSnap.above_price } : null,
                            };
                        }
                    }
                    if (!latestSnap) { const session = loadSessionData(dbt.target_date); latestSnap = session?.snapshots?.[session.snapshots.length - 1] || null; }
                    const liquidityBids = await fetchLiquidityBids(dbt.target_date);
                    const buyOrderCompat = { positions: positions.map(p => ({ label: p.label, question: p.question, buyPrice: p.price, shares: p.shares, soldAt: p.sold_at ? (p.sell_price || p.sold_at) : null, soldStatus: p.status === 'sold' ? 'placed' : null })) };
                    const pnl = computeLivePnL(buyOrderCompat, latestSnap, liquidityBids);
                    let metadata = {}; try { metadata = dbt.metadata ? JSON.parse(dbt.metadata) : {}; } catch {}
                    const sells = db.prepare("SELECT * FROM trades WHERE target_date = ? AND type = 'sell' AND market_id = ?").all(dbt.target_date, dbt.market_id || 'nyc');
                    const sellPositions = new Map();
                    for (const sell of sells) { for (const p of db.prepare('SELECT * FROM positions WHERE trade_id = ?').all(sell.id)) { sellPositions.set(p.question, { price: p.price, status: p.status }); } }
                    const redeems = db.prepare("SELECT * FROM trades WHERE target_date = ? AND type = 'redeem' AND market_id = ?").all(dbt.target_date, dbt.market_id || 'nyc');
                    trades.push({
                        date: dbt.target_date, placedAt: dbt.placed_at, mode: dbt.mode || 'live',
                        positions: positions.map(p => {
                            const sold = sellPositions.get(p.question); const redeemed = p.status === 'redeemed';
                            return { positionId: p.id, label: p.label, question: p.question, buyPrice: p.price, shares: p.shares, status: redeemed ? 'redeemed' : (sold || p.sold_at ? 'sold' : (p.status || 'placed')), orderId: p.order_id || null, error: p.error || null, soldAt: sold ? sold.price : (p.sold_at || null), soldStatus: sold ? 'placed' : (p.sold_at ? 'placed' : null), sellPrice: sold ? sold.price : null, redeemedAt: p.redeemed_at || null, redeemedValue: p.redeemed_value || null };
                        }),
                        totalCost: dbt.actual_cost || dbt.total_cost,
                        maxProfit: metadata.maxProfit || parseFloat((1.0 - (dbt.actual_cost || dbt.total_cost)).toFixed(4)),
                        pnl: pnl ? { totalPnL: pnl.totalPnL, totalPnLPct: pnl.totalPnLPct, totalBuyCost: pnl.totalBuyCost, totalCurrentValue: pnl.totalCurrentValue } : null,
                        sessionStatus: dbt.session_status || 'active', phase: dbt.phase || getPhase(dbt.target_date), resolution: null, redeemed: redeems.length > 0,
                    });
                }
            }
        } catch (dbErr) { console.warn(`Trade log DB read failed, falling back to JSON: ${dbErr.message}`); trades = []; }

        if (trades.length === 0) {
            for (const date of listAvailableDates()) {
                const session = loadSessionData(date); if (!session?.buyOrder) continue;
                const bo = session.buyOrder; const latest = session.snapshots?.[session.snapshots.length - 1];
                const liquidityBids = await fetchLiquidityBids(date); const pnl = computeLivePnL(bo, latest, liquidityBids);
                trades.push({ date, placedAt: bo.placedAt, mode: bo.mode || (bo.simulated ? 'dry-run' : 'live'), positions: (bo.positions || []).map(p => ({ label: p.label, question: p.question, buyPrice: p.buyPrice, shares: p.shares, status: p.status || 'placed', orderId: p.orderId || null, error: p.error || null, soldAt: p.soldAt || null, soldStatus: p.soldStatus || null, sellPrice: (p.soldAt && p.soldStatus === 'placed') ? (typeof p.soldAt === 'number' ? p.soldAt : parseFloat(p.soldAt) || 0) : null })), totalCost: bo.totalCost, maxProfit: bo.maxProfit, pnl: pnl ? { totalPnL: pnl.totalPnL, totalPnLPct: pnl.totalPnLPct, totalBuyCost: pnl.totalBuyCost, totalCurrentValue: pnl.totalCurrentValue } : null, sessionStatus: session.status, phase: session.phase || getPhase(date), resolution: session.resolution ? { keep: session.resolution.keep, discardLabels: session.resolution.discardLabels } : null });
            }
        }

        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ trades, count: trades.length, serverTime: new Date().toISOString(), source: trades.length > 0 ? 'db' : 'json' }));
        return;
    }

    // ─── API: GET /api/analytics ────────────────────────────────────
    if (url.pathname === '/api/analytics') {
        try {
            const db = getDb();
            const pnlByDate = db.prepare(`SELECT t.target_date, t.market_id, SUM(CASE WHEN t.type = 'buy' THEN COALESCE(t.actual_cost, t.total_cost) ELSE 0 END) as total_bought, SUM(CASE WHEN t.type = 'sell' THEN t.total_proceeds ELSE 0 END) as total_sold, SUM(CASE WHEN t.type = 'redeem' THEN t.total_proceeds ELSE 0 END) as total_redeemed, COUNT(DISTINCT t.id) as trade_count, COUNT(DISTINCT CASE WHEN t.type = 'buy' THEN t.id END) as buy_count, COUNT(DISTINCT CASE WHEN t.type = 'sell' THEN t.id END) as sell_count FROM trades t WHERE t.status != 'failed' GROUP BY t.target_date, t.market_id ORDER BY t.target_date DESC`).all();
            const totals = { totalInvested: pnlByDate.reduce((s, r) => s + r.total_bought, 0), totalSold: pnlByDate.reduce((s, r) => s + r.total_sold, 0), totalRedeemed: pnlByDate.reduce((s, r) => s + r.total_redeemed, 0), tradingDays: pnlByDate.length, totalTrades: db.prepare("SELECT COUNT(*) as c FROM trades WHERE status != 'failed'").get().c };
            totals.realizedPnL = (totals.totalSold + totals.totalRedeemed) - totals.totalInvested;
            res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            res.end(JSON.stringify({ pnlByDate, totals, serverTime: new Date().toISOString() }));
        } catch (err) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: err.message })); }
        return;
    }

    // ─── API: GET /api/pipeline ─────────────────────────────────────
    if (url.pathname === '/api/pipeline') {
        const pipeline = [];
        for (const date of listAvailableDates()) {
            const session = loadSessionData(date); if (!session) continue;
            const phase = session.phase || getPhase(date);
            if (phase !== 'scout' && phase !== 'track') continue;
            pipeline.push({ date, phase, forecastHistory: session.forecastHistory || [], trend: session.trend || null, latestForecast: session.snapshots?.length ? session.snapshots[session.snapshots.length - 1].forecastTempF : null, targetRange: session.snapshots?.length ? session.snapshots[session.snapshots.length - 1].target?.question?.match(/(\d+-\d+)/)?.[1] || null : null });
        }
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ pipeline }));
        return;
    }

    // ─── API: GET /api/liquidity (proxy) ────────────────────────────
    if (url.pathname === '/api/liquidity') {
        const date = url.searchParams.get('date');
        const liqUrl = date ? `${LIQUIDITY_SERVICE_URL}/api/liquidity?date=${date}` : `${LIQUIDITY_SERVICE_URL}/api/liquidity`;
        try {
            const liqRes = await new Promise((resolve, reject) => {
                const liqReq = http.get(liqUrl, (r) => { let body = ''; r.on('data', c => body += c); r.on('end', () => resolve(body)); });
                liqReq.on('error', reject); liqReq.setTimeout(3000, () => { liqReq.destroy(); reject(new Error('timeout')); });
            });
            res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            res.end(liqRes);
        } catch (err) {
            res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            res.end(JSON.stringify({ status: 'service-unavailable', error: err.message, tokens: [], tokenCount: 0, timestamp: new Date().toISOString() }));
        }
        return;
    }

    // ─── API: GET /api/config ───────────────────────────────────────
    if (url.pathname === '/api/config' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ config: getConfigSnapshot(), serverTime: new Date().toISOString() }));
        return;
    }

    // ─── API: PUT /api/config ───────────────────────────────────────
    if (url.pathname === '/api/config' && req.method === 'PUT') {
        let body = ''; req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const updates = JSON.parse(body); const result = updateConfig(updates);
                res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                res.end(JSON.stringify({ success: true, ...result, config: getConfigSnapshot() }));
            } catch (err) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: false, error: err.message })); }
        });
        return;
    }

    // ─── API: DELETE /api/config/reset/:section/:field ───────────────
    if (url.pathname.startsWith('/api/config/reset/') && req.method === 'DELETE') {
        const parts = url.pathname.replace('/api/config/reset/', '').split('/');
        if (parts.length === 2) {
            resetConfigValue(parts[0], parts[1]);
            res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            res.end(JSON.stringify({ success: true, config: getConfigSnapshot() }));
        } else { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Invalid path: /api/config/reset/{section}/{field}' })); }
        return;
    }

    // ─── API: DELETE /api/config/reset ───────────────────────────────
    if (url.pathname === '/api/config/reset' && req.method === 'DELETE') {
        resetAllOverrides();
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ success: true, config: getConfigSnapshot() }));
        return;
    }

    // ─── API: POST /api/retry-position ──────────────────────────────
    if (url.pathname === '/api/retry-position' && req.method === 'POST') {
        let body = ''; req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {
            try {
                const { positionId } = JSON.parse(body);
                if (!positionId) throw new Error('positionId is required');
                const db = getDb();
                const pos = db.prepare(`SELECT p.*, t.target_date, t.session_id, t.market_id, t.id as trade_id FROM positions p JOIN trades t ON p.trade_id = t.id WHERE p.id = ? AND p.status = 'failed'`).get(positionId);
                if (!pos) { res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify({ success: false, error: 'Position not found or not in failed status' })); return; }
                console.log(`\n  🔄 Retrying position #${positionId}: ${pos.label} for ${pos.target_date}`);
                let conditionId = pos.condition_id, clobTokenIds = pos.clob_token_ids;
                if (!conditionId || !clobTokenIds) {
                    const session = loadSessionData(pos.target_date);
                    if (session) { const latestSnap = session.snapshots?.[session.snapshots.length - 1]; if (latestSnap) { for (const rangeKey of ['target', 'below', 'above']) { const range = latestSnap[rangeKey]; if (range && range.question === pos.question) { conditionId = conditionId || range.conditionId; clobTokenIds = clobTokenIds || (range.clobTokenIds ? JSON.stringify(range.clobTokenIds) : null); break; } } } }
                    if (!clobTokenIds) { res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify({ success: false, error: 'Cannot resolve market data (clobTokenIds)' })); return; }
                }
                let liqTokenData = null;
                try { const liqData = await fetchLiquidityData(pos.target_date); if (liqData.tokens?.length > 0) liqTokenData = liqData.tokens.find(t => t.question === pos.question) || null; } catch {}
                const result = await retrySinglePosition({ label: pos.label, question: pos.question, conditionId, clobTokenIds, buyPrice: pos.price, marketId: pos.polymarket_id }, liqTokenData);
                if (result.success) {
                    db.prepare(`UPDATE positions SET status = 'filled', shares = ?, price = ?, fill_price = ?, fill_shares = ?, order_id = ?, error = NULL, condition_id = COALESCE(condition_id, ?), clob_token_ids = COALESCE(clob_token_ids, ?) WHERE id = ?`).run(result.shares, result.price, result.price, result.shares, result.orderId, conditionId, clobTokenIds, positionId);
                    db.prepare(`UPDATE trades SET total_cost = total_cost + ?, actual_cost = COALESCE(actual_cost, 0) + ?, status = 'filled' WHERE id = ?`).run(result.cost, result.cost, pos.trade_id);
                }
                res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                res.end(JSON.stringify(result));
            } catch (err) { res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify({ success: false, error: err.message })); }
        });
        return;
    }

    // ─── API: POST /api/sell-position ────────────────────────────────
    if (url.pathname === '/api/sell-position' && req.method === 'POST') {
        let body = ''; req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {
            try {
                if (!config.dashboard.manualSellEnabled) { res.writeHead(403, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify({ success: false, error: 'Manual sell is disabled' })); return; }
                const { positionId } = JSON.parse(body);
                if (!positionId) throw new Error('positionId is required');
                const db = getDb();
                const pos = db.prepare(`SELECT p.*, t.target_date, t.session_id, t.market_id, t.id as trade_id FROM positions p JOIN trades t ON p.trade_id = t.id WHERE p.id = ? AND t.type = 'buy' AND (p.status = 'placed' OR p.status = 'filled') AND p.sold_at IS NULL AND p.redeemed_at IS NULL`).get(positionId);
                if (!pos) { res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify({ success: false, error: 'Position not found, already sold, or not in filled status' })); return; }
                let conditionId = pos.condition_id, clobTokenIds = pos.clob_token_ids, tokenId = pos.token_id;
                if (!conditionId || !clobTokenIds) {
                    const session = loadSessionData(pos.target_date);
                    if (session) { const latestSnap = session.snapshots?.[session.snapshots.length - 1]; if (latestSnap) { for (const rangeKey of ['target', 'below', 'above']) { const range = latestSnap[rangeKey]; if (range && range.question === pos.question) { conditionId = conditionId || range.conditionId; clobTokenIds = clobTokenIds || (range.clobTokenIds ? JSON.stringify(range.clobTokenIds) : null); tokenId = tokenId || range.clobTokenIds?.[0]; break; } } } }
                }
                if (!tokenId && clobTokenIds) { try { tokenId = JSON.parse(clobTokenIds)[0]; } catch {} }
                if (!tokenId || !conditionId) { res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify({ success: false, error: 'Cannot resolve market data' })); return; }
                const sellResult = await executeSellOrder([{ label: pos.label, question: pos.question, clobTokenId: tokenId, conditionId, shares: pos.shares || 1 }], { sessionId: pos.session_id, targetDate: pos.target_date, marketId: pos.market_id || 'nyc' });
                if (sellResult?.positions?.length > 0) {
                    const soldPos = sellResult.positions[0];
                    if (soldPos.status === 'filled' || soldPos.status === 'placed') {
                        db.prepare(`UPDATE positions SET sold_at = ?, sell_price = ?, sell_order_id = ? WHERE id = ?`).run(new Date().toISOString(), soldPos.sellPrice, soldPos.orderId, positionId);
                        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                        res.end(JSON.stringify({ success: true, sellPrice: soldPos.sellPrice, proceeds: sellResult.totalProceeds, orderId: soldPos.orderId }));
                    } else { res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify({ success: false, error: soldPos.error || 'Sell order did not fill' })); }
                } else { res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify({ success: false, error: 'executeSellOrder returned null' })); }
            } catch (err) { res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify({ success: false, error: err.message })); }
        });
        return;
    }

    // ─── API: POST /api/restart ─────────────────────────────────────
    if (url.pathname === '/api/restart' && req.method === 'POST') {
        const signalPath = path.join(OUTPUT_DIR, '.restart-requested');
        try {
            fs.writeFileSync(signalPath, JSON.stringify({ requestedAt: new Date().toISOString(), requestedBy: 'admin-panel' }));
            res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            res.end(JSON.stringify({ success: true, message: 'Restart signal sent.' }));
        } catch (err) { res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify({ success: false, error: err.message })); }
        return;
    }

    // ─── CORS preflight ─────────────────────────────────────────────
    if (req.method === 'OPTIONS') {
        res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
        res.end(); return;
    }

    // ─── Static files ───────────────────────────────────────────────
    if (url.pathname === '/' || url.pathname === '/index.html') {
        serveStaticFile(path.join(STATIC_DIR, 'index.html'), res); return;
    }
    if (url.pathname === '/admin') {
        serveStaticFile(path.join(STATIC_DIR, 'admin.html'), res); return;
    }
    if (url.pathname.startsWith('/static/')) {
        // Extract relative path from URL (always forward-slash) and validate
        const relativePath = url.pathname.slice('/static/'.length);
        if (relativePath.includes('..') || relativePath.includes('\\')) {
            res.writeHead(403, { 'Content-Type': 'text/plain' }); res.end('Forbidden'); return;
        }
        serveStaticFile(path.join(STATIC_DIR, ...relativePath.split('/')), res); return;
    }

    // ─── 404 ────────────────────────────────────────────────────────
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
});

server.listen(port, () => {
    console.log(`\n🌡️  TempEdge Dashboard`);
    console.log(`═══════════════════════════════════════`);
    console.log(`  URL:    http://localhost:${port}`);
    console.log(`  Date:   ${targetDate}`);
    console.log(`  Data:   ${OUTPUT_DIR}`);
    console.log(`  Static: ${STATIC_DIR}`);
    console.log(`═══════════════════════════════════════\n`);
});
