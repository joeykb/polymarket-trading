/**
 * TempEdge Liquidity Service — Dedicated WebSocket microservice
 *
 * Manages WebSocket connections to Polymarket's CLOB for live order book
 * streaming across ALL active dates (not just T+2). Exposes a REST API
 * that the dashboard and monitor can query.
 *
 * Port: 3001 (internal pod networking)
 *
 * API:
 *   GET /api/liquidity           — All tracked dates
 *   GET /api/liquidity?date=X    — Specific date
 *   GET /health                  — Health check
 *
 * Reads session files from /app/output/monitor-YYYY-MM-DD.json to discover
 * tokens for each date automatically. Periodically rescans for new sessions.
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import WebSocket from 'ws';
import { config } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.resolve(__dirname, '../output');
const PORT = parseInt(process.env.LIQUIDITY_PORT || '3001');

const WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
const HEARTBEAT_INTERVAL_MS = 30_000;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 60_000;
const MAX_HISTORY = 200;
const RESCAN_INTERVAL_MS = 60_000; // Rescan for new sessions every 60s

// ── Per-Date Stream Manager ─────────────────────────────────────────────

/**
 * Each date gets its own WebSocket connection + book state.
 * @type {Map<string, DateStream>}
 */
const dateStreams = new Map();

/**
 * @typedef {{
 *   date: string,
 *   ws: WebSocket|null,
 *   tokens: Array<{tokenId: string, label: string, question: string}>,
 *   books: Map<string, BookEntry>,
 *   status: string,
 *   lastError: string|null,
 *   reconnectAttempts: number,
 *   heartbeatTimer: any,
 *   assessmentTimer: any,
 *   callbacks: Array<function>,
 * }} DateStream
 *
 * @typedef {{
 *   tokenId: string,
 *   label: string,
 *   question: string,
 *   bestBid: number,
 *   bestAsk: number,
 *   bidDepth: number,
 *   askDepth: number,
 *   spread: number,
 *   spreadPct: number,
 *   score: number,
 *   lastTrade: number|null,
 *   lastUpdate: string|null,
 *   history: Array<{time: string, spread: number, depth: number, score: number}>,
 *   isLiquid: boolean,
 * }} BookEntry
 */

// ── Score Calculation ───────────────────────────────────────────────────

function liquidityScore(spreadPct, askDepth) {
    if (spreadPct >= 1 || askDepth <= 0) return 0;
    const spreadFactor = Math.max(0, 1 - spreadPct / config.trading.maxSpreadPct);
    const depthFactor = Math.min(askDepth / (config.trading.minAskDepth * 2), 1);
    return parseFloat((spreadFactor * 0.6 + depthFactor * 0.4).toFixed(3));
}

function assessLiquidity(entry) {
    const maxSpread = config.trading.maxSpreadPct;
    const minDepth = config.trading.minAskDepth;

    entry.isLiquid = entry.spreadPct <= maxSpread && entry.askDepth >= minDepth;
    entry.score = liquidityScore(entry.spreadPct, entry.askDepth);

    entry.history.push({
        time: new Date().toISOString(),
        spread: entry.spreadPct,
        depth: entry.askDepth,
        score: entry.score,
    });
    if (entry.history.length > MAX_HISTORY) {
        entry.history.shift();
    }
}

// ── WebSocket Management (per-date) ─────────────────────────────────────

function connectDate(stream) {
    if (stream.ws) {
        try { stream.ws.close(); } catch { /* ignore */ }
    }

    stream.status = 'connecting';
    console.log(`  📡 [${stream.date}] Connecting (${stream.tokens.length} tokens)...`);

    stream.ws = new WebSocket(WS_URL);

    stream.ws.on('open', () => {
        stream.status = 'connected';
        stream.reconnectAttempts = 0;
        stream.lastError = null;

        const tokenIds = stream.tokens.map(t => t.tokenId);
        const sub = { type: 'market', assets_ids: tokenIds };
        stream.ws.send(JSON.stringify(sub));
        console.log(`  ✅ [${stream.date}] Connected — ${stream.tokens.map(t => t.label).join(', ')}`);

        // Heartbeat
        clearInterval(stream.heartbeatTimer);
        stream.heartbeatTimer = setInterval(() => {
            if (stream.ws?.readyState === WebSocket.OPEN) {
                stream.ws.ping();
            }
        }, HEARTBEAT_INTERVAL_MS);
    });

    stream.ws.on('message', (raw) => {
        try {
            const data = JSON.parse(raw.toString());
            handleMessage(stream, data);
        } catch { /* ignore non-JSON */ }
    });

    stream.ws.on('close', (code) => {
        stream.status = 'disconnected';
        clearInterval(stream.heartbeatTimer);
        console.log(`  ⚠️  [${stream.date}] WebSocket closed (code=${code})`);
        scheduleReconnect(stream);
    });

    stream.ws.on('error', (err) => {
        stream.lastError = err.message;
    });
}

function scheduleReconnect(stream) {
    const delay = Math.min(
        RECONNECT_BASE_MS * Math.pow(2, stream.reconnectAttempts),
        RECONNECT_MAX_MS
    );
    stream.reconnectAttempts++;
    setTimeout(() => {
        if (dateStreams.has(stream.date)) connectDate(stream);
    }, delay);
}

// ── Message Handling ────────────────────────────────────────────────────

function handleMessage(stream, data) {
    const events = Array.isArray(data) ? data : [data];

    for (const event of events) {
        const assetId = event.asset_id;
        const type = event.event_type || event.type;

        // Price_change events nest asset_ids in price_changes array
        if (type === 'price_change' && !assetId && event.price_changes) {
            for (const pc of event.price_changes) {
                if (pc.asset_id) {
                    const pcEntry = stream.books.get(pc.asset_id);
                    if (pcEntry) handlePriceChange(pcEntry, pc);
                }
            }
            continue;
        }

        if (!assetId) continue;

        const entry = stream.books.get(assetId);
        if (!entry) continue;

        switch (type) {
            case 'book':
                handleBookSnapshot(entry, event);
                break;
            case 'price_change':
                handlePriceChange(entry, event);
                break;
            case 'last_trade_price':
                if (event.price || event.last_trade_price) {
                    entry.lastTrade = parseFloat(event.price || event.last_trade_price);
                    entry.lastUpdate = new Date().toISOString();
                }
                break;
        }
    }
}

function handleBookSnapshot(entry, event) {
    const bids = event.bids || [];
    const asks = event.asks || [];

    const bestBid = bids.length > 0 ? parseFloat(bids[bids.length - 1].price) : 0;
    const bestAsk = asks.length > 0 ? parseFloat(asks[asks.length - 1].price) : 0;
    const bestAskDepth = asks.length > 0 ? parseFloat(asks[asks.length - 1].size || 0) : 0;
    const totalBidDepth = bids.reduce((sum, b) => sum + parseFloat(b.size || 0), 0);
    const totalAskDepth = asks.reduce((sum, a) => sum + parseFloat(a.size || 0), 0);

    entry.bestBid = bestBid;
    entry.bestAsk = bestAsk;
    entry.bidDepth = parseFloat(totalBidDepth.toFixed(2));
    entry.askDepth = parseFloat(bestAskDepth.toFixed(2));
    entry.totalAskDepth = parseFloat(totalAskDepth.toFixed(2));
    entry.spread = bestAsk > 0 && bestBid > 0 ? parseFloat((bestAsk - bestBid).toFixed(4)) : 0;
    entry.spreadPct = bestAsk > 0 && bestBid > 0 ? parseFloat(((bestAsk - bestBid) / bestAsk).toFixed(4)) : 1;

    if (event.last_trade_price) {
        entry.lastTrade = parseFloat(event.last_trade_price);
    }

    entry.lastUpdate = new Date().toISOString();
    assessLiquidity(entry);

    console.log(`  📊 [${entry.label}] book bid=$${bestBid.toFixed(3)} ask=$${bestAsk.toFixed(3)} spread=${(entry.spreadPct * 100).toFixed(1)}% depth=${bestAskDepth}`);
}

function handlePriceChange(entry, event) {
    if (event.best_bid) entry.bestBid = parseFloat(event.best_bid);
    if (event.best_ask) entry.bestAsk = parseFloat(event.best_ask);

    if (event.changes && Array.isArray(event.changes)) {
        for (const change of event.changes) {
            const price = parseFloat(change.price || 0);
            const size = parseFloat(change.size || 0);
            if (change.side === 'sell' || change.side === 'ask') {
                if (price > 0 && (entry.bestAsk === 0 || price <= entry.bestAsk)) {
                    entry.bestAsk = price;
                    entry.askDepth = size;
                }
            } else if (change.side === 'buy' || change.side === 'bid') {
                if (price > 0 && price >= entry.bestBid) {
                    entry.bestBid = price;
                    entry.bidDepth = size;
                }
            }
        }
    }

    if (entry.bestAsk > 0 && entry.bestBid > 0) {
        entry.spread = parseFloat((entry.bestAsk - entry.bestBid).toFixed(4));
        entry.spreadPct = parseFloat(((entry.bestAsk - entry.bestBid) / entry.bestAsk).toFixed(4));
    }

    entry.lastUpdate = new Date().toISOString();
    assessLiquidity(entry);
}

// ── Session Discovery ───────────────────────────────────────────────────

/**
 * Scan output directory for session files, extract tokens per date.
 * @returns {Map<string, Array<{tokenId: string, label: string, question: string}>>}
 */
function discoverSessions() {
    const result = new Map();
    if (!fs.existsSync(OUTPUT_DIR)) return result;

    const files = fs.readdirSync(OUTPUT_DIR)
        .filter(f => f.startsWith('monitor-') && f.endsWith('.json'));

    for (const file of files) {
        try {
            const data = JSON.parse(fs.readFileSync(path.join(OUTPUT_DIR, file), 'utf-8'));
            const date = data.targetDate;
            if (!date) continue;

            const latest = data.snapshots?.[data.snapshots.length - 1];
            if (!latest) continue;

            const tokens = [];
            for (const pos of ['target', 'below', 'above']) {
                const range = latest[pos];
                if (range?.clobTokenIds?.[0]) {
                    tokens.push({
                        tokenId: range.clobTokenIds[0],
                        label: pos,
                        question: range.question || pos,
                    });
                }
            }

            if (tokens.length > 0) {
                result.set(date, tokens);
            }
        } catch { /* skip corrupted files */ }
    }

    return result;
}

/**
 * Sync running streams to discovered sessions.
 * Start new streams, stop old ones.
 */
function syncStreams() {
    const sessions = discoverSessions();

    // Start streams for new dates
    for (const [date, tokens] of sessions) {
        if (dateStreams.has(date)) {
            // Check if tokens changed
            const existing = dateStreams.get(date);
            const existingIds = existing.tokens.map(t => t.tokenId).sort().join(',');
            const newIds = tokens.map(t => t.tokenId).sort().join(',');
            if (existingIds !== newIds) {
                console.log(`  🔄 [${date}] Tokens changed, reconnecting...`);
                stopDateStream(date);
                startDateStream(date, tokens);
            }
            continue;
        }
        startDateStream(date, tokens);
    }

    // Stop streams for removed dates
    for (const [date] of dateStreams) {
        if (!sessions.has(date)) {
            console.log(`  🛑 [${date}] Session no longer active, stopping stream.`);
            stopDateStream(date);
        }
    }
}

function startDateStream(date, tokens) {
    /** @type {DateStream} */
    const stream = {
        date,
        ws: null,
        tokens,
        books: new Map(),
        status: 'initializing',
        lastError: null,
        reconnectAttempts: 0,
        heartbeatTimer: null,
        assessmentTimer: null,
        callbacks: [],
    };

    // Initialize book entries
    for (const token of tokens) {
        stream.books.set(token.tokenId, {
            tokenId: token.tokenId,
            label: token.label,
            question: token.question,
            bestBid: 0,
            bestAsk: 0,
            bidDepth: 0,
            askDepth: 0,
            spread: 0,
            spreadPct: 1,
            score: 0,
            lastTrade: null,
            lastUpdate: null,
            history: [],
            isLiquid: false,
        });
    }

    dateStreams.set(date, stream);
    connectDate(stream);

    // Start assessment loop for this date
    const intervalMs = (config.liquidity?.checkIntervalSecs || 30) * 1000;
    stream.assessmentTimer = setInterval(() => {
        let liquidCount = 0;
        let totalCount = 0;
        for (const [, entry] of stream.books) {
            totalCount++;
            if (entry.isLiquid) liquidCount++;
        }

        const allLiquid = totalCount > 0 && liquidCount === totalCount;
        const anyLiquid = liquidCount > 0;

        if (anyLiquid) {
            for (const cb of stream.callbacks) {
                try {
                    cb({
                        date,
                        allLiquid,
                        liquidCount,
                        totalCount,
                        tokens: getDateSnapshot(stream).tokens,
                    });
                } catch { /* ignore */ }
            }
        }
    }, intervalMs);

    console.log(`  📡 [${date}] Stream started (${tokens.length} tokens)`);
}

function stopDateStream(date) {
    const stream = dateStreams.get(date);
    if (!stream) return;

    clearInterval(stream.heartbeatTimer);
    clearInterval(stream.assessmentTimer);
    if (stream.ws) {
        try { stream.ws.close(); } catch { /* ignore */ }
    }
    dateStreams.delete(date);
    console.log(`  🛑 [${date}] Stream stopped.`);
}

// ── Snapshot Building ───────────────────────────────────────────────────

function getDateSnapshot(stream) {
    const tokens = [];
    let bestScore = 0;
    let bestToken = null;

    for (const [, entry] of stream.books) {
        const data = {
            tokenId: entry.tokenId,
            label: entry.label,
            question: entry.question,
            bestBid: entry.bestBid,
            bestAsk: entry.bestAsk,
            bidDepth: entry.bidDepth,
            askDepth: entry.askDepth,
            spread: entry.spread,
            spreadPct: entry.spreadPct,
            score: entry.score,
            lastTrade: entry.lastTrade,
            lastUpdate: entry.lastUpdate,
            isLiquid: entry.isLiquid,
            historyCount: entry.history.length,
            recentHistory: entry.history.slice(-20),
        };

        tokens.push(data);
        if (entry.score > bestScore) {
            bestScore = entry.score;
            bestToken = entry.label;
        }
    }

    return {
        date: stream.date,
        status: stream.status,
        lastError: stream.lastError,
        tokenCount: tokens.length,
        tokens,
        bestScore,
        bestToken,
        allLiquid: tokens.length > 0 && tokens.every(t => t.isLiquid),
        liquidCount: tokens.filter(t => t.isLiquid).length,
        thresholds: {
            maxSpreadPct: config.trading.maxSpreadPct,
            minAskDepth: config.trading.minAskDepth,
        },
        timestamp: new Date().toISOString(),
    };
}

function getAllSnapshots() {
    const dates = {};
    for (const [date, stream] of dateStreams) {
        dates[date] = getDateSnapshot(stream);
    }
    return {
        dateCount: dateStreams.size,
        dates,
        timestamp: new Date().toISOString(),
    };
}

// ── HTTP Server ─────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);

    // Health check
    if (url.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            status: 'ok',
            streams: dateStreams.size,
            timestamp: new Date().toISOString(),
        }));
        return;
    }

    // Liquidity API
    if (url.pathname === '/api/liquidity') {
        res.writeHead(200, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
        });

        const date = url.searchParams.get('date');
        if (date) {
            const stream = dateStreams.get(date);
            if (stream) {
                res.end(JSON.stringify(getDateSnapshot(stream)));
            } else {
                res.end(JSON.stringify({
                    date,
                    status: 'not-tracked',
                    tokens: [],
                    tokenCount: 0,
                    timestamp: new Date().toISOString(),
                }));
            }
        } else {
            res.end(JSON.stringify(getAllSnapshots()));
        }
        return;
    }

    // Callback registration for buy-gate (monitor calls this)
    if (url.pathname === '/api/liquidity/subscribe' && req.method === 'POST') {
        // The monitor uses this to register for liquidity notifications
        // For now, poll-based — the monitor can poll /api/liquidity?date=X
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', message: 'Use polling: GET /api/liquidity?date=X' }));
        return;
    }

    // 404
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
});

// ── Main ────────────────────────────────────────────────────────────────

function main() {
    console.log(`\n📡 TempEdge Liquidity Service`);
    console.log('═══════════════════════════════════════════');
    console.log(`  Port:          ${PORT}`);
    console.log(`  Output dir:    ${OUTPUT_DIR}`);
    console.log(`  Max spread:    ${(config.trading.maxSpreadPct * 100).toFixed(0)}%`);
    console.log(`  Min depth:     ${config.trading.minAskDepth}`);
    console.log(`  Assessment:    every ${config.liquidity?.checkIntervalSecs || 30}s`);
    console.log('═══════════════════════════════════════════');

    // Initial scan
    syncStreams();

    // Periodic rescan for new sessions
    setInterval(syncStreams, RESCAN_INTERVAL_MS);

    server.listen(PORT, '0.0.0.0', () => {
        console.log(`\n  🌐 Liquidity API: http://localhost:${PORT}/api/liquidity`);
        console.log(`  ❤️  Health:        http://localhost:${PORT}/health`);
    });
}

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\n  🛑 Shutting down liquidity service...');
    for (const [date] of dateStreams) {
        stopDateStream(date);
    }
    server.close();
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('  🛑 SIGTERM received, shutting down...');
    for (const [date] of dateStreams) {
        stopDateStream(date);
    }
    server.close();
    process.exit(0);
});

main();
