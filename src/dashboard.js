/**
 * TempEdge Dashboard — Local web dashboard for monitoring temperature markets
 *
 * Usage:
 *   node src/dashboard.js                     # Default port 3000
 *   node src/dashboard.js --port 8080         # Custom port
 *   node src/dashboard.js --date 2026-03-08   # Specific date
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getTodayET, getTomorrowET, getTargetDateET, daysUntil, getPhase } from './utils/dateUtils.js';
import { config, getConfigSnapshot, updateConfig, resetConfigValue, resetAllOverrides } from './config.js';
import { getDb } from './db/index.js';
import { getAllTrades, getPositionsForTrade, getAllSessions, getSession, insertTrade, insertPositions } from './db/queries.js';
import { retrySinglePosition } from './services/trading.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const OUTPUT_DIR = path.resolve(__dirname, '../output');

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

// ── Data Loading ────────────────────────────────────────────────────────

/** @type {Map<string, {data: Object, mtime: number, cachedAt: number}>} */
const sessionCache = new Map();
const SESSION_CACHE_TTL_MS = 60_000; // 60s — session files update every 15 min

function loadSessionData(date) {
    const sessionPath = path.join(OUTPUT_DIR, `monitor-${date}.json`);
    if (!fs.existsSync(sessionPath)) return null;

    try {
        const stat = fs.statSync(sessionPath);
        const mtime = stat.mtimeMs;
        const cached = sessionCache.get(date);

        // Return cached if file hasn't changed and cache is fresh
        if (cached && cached.mtime === mtime && (Date.now() - cached.cachedAt) < SESSION_CACHE_TTL_MS) {
            return cached.data;
        }

        const data = JSON.parse(fs.readFileSync(sessionPath, 'utf-8'));
        sessionCache.set(date, { data, mtime, cachedAt: Date.now() });

        // Evict old cache entries to prevent memory leak
        if (sessionCache.size > 10) {
            const oldest = [...sessionCache.entries()].sort((a, b) => a[1].cachedAt - b[1].cachedAt)[0];
            if (oldest) sessionCache.delete(oldest[0]);
        }

        return data;
    } catch {
        return null;
    }
}

function loadObservationData(date) {
    const obsPath = path.join(OUTPUT_DIR, `${date}.json`);
    if (fs.existsSync(obsPath)) {
        try {
            return JSON.parse(fs.readFileSync(obsPath, 'utf-8'));
        } catch {
            return null;
        }
    }
    return null;
}

function listAvailableDates() {
    if (!fs.existsSync(OUTPUT_DIR)) return [];
    return fs.readdirSync(OUTPUT_DIR)
        .filter(f => f.startsWith('monitor-') && f.endsWith('.json'))
        .map(f => f.replace('monitor-', '').replace('.json', ''))
        .sort()
        .reverse();
}


const LIQUIDITY_SERVICE_URL = `http://localhost:${process.env.LIQUIDITY_PORT || 3001}`;

// ── HTTP Server ─────────────────────────────────────────────────────────

/**
 * Fetch live CLOB order book data for a specific date from the liquidity microservice.
 * Returns bids (sell price), asks (buy price), and raw token data.
 * @param {string} date
 * @returns {Promise<{bids: Object, asks: Object, tokens: Array, live: boolean}>}
 */
async function fetchLiquidityData(date) {
    const result = { bids: {}, asks: {}, tokens: [], live: false };
    try {
        const resp = await fetch(`${LIQUIDITY_SERVICE_URL}/api/liquidity?date=${date}`);
        if (resp.ok) {
            const data = await resp.json();
            result.tokens = data.tokens || [];
            for (const t of result.tokens) {
                if (t.question) {
                    if (t.bestBid > 0) result.bids[t.question] = t.bestBid;
                    if (t.bestAsk > 0) result.asks[t.question] = t.bestAsk;
                }
            }
            result.live = result.tokens.length > 0;
        }
    } catch {
        // Liquidity service unavailable — will fall back to snapshot prices
    }
    return result;
}

// Backward-compat wrapper (used by /api/trades)
async function fetchLiquidityBids(date) {
    const { bids } = await fetchLiquidityData(date);
    return bids;
}

/**
 * Overlay live CLOB prices onto a snapshot's range objects.
 * Uses bestAsk as the displayed price (= what you'd pay to buy YES),
 * matching the Polymarket UI convention. If WS data is unavailable,
 * the snapshot retains its original Gamma API prices.
 *
 * Mutates snapshot in-place for efficiency. Adds a `_liveOverlay` flag
 * so the frontend can indicate real-time vs snapshot pricing.
 *
 * @param {Object|null} snapshot - The latest monitoring snapshot
 * @param {{bids: Object, asks: Object, live: boolean}} liveData - From fetchLiquidityData()
 * @returns {Object|null} The same snapshot, now with live prices overlaid
 */
function overlayLivePrices(snapshot, liveData) {
    if (!snapshot || !liveData.live) return snapshot;

    for (const key of ['target', 'below', 'above']) {
        const range = snapshot[key];
        if (!range?.question) continue;

        const liveAsk = liveData.asks[range.question];
        const liveBid = liveData.bids[range.question];

        if (liveAsk > 0) {
            range.yesPrice = liveAsk;  // Display price = what you'd pay
            range._live = true;
        }
        if (liveBid > 0) {
            range.bestBid = liveBid;   // Sell price = what you'd receive
        }
    }

    // Recalculate totalCost from the (now-live) range prices
    const t = snapshot.target?.yesPrice || 0;
    const b = snapshot.below?.yesPrice || 0;
    const a = snapshot.above?.yesPrice || 0;
    snapshot.totalCost = parseFloat((t + b + a).toFixed(4));
    snapshot._liveOverlay = true;

    return snapshot;
}

/**
 * Compute P&L from buyOrder vs latest snapshot - runs on every API call.
 * Uses live CLOB bids from the liquidity microservice for accurate sell pricing.
 * @param {Object} buyOrder
 * @param {Object} latestSnapshot
 * @param {Object} liquidityBids - { questionText: bestBid } from CLOB
 */
function computeLivePnL(buyOrder, latestSnapshot, liquidityBids) {
    if (!buyOrder || !buyOrder.positions || !latestSnapshot) return null;

    const currentRanges = {
        target: latestSnapshot.target,
        below: latestSnapshot.below,
        above: latestSnapshot.above,
    };

    const bids = liquidityBids || {};

    let totalBuyCost = 0;
    let totalCurrentValue = 0;
    const positions = [];

    for (const pos of buyOrder.positions) {
        const shares = pos.shares || 1;
        const buyCost = pos.buyPrice * shares;

        let currentPrice;
        let sold = false;
        let sellPrice = 0;

        if (pos.soldAt && pos.soldStatus === 'placed') {
            // Position was sold — use actual sell price
            sold = true;
            sellPrice = typeof pos.soldAt === 'number' ? pos.soldAt : parseFloat(pos.soldAt) || 0;
            currentPrice = sellPrice;
        } else {
            // Still held — use live CLOB bid
            const currentRange = currentRanges[pos.label];
            const clobBid = bids[pos.question];
            currentPrice = clobBid > 0
                ? clobBid
                : (currentRange?.yesPrice ?? pos.buyPrice);
        }

        const currentValue = currentPrice * shares;
        const pnl = parseFloat((currentValue - buyCost).toFixed(4));
        const pnlPct = buyCost > 0
            ? parseFloat(((pnl / buyCost) * 100).toFixed(1))
            : 0;

        totalBuyCost += buyCost;
        totalCurrentValue += currentValue;

        positions.push({
            label: pos.label,
            question: pos.question,
            buyPrice: pos.buyPrice,
            currentPrice,
            shares,
            pnl,
            pnlPct,
            sold,
            sellPrice: sold ? sellPrice : null,
        });
    }

    const totalPnL = parseFloat((totalCurrentValue - totalBuyCost).toFixed(4));
    const totalPnLPct = totalBuyCost > 0
        ? parseFloat(((totalPnL / totalBuyCost) * 100).toFixed(1))
        : 0;

    return {
        positions,
        totalBuyCost: parseFloat(totalBuyCost.toFixed(4)),
        totalCurrentValue: parseFloat(totalCurrentValue.toFixed(4)),
        totalPnL,
        totalPnLPct,
    };
}

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);

    // API Routes
    if (url.pathname === '/api/status') {
        const date = url.searchParams.get('date') || targetDate;
        const session = loadSessionData(date);
        const observation = loadObservationData(date);

        // Overlay live CLOB prices onto the latest snapshot so stat cards
        // display real-time prices instead of 15-minute-stale Gamma data
        const liveData = await fetchLiquidityData(date);
        const latestSnap = session?.snapshots?.[session.snapshots.length - 1] || null;
        if (latestSnap) {
            overlayLivePrices(latestSnap, liveData);
        }

        // Attach live P&L directly (avoid spreading the 10MB+ session object)
        if (session) {
            session.pnl = computeLivePnL(session.buyOrder, latestSnap, liveData.bids);
        }

        // Build a lightweight session response — strip the massive snapshots array
        // (11MB+) and only send the last 20 for chart rendering. The frontend uses
        // /api/snapshots if it needs the full history.
        let sessionLight = null;
        if (session) {
            const recentSnaps = session.snapshots ? session.snapshots.slice(-20) : [];
            sessionLight = {
                id: session.id,
                status: session.status,
                phase: session.phase,
                initialForecastTempF: session.initialForecastTempF,
                initialTargetRange: session.initialTargetRange,
                forecastSource: session.forecastSource,
                rebalanceThreshold: session.rebalanceThreshold,
                resolution: session.resolution || null,
                buyOrder: session.buyOrder || null,
                pnl: session.pnl,
                redeemExecuted: session.redeemExecuted || false,
                redeemResult: session.redeemResult || null,
                awaitingLiquidity: session.awaitingLiquidity || false,
                liquidityWaitStart: session.liquidityWaitStart || null,
                snapshots: recentSnaps,
                alerts: session.alerts || [],
            };
        }

        res.writeHead(200, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
        });
        res.end(JSON.stringify({
            targetDate: date,
            session: sessionLight,
            observation,
            availableDates: listAvailableDates(),
            serverTime: new Date().toISOString(),
        }));
        return;
    }

    if (url.pathname === '/api/snapshots') {
        const date = url.searchParams.get('date') || targetDate;
        const session = loadSessionData(date);
        res.writeHead(200, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
        });
        res.end(JSON.stringify(session?.snapshots || []));
        return;
    }

    // Portfolio endpoint — returns all active sessions across the 3 rolling dates
    if (url.pathname === '/api/portfolio') {
        const today = getTodayET();
        const tomorrow = getTomorrowET();
        const dayAfter = getTargetDateET();
        const portfolioDates = [today, tomorrow, dayAfter];

        const plays = await Promise.all(portfolioDates.map(async date => {
            const session = loadSessionData(date);
            const phase = getPhase(date);
            const days = daysUntil(date);
            const latest = session?.snapshots?.[session.snapshots.length - 1] || null;

            // Overlay live CLOB prices onto portfolio card snapshot
            const liveData = await fetchLiquidityData(date);
            if (latest) overlayLivePrices(latest, liveData);

            return {
                date,
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
                    buyOrder: session.buyOrder || null,
                    pnl: computeLivePnL(session.buyOrder, latest, liveData.bids),
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
                hasData: !!session || !!loadObservationData(date),
            };
        }));

        res.writeHead(200, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
        });
        res.end(JSON.stringify({
            plays,
            availableDates: listAvailableDates(),
            serverTime: new Date().toISOString(),
        }));
        return;
    }

    if (url.pathname === '/api/dates') {
        res.writeHead(200, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
        });
        res.end(JSON.stringify(listAvailableDates()));
        return;
    }

    // Trade log — aggregated buy orders across all sessions
    // Phase 3: reads from SQLite DB (survives pod restarts), falls back to JSON
    if (url.pathname === '/api/trades') {
        let trades = [];

        try {
            // Try DB-first approach
            const db = getDb();
            const dbTrades = db.prepare(`
                SELECT t.*, s.phase, s.status as session_status, s.initial_forecast_temp
                FROM trades t
                LEFT JOIN sessions s ON t.session_id = s.id
                WHERE t.type = 'buy'
                ORDER BY t.target_date DESC
            `).all();

            if (dbTrades.length > 0) {
                for (const dbt of dbTrades) {
                    const positions = db.prepare('SELECT * FROM positions WHERE trade_id = ?').all(dbt.id);

                    // Get latest snapshot for P&L (try DB first, fall back to JSON)
                    let latestSnap = null;
                    if (dbt.session_id) {
                        const dbSnap = db.prepare(
                            'SELECT * FROM snapshots WHERE session_id = ? ORDER BY id DESC LIMIT 1'
                        ).get(dbt.session_id);
                        if (dbSnap) {
                            latestSnap = {
                                target: dbSnap.target_question ? { question: dbSnap.target_question, yesPrice: dbSnap.target_price } : null,
                                below: dbSnap.below_question ? { question: dbSnap.below_question, yesPrice: dbSnap.below_price } : null,
                                above: dbSnap.above_question ? { question: dbSnap.above_question, yesPrice: dbSnap.above_price } : null,
                            };
                        }
                    }
                    // Fallback to JSON snapshot if DB doesn't have it
                    if (!latestSnap) {
                        const session = loadSessionData(dbt.target_date);
                        latestSnap = session?.snapshots?.[session.snapshots.length - 1] || null;
                    }

                    const liquidityBids = await fetchLiquidityBids(dbt.target_date);

                    // Build buyOrder-compatible object for P&L computation
                    const buyOrderCompat = {
                        positions: positions.map(p => ({
                            label: p.label,
                            question: p.question,
                            buyPrice: p.price,
                            shares: p.shares,
                            soldAt: p.sold_at ? (p.sell_price || p.sold_at) : null,
                            soldStatus: p.status === 'sold' ? 'placed' : null,
                        })),
                    };
                    const pnl = computeLivePnL(buyOrderCompat, latestSnap, liquidityBids);

                    // Parse metadata JSON
                    let metadata = {};
                    try { metadata = dbt.metadata ? JSON.parse(dbt.metadata) : {}; } catch { /* ignore */ }

                    // Check for sells on this date
                    const sells = db.prepare(
                        "SELECT * FROM trades WHERE target_date = ? AND type = 'sell' AND market_id = ?"
                    ).all(dbt.target_date, dbt.market_id || 'nyc');
                    const sellPositions = new Map();
                    for (const sell of sells) {
                        const sp = db.prepare('SELECT * FROM positions WHERE trade_id = ?').all(sell.id);
                        for (const p of sp) {
                            sellPositions.set(p.question, { price: p.price, status: p.status });
                        }
                    }

                    // Check for redeems
                    const redeems = db.prepare(
                        "SELECT * FROM trades WHERE target_date = ? AND type = 'redeem' AND market_id = ?"
                    ).all(dbt.target_date, dbt.market_id || 'nyc');

                    trades.push({
                        date: dbt.target_date,
                        placedAt: dbt.placed_at,
                        mode: dbt.mode || 'live',
                        positions: positions.map(p => {
                            const sold = sellPositions.get(p.question);
                            const redeemed = p.status === 'redeemed';
                            return {
                                positionId: p.id,
                                label: p.label,
                                question: p.question,
                                buyPrice: p.price,
                                shares: p.shares,
                                status: redeemed ? 'redeemed' : (sold ? 'sold' : (p.status || 'placed')),
                                orderId: p.order_id || null,
                                error: p.error || null,
                                soldAt: sold ? sold.price : null,
                                soldStatus: sold ? 'placed' : null,
                                sellPrice: sold ? sold.price : null,
                                redeemedAt: p.redeemed_at || null,
                                redeemedValue: p.redeemed_value || null,
                            };
                        }),
                        totalCost: dbt.actual_cost || dbt.total_cost,
                        maxProfit: metadata.maxProfit || parseFloat((1.0 - (dbt.actual_cost || dbt.total_cost)).toFixed(4)),
                        pnl: pnl ? {
                            totalPnL: pnl.totalPnL,
                            totalPnLPct: pnl.totalPnLPct,
                            totalBuyCost: pnl.totalBuyCost,
                            totalCurrentValue: pnl.totalCurrentValue,
                        } : null,
                        sessionStatus: dbt.session_status || 'active',
                        phase: dbt.phase || getPhase(dbt.target_date),
                        resolution: null, // TODO: pull from session if needed
                        redeemed: redeems.length > 0,
                    });
                }
            }
        } catch (dbErr) {
            console.warn(`Trade log DB read failed, falling back to JSON: ${dbErr.message}`);
            trades = []; // Reset to trigger fallback
        }

        // Fallback: JSON-based approach (for backward compatibility)
        if (trades.length === 0) {
            const dates = listAvailableDates();
            for (const date of dates) {
                const session = loadSessionData(date);
                if (!session?.buyOrder) continue;

                const bo = session.buyOrder;
                const latest = session.snapshots?.[session.snapshots.length - 1];
                const liquidityBids = await fetchLiquidityBids(date);
                const pnl = computeLivePnL(bo, latest, liquidityBids);

                trades.push({
                    date,
                    placedAt: bo.placedAt,
                    mode: bo.mode || (bo.simulated ? 'dry-run' : 'live'),
                    positions: (bo.positions || []).map(p => ({
                        label: p.label,
                        question: p.question,
                        buyPrice: p.buyPrice,
                        shares: p.shares,
                        status: p.status || 'placed',
                        orderId: p.orderId || null,
                        error: p.error || null,
                        soldAt: p.soldAt || null,
                        soldStatus: p.soldStatus || null,
                        sellPrice: (p.soldAt && p.soldStatus === 'placed') ? (typeof p.soldAt === 'number' ? p.soldAt : parseFloat(p.soldAt) || 0) : null,
                    })),
                    totalCost: bo.totalCost,
                    maxProfit: bo.maxProfit,
                    pnl: pnl ? {
                        totalPnL: pnl.totalPnL,
                        totalPnLPct: pnl.totalPnLPct,
                        totalBuyCost: pnl.totalBuyCost,
                        totalCurrentValue: pnl.totalCurrentValue,
                    } : null,
                    sessionStatus: session.status,
                    phase: session.phase || getPhase(date),
                    resolution: session.resolution ? {
                        keep: session.resolution.keep,
                        discardLabels: session.resolution.discardLabels,
                    } : null,
                });
            }
        }

        // Already sorted newest first
        res.writeHead(200, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
        });
        res.end(JSON.stringify({
            trades,
            count: trades.length,
            serverTime: new Date().toISOString(),
            source: trades.length > 0 ? 'db' : 'json',
        }));
        return;
    }

    // Analytics endpoint — P&L summary, forecast accuracy, stats
    if (url.pathname === '/api/analytics') {
        try {
            const db = getDb();
            const pnlByDate = db.prepare(`
                SELECT
                    t.target_date,
                    t.market_id,
                    SUM(CASE WHEN t.type = 'buy' THEN COALESCE(t.actual_cost, t.total_cost) ELSE 0 END) as total_bought,
                    SUM(CASE WHEN t.type = 'sell' THEN t.total_proceeds ELSE 0 END) as total_sold,
                    SUM(CASE WHEN t.type = 'redeem' THEN t.total_proceeds ELSE 0 END) as total_redeemed,
                    COUNT(DISTINCT t.id) as trade_count,
                    COUNT(DISTINCT CASE WHEN t.type = 'buy' THEN t.id END) as buy_count,
                    COUNT(DISTINCT CASE WHEN t.type = 'sell' THEN t.id END) as sell_count
                FROM trades t
                WHERE t.status != 'failed'
                GROUP BY t.target_date, t.market_id
                ORDER BY t.target_date DESC
            `).all();

            const totals = {
                totalInvested: pnlByDate.reduce((s, r) => s + r.total_bought, 0),
                totalSold: pnlByDate.reduce((s, r) => s + r.total_sold, 0),
                totalRedeemed: pnlByDate.reduce((s, r) => s + r.total_redeemed, 0),
                tradingDays: pnlByDate.length,
                totalTrades: db.prepare("SELECT COUNT(*) as c FROM trades WHERE status != 'failed'").get().c,
            };
            totals.realizedPnL = (totals.totalSold + totals.totalRedeemed) - totals.totalInvested;

            res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            res.end(JSON.stringify({ pnlByDate, totals, serverTime: new Date().toISOString() }));
        } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
        }
        return;
    }

    // Forecast pipeline — scout/track sessions
    if (url.pathname === '/api/pipeline') {
        const dates = listAvailableDates();
        const pipeline = [];

        for (const date of dates) {
            const session = loadSessionData(date);
            if (!session) continue;
            const phase = session.phase || getPhase(date);
            if (phase !== 'scout' && phase !== 'track') continue;

            pipeline.push({
                date,
                phase,
                forecastHistory: session.forecastHistory || [],
                trend: session.trend || null,
                latestForecast: session.snapshots?.length
                    ? session.snapshots[session.snapshots.length - 1].forecastTempF
                    : null,
                targetRange: session.snapshots?.length
                    ? session.snapshots[session.snapshots.length - 1].target?.question?.match(/(\d+-\d+)/)?.[1] || null
                    : null,
            });
        }

        res.writeHead(200, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
        });
        res.end(JSON.stringify({ pipeline }));
        return;
    }

    // Liquidity endpoint — proxy to dedicated liquidity microservice
    if (url.pathname === '/api/liquidity') {
        const date = url.searchParams.get('date');
        const liqUrl = date
            ? `${LIQUIDITY_SERVICE_URL}/api/liquidity?date=${date}`
            : `${LIQUIDITY_SERVICE_URL}/api/liquidity`;

        try {
            const liqRes = await new Promise((resolve, reject) => {
                const liqReq = http.get(liqUrl, (r) => {
                    let body = '';
                    r.on('data', c => body += c);
                    r.on('end', () => resolve(body));
                });
                liqReq.on('error', reject);
                liqReq.setTimeout(3000, () => { liqReq.destroy(); reject(new Error('timeout')); });
            });

            res.writeHead(200, {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
            });
            res.end(liqRes);
        } catch (err) {
            res.writeHead(200, {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
            });
            res.end(JSON.stringify({
                status: 'service-unavailable',
                error: err.message,
                tokens: [],
                tokenCount: 0,
                timestamp: new Date().toISOString(),
            }));
        }
        return;
    }

    // Config endpoint — runtime configuration snapshot (secrets masked)
    if (url.pathname === '/api/config' && req.method === 'GET') {
        res.writeHead(200, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
        });
        res.end(JSON.stringify({
            config: getConfigSnapshot(),
            serverTime: new Date().toISOString(),
        }));
        return;
    }

    // Config update endpoint — save config changes
    if (url.pathname === '/api/config' && req.method === 'PUT') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const updates = JSON.parse(body);
                const result = updateConfig(updates);
                res.writeHead(200, {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*',
                });
                res.end(JSON.stringify({
                    success: true,
                    ...result,
                    config: getConfigSnapshot(),
                }));
            } catch (err) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: err.message }));
            }
        });
        return;
    }

    // Config reset single value
    if (url.pathname.startsWith('/api/config/reset/') && req.method === 'DELETE') {
        const parts = url.pathname.replace('/api/config/reset/', '').split('/');
        if (parts.length === 2) {
            resetConfigValue(parts[0], parts[1]);
            res.writeHead(200, {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
            });
            res.end(JSON.stringify({ success: true, config: getConfigSnapshot() }));
        } else {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid path: /api/config/reset/{section}/{field}' }));
        }
        return;
    }

    // Config reset all overrides
    if (url.pathname === '/api/config/reset' && req.method === 'DELETE') {
        resetAllOverrides();
        res.writeHead(200, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
        });
        res.end(JSON.stringify({ success: true, config: getConfigSnapshot() }));
        return;
    }

    // Retry a failed position — place a single order for a position that previously failed
    if (url.pathname === '/api/retry-position' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {
            try {
                const { positionId, targetDate } = JSON.parse(body);
                if (!positionId) throw new Error('positionId is required');

                const db = getDb();

                // Look up the failed position
                const pos = db.prepare(`
                    SELECT p.*, t.target_date, t.session_id, t.market_id, t.id as trade_id
                    FROM positions p
                    JOIN trades t ON p.trade_id = t.id
                    WHERE p.id = ? AND p.status = 'failed'
                `).get(positionId);

                if (!pos) {
                    res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                    res.end(JSON.stringify({ success: false, error: 'Position not found or not in failed status' }));
                    return;
                }

                console.log(`\n  🔄 Retrying position #${positionId}: ${pos.label} for ${pos.target_date}`);

                // Resolve market data — DB may not have conditionId/clobTokenIds
                // (e.g. backfilled trades), so fall back to the session snapshot
                let conditionId = pos.condition_id;
                let clobTokenIds = pos.clob_token_ids;

                if (!conditionId || !clobTokenIds) {
                    const session = loadSessionData(pos.target_date);
                    if (session) {
                        const latestSnap = session.snapshots?.[session.snapshots.length - 1];
                        if (latestSnap) {
                            for (const rangeKey of ['target', 'below', 'above']) {
                                const range = latestSnap[rangeKey];
                                if (range && range.question === pos.question) {
                                    conditionId = conditionId || range.conditionId;
                                    clobTokenIds = clobTokenIds || (range.clobTokenIds ? JSON.stringify(range.clobTokenIds) : null);
                                    console.log(`  📡 Resolved ${rangeKey} from session snapshot: conditionId=${conditionId}, tokenId=${range.clobTokenIds?.[0]}`);
                                    break;
                                }
                            }
                        }
                    }
                    if (!clobTokenIds) {
                        res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                        res.end(JSON.stringify({ success: false, error: 'Cannot resolve market data (clobTokenIds) for this position — no session snapshot available' }));
                        return;
                    }
                }

                // Fetch live WS liquidity data so we use accurate spreads
                // (the REST CLOB API returns unreliable data for these markets)
                let liqTokenData = null;
                try {
                    const liqData = await fetchLiquidityData(pos.target_date);
                    if (liqData.tokens && liqData.tokens.length > 0) {
                        liqTokenData = liqData.tokens.find(t => t.question === pos.question) || null;
                        if (liqTokenData) {
                            console.log(`  📡 Using WS liquidity: bid=$${liqTokenData.bestBid?.toFixed(4)} | ask=$${liqTokenData.bestAsk?.toFixed(4)} | depth=${liqTokenData.askDepth}`);
                        }
                    }
                } catch (liqErr) {
                    console.warn(`  ⚠️  Could not fetch WS liquidity: ${liqErr.message} — will fall back to REST`);
                }

                // Call the trading service to place a single order
                const result = await retrySinglePosition({
                    label: pos.label,
                    question: pos.question,
                    conditionId,
                    clobTokenIds,
                    buyPrice: pos.price,
                    marketId: pos.polymarket_id,
                }, liqTokenData);

                if (result.success) {
                    // Update the position in the DB
                    db.prepare(`
                        UPDATE positions SET status = 'filled', shares = ?, price = ?, fill_price = ?, fill_shares = ?, order_id = ?, error = NULL,
                        condition_id = COALESCE(condition_id, ?), clob_token_ids = COALESCE(clob_token_ids, ?)
                        WHERE id = ?
                    `).run(result.shares, result.price, result.price, result.shares, result.orderId, conditionId, clobTokenIds, positionId);

                    // Update the trade's total cost
                    db.prepare(`
                        UPDATE trades SET total_cost = total_cost + ?, actual_cost = COALESCE(actual_cost, 0) + ?, status = 'filled'
                        WHERE id = ?
                    `).run(result.cost, result.cost, pos.trade_id);

                    console.log(`  ✅ Position #${positionId} retried successfully: ${result.shares} shares at $${result.price}`);
                }

                res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                res.end(JSON.stringify(result));
            } catch (err) {
                console.error(`  ❌ Retry error: ${err.message}`);
                res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                res.end(JSON.stringify({ success: false, error: err.message }));
            }
        });
        return;
    }

    // Restart service — writes signal file for monitor to pick up
    if (url.pathname === '/api/restart' && req.method === 'POST') {
        console.log('\n  🔄 Restart requested via admin panel');
        const signalPath = path.join(OUTPUT_DIR, '.restart-requested');
        try {
            fs.writeFileSync(signalPath, JSON.stringify({
                requestedAt: new Date().toISOString(),
                requestedBy: 'admin-panel',
            }));
            console.log('  ✅ Restart signal written — monitor will pick up on next cycle');
        } catch (err) {
            console.warn(`  ⚠️  Could not write restart signal: ${err.message}`);
            res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            res.end(JSON.stringify({ success: false, error: 'Could not write restart signal: ' + err.message }));
            return;
        }
        res.writeHead(200, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
        });
        res.end(JSON.stringify({ success: true, message: 'Restart signal sent — monitor will restart on next cycle.' }));
        return;
    }

    // CORS preflight
    if (req.method === 'OPTIONS') {
        res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
        });
        res.end();
        return;
    }

    // Dashboard HTML
    if (url.pathname === '/' || url.pathname === '/index.html') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(getDashboardHTML(targetDate));
        return;
    }

    // Admin config page
    if (url.pathname === '/admin') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(getAdminHTML());
        return;
    }

    // 404
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
});

server.listen(port, () => {
    console.log(`\n🌡️  TempEdge Dashboard`);
    console.log(`═══════════════════════════════════════`);
    console.log(`  URL:    http://localhost:${port}`);
    console.log(`  Date:   ${targetDate}`);
    console.log(`  Data:   ${OUTPUT_DIR}`);
    console.log(`═══════════════════════════════════════\n`);
});

// ── Dashboard HTML ──────────────────────────────────────────────────────

function getDashboardHTML(defaultDate) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>TempEdge Dashboard</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
    <style>
        :root {
            --bg-primary: #0a0e17;
            --bg-secondary: #111827;
            --bg-card: #1a2235;
            --bg-card-hover: #1f2a40;
            --border: #2a3550;
            --text-primary: #f0f4f8;
            --text-secondary: #8b99b0;
            --text-muted: #5a6a80;
            --accent-blue: #3b82f6;
            --accent-orange: #f59e0b;
            --accent-cyan: #06b6d4;
            --accent-green: #10b981;
            --accent-amber: #f59e0b;
            --accent-red: #ef4444;
            --accent-purple: #8b5cf6;
            --gradient-blue: linear-gradient(135deg, #3b82f6, #06b6d4);
            --gradient-green: linear-gradient(135deg, #10b981, #06d6a0);
            --gradient-warm: linear-gradient(135deg, #f59e0b, #ef4444);
            --shadow-sm: 0 1px 3px rgba(0,0,0,0.3);
            --shadow-md: 0 4px 12px rgba(0,0,0,0.4);
            --shadow-lg: 0 8px 30px rgba(0,0,0,0.5);
            --radius: 12px;
            --radius-sm: 8px;
        }

        * { margin: 0; padding: 0; box-sizing: border-box; }

        body {
            font-family: 'Inter', -apple-system, sans-serif;
            background: var(--bg-primary);
            color: var(--text-primary);
            min-height: 100vh;
            overflow-x: hidden;
        }

        /* ── Header ─────────────────────────────── */
        .header {
            background: var(--bg-secondary);
            border-bottom: 1px solid var(--border);
            padding: 16px 32px;
            display: flex;
            align-items: center;
            justify-content: space-between;
            position: sticky;
            top: 0;
            z-index: 100;
            backdrop-filter: blur(12px);
        }

        .header-left {
            display: flex;
            align-items: center;
            gap: 16px;
        }

        .logo {
            font-size: 24px;
            font-weight: 700;
            background: var(--gradient-blue);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            background-clip: text;
        }

        .status-badge {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            padding: 4px 12px;
            border-radius: 20px;
            font-size: 12px;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }

        .status-active {
            background: rgba(16, 185, 129, 0.15);
            color: var(--accent-green);
            border: 1px solid rgba(16, 185, 129, 0.3);
        }

        .status-completed {
            background: rgba(59, 130, 246, 0.15);
            color: var(--accent-blue);
            border: 1px solid rgba(59, 130, 246, 0.3);
        }

        .status-stopped {
            background: rgba(245, 158, 11, 0.15);
            color: var(--accent-amber);
            border: 1px solid rgba(245, 158, 11, 0.3);
        }

        .status-none {
            background: rgba(90, 106, 128, 0.15);
            color: var(--text-muted);
            border: 1px solid rgba(90, 106, 128, 0.3);
        }

        .status-dot {
            width: 8px;
            height: 8px;
            border-radius: 50%;
            background: currentColor;
        }

        .status-active .status-dot {
            animation: pulse 2s infinite;
        }

        @keyframes pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.4; }
        }

        .header-right {
            display: flex;
            align-items: center;
            gap: 12px;
            font-size: 13px;
            color: var(--text-secondary);
        }

        .header-right select {
            background: var(--bg-card);
            color: var(--text-primary);
            border: 1px solid var(--border);
            border-radius: var(--radius-sm);
            padding: 6px 10px;
            font-family: 'JetBrains Mono', monospace;
            font-size: 13px;
            cursor: pointer;
        }

        /* ── Main Layout ────────────────────────── */
        .container {
            max-width: 1400px;
            margin: 0 auto;
            padding: 24px 32px;
        }

        /* ── Stat Cards Row ──────────────────────── */
        .stats-row {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
            gap: 16px;
            margin-bottom: 24px;
        }

        .stat-card {
            background: var(--bg-card);
            border: 1px solid var(--border);
            border-radius: var(--radius);
            padding: 20px;
            transition: all 0.2s ease;
        }

        .stat-card:hover {
            background: var(--bg-card-hover);
            border-color: var(--accent-blue);
            box-shadow: var(--shadow-md);
        }

        .stat-label {
            font-size: 12px;
            color: var(--text-muted);
            text-transform: uppercase;
            letter-spacing: 1px;
            margin-bottom: 8px;
        }

        .stat-value {
            font-size: 28px;
            font-weight: 700;
            font-family: 'JetBrains Mono', monospace;
        }

        .stat-sub {
            font-size: 12px;
            color: var(--text-secondary);
            margin-top: 4px;
        }

        .stat-change {
            display: inline-flex;
            align-items: center;
            gap: 4px;
            font-size: 13px;
            font-weight: 600;
            padding: 2px 8px;
            border-radius: 6px;
            margin-top: 6px;
        }

        .change-up {
            color: var(--accent-green);
            background: rgba(16, 185, 129, 0.1);
        }

        .change-down {
            color: var(--accent-red);
            background: rgba(239, 68, 68, 0.1);
        }

        .change-neutral {
            color: var(--text-muted);
            background: rgba(90, 106, 128, 0.1);
        }

        /* ── Grid Layout ─────────────────────────── */
        .grid-2col {
            display: grid;
            grid-template-columns: 2fr 1fr;
            gap: 24px;
            margin-bottom: 24px;
        }

        @media (max-width: 1024px) {
            .grid-2col { grid-template-columns: 1fr; }
        }

        /* ── Card ─────────────────────────────────── */
        .card {
            background: var(--bg-card);
            border: 1px solid var(--border);
            border-radius: var(--radius);
            overflow: visible;
        }

        .portfolio-card {
            padding: 16px;
        }

        .card-header {
            padding: 16px 20px;
            border-bottom: 1px solid var(--border);
            display: flex;
            align-items: center;
            justify-content: space-between;
        }

        .card-title {
            font-size: 14px;
            font-weight: 600;
            color: var(--text-primary);
        }

        .card-body {
            padding: 20px;
        }

        /* ── Chart ────────────────────────────────── */
        .chart-container {
            width: 100%;
            height: 280px;
            position: relative;
        }

        .chart-canvas {
            width: 100%;
            height: 100%;
        }

        .chart-empty {
            display: flex;
            align-items: center;
            justify-content: center;
            height: 100%;
            color: var(--text-muted);
            font-size: 14px;
        }

        /* ── Price Tooltip ────────────────────────── */
        .price-tip {
            position: relative;
            cursor: help;
            border-bottom: 1px dashed rgba(255,255,255,0.3);
            display: inline-block;
        }
        .price-tip .tip-content {
            display: none;
            position: absolute;
            bottom: calc(100% + 8px);
            left: 50%;
            transform: translateX(-50%);
            background: var(--surface);
            border: 1px solid var(--border);
            border-radius: 8px;
            padding: 10px 14px;
            white-space: nowrap;
            z-index: 100;
            box-shadow: 0 8px 24px rgba(0,0,0,0.4);
            font-size: 12px;
            line-height: 1.6;
            pointer-events: none;
        }
        .price-tip .tip-content::after {
            content: '';
            position: absolute;
            top: 100%;
            left: 50%;
            transform: translateX(-50%);
            border: 6px solid transparent;
            border-top-color: var(--border);
        }
        .price-tip:hover .tip-content {
            display: block;
        }
        .tip-row {
            display: flex;
            justify-content: space-between;
            gap: 16px;
        }
        .tip-label {
            color: var(--text-secondary);
        }
        .tip-price {
            font-weight: 600;
            color: var(--text-primary);
        }
        .tip-total {
            border-top: 1px solid var(--border);
            margin-top: 4px;
            padding-top: 4px;
            font-weight: 700;
        }

        /* ── Ranges Table ─────────────────────────── */
        .ranges-table {
            width: 100%;
            border-collapse: collapse;
        }

        .ranges-table th {
            font-size: 11px;
            text-transform: uppercase;
            letter-spacing: 0.8px;
            color: var(--text-muted);
            font-weight: 500;
            text-align: left;
            padding: 10px 12px;
            border-bottom: 1px solid var(--border);
        }

        .ranges-table td {
            padding: 10px 12px;
            font-size: 13px;
            font-family: 'JetBrains Mono', monospace;
            border-bottom: 1px solid rgba(42, 53, 80, 0.5);
        }

        .ranges-table tr:hover td {
            background: rgba(59, 130, 246, 0.05);
        }

        .ranges-table tr.selected-target td {
            background: rgba(59, 130, 246, 0.1);
            border-left: 3px solid var(--accent-blue);
        }

        .ranges-table tr.selected-below td {
            background: rgba(245, 158, 11, 0.08);
            border-left: 3px solid var(--accent-orange);
        }

        .ranges-table tr.selected-above td {
            background: rgba(16, 185, 129, 0.08);
            border-left: 3px solid var(--accent-green);
        }

        .range-marker {
            font-size: 16px;
            width: 24px;
            display: inline-block;
            text-align: center;
        }

        .price-bar {
            height: 6px;
            border-radius: 3px;
            background: var(--border);
            overflow: hidden;
            margin-top: 4px;
        }

        .price-bar-fill {
            height: 100%;
            border-radius: 3px;
            transition: width 0.5s ease;
        }

        /* ── Alert Feed ───────────────────────────── */
        .alert-item {
            display: flex;
            gap: 12px;
            padding: 12px 16px;
            border-bottom: 1px solid rgba(42, 53, 80, 0.5);
            font-size: 13px;
            transition: background 0.2s;
        }

        .alert-item:last-child { border-bottom: none; }
        .alert-item:hover { background: var(--bg-card-hover); }

        .alert-icon {
            font-size: 18px;
            flex-shrink: 0;
            margin-top: 1px;
        }

        .alert-content {
            flex: 1;
        }

        .alert-message {
            color: var(--text-primary);
            line-height: 1.5;
        }

        .alert-time {
            color: var(--text-muted);
            font-size: 11px;
            font-family: 'JetBrains Mono', monospace;
            margin-top: 4px;
        }

        .alert-empty {
            padding: 24px;
            text-align: center;
            color: var(--text-muted);
            font-size: 13px;
        }

        /* ── Loading / No Data ────────────────────── */
        .no-data {
            text-align: center;
            padding: 60px 20px;
            color: var(--text-muted);
        }

        .no-data h2 {
            font-size: 20px;
            font-weight: 600;
            color: var(--text-secondary);
            margin-bottom: 8px;
        }

        .no-data p {
            font-size: 14px;
            max-width: 460px;
            margin: 0 auto;
            line-height: 1.6;
        }

        .no-data code {
            background: var(--bg-card);
            padding: 2px 8px;
            border-radius: 4px;
            font-family: 'JetBrains Mono', monospace;
            font-size: 13px;
            color: var(--accent-cyan);
        }

        /* ── Refresh indicator ────────────────────── */
        .refresh-indicator {
            font-size: 11px;
            color: var(--text-muted);
            font-family: 'JetBrains Mono', monospace;
        }

        .refresh-indicator .dot {
            display: inline-block;
            width: 6px;
            height: 6px;
            border-radius: 50%;
            background: var(--accent-green);
            margin-right: 6px;
            animation: pulse 2s infinite;
        }

        /* ── Value update flash ────────────────────── */
        @keyframes valueFlash {
            0% { background: rgba(59,130,246,0.18); }
            100% { background: transparent; }
        }
        .value-updated {
            animation: valueFlash 1.2s ease-out;
            border-radius: var(--radius-sm);
        }

        .trade-row:hover td {
            background: var(--bg-card-hover);
        }

        .retry-btn {
            background: rgba(59,130,246,0.2);
            color: #60a5fa;
            border: 1px solid rgba(59,130,246,0.3);
            padding: 2px 8px;
            border-radius: 4px;
            font-size: 10px;
            font-weight: 700;
            cursor: pointer;
            margin-left: 6px;
            transition: all 0.2s;
        }
        .retry-btn:hover {
            background: rgba(59,130,246,0.4);
        }
        .retry-btn:disabled {
            cursor: wait;
            opacity: 0.7;
        }
    </style>
</head>
<body>
    <header class="header">
        <div class="header-left">
            <span class="logo">🌡️ TempEdge</span>
            <span id="statusBadge" class="status-badge status-none">
                <span class="status-dot"></span>
                <span id="statusText">Loading...</span>
            </span>
        </div>
        <div class="header-right">
            <a href="/admin" style="color:var(--text-secondary);text-decoration:none;font-size:13px;padding:6px 12px;border:1px solid var(--border);border-radius:var(--radius-sm);transition:all 0.2s;" onmouseover="this.style.color='var(--accent-cyan)';this.style.borderColor='var(--accent-cyan)'" onmouseout="this.style.color='var(--text-secondary)';this.style.borderColor='var(--border)'">⚙️ Admin</a>
            <span class="refresh-indicator"><span class="dot"></span>Auto-refresh</span>
            <select id="dateSelect" onchange="switchDate(this.value)">
                <option value="${defaultDate}">${defaultDate}</option>
            </select>
        </div>
    </header>

    <main class="container" id="app">
        <div class="no-data" id="loadingState">
            <h2>Loading...</h2>
            <p>Connecting to TempEdge monitor data</p>
        </div>
    </main>

    <script>
        let currentDate = '${defaultDate}';
        let refreshTimer = null;
        let lastRenderState = null;  // Tracks what was last rendered for incremental updates
        let currentPlay = null;     // Current portfolio play for phase-aware rendering

        // ── Data Fetching ─────────────────────────
        async function fetchStatus(date) {
            try {
                const res = await fetch('/api/status?date=' + (date || currentDate));
                return await res.json();
            } catch {
                return null;
            }
        }

        async function fetchPortfolio() {
            try {
                const res = await fetch('/api/portfolio');
                return await res.json();
            } catch {
                return null;
            }
        }

        // switchDate is declared later after lastRenderState is available

        function shortLabel(question) {
            if (!question) return '--';
            const rangeMatch = question.match(/(\\d+)-(\\d+)/);
            if (rangeMatch) return rangeMatch[1] + '-' + rangeMatch[2] + '\\u00b0F';
            const upperMatch = question.match(/(\\d+).*or higher/i);
            if (upperMatch) return upperMatch[1] + '\\u00b0F+';
            const lowerMatch = question.match(/(\\d+).*or (?:lower|below)/i);
            if (lowerMatch) return '\\u2264' + lowerMatch[1] + '\\u00b0F';
            return question.slice(0, 15);
        }

        function renderPortfolioCard(play) {
            const phaseColors = { buy: '#10b981', monitor: '#f59e0b', resolve: '#ef4444' };
            const phaseIcons = { buy: '\\ud83d\\uded2', monitor: '\\ud83d\\udc41\\ufe0f', resolve: '\\ud83c\\udfaf' };
            const phaseLabels = { buy: 'BUY', monitor: 'MONITOR', resolve: 'RESOLVE' };
            const color = phaseColors[play.phase] || '#6b7280';
            const icon = phaseIcons[play.phase] || '';
            const label = phaseLabels[play.phase] || play.phase;
            const latest = play.latest;
            const eventClosed = latest?.eventClosed === true;

            const forecastTemp = latest ? latest.forecastTempF + '\\u00b0F' : '--';
            const currentTemp = latest?.currentTempF != null ? latest.currentTempF + '\\u00b0F' : '--';
            const forecastTarget = (latest && !eventClosed) ? shortLabel(latest.target?.question) : '--';

            // Buy order & P&L data — suppress when event is closed (stale market)
            const buyOrder = eventClosed ? null : play.session?.buyOrder;
            const pnl = eventClosed ? null : play.session?.pnl;
            // Only treat as "post-buy" if at least one position was actually filled
            const hasFilled = buyOrder?.positions?.some(function(p) { return p.status !== 'failed' && p.status !== 'rejected'; });

            // Detect if bought target differs from current forecast target
            const boughtTargetQ = hasFilled ? buyOrder?.positions?.find(function(p) { return p.label === 'target'; })?.question : null;
            const boughtTarget = boughtTargetQ ? shortLabel(boughtTargetQ) : null;
            const targetShifted = buyOrder && boughtTarget && boughtTarget !== forecastTarget;
            const buyCost = buyOrder ? '$' + buyOrder.totalCost.toFixed(3) : '--';
            const sellValue = pnl ? '$' + pnl.totalCurrentValue.toFixed(3) : '--';
            const totalPnL = pnl ? pnl.totalPnL : 0;
            const totalPnLPct = pnl ? pnl.totalPnLPct : 0;
            const pnlColor = totalPnL >= 0 ? 'var(--accent-green)' : 'var(--accent-red)';
            const pnlSign = totalPnL >= 0 ? '+' : '';
            const pnlDisplay = pnl ? pnlSign + '$' + totalPnL.toFixed(4) + ' (' + pnlSign + totalPnLPct + '%)' : '--';
            const buyTime = buyOrder ? new Date(buyOrder.placedAt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZone: 'America/New_York' }) : '';

            // Build tooltip text for Bought At (per-range buy prices)
            // Use range name + role indicator instead of ambiguous buy-time labels
            let buyTitleAttr = '';
            let buyTooltipHtml = buyCost;
            if (buyOrder && buyOrder.positions) {
                const lines = buyOrder.positions.map(function(pos) {
                    var marker = pos.label === 'target' ? '\ud83c\udfaf' : '\ud83d\udcca';
                    return marker + ' ' + shortLabel(pos.question) + ' @ ' + (pos.buyPrice * 100).toFixed(1) + String.fromCharCode(162);
                });
                lines.push('Total: ' + buyCost);
                buyTitleAttr = lines.join(String.fromCharCode(10));
                buyTooltipHtml = '<span style="cursor:help;border-bottom:1px dashed rgba(255,255,255,0.3)" title="' + escapeHtml(buyTitleAttr) + '">' + buyCost + '</span>';
            }

            // Build tooltip text for Sell Value (per-range bid price + P&L)
            let sellTooltipHtml = sellValue;
            if (pnl && pnl.positions) {
                const lines = pnl.positions.map(function(pos) {
                    var marker = pos.label === 'target' ? '\ud83c\udfaf' : '\ud83d\udcca';
                    var sign = pos.pnl >= 0 ? '+' : '';
                    return marker + ' ' + shortLabel(pos.question) + ' bid@' + (pos.currentPrice * 100).toFixed(1) + String.fromCharCode(162) + ' (' + sign + (pos.pnl * 100).toFixed(1) + String.fromCharCode(162) + ')';
                });
                lines.push('Total: ' + sellValue);
                var cvTitle = lines.join(String.fromCharCode(10));
                sellTooltipHtml = '<span style="cursor:help;border-bottom:1px dashed rgba(255,255,255,0.3)" title="' + escapeHtml(cvTitle) + '">' + sellValue + '</span>';
            }

            const snaps = play.session?.snapshotCount || 0;
            const alerts = play.session?.alertCount || 0;
            const selected = play.date === currentDate ? 'border-color:' + color + ';' : '';
            const dayLabel = play.daysUntil === 0 ? 'Today' : play.daysUntil === 1 ? 'Tomorrow' : 'T+' + play.daysUntil;
            var forecastAge = latest?.timestamp ? timeAgo(latest.timestamp) : '';

            let resolutionHtml = '';
            if (play.session?.resolution) {
                const r = play.session.resolution;
                resolutionHtml = '<div style=\"margin-top:8px;padding-top:8px;border-top:1px solid rgba(255,255,255,0.1);\">' +
                    '<div style=\"color:' + color + ';font-weight:700;\">KEEP: ' + escapeHtml(shortLabel(r.keep)) + '</div>' +
                    '<div style=\"color:var(--accent-red);font-size:12px;\">DISCARD: ' + r.discard.map(d => escapeHtml(shortLabel(d))).join(', ') + '</div>' +
                    '</div>';
            }

            return '<div class=\"card portfolio-card\" style=\"cursor:pointer;' + selected + '\" onclick=\"switchDate(\\'' + play.date + '\\')\">' +
                '<div style=\"display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;\">' +
                '<div style=\"display:flex;align-items:center;gap:8px;\">' +
                '<span style=\"font-size:18px;font-weight:700;color:var(--text-primary);\">' + play.date + '</span>' +
                '<span style=\"background:' + color + ';color:#fff;font-size:11px;font-weight:700;padding:2px 10px;border-radius:99px;\">' + icon + ' ' + label + '</span>' +
                '</div>' +
                '<span style=\"color:var(--text-secondary);font-size:12px;\">' + dayLabel + '</span>' +
                '</div>' +
                '<div style=\"display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;\">' +
                '<div><div style=\"color:var(--text-secondary);font-size:11px;\">Current</div><div style=\"font-size:18px;font-weight:700;\">' + currentTemp + '</div></div>' +
                '<div><div style=\"color:var(--text-secondary);font-size:11px;\">Forecast' + (forecastAge ? ' <span style=\"opacity:0.5;font-size:10px;\">' + forecastAge + '</span>' : '') + '</div><div style=\"font-size:18px;font-weight:700;\">' + forecastTemp + '</div></div>' +
                (targetShifted ?
                    '<div><div style=\"color:var(--text-secondary);font-size:11px;\">Bought Target</div><div style=\"font-size:15px;font-weight:700;color:var(--accent-amber);\">' + boughtTarget + '</div>' +
                    '<div style=\"font-size:11px;color:var(--text-secondary);margin-top:2px;\">Forecast: <span style=\"color:' + color + ';font-weight:600;\">' + forecastTarget + '</span> \u26a0\ufe0f</div></div>' :
                    '<div><div style=\"color:var(--text-secondary);font-size:11px;\">Target</div><div style=\"font-size:18px;font-weight:700;color:' + color + ';\">' + forecastTarget + '</div></div>') +
                '</div>' +
                '<div style=\"display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-top:8px;\">' +
                '<div><div style=\"color:var(--text-secondary);font-size:11px;\">Bought At' + (buyTime ? ' (' + buyTime + ')' : '') + '</div><div style=\"font-weight:600;\">' + buyTooltipHtml + '</div></div>' +
                '<div><div style="color:var(--text-secondary);font-size:11px;">Sell Value</div><div style="font-weight:600;">' + sellTooltipHtml + '</div></div>' +
                '<div><div style=\"color:var(--text-secondary);font-size:11px;\">P&amp;L</div><div style=\"font-weight:700;font-size:14px;color:' + pnlColor + ';\">' + pnlDisplay + '</div></div>' +
                '</div>' +
                (play.hasData ? '<div style=\"margin-top:8px;color:var(--text-secondary);font-size:12px;\">' + snaps + ' snapshots \u00b7 ' + alerts + ' alerts</div>' : '<div style=\"margin-top:8px;color:var(--text-muted);font-size:12px;\">Awaiting market data</div>') +
                resolutionHtml +
                '</div>';
        }

        // ── Rendering ─────────────────────────────

        function extractViewModel(data) {
            const session = data.session;
            const observation = data.observation;
            const snapshots = session?.snapshots || [];
            const alerts = session?.alerts || [];
            const latest = snapshots[snapshots.length - 1] || null;
            const status = session?.status || (observation ? 'observation' : 'none');
            const phase = latest?.phase || session?.phase || '';

            let forecastTemp = '--', targetRange = null, belowRange = null, aboveRange = null;
            let totalCost = 0, allRanges = [];
            let currentTempF = null, currentConditions = '', maxTodayF = null;
            let forecastSource = 'unknown', daysUntilTarget = null;

            // If the event is closed (e.g. T+2 before new market created),
            // suppress stale market data but keep weather data
            const eventClosed = latest?.eventClosed === true;

            if (latest) {
                forecastTemp = latest.forecastTempF;
                currentTempF = latest.currentTempF;
                currentConditions = latest.currentConditions || '';
                maxTodayF = latest.maxTodayF;
                forecastSource = latest.forecastSource || session?.forecastSource || 'unknown';
                daysUntilTarget = latest.daysUntilTarget;
                if (!eventClosed) {
                    targetRange = latest.target;
                    belowRange = latest.below;
                    aboveRange = latest.above;
                    totalCost = latest.totalCost;
                    allRanges = latest.allRanges || [];
                }
            } else if (observation) {
                forecastTemp = observation.forecast.highTempF;
                targetRange = observation.selection.target;
                belowRange = observation.selection.below;
                aboveRange = observation.selection.above;
                totalCost = observation.selection.totalCost;
                forecastSource = observation.forecast.source || 'unknown';
                allRanges = observation.event.ranges.map(r => ({
                    marketId: r.marketId, question: r.question,
                    yesPrice: r.yesPrice, impliedProbability: r.impliedProbability, volume: r.volume,
                }));
            }

            const profit = (1 - totalCost).toFixed(3);
            const roi = totalCost > 0 ? ((1 - totalCost) / totalCost * 100).toFixed(1) : '0';
            const forecastChange = latest?.forecastChange || 0;
            const sourceLabel = forecastSource === 'weather-company' ? 'WU/KLGA' : forecastSource;

            const detailBuyOrder = eventClosed ? null : session?.buyOrder;
            const detailPnL = eventClosed ? null : session?.pnl;
            let costLabel = 'Total Cost';
            let costValue = totalCost > 0 ? '$' + totalCost?.toFixed(3) : '--';
            let costSub = totalCost > 0 ? 'Profit: $' + profit + ' \\u00b7 ROI: ' + roi + '%' : '';
            if (detailBuyOrder) {
                costLabel = 'Buy / Sell';
                costValue = '$' + detailBuyOrder.totalCost.toFixed(3);
                if (detailPnL) {
                    const pSign = detailPnL.totalPnL >= 0 ? '+' : '';
                    costSub = 'Sell: $' + detailPnL.totalCurrentValue.toFixed(3) + ' \\\\u00b7 P&L: ' + pSign + '$' + detailPnL.totalPnL.toFixed(4) + ' (' + pSign + detailPnL.totalPnLPct + '%)';
                }
            }

            return {
                session, observation, snapshots, alerts, latest,
                status, phase, forecastTemp, targetRange, belowRange, aboveRange,
                totalCost, allRanges, currentTempF, currentConditions, maxTodayF,
                forecastSource, sourceLabel, daysUntilTarget, forecastChange,
                costLabel, costValue, costSub,
                snapshotCount: snapshots.length, alertCount: alerts.length,
                snapshotTimestamp: latest?.timestamp || null,
                awaitingLiquidity: session?.awaitingLiquidity || false,
                liquidityWaitStart: session?.liquidityWaitStart || null,
            };
        }

        function updateStatCard(id, value, sub) {
            const valEl = document.getElementById(id + '-value');
            const subEl = document.getElementById(id + '-sub');
            if (!valEl) return;
            if (valEl.textContent !== value) {
                valEl.textContent = value;
                valEl.classList.remove('value-updated');
                void valEl.offsetWidth;
                valEl.classList.add('value-updated');
            }
            if (subEl && subEl.textContent !== sub) {
                subEl.textContent = sub;
            }
        }

        function renderAlertsFeed(alertsArr) {
            if (!alertsArr || alertsArr.length === 0) {
                return '<div class="alert-empty">No alerts yet. Monitoring will detect forecast shifts, range changes, and price spikes.</div>';
            }
            const alertIcons = { forecast_shift: '\\u26a0\\ufe0f', range_shift: '\\ud83d\\udd34', price_spike: '\\ud83d\\udcca', market_closed: '\\u2705' };
            let h = '';
            for (let i = alertsArr.length - 1; i >= 0; i--) {
                const a = alertsArr[i];
                h += '<div class="alert-item">';
                h += '<span class="alert-icon">' + (alertIcons[a.type] || '\\u2753') + '</span>';
                h += '<div class="alert-content">';
                h += '<div class="alert-message">' + escapeHtml(a.message) + '</div>';
                h += '<div class="alert-time">' + formatTime(a.timestamp) + '</div>';
                h += '</div></div>';
            }
            return h;
        }

        async function incrementalUpdate(data) {
            if (!lastRenderState || lastRenderState.date !== currentDate) return false;
            if (!data || (!data.session && !data.observation)) return false;
            if (!document.getElementById('statsRow')) return false;

            const vm = extractViewModel(data);
            const phaseLabels = { buy: '\\ud83d\\uded2 BUY', monitor: '\\ud83d\\udc41\\ufe0f MONITOR', resolve: '\\ud83c\\udfaf RESOLVE' };
            let phaseStr = phaseLabels[vm.phase] ? ' \\u00b7 ' + phaseLabels[vm.phase] : '';
            if (vm.awaitingLiquidity) phaseStr = ' \\u00b7 \\u23f3 AWAITING LIQUIDITY';
            updateStatus(vm.status, (vm.status.charAt(0).toUpperCase() + vm.status.slice(1)) + phaseStr);

            updateStatCard('stat-current', vm.currentTempF !== null ? vm.currentTempF + '\\u00b0F' : '--',
                vm.currentConditions + (vm.maxTodayF ? ' \\u00b7 Hi: ' + vm.maxTodayF + '\\u00b0F' : ''));
            updateStatCard('stat-forecast', vm.forecastTemp + '\\u00b0F',
                vm.sourceLabel + (vm.daysUntilTarget !== null ? ' \\u00b7 T-' + vm.daysUntilTarget : '') + (vm.snapshotTimestamp ? ' \\u00b7 ' + timeAgo(vm.snapshotTimestamp) : ''));
            updateStatCard('stat-target', shortLabel(vm.targetRange?.question || '--'),
                vm.session?.initialTargetRange ? 'Initial: ' + shortLabel(vm.session.initialTargetRange) : '');
            updateStatCard('stat-cost', vm.costValue, vm.costSub);

            const portfolio = await fetchPortfolio();
            const portfolioEl = document.getElementById('portfolioSection');
            if (portfolioEl && portfolio && portfolio.plays) {
                portfolioEl.innerHTML = '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:16px;">' +
                    portfolio.plays.map(p => renderPortfolioCard(p)).join('') + '</div>';
                currentPlay = portfolio.plays.find(p => p.date === currentDate) || null;
            }

            if (vm.snapshotCount !== lastRenderState.snapshotCount) {
                const chartEl = document.getElementById('chartContainer');
                const snapLabel = document.getElementById('snapshotCountLabel');
                if (chartEl && vm.snapshots.length >= 2) chartEl.innerHTML = renderChart(vm.snapshots);
                if (snapLabel) snapLabel.textContent = vm.snapshotCount + ' snapshots';
                lastRenderState.snapshotCount = vm.snapshotCount;
            }

            if (vm.alertCount !== lastRenderState.alertCount) {
                const alertsEl = document.getElementById('alertsBody');
                const alertLabel = document.getElementById('alertCountLabel');
                if (alertsEl) alertsEl.innerHTML = renderAlertsFeed(vm.alerts);
                if (alertLabel) alertLabel.textContent = vm.alertCount + ' total';
                lastRenderState.alertCount = vm.alertCount;
            }

            if (vm.snapshotCount !== lastRenderState.lastRangesSnapshotCount) {
                const rangesEl = document.getElementById('rangesTableBody');
                if (rangesEl) rangesEl.innerHTML = renderRangesTable(vm.allRanges, vm.targetRange, vm.belowRange, vm.aboveRange);
                lastRenderState.lastRangesSnapshotCount = vm.snapshotCount;
            }

            return true;
        }

        async function render(data) {
            if (!data) {
                document.getElementById('app').innerHTML = '<div class="no-data"><h2>Connection Error</h2><p>Could not connect to the dashboard server.</p></div>';
                lastRenderState = null;
                return;
            }

            // Fast path: incremental update (no flicker)
            if (await incrementalUpdate(data)) return;

            // ── Full rebuild below (initial load or date change) ──
            const portfolio = await fetchPortfolio();

            const select = document.getElementById('dateSelect');
            const dates = data.availableDates || [];
            if (!dates.includes(currentDate) && data.observation) dates.unshift(currentDate);
            if (dates.length > 0) {
                select.innerHTML = dates.map(d =>
                    '<option value="' + d + '"' + (d === currentDate ? ' selected' : '') + '>' + d + '</option>'
                ).join('');
            }

            const vm = extractViewModel(data);
            const session = vm.session;
            const observation = vm.observation;

            let portfolioHtml = '';
            if (portfolio && portfolio.plays) {
                portfolioHtml = '<div class="card" style="margin-bottom:24px;">' +
                    '<div class="card-header"><span class="card-title">\\ud83d\\udcca Rolling Portfolio</span><span style="color:var(--text-secondary);font-size:13px;">click a play to view details</span></div>' +
                    '<div class="card-body" id="portfolioSection">' +
                    '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:16px;">' +
                    portfolio.plays.map(p => renderPortfolioCard(p)).join('') +
                    '</div></div></div>';
                currentPlay = portfolio.plays.find(p => p.date === currentDate) || null;
            }

            if (!session && !observation) {
                updateStatus('none', 'No Data');
                let noDataHtml = '';

                // Stats Row — always visible, show placeholders for missing data
                noDataHtml += '<div class="stats-row" id="statsRow">';
                noDataHtml += statCard('stat-current', 'Current Temp', '--', '', 0, '');
                noDataHtml += statCard('stat-forecast', 'Forecast High', '--', '', 0, '');
                noDataHtml += statCard('stat-target', 'Target Range', '--', '', 0, '');
                noDataHtml += statCard('stat-cost', 'Buy / Sell', '--', '', 0, '');
                noDataHtml += '</div>';

                noDataHtml += '<div class="no-data"><h2>No monitoring data for ' + currentDate + '</h2>' +
                    '<p>Start the monitor with:<br><code>node src/monitor.js</code></p></div>' +
                    '<div id="configPanel"></div>';

                document.getElementById('app').innerHTML = portfolioHtml + noDataHtml;
                lastRenderState = { date: currentDate, snapshotCount: 0, alertCount: 0, lastRangesSnapshotCount: 0 };
                loadConfigPanel();
                return;
            }

            const phaseLabels = { buy: '\\ud83d\\uded2 BUY', monitor: '\\ud83d\\udc41\\ufe0f MONITOR', resolve: '\\ud83c\\udfaf RESOLVE' };
            let phaseStr = phaseLabels[vm.phase] ? ' \\u00b7 ' + phaseLabels[vm.phase] : '';
            if (vm.awaitingLiquidity) phaseStr = ' \\u00b7 \\u23f3 AWAITING LIQUIDITY';
            updateStatus(vm.status, (vm.status.charAt(0).toUpperCase() + vm.status.slice(1)) + phaseStr);

            const { snapshots, alerts, latest, targetRange, belowRange, aboveRange, allRanges,
                    currentTempF, currentConditions, maxTodayF, forecastTemp, sourceLabel,
                    daysUntilTarget, forecastChange, snapshotCount, alertCount,
                    costLabel, costValue, costSub } = vm;

            // Build HTML
            let html = '';

            // Stats Row
            html += '<div class="stats-row" id="statsRow">';
            html += statCard('stat-current', 'Current Temp', currentTempF !== null ? currentTempF + '\u00b0F' : '--', currentConditions + (maxTodayF ? ' \u00b7 Hi: ' + maxTodayF + '\u00b0F' : ''), 0, '');
            html += statCard('stat-forecast', 'Forecast High', forecastTemp + '\u00b0F', sourceLabel + (daysUntilTarget !== null ? ' \u00b7 T-' + daysUntilTarget : ''), forecastChange, '\u00b0F');
            html += statCard('stat-target', 'Target Range', shortLabel(targetRange?.question || '--'), session?.initialTargetRange ? 'Initial: ' + shortLabel(session.initialTargetRange) : '', 0, '');
            html += statCard('stat-cost', costLabel, costValue, costSub, 0, '');
            html += '</div>';

            // Resolve-day decision card
            if (session?.resolution) {
                const r = session.resolution;
                html += '<div class="card" style="border-color:var(--accent-green);margin-bottom:24px;">';
                html += '<div class="card-header" style="background:rgba(16,185,129,0.1);"><span class="card-title">🎯 Resolve Day — Range Decision</span></div>';
                html += '<div class="card-body">';
                html += '<div style="font-size:18px;font-weight:700;color:var(--accent-green);margin-bottom:8px;">KEEP: ' + escapeHtml(shortLabel(r.keep)) + ' (' + (r.keepPrice * 100).toFixed(1) + '¢)</div>';
                html += '<div style="color:var(--accent-red);margin-bottom:8px;">DISCARD: ' + r.discard.map(d => escapeHtml(shortLabel(d))).join(', ') + '</div>';
                html += '<div style="color:var(--text-secondary);font-size:13px;">' + escapeHtml(r.reason) + '</div>';
                html += '</div></div>';
            }

            // Chart + Alerts Layout
            html += '<div class="grid-2col">';

            // Price History Chart
            html += '<div class="card">';
            html += '<div class="card-header"><span class="card-title">📈 Price History</span><span id="snapshotCountLabel" style="font-size:12px;color:var(--text-muted);">' + snapshotCount + ' snapshots</span></div>';
            html += '<div class="card-body"><div class="chart-container" id="chartContainer">';
            if (snapshots.length >= 2) {
                html += renderChart(snapshots);
            } else {
                html += '<div class="chart-empty">Waiting for more snapshots to plot chart...</div>';
            }
            html += '</div></div></div>';

            // Alerts Feed
            html += '<div class="card">';
            html += '<div class="card-header"><span class="card-title">🔔 Alerts</span><span id="alertCountLabel" style="font-size:12px;color:var(--text-muted);">' + alertCount + ' total</span></div>';
            html += '<div class="card-body" style="padding:0;max-height:280px;overflow-y:auto;" id="alertsBody">';
            html += renderAlertsFeed(alerts);
            html += '</div></div>';

            html += '</div>'; // end grid-2col

            // Live Liquidity Panel (T+2 WebSocket stream)
            html += '<div class="card" id="liquidityCard" style="display:none;">';
            html += '<div class="card-header"><span class="card-title">📡 Live Liquidity</span><span id="liquidityStatus" style="font-size:11px;color:var(--text-muted);font-family:JetBrains Mono,monospace;">connecting...</span></div>';
            html += '<div class="card-body" id="liquidityBody" style="padding:0;">';
            html += '<div style="padding:24px;text-align:center;color:var(--text-muted);font-size:13px;">Connecting to order book stream...</div>';
            html += '</div></div>';

            // Forecast Pipeline (Scout/Track observations)
            html += '<div class="card" id="pipelineCard" style="display:none;">';
            html += '<div class="card-header"><span class="card-title">🔭 Forecast Pipeline</span><span id="pipelineCount" style="font-size:12px;color:var(--text-muted);">loading...</span></div>';
            html += '<div class="card-body" id="pipelineBody" style="padding:0;">';
            html += '<div style="padding:24px;text-align:center;color:var(--text-muted);font-size:13px;">Loading pipeline data...</div>';
            html += '</div></div>';

            // Trade Log
            html += '<div class="card" id="tradeLogCard">';
            html += '<div class="card-header"><span class="card-title">📋 Trade Log</span><span id="tradeLogCount" style="font-size:12px;color:var(--text-muted);">loading...</span></div>';
            html += '<div class="card-body" id="tradeLogBody" style="padding:0;max-height:400px;overflow-y:auto;">';
            html += '<div style="padding:24px;text-align:center;color:var(--text-muted);font-size:13px;">Loading trade history...</div>';
            html += '</div></div>';

            // All Ranges Table
            html += '<div class="card">';
            html += '<div class="card-header"><span class="card-title">📊 All Temperature Ranges</span></div>';
            html += '<div class="card-body" style="padding:0;overflow-x:auto;" id="rangesTableBody">';
            html += renderRangesTable(allRanges, targetRange, belowRange, aboveRange);
            html += '</div></div>';

            // Config Panel — rendered async after initial paint
            html += '<div id="configPanel"></div>';

            document.getElementById('app').innerHTML = portfolioHtml + html;

            // Track render state for incremental updates
            lastRenderState = {
                date: currentDate,
                snapshotCount: snapshotCount,
                alertCount: alertCount,
                lastRangesSnapshotCount: snapshotCount,
            };

            // Load config panel asynchronously (only on full rebuild)
            loadConfigPanel();

            // Start liquidity polling
            fetchLiquidity();

            // Start pipeline polling
            fetchPipeline();

            // Start trade log polling
            fetchTradeLog();
        }

        async function loadConfigPanel() {
            try {
                const res = await fetch('/api/config');
                const data = await res.json();
                if (data && data.config) {
                    renderConfigPanel(data.config);
                }
            } catch {
                // Config panel is optional — fail silently
            }
        }

        function renderConfigPanel(cfg) {
            const sectionLabels = {
                trading: { icon: '💰', label: 'Trading & Risk' },
                monitor: { icon: '👁️', label: 'Monitoring' },
                weather: { icon: '🌤️', label: 'Weather Service' },
                polymarket: { icon: '📈', label: 'Polymarket API' },
                dashboard: { icon: '📊', label: 'Dashboard' },
                phases: { icon: '🔄', label: 'Phase Logic' },
            };

            let html = '<div class="card" style="margin-top:24px;">';
            html += '<div class="card-header" style="cursor:pointer;" onclick="toggleConfigPanel()">';
            html += '<span class="card-title">⚙️ Runtime Configuration</span>';
            html += '<span id="configToggle" style="color:var(--text-muted);font-size:12px;">▶ Show</span>';
            html += '</div>';
            html += '<div class="card-body" id="configBody" style="display:none;padding:0;">';

            for (const [section, fields] of Object.entries(cfg)) {
                const meta = sectionLabels[section] || { icon: '📋', label: section };
                html += '<div style="padding:16px 20px;border-bottom:1px solid var(--border);">';
                html += '<div style="font-weight:600;font-size:13px;margin-bottom:12px;color:var(--text-primary);">' + meta.icon + ' ' + meta.label + '</div>';
                html += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:10px;">';

                for (const [key, info] of Object.entries(fields)) {
                    const isOverridden = info.source === 'env';
                    const badgeColor = isOverridden ? 'var(--accent-cyan)' : 'var(--text-muted)';
                    const badgeBg = isOverridden ? 'rgba(6,182,212,0.12)' : 'rgba(90,106,128,0.1)';
                    const badgeText = isOverridden ? 'ENV' : 'DEFAULT';
                    const displayVal = typeof info.value === 'string' && info.value.length > 40
                        ? info.value.slice(0, 37) + '...'
                        : String(info.value);

                    html += '<div style="background:var(--bg-primary);border:1px solid var(--border);border-radius:var(--radius-sm);padding:10px 12px;">';
                    html += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">';
                    html += '<span style="font-family:JetBrains Mono,monospace;font-size:11px;color:var(--text-secondary);">' + escapeHtml(info.envKey) + '</span>';
                    html += '<span style="font-size:10px;font-weight:700;padding:1px 6px;border-radius:4px;background:' + badgeBg + ';color:' + badgeColor + ';">' + badgeText + '</span>';
                    html += '</div>';
                    html += '<div style="font-family:JetBrains Mono,monospace;font-size:13px;font-weight:600;color:var(--text-primary);word-break:break-all;">' + escapeHtml(displayVal) + '</div>';
                    if (isOverridden && String(info.default) !== String(info.value) && info.default !== '(hidden)') {
                        html += '<div style="font-size:11px;color:var(--text-muted);margin-top:2px;">default: ' + escapeHtml(String(info.default)) + '</div>';
                    }
                    html += '</div>';
                }

                html += '</div></div>';
            }

            html += '</div></div>';
            document.getElementById('configPanel').innerHTML = html;
        }

        function toggleConfigPanel() {
            const body = document.getElementById('configBody');
            const toggle = document.getElementById('configToggle');
            if (body.style.display === 'none') {
                body.style.display = 'block';
                toggle.textContent = '▼ Hide';
            } else {
                body.style.display = 'none';
                toggle.textContent = '▶ Show';
            }
        }

        // ── Live Liquidity ─────────────────────────
        let liquidityTimer = null;

        async function fetchLiquidity() {
            if (liquidityTimer) clearTimeout(liquidityTimer);
            try {
                const res = await fetch('/api/liquidity?date=' + encodeURIComponent(currentDate));
                const data = await res.json();
                renderLiquidity(data);
            } catch {
                // silent
            }
            liquidityTimer = setTimeout(fetchLiquidity, ${config.dashboard.liquidityPollMs});
        }

        // ── Forecast Pipeline ───────────────────────────
        let pipelineTimer = null;
        async function fetchPipeline() {
            if (pipelineTimer) clearTimeout(pipelineTimer);
            try {
                const res = await fetch('/api/pipeline');
                const data = await res.json();
                renderPipeline(data);
            } catch { /* silent */ }
            pipelineTimer = setTimeout(fetchPipeline, 30000);
        }

        function renderPipeline(data) {
            const card = document.getElementById('pipelineCard');
            const body = document.getElementById('pipelineBody');
            const countEl = document.getElementById('pipelineCount');
            if (!card || !body) return;
            if (!data || !data.pipeline || data.pipeline.length === 0) {
                card.style.display = 'none';
                return;
            }
            card.style.display = 'block';
            if (countEl) countEl.textContent = data.pipeline.length + ' scouting';

            var html = '<table style="width:100%;border-collapse:collapse;font-size:13px;">';
            html += '<thead><tr style="border-bottom:1px solid var(--border);">';
            html += '<th style="padding:10px 14px;text-align:left;color:var(--text-secondary);font-weight:600;">Date</th>';
            html += '<th style="padding:10px 8px;text-align:center;color:var(--text-secondary);font-weight:600;">Phase</th>';
            html += '<th style="padding:10px 8px;text-align:left;color:var(--text-secondary);font-weight:600;">Current Forecast</th>';
            html += '<th style="padding:10px 8px;text-align:left;color:var(--text-secondary);font-weight:600;">Forecast History</th>';
            html += '<th style="padding:10px 14px;text-align:center;color:var(--text-secondary);font-weight:600;">Trend</th>';
            html += '</tr></thead><tbody>';

            for (var i = 0; i < data.pipeline.length; i++) {
                var p = data.pipeline[i];
                var phaseBadge = p.phase === 'scout'
                    ? '<span style="background:rgba(6,182,212,0.15);color:#22d3ee;padding:3px 10px;border-radius:6px;font-size:11px;font-weight:700;">\\ud83d\\udd2d Scout</span>'
                    : '<span style="background:rgba(168,85,247,0.15);color:#c084fc;padding:3px 10px;border-radius:6px;font-size:11px;font-weight:700;">\\ud83d\\udcc8 Track</span>';

                var forecastStr = p.latestForecast ? p.latestForecast + '\\u00b0F' : '--';
                var rangeStr = p.targetRange ? ' (' + p.targetRange + '\\u00b0F)' : '';

                // Build forecast history progression
                var historyParts = [];
                if (p.forecastHistory && p.forecastHistory.length > 0) {
                    var sorted = p.forecastHistory.slice().sort(function(a,b) { return b.daysOut - a.daysOut; });
                    for (var j = 0; j < sorted.length; j++) {
                        var h = sorted[j];
                        var label = 'T+' + h.daysOut + ': ' + h.forecast + '\\u00b0F';
                        if (j > 0) {
                            var delta = h.forecast - sorted[j-1].forecast;
                            var sign = delta > 0 ? '+' : '';
                            var col = delta > 0 ? 'var(--accent-red)' : delta < 0 ? 'var(--accent-cyan)' : 'var(--text-muted)';
                            label += ' <span style="color:' + col + ';font-size:11px;">(' + sign + delta + ')</span>';
                        }
                        historyParts.push(label);
                    }
                }
                var historyStr = historyParts.length > 0 ? historyParts.join(' \\u2192 ') : '<span style="color:var(--text-muted);">Awaiting first observation</span>';

                // Trend badge
                var trendBadge = '<span style="color:var(--text-muted);font-size:12px;">--</span>';
                if (p.trend && p.trend.direction !== 'neutral' && p.forecastHistory && p.forecastHistory.length >= 2) {
                    var arrow = p.trend.direction === 'warming' ? '\\u2197\\ufe0f' : '\\u2198\\ufe0f';
                    var tColor = p.trend.direction === 'warming' ? 'var(--accent-red)' : 'var(--accent-cyan)';
                    var tSign = p.trend.magnitude > 0 ? '+' : '';
                    trendBadge = '<span style="color:' + tColor + ';font-weight:700;font-size:13px;">' + arrow + ' ' + tSign + p.trend.magnitude + '\\u00b0F</span>';
                } else if (p.forecastHistory && p.forecastHistory.length >= 2) {
                    trendBadge = '<span style="color:var(--text-muted);font-size:12px;">\\u2194\\ufe0f Neutral</span>';
                }

                html += '<tr style="border-bottom:1px solid var(--border);">';
                html += '<td style="padding:10px 14px;font-weight:600;white-space:nowrap;">' + p.date + '</td>';
                html += '<td style="padding:10px 8px;text-align:center;">' + phaseBadge + '</td>';
                html += '<td style="padding:10px 8px;font-family:JetBrains Mono,monospace;font-weight:600;">' + forecastStr + rangeStr + '</td>';
                html += '<td style="padding:10px 8px;font-size:12px;line-height:1.6;">' + historyStr + '</td>';
                html += '<td style="padding:10px 14px;text-align:center;">' + trendBadge + '</td>';
                html += '</tr>';
            }

            html += '</tbody></table>';
            body.innerHTML = html;
        }

        // ── Trade Log ─────────────────────────────────
        let tradeLogTimer = null;
        async function fetchTradeLog() {
            if (tradeLogTimer) clearTimeout(tradeLogTimer);
            try {
                const res = await fetch('/api/trades');
                const data = await res.json();
                renderTradeLog(data);
            } catch { /* silent */ }
            tradeLogTimer = setTimeout(fetchTradeLog, 30000);
        }

        async function retryPosition(positionId, btnEl) {
            if (!positionId) return;
            if (!confirm('Retry this failed order? This will place a real trade.')) return;

            // Loading state
            var origHtml = btnEl.innerHTML;
            btnEl.disabled = true;
            btnEl.innerHTML = '\u23f3 Placing...';
            btnEl.style.background = 'rgba(251,191,36,0.2)';
            btnEl.style.color = '#fbbf24';
            btnEl.style.borderColor = 'rgba(251,191,36,0.3)';

            try {
                var res = await fetch('/api/retry-position', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ positionId: positionId }),
                });
                var result = await res.json();

                if (result.success) {
                    btnEl.innerHTML = '\u2705 ' + result.shares + ' shares filled';
                    btnEl.style.background = 'rgba(16,185,129,0.2)';
                    btnEl.style.color = '#34d399';
                    btnEl.style.borderColor = 'rgba(16,185,129,0.3)';
                    // Refresh trade log after 2s to show updated data
                    setTimeout(fetchTradeLog, 2000);
                } else {
                    btnEl.innerHTML = '\u274c ' + (result.error || 'Failed').substring(0, 30);
                    btnEl.style.background = 'rgba(239,68,68,0.15)';
                    btnEl.style.color = '#f87171';
                    btnEl.style.borderColor = 'rgba(239,68,68,0.3)';
                    // Re-enable after 5s
                    setTimeout(function() {
                        btnEl.disabled = false;
                        btnEl.innerHTML = origHtml;
                        btnEl.style.background = 'rgba(59,130,246,0.2)';
                        btnEl.style.color = '#60a5fa';
                        btnEl.style.borderColor = 'rgba(59,130,246,0.3)';
                    }, 5000);
                }
            } catch (err) {
                btnEl.innerHTML = '\u274c Network error';
                btnEl.style.background = 'rgba(239,68,68,0.15)';
                btnEl.style.color = '#f87171';
                setTimeout(function() {
                    btnEl.disabled = false;
                    btnEl.innerHTML = origHtml;
                    btnEl.style.background = 'rgba(59,130,246,0.2)';
                    btnEl.style.color = '#60a5fa';
                }, 5000);
            }
        }

        function renderTradeLog(data) {
            const body = document.getElementById('tradeLogBody');
            const countEl = document.getElementById('tradeLogCount');
            if (!body) return;
            if (!data || !data.trades || data.trades.length === 0) {
                body.innerHTML = '<div style="padding:24px;text-align:center;color:var(--text-muted);font-size:13px;">No trades yet</div>';
                if (countEl) countEl.textContent = '0 trades';
                return;
            }

            // Count real vs simulated
            const realCount = data.trades.filter(function(t) {
                return t.mode === 'live' && t.positions.some(function(p) { return p.status === 'placed'; });
            }).length;
            const simCount = data.trades.filter(function(t) { return t.mode === 'dry-run'; }).length;
            const failCount = data.trades.filter(function(t) {
                return t.mode === 'live' && t.positions.every(function(p) { return p.status === 'failed'; });
            }).length;

            if (countEl) {
                countEl.textContent = realCount + ' live, ' + simCount + ' sim, ' + failCount + ' failed';
            }

            let html = '<table style="width:100%;border-collapse:collapse;font-size:13px;">';
            html += '<thead><tr style="border-bottom:1px solid var(--border);">';
            html += '<th style="padding:10px 14px;text-align:left;color:var(--text-secondary);font-weight:600;">Date</th>';
            html += '<th style="padding:10px 8px;text-align:center;color:var(--text-secondary);font-weight:600;">Execution</th>';
            html += '<th style="padding:10px 8px;text-align:left;color:var(--text-secondary);font-weight:600;">Time</th>';
            html += '<th style="padding:10px 8px;text-align:left;color:var(--text-secondary);font-weight:600;">Positions</th>';
            html += '<th style="padding:10px 8px;text-align:right;color:var(--text-secondary);font-weight:600;">Cost</th>';
            html += '<th style="padding:10px 8px;text-align:right;color:var(--text-secondary);font-weight:600;">P&L</th>';
            html += '<th style="padding:10px 14px;text-align:center;color:var(--text-secondary);font-weight:600;">Session</th>';
            html += '</tr></thead><tbody>';

            for (const t of data.trades) {
                const time = t.placedAt ? new Date(t.placedAt).toLocaleTimeString('en-US', {hour:'2-digit',minute:'2-digit',timeZone:'America/New_York'}) : '--';

                // Determine execution type
                const allFailed = t.positions.every(function(p) { return p.status === 'failed'; });
                const anyPlaced = t.positions.some(function(p) { return p.status === 'placed' || p.status === 'filled'; });
                const anyPartial = t.positions.some(function(p) { return p.status === 'partial'; });
                let execBadge = '';
                if (t.mode === 'dry-run') {
                    execBadge = '<span style="background:rgba(251,191,36,0.2);color:#fbbf24;padding:3px 10px;border-radius:6px;font-size:11px;font-weight:700;">\\ud83e\\uddea DRY RUN</span>';
                } else if (allFailed) {
                    const firstErr = t.positions[0]?.error || 'unknown';
                    execBadge = '<span style="background:rgba(239,68,68,0.15);color:#f87171;padding:3px 10px;border-radius:6px;font-size:11px;font-weight:700;cursor:help;" title="' + escapeHtml(firstErr) + '">\\u274c FAILED</span>';
                } else if (anyPlaced) {
                    execBadge = '<span style="background:rgba(16,185,129,0.15);color:#34d399;padding:3px 10px;border-radius:6px;font-size:11px;font-weight:700;">\\ud83d\\udfe2 LIVE</span>';
                } else if (anyPartial) {
                    execBadge = '<span style="background:rgba(251,191,36,0.2);color:#fbbf24;padding:3px 10px;border-radius:6px;font-size:11px;font-weight:700;">\\ud83d\\udfe1 PARTIAL</span>';
                } else {
                    execBadge = '<span style="background:rgba(107,114,128,0.15);color:#9ca3af;padding:3px 10px;border-radius:6px;font-size:11px;font-weight:700;">\\u2753 Unknown</span>';
                }

                // Position details with clear icons
                const posLabels = t.positions.map(function(p) {
                    var icon, tipText = '', extraInfo = '';
                    if (p.soldAt && p.soldStatus === 'placed') {
                        // Sold position
                        icon = '\\ud83d\\udcb5';  // money = sold
                        var sp = p.sellPrice || (typeof p.soldAt === 'number' ? p.soldAt : parseFloat(p.soldAt) || 0);
                        var posShares = p.shares || 1;
                        var realizedPnl = (sp - p.buyPrice) * posShares;
                        var pnlSign = realizedPnl >= 0 ? '+' : '';
                        var pnlColor = realizedPnl >= 0 ? 'var(--accent-green)' : 'var(--accent-red)';
                        extraInfo = ' <span style="background:rgba(107,114,128,0.25);color:#9ca3af;padding:1px 6px;border-radius:4px;font-size:10px;font-weight:700;margin-left:4px;">SOLD @$' + sp.toFixed(2) + '</span>';
                        extraInfo += ' <span style="color:' + pnlColor + ';font-size:11px;font-weight:600;">' + pnlSign + '$' + realizedPnl.toFixed(3) + '</span>';
                    } else if ((p.status === 'placed' || p.status === 'filled') && t.mode !== 'dry-run') {
                        icon = '\\ud83d\\udfe2';  // green circle = filled/placed
                    } else if (t.mode === 'dry-run') {
                        icon = '\\ud83e\\uddea';  // flask = simulated
                    } else {
                        icon = '\\u274c';  // red X = failed
                        tipText = p.error || '';
                    }
                    // Extract range from question (e.g., "54-55°F" from "...between 54-55°F on March 20?")
                    var rangeMatch = p.question ? p.question.match(/between[ ]+([0-9]+-[0-9]+)[^a-zA-Z0-9]*F/i) : null;
                    var edgeMatch = !rangeMatch && p.question ? p.question.match(/be[ ]+([0-9]+)[^a-zA-Z0-9]*F[ ]+(or[ ]+)(below|higher|above)/i) : null;
                    var displayLabel = rangeMatch ? rangeMatch[1] + '\u00b0F' : edgeMatch ? edgeMatch[1] + '\u00b0F ' + edgeMatch[3] : p.label;
                    // Add role as a subtle tag: (target), (below), (above)
                    var roleTag = (p.label && p.label !== displayLabel) ? ' <span style="color:var(--text-muted);font-size:10px;opacity:0.7;">(' + p.label + ')</span>' : '';
                    var priceStr = p.buyPrice ? '$' + p.buyPrice.toFixed(2) : '--';
                    var shares = p.shares ? ' \\u00d7' + p.shares : '';
                    var label = icon + ' ' + displayLabel + roleTag + ' @' + priceStr + shares + extraInfo;
                    if (tipText) {
                        label += ' <span style="color:var(--text-muted);font-size:11px;" title="' + escapeHtml(tipText) + '">(' + escapeHtml(tipText.substring(0, 25)) + ')</span>';
                    }
                    // Add retry button for failed live positions (only on active sessions)
                    if (p.status === 'failed' && t.mode === 'live' && p.positionId && t.sessionStatus === 'active') {
                        label += ' <button onclick="retryPosition(' + p.positionId + ', this)" class="retry-btn" title="Retry this failed order">\ud83d\udd04 Retry</button>';
                    }
                    return label;
                }).join('<br>');

                // P&L (only meaningful for real or dry-run with cost > 0)
                const pnlVal = t.pnl ? t.pnl.totalPnL : null;
                const pnlPct = t.pnl ? t.pnl.totalPnLPct : null;
                const hasCost = t.totalCost > 0;
                const pnlColor = !hasCost ? 'var(--text-muted)' : pnlVal >= 0 ? 'var(--accent-green)' : 'var(--accent-red)';
                const pnlStr = hasCost && pnlVal !== null ? (pnlVal >= 0 ? '+' : '') + '$' + pnlVal.toFixed(3) + ' (' + (pnlPct >= 0 ? '+' : '') + pnlPct.toFixed(1) + '%)' : (allFailed ? 'N/A' : '--');

                // Session status badge
                const statusMap = {
                    active: { bg: 'rgba(59,130,246,0.15)', color: '#60a5fa', text: '\\ud83d\\udfe2 Active' },
                    completed: { bg: 'rgba(16,185,129,0.15)', color: '#34d399', text: '\\u2705 Done' },
                    stopped: { bg: 'rgba(107,114,128,0.15)', color: '#9ca3af', text: '\\u23f9 Stopped' },
                };
                const st = statusMap[t.sessionStatus] || statusMap.active;

                // Cost display
                const costStr = hasCost ? '$' + t.totalCost.toFixed(3) : (allFailed ? '$0 (rejected)' : '$0');

                html += '<tr style="border-bottom:1px solid var(--border);transition:background 0.15s;' + (allFailed ? 'opacity:0.6;' : '') + '" class="trade-row">';
                html += '<td style="padding:10px 14px;font-weight:600;white-space:nowrap;">' + t.date + '</td>';
                html += '<td style="padding:10px 8px;text-align:center;">' + execBadge + '</td>';
                html += '<td style="padding:10px 8px;color:var(--text-secondary);white-space:nowrap;font-family:JetBrains Mono,monospace;font-size:12px;">' + time + ' ET</td>';
                html += '<td style="padding:10px 8px;line-height:1.6;">' + posLabels + '</td>';
                html += '<td style="padding:10px 8px;text-align:right;font-family:JetBrains Mono,monospace;font-weight:600;' + (allFailed ? 'color:var(--text-muted);' : '') + '">' + costStr + '</td>';
                html += '<td style="padding:10px 8px;text-align:right;font-family:JetBrains Mono,monospace;font-weight:600;color:' + pnlColor + ';">' + pnlStr + '</td>';
                html += '<td style="padding:10px 14px;text-align:center;"><span style="background:' + st.bg + ';color:' + st.color + ';padding:3px 10px;border-radius:6px;font-size:11px;font-weight:600;">' + st.text + '</span></td>';
                html += '</tr>';
            }

            html += '</tbody></table>';
            body.innerHTML = html;
        }

        function renderLiquidity(data) {
            const card = document.getElementById('liquidityCard');
            const body = document.getElementById('liquidityBody');
            const statusEl = document.getElementById('liquidityStatus');

            if (!card) return;
            if (!data || !data.tokens || data.tokens.length === 0) {
                if (data && data.status === 'disabled') {
                    card.style.display = 'none';
                }
                return;
            }

            card.style.display = 'block';

            // Status indicator
            const statusColors = { connected: 'var(--accent-green)', connecting: 'var(--accent-amber)', disconnected: 'var(--accent-red)' };
            const statusColor = statusColors[data.status] || 'var(--text-muted)';
            statusEl.innerHTML = '<span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:' + statusColor + ';margin-right:5px;"></span>' + data.status;

            let html = '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:0;">';

            // Phase-aware label logic:
            // - Buy phase: TARGET / BELOW / ABOVE (current forecast labels)
            // - Post-buy: range names with bought-target marker
            const hasBuyOrder = currentPlay?.session?.buyOrder;
            const hasFilled = hasBuyOrder?.positions?.some(function(p) { return p.status !== 'failed' && p.status !== 'rejected'; });
            const boughtTargetQ = hasFilled ? hasBuyOrder?.positions?.find(function(p) { return p.label === 'target'; })?.question : null;

            const labelColors = { target: 'var(--accent-blue)', below: 'var(--accent-orange)', above: 'var(--accent-green)' };
            const labelIcons = { target: '🎯', below: '⬇️', above: '⬆️' };

            for (const token of data.tokens) {
                // Determine display label based on phase
                let displayLabel, displayIcon, displayColor;
                if (hasFilled) {
                    // Post-buy: show range name with role marker
                    const isBoughtTarget = token.question === boughtTargetQ;
                    displayLabel = shortLabel(token.question);
                    displayIcon = isBoughtTarget ? '🎯' : '📊';
                    displayColor = isBoughtTarget ? 'var(--accent-amber)' : 'var(--text-primary)';
                } else {
                    // Buy phase: standard TARGET/BELOW/ABOVE labels
                    const lbl = token.label;
                    displayLabel = lbl.toUpperCase() + ' <span style="color:var(--text-secondary);font-weight:400;">' + shortLabel(token.question) + '</span>';
                    displayIcon = labelIcons[lbl] || '📊';
                    displayColor = labelColors[lbl] || 'var(--text-primary)';
                }

                const liquidBg = token.isLiquid ? 'rgba(16,185,129,0.08)' : 'rgba(239,68,68,0.05)';
                const liquidBorder = token.isLiquid ? 'var(--accent-green)' : 'var(--border)';
                const spreadColor = token.spreadPct <= (data.thresholds?.maxSpreadPct || 0.2) ? 'var(--accent-green)' : 'var(--accent-red)';
                const depthColor = token.askDepth >= (data.thresholds?.minAskDepth || 5) ? 'var(--accent-green)' : 'var(--accent-red)';

                // Short question label
                var ql = shortLabel(token.question);

                // Score bar width
                var scorePct = Math.round(token.score * 100);
                var scoreColor = scorePct >= 60 ? 'var(--accent-green)' : scorePct >= 30 ? 'var(--accent-amber)' : 'var(--accent-red)';

                html += '<div style="padding:16px 20px;border-bottom:1px solid var(--border);border-left:3px solid ' + liquidBorder + ';background:' + liquidBg + ';">';

                // Header: label + question + liquid badge
                html += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">';
                html += '<div style="font-weight:600;font-size:13px;color:' + displayColor + ';">' + displayIcon + ' ' + displayLabel + '</div>';
                html += '<span style="font-size:10px;font-weight:700;padding:2px 8px;border-radius:4px;background:' + (token.isLiquid ? 'rgba(16,185,129,0.15)' : 'rgba(239,68,68,0.12)') + ';color:' + (token.isLiquid ? 'var(--accent-green)' : 'var(--accent-red)') + ';">' + (token.isLiquid ? '🟢 LIQUID' : '🔴 ILLIQUID') + '</span>';
                html += '</div>';

                // Metrics grid
                html += '<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:8px;">';

                // Bid
                html += '<div style="text-align:center;">';
                html += '<div style="font-size:11px;color:var(--text-muted);margin-bottom:2px;">Bid</div>';
                html += '<div style="font-family:JetBrains Mono,monospace;font-size:14px;font-weight:600;color:var(--accent-green);">' + (token.bestBid > 0 ? (token.bestBid * 100).toFixed(1) + '¢' : '--') + '</div>';
                html += '</div>';

                // Ask
                html += '<div style="text-align:center;">';
                html += '<div style="font-size:11px;color:var(--text-muted);margin-bottom:2px;">Ask</div>';
                html += '<div style="font-family:JetBrains Mono,monospace;font-size:14px;font-weight:600;color:var(--accent-red);">' + (token.bestAsk > 0 ? (token.bestAsk * 100).toFixed(1) + '¢' : '--') + '</div>';
                html += '</div>';

                // Spread
                html += '<div style="text-align:center;">';
                html += '<div style="font-size:11px;color:var(--text-muted);margin-bottom:2px;">Spread</div>';
                html += '<div style="font-family:JetBrains Mono,monospace;font-size:14px;font-weight:600;color:' + spreadColor + ';">' + (token.spreadPct * 100).toFixed(1) + '%</div>';
                html += '</div>';

                // Depth
                html += '<div style="text-align:center;">';
                html += '<div style="font-size:11px;color:var(--text-muted);margin-bottom:2px;">Depth</div>';
                html += '<div style="font-family:JetBrains Mono,monospace;font-size:14px;font-weight:600;color:' + depthColor + ';">' + token.askDepth.toFixed(1) + '</div>';
                html += '</div>';

                html += '</div>';

                // Score bar
                html += '<div style="display:flex;align-items:center;gap:8px;">';
                html += '<div style="font-size:11px;color:var(--text-muted);width:40px;">Score</div>';
                html += '<div style="flex:1;height:6px;background:rgba(42,53,80,0.5);border-radius:3px;overflow:hidden;">';
                html += '<div style="width:' + scorePct + '%;height:100%;background:' + scoreColor + ';border-radius:3px;transition:width 0.5s;"></div>';
                html += '</div>';
                html += '<div style="font-family:JetBrains Mono,monospace;font-size:12px;font-weight:600;color:' + scoreColor + ';width:35px;text-align:right;">' + scorePct + '%</div>';
                html += '</div>';

                html += '</div>';
            }

            html += '</div>';
            body.innerHTML = html;
        }

        function statCard(id, label, value, sub, change, unit) {
            let changeHtml = '';
            if (change !== 0) {
                const cls = change > 0 ? 'change-up' : 'change-down';
                const sign = change > 0 ? '+' : '';
                changeHtml = '<div class="stat-change ' + cls + '">' + sign + change + unit + '</div>';
            }
            return '<div class="stat-card" id="' + id + '">' +
                '<div class="stat-label">' + label + '</div>' +
                '<div class="stat-value" id="' + id + '-value">' + value + '</div>' +
                '<div class="stat-sub" id="' + id + '-sub">' + sub + '</div>' +
                changeHtml +
                '</div>';
        }

        function updateStatus(status, text) {
            const badge = document.getElementById('statusBadge');
            const textEl = document.getElementById('statusText');
            badge.className = 'status-badge status-' + status;
            textEl.textContent = text;
        }

        function renderRangesTable(ranges, target, below, above) {
            if (!ranges || ranges.length === 0) return '<div class="alert-empty">No range data available</div>';

            const sorted = [...ranges].sort((a, b) => {
                const aLow = a.question.match(/\\d+/);
                const bLow = b.question.match(/\\d+/);
                return (aLow ? parseInt(aLow[0]) : -999) - (bLow ? parseInt(bLow[0]) : -999);
            });

            let html = '<table class="ranges-table">';
            html += '<thead><tr><th></th><th>Range</th><th>YES Price</th><th>Implied %</th><th>Volume</th><th>Probability</th></tr></thead>';
            html += '<tbody>';

            for (const r of sorted) {
                let rowClass = '';
                let marker = '';
                if (target && r.marketId === target.marketId) { rowClass = 'selected-target'; marker = '🎯'; }
                else if (below && r.marketId === below.marketId) { rowClass = 'selected-below'; marker = '⬇️'; }
                else if (above && r.marketId === above.marketId) { rowClass = 'selected-above'; marker = '⬆️'; }

                const pct = r.impliedProbability || (r.yesPrice * 100);
                const barColor = pct > 50 ? 'var(--accent-green)' : pct > 20 ? 'var(--accent-amber)' : 'var(--accent-blue)';

                html += '<tr class="' + rowClass + '">';
                html += '<td><span class="range-marker">' + marker + '</span></td>';
                html += '<td style="color:var(--text-primary);font-weight:500;">' + escapeHtml(shortLabel(r.question)) + '</td>';
                html += '<td>' + (r.yesPrice * 100).toFixed(1) + '¢</td>';
                html += '<td>' + pct.toFixed(1) + '%</td>';
                html += '<td>$' + (r.volume || 0).toFixed(0) + '</td>';
                html += '<td style="min-width:120px;"><div class="price-bar"><div class="price-bar-fill" style="width:' + Math.min(pct, 100) + '%;background:' + barColor + ';"></div></div></td>';
                html += '</tr>';
            }

            html += '</tbody></table>';
            return html;
        }

        function renderChart(snapshots) {
            if (snapshots.length < 2) return '<div class="chart-empty">Need 2+ snapshots</div>';

            const width = 800;
            const height = 250;
            const pad = { top: 20, right: 20, bottom: 40, left: 55 };
            const plotW = width - pad.left - pad.right;
            const plotH = height - pad.top - pad.bottom;

            // Collect all prices
            const targetPrices = snapshots.map(s => s.target.yesPrice * 100);
            const belowPrices = snapshots.map(s => s.below ? s.below.yesPrice * 100 : null);
            const abovePrices = snapshots.map(s => s.above ? s.above.yesPrice * 100 : null);

            const allPrices = [...targetPrices, ...belowPrices.filter(p => p !== null), ...abovePrices.filter(p => p !== null)];
            const minP = Math.max(0, Math.min(...allPrices) - 2);
            const maxP = Math.min(100, Math.max(...allPrices) + 2);
            const rangeP = maxP - minP || 1;

            const xScale = (i) => pad.left + (i / (snapshots.length - 1)) * plotW;
            const yScale = (v) => pad.top + plotH - ((v - minP) / rangeP) * plotH;

            function polyline(data, color, dash) {
                const points = data.map((v, i) => v !== null ? xScale(i) + ',' + yScale(v) : null).filter(p => p !== null);
                if (points.length < 2) return '';
                var dashAttr = dash ? ' stroke-dasharray="' + dash + '"' : '';
                return '<polyline points="' + points.join(' ') + '" fill="none" stroke="' + color + '" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"' + dashAttr + ' />';
            }

            function dots(data, color) {
                return data.map((v, i) => {
                    if (v === null) return '';
                    return '<circle cx="' + xScale(i) + '" cy="' + yScale(v) + '" r="3.5" fill="' + color + '" stroke="var(--bg-card)" stroke-width="1.5" />';
                }).join('');
            }

            // Y-axis labels
            let yLabels = '';
            const ySteps = 5;
            for (let i = 0; i <= ySteps; i++) {
                const val = minP + (rangeP / ySteps) * i;
                const y = yScale(val);
                yLabels += '<text x="' + (pad.left - 8) + '" y="' + (y + 4) + '" fill="var(--text-muted)" font-size="11" text-anchor="end" font-family="JetBrains Mono">' + val.toFixed(1) + '¢</text>';
                yLabels += '<line x1="' + pad.left + '" y1="' + y + '" x2="' + (width - pad.right) + '" y2="' + y + '" stroke="var(--border)" stroke-width="0.5" />';
            }

            // X-axis labels (show first, last, and a few in between)
            let xLabels = '';
            const xLabelCount = Math.min(6, snapshots.length);
            for (let i = 0; i < xLabelCount; i++) {
                const idx = Math.round(i * (snapshots.length - 1) / (xLabelCount - 1));
                const x = xScale(idx);
                const time = formatTime(snapshots[idx].timestamp);
                xLabels += '<text x="' + x + '" y="' + (height - 8) + '" fill="var(--text-muted)" font-size="10" text-anchor="middle" font-family="JetBrains Mono">' + time + '</text>';
            }

            // Legend
            const legendY = pad.top - 2;
            let legend = '';
            legend += '<rect x="' + pad.left + '" y="' + (legendY - 8) + '" width="10" height="10" rx="2" fill="var(--accent-blue)" />';
            legend += '<text x="' + (pad.left + 14) + '" y="' + legendY + '" fill="var(--text-secondary)" font-size="11">Target</text>';
            legend += '<rect x="' + (pad.left + 70) + '" y="' + (legendY - 8) + '" width="10" height="10" rx="2" fill="var(--accent-orange)" />';
            legend += '<text x="' + (pad.left + 84) + '" y="' + legendY + '" fill="var(--text-secondary)" font-size="11">Below</text>';
            legend += '<rect x="' + (pad.left + 134) + '" y="' + (legendY - 8) + '" width="10" height="10" rx="2" fill="var(--accent-green)" />';
            legend += '<text x="' + (pad.left + 148) + '" y="' + legendY + '" fill="var(--text-secondary)" font-size="11">Above</text>';

            return '<svg viewBox="0 0 ' + width + ' ' + height + '" class="chart-canvas" preserveAspectRatio="xMidYMid meet">' +
                yLabels + xLabels + legend +
                polyline(targetPrices, 'var(--accent-blue)') +
                polyline(belowPrices, 'var(--accent-orange)', '8 4') +
                polyline(abovePrices, 'var(--accent-green)', '3 3') +
                dots(targetPrices, 'var(--accent-blue)') +
                dots(belowPrices, 'var(--accent-orange)') +
                dots(abovePrices, 'var(--accent-green)') +
                '</svg>';
        }

        // ── Utilities ─────────────────────────────
        function escapeHtml(str) {
            return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        }

        function formatTime(iso) {
            try {
                return new Date(iso).toLocaleTimeString('en-US', {
                    hour: '2-digit', minute: '2-digit', second: '2-digit',
                    hour12: true, timeZone: 'America/New_York'
                });
            } catch {
                return iso;
            }
        }

        function timeAgo(iso) {
            if (!iso) return '';
            try {
                var ms = Date.now() - new Date(iso).getTime();
                if (ms < 0) return 'just now';
                var sec = Math.floor(ms / 1000);
                if (sec < 60) return sec + 's ago';
                var min = Math.floor(sec / 60);
                if (min < 60) return min + 'm ago';
                var hrs = Math.floor(min / 60);
                return hrs + 'h ago';
            } catch {
                return '';
            }
        }

        // ── Auto-refresh loop ─────────────────────
        async function refresh() {
            const data = await fetchStatus(currentDate);
            await render(data);
        }

        function switchDate(date) {
            currentDate = date;
            lastRenderState = null;  // Force full rebuild on date change
            refresh();
        }

        // Initial load
        refresh();

        // Refresh every ${config.dashboard.refreshInterval}ms
        refreshTimer = setInterval(refresh, ${config.dashboard.refreshInterval});
    </script>
</body>
</html>`;
}

// ── Admin Config Page ───────────────────────────────────────────────────

function getAdminHTML() {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>TempEdge — Admin Configuration</title>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
    <style>
        :root {
            --bg-primary: #0f1419;
            --bg-secondary: #1a1f2e;
            --bg-tertiary: #242938;
            --border: #2d3348;
            --border-hover: #3d4560;
            --text-primary: #e0e6ed;
            --text-secondary: #8892a4;
            --text-muted: #5a6a80;
            --accent-cyan: #06b6d4;
            --accent-green: #22c55e;
            --accent-amber: #f59e0b;
            --accent-red: #ef4444;
            --accent-purple: #a78bfa;
            --radius: 12px;
            --radius-sm: 8px;
        }

        * { box-sizing: border-box; margin: 0; padding: 0; }

        body {
            font-family: 'Inter', -apple-system, sans-serif;
            background: var(--bg-primary);
            color: var(--text-primary);
            min-height: 100vh;
        }

        .admin-header {
            background: var(--bg-secondary);
            border-bottom: 1px solid var(--border);
            padding: 16px 32px;
            display: flex;
            align-items: center;
            justify-content: space-between;
            position: sticky;
            top: 0;
            z-index: 100;
        }

        .admin-header-left {
            display: flex;
            align-items: center;
            gap: 16px;
        }

        .admin-header-left .logo {
            font-size: 20px;
            font-weight: 700;
            background: linear-gradient(135deg, #06b6d4, #a78bfa);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
        }

        .admin-header-left .subtitle {
            font-size: 14px;
            color: var(--text-secondary);
            border-left: 1px solid var(--border);
            padding-left: 16px;
        }

        .admin-actions {
            display: flex;
            gap: 12px;
            align-items: center;
        }

        .btn {
            padding: 8px 16px;
            border-radius: var(--radius-sm);
            font-family: 'Inter', sans-serif;
            font-size: 13px;
            font-weight: 600;
            cursor: pointer;
            border: 1px solid var(--border);
            transition: all 0.2s;
            text-decoration: none;
        }

        .btn-ghost {
            background: transparent;
            color: var(--text-secondary);
        }
        .btn-ghost:hover { color: var(--text-primary); border-color: var(--border-hover); }

        .btn-danger {
            background: rgba(239,68,68,0.1);
            border-color: rgba(239,68,68,0.3);
            color: var(--accent-red);
        }
        .btn-danger:hover {
            background: rgba(239,68,68,0.2);
            border-color: var(--accent-red);
        }

        .admin-container {
            max-width: 1200px;
            margin: 0 auto;
            padding: 32px;
        }

        .section {
            margin-bottom: 32px;
        }

        .section-header {
            display: flex;
            align-items: center;
            gap: 10px;
            margin-bottom: 16px;
            padding-bottom: 12px;
            border-bottom: 1px solid var(--border);
        }

        .section-icon { font-size: 20px; }
        .section-title { font-size: 16px; font-weight: 700; }
        .section-count {
            font-size: 11px;
            font-weight: 600;
            color: var(--text-muted);
            background: var(--bg-tertiary);
            padding: 2px 8px;
            border-radius: 10px;
        }

        .config-grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
            gap: 12px;
        }

        .config-item {
            background: var(--bg-secondary);
            border: 1px solid var(--border);
            border-radius: var(--radius-sm);
            padding: 14px 16px;
            transition: border-color 0.2s;
        }

        .config-item:hover { border-color: var(--border-hover); }
        .config-item.locked { opacity: 0.7; }
        .config-item.modified { border-color: var(--accent-cyan); }

        .config-item-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 6px;
        }

        .config-key {
            font-family: 'JetBrains Mono', monospace;
            font-size: 11px;
            color: var(--text-secondary);
        }

        .config-badges {
            display: flex;
            gap: 6px;
            align-items: center;
        }

        .badge {
            font-size: 9px;
            font-weight: 700;
            padding: 2px 6px;
            border-radius: 4px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }

        .badge-env { background: rgba(6,182,212,0.15); color: var(--accent-cyan); }
        .badge-override { background: rgba(167,139,250,0.15); color: var(--accent-purple); }
        .badge-default { background: rgba(90,106,128,0.1); color: var(--text-muted); }
        .badge-restart { background: rgba(245,158,11,0.15); color: var(--accent-amber); }
        .badge-locked { background: rgba(90,106,128,0.1); color: var(--text-muted); }

        .config-desc {
            font-size: 12px;
            color: var(--text-muted);
            margin-bottom: 8px;
        }

        .config-input-row {
            display: flex;
            gap: 8px;
            align-items: center;
        }

        .config-input {
            flex: 1;
            background: var(--bg-primary);
            border: 1px solid var(--border);
            border-radius: 6px;
            padding: 8px 12px;
            font-family: 'JetBrains Mono', monospace;
            font-size: 13px;
            font-weight: 600;
            color: var(--text-primary);
            outline: none;
            transition: border-color 0.2s;
        }

        .config-input:focus { border-color: var(--accent-cyan); }
        .config-input:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }

        .config-input.changed {
            border-color: var(--accent-cyan);
            box-shadow: 0 0 0 1px rgba(6,182,212,0.2);
        }

        .btn-save {
            background: var(--accent-cyan);
            color: #000;
            border: none;
            padding: 8px 14px;
            border-radius: 6px;
            font-family: 'Inter', sans-serif;
            font-size: 12px;
            font-weight: 700;
            cursor: pointer;
            opacity: 0;
            transition: opacity 0.2s;
        }

        .btn-save.visible { opacity: 1; }
        .btn-save:hover { background: #0891b2; }

        .btn-reset-val {
            background: transparent;
            border: 1px solid var(--border);
            color: var(--text-muted);
            padding: 7px 10px;
            border-radius: 6px;
            font-size: 11px;
            cursor: pointer;
            transition: all 0.2s;
            opacity: 0;
        }

        .btn-reset-val.visible { opacity: 1; }
        .btn-reset-val:hover { border-color: var(--accent-red); color: var(--accent-red); }

        .config-default {
            font-size: 11px;
            color: var(--text-muted);
            margin-top: 4px;
        }

        /* Toast */
        .toast-container {
            position: fixed;
            top: 70px;
            right: 24px;
            z-index: 200;
            display: flex;
            flex-direction: column;
            gap: 8px;
        }

        .toast {
            background: var(--bg-tertiary);
            border: 1px solid var(--border);
            border-radius: var(--radius-sm);
            padding: 12px 20px;
            font-size: 13px;
            color: var(--text-primary);
            box-shadow: 0 8px 32px rgba(0,0,0,0.4);
            animation: slideIn 0.3s ease;
            max-width: 360px;
        }

        .toast.success { border-color: var(--accent-green); }
        .toast.error { border-color: var(--accent-red); }
        .toast.warning { border-color: var(--accent-amber); }

        @keyframes slideIn {
            from { transform: translateX(100%); opacity: 0; }
            to { transform: translateX(0); opacity: 1; }
        }
    </style>
</head>
<body>
    <header class="admin-header">
        <div class="admin-header-left">
            <span class="logo">⚙️ TempEdge Admin</span>
            <span class="subtitle">Runtime Configuration</span>
        </div>
        <div class="admin-actions">
            <a href="/" class="btn btn-ghost">← Dashboard</a>
            <button class="btn" style="background:#f59e0b;color:#000;font-weight:700;" onclick="restartService()">🔄 Restart Service</button>
            <button class="btn btn-danger" onclick="resetAll()">Reset All to Defaults</button>
        </div>
    </header>

    <div class="admin-container" id="configRoot">
        <div style="text-align:center;padding:60px;color:var(--text-muted);">Loading configuration...</div>
    </div>

    <div class="toast-container" id="toasts"></div>

    <script>
        const SECTION_META = {
            trading: { icon: '💰', label: 'Trading & Risk' },
            monitor: { icon: '👁️', label: 'Monitoring Thresholds' },
            weather: { icon: '🌤️', label: 'Weather Service' },
            polymarket: { icon: '📈', label: 'Polymarket API' },
            dashboard: { icon: '📊', label: 'Dashboard' },
            phases: { icon: '🔄', label: 'Phase Logic' },
        };

        let currentConfig = {};

        // ── Toast ───────────────────────────────────
        function toast(message, type = 'success') {
            const container = document.getElementById('toasts');
            const el = document.createElement('div');
            el.className = 'toast ' + type;
            el.textContent = message;
            container.appendChild(el);
            setTimeout(() => el.remove(), 4000);
        }

        // ── Load Config ─────────────────────────────
        async function loadConfig() {
            const res = await fetch('/api/config');
            const data = await res.json();
            currentConfig = data.config;
            render(currentConfig);
        }

        // ── Save Single Value ───────────────────────
        async function saveValue(section, field, value) {
            try {
                const res = await fetch('/api/config', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ [section]: { [field]: value } }),
                });
                const data = await res.json();

                if (data.success) {
                    currentConfig = data.config;
                    render(currentConfig);

                    if (data.applied?.length > 0) {
                        toast('Saved: ' + data.applied.join(', '));
                    }
                    if (data.requiresRestart?.length > 0) {
                        toast('⚠️ Restart required for: ' + data.requiresRestart.join(', '), 'warning');
                    }
                    if (data.skipped?.length > 0) {
                        toast('Skipped: ' + data.skipped.join(', '), 'warning');
                    }
                } else {
                    toast('Error: ' + (data.error || 'Unknown'), 'error');
                }
            } catch (err) {
                toast('Network error: ' + err.message, 'error');
            }
        }

        // ── Reset Single Value ──────────────────────
        async function resetValue(section, field) {
            try {
                const res = await fetch('/api/config/reset/' + section + '/' + field, { method: 'DELETE' });
                const data = await res.json();
                if (data.success) {
                    currentConfig = data.config;
                    render(currentConfig);
                    toast('Reset ' + section + '.' + field + ' to default');
                }
            } catch (err) {
                toast('Reset failed: ' + err.message, 'error');
            }
        }

        // ── Reset All ───────────────────────────────
        async function resetAll() {
            if (!confirm('Reset ALL config overrides back to defaults? This cannot be undone.')) return;
            try {
                const res = await fetch('/api/config/reset', { method: 'DELETE' });
                const data = await res.json();
                if (data.success) {
                    currentConfig = data.config;
                    render(currentConfig);
                    toast('All overrides reset to defaults');
                }
            } catch (err) {
                toast('Reset failed: ' + err.message, 'error');
            }
        }

        // ── Restart Service ──────────────────────────
        async function restartService() {
            if (!confirm('Restart the TempEdge monitor service?\\nThe monitor will save sessions and restart within a few seconds.')) return;
            try {
                const res = await fetch('/api/restart', { method: 'POST' });
                const data = await res.json();
                if (data.success) {
                    toast('Restart signal sent — monitor will restart within 5 seconds', 'info');
                } else {
                    toast('Restart failed: ' + (data.error || 'Unknown error'), 'error');
                }
            } catch (err) {
                toast('Restart failed: ' + err.message, 'error');
            }
        }

        // ── Render ───────────────────────────────────
        function render(cfg) {
            const root = document.getElementById('configRoot');
            let html = '';

            for (const [section, fields] of Object.entries(cfg)) {
                const meta = SECTION_META[section] || { icon: '📋', label: section };
                const count = Object.keys(fields).length;

                html += '<div class="section">';
                html += '<div class="section-header">';
                html += '<span class="section-icon">' + meta.icon + '</span>';
                html += '<span class="section-title">' + meta.label + '</span>';
                html += '<span class="section-count">' + count + ' settings</span>';
                html += '</div>';
                html += '<div class="config-grid">';

                for (const [field, info] of Object.entries(fields)) {
                    const id = section + '__' + field;
                    const isLocked = info.lockedByEnv || info.readOnly;
                    const isOverride = info.source === 'override';
                    const cls = isLocked ? 'locked' : (isOverride ? 'modified' : '');

                    html += '<div class="config-item ' + cls + '">';

                    // Header
                    html += '<div class="config-item-header">';
                    html += '<span class="config-key">' + esc(info.envKey) + '</span>';
                    html += '<div class="config-badges">';
                    if (info.requiresRestart) html += '<span class="badge badge-restart">restart</span>';
                    if (info.sensitive) html += '<span class="badge badge-locked">🔒</span>';
                    if (info.source === 'env') html += '<span class="badge badge-env">ENV</span>';
                    else if (info.source === 'override') html += '<span class="badge badge-override">OVERRIDE</span>';
                    else html += '<span class="badge badge-default">DEFAULT</span>';
                    html += '</div></div>';

                    // Description
                    if (info.description) {
                        html += '<div class="config-desc">' + esc(info.description) + '</div>';
                    }

                    // Input
                    html += '<div class="config-input-row">';
                    html += '<input class="config-input" id="' + id + '" ';
                    html += 'value="' + esc(String(info.value)) + '" ';
                    if (isLocked) html += 'disabled ';
                    html += 'data-section="' + section + '" ';
                    html += 'data-field="' + field + '" ';
                    html += 'data-original="' + esc(String(info.value)) + '" ';
                    html += '/>';

                    // Save button (hidden until changed)
                    if (!isLocked) {
                        html += '<button class="btn-save" id="save_' + id + '" data-input-id="' + id + '">Save</button>';
                    }

                    // Reset button (visible only for overrides)
                    if (isOverride && !isLocked) {
                        html += '<button class="btn-reset-val visible" data-reset-section="' + section + '" data-reset-field="' + field + '">↺</button>';
                    }

                    html += '</div>';

                    // Default value display
                    if (info.source !== 'default' && info.default !== '(hidden)') {
                        html += '<div class="config-default">default: ' + esc(String(info.default)) + '</div>';
                    }

                    html += '</div>';
                }

                html += '</div></div>';
            }

            root.innerHTML = html;

            // ── Event delegation ─────────────────────
            root.addEventListener('input', function(e) {
                if (e.target.classList.contains('config-input')) {
                    const el = e.target;
                    const isChanged = el.value !== el.dataset.original;
                    el.classList.toggle('changed', isChanged);
                    const saveBtn = document.getElementById('save_' + el.id);
                    if (saveBtn) saveBtn.classList.toggle('visible', isChanged);
                }
            });

            root.addEventListener('keydown', function(e) {
                if (e.target.classList.contains('config-input') && e.key === 'Enter') {
                    const el = e.target;
                    if (el.value !== el.dataset.original) {
                        saveValue(el.dataset.section, el.dataset.field, el.value);
                    }
                }
            });

            root.addEventListener('click', function(e) {
                // Save button
                const saveBtn = e.target.closest('.btn-save');
                if (saveBtn) {
                    const inputId = saveBtn.dataset.inputId;
                    const inputEl = document.getElementById(inputId);
                    if (inputEl && inputEl.value !== inputEl.dataset.original) {
                        saveValue(inputEl.dataset.section, inputEl.dataset.field, inputEl.value);
                    }
                    return;
                }

                // Reset button
                const resetBtn = e.target.closest('.btn-reset-val');
                if (resetBtn) {
                    resetValue(resetBtn.dataset.resetSection, resetBtn.dataset.resetField);
                    return;
                }
            });
        }

        function esc(s) {
            return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
        }

        // Initial load
        loadConfig();
    </script>
</body>
</html>`;
}
