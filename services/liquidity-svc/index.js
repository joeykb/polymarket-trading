/**
 * TempEdge Liquidity Service — Standalone Microservice
 *
 * Manages WebSocket connections to Polymarket's CLOB for live order book
 * streaming across ALL active dates. Exposes a REST API.
 *
 * Dependencies:
 *   - data-svc: session file discovery + config
 *   - Polymarket CLOB WebSocket (external)
 *
 * Port: 3001
 *
 * API:
 *   GET /api/liquidity           — All tracked dates
 *   GET /api/liquidity?date=X    — Specific date
 *   GET /health                  — Health check
 */

import 'dotenv/config';
import http from 'http';
import WebSocket from 'ws';
import { services } from '../../shared/services.js';
import { healthResponse } from '../../shared/health.js';
import { createLogger, requestLogger } from '../../shared/logger.js';
import { svcGet } from '../../shared/httpClient.js';
import { jsonResponse, errorResponse } from '../../shared/httpServer.js';

const DATA_SVC = services.dataSvc;
const PORT = parseInt(process.env.LIQUIDITY_PORT || '3001');
const WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
const HEARTBEAT_INTERVAL_MS = 10_000;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 60_000;
const MAX_HISTORY = 200;
const RESCAN_INTERVAL_MS = 60_000;

// ── Config (fetched from data-svc, with sensible defaults) ──────────────

let svcConfig = {
    trading: { maxSpreadPct: 0.4, minAskDepth: 5 },
    liquidity: { checkIntervalSecs: 30 },
};

async function refreshConfig() {
    const data = await svcGet(`${DATA_SVC}/api/config`, { timeoutMs: 5000 });
    if (data) svcConfig = { ...svcConfig, ...data };
}

// ── Per-Date Stream Manager ─────────────────────────────────────────────

const dateStreams = new Map();

// ── Score Calculation ───────────────────────────────────────────────────

function liquidityScore(spreadPct, askDepth) {
    if (spreadPct >= 1 || askDepth <= 0) return 0;
    const maxSpread = svcConfig.liquidity?.spreadThreshold ?? svcConfig.trading.maxSpreadPct;
    const minDepth = svcConfig.liquidity?.depthThreshold ?? svcConfig.trading.minAskDepth;
    const spreadFactor = Math.max(0, 1 - spreadPct / maxSpread);
    const depthFactor = Math.min(askDepth / (minDepth * 2), 1);
    return parseFloat((spreadFactor * 0.6 + depthFactor * 0.4).toFixed(3));
}

function assessLiquidity(entry) {
    const maxSpread = svcConfig.liquidity?.spreadThreshold ?? svcConfig.trading.maxSpreadPct;
    const minDepth = svcConfig.liquidity?.depthThreshold ?? svcConfig.trading.minAskDepth;

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
        try {
            stream.ws.close();
        } catch {
            /* intentional: WS may already be closed */
        }
    }

    stream.status = 'connecting';
    console.log(`  📡 [${stream.date}] Connecting (${stream.tokens.length} tokens)...`);

    stream.ws = new WebSocket(WS_URL);

    stream.ws.on('open', () => {
        stream.status = 'connected';
        stream.reconnectAttempts = 0;
        stream.lastError = null;

        const tokenIds = stream.tokens.map((t) => t.tokenId);
        const sub = { type: 'market', assets_ids: tokenIds, custom_feature_enabled: true };
        stream.ws.send(JSON.stringify(sub));
        console.log(`  ✅ [${stream.date}] Connected — ${stream.tokens.map((t) => t.label).join(', ')}`);

        clearInterval(stream.heartbeatTimer);
        stream.heartbeatTimer = setInterval(() => {
            if (stream.ws?.readyState === WebSocket.OPEN) {
                stream.ws.send('PING');
            }
        }, HEARTBEAT_INTERVAL_MS);
    });

    stream.ws.on('message', (raw) => {
        const text = raw.toString();
        if (text === 'PONG') return;
        try {
            const data = JSON.parse(text);
            handleMessage(stream, data);
        } catch {
            /* intentional: non-JSON WS frames (e.g. pings) */
        }
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
    const base = Math.min(RECONNECT_BASE_MS * Math.pow(2, stream.reconnectAttempts), RECONNECT_MAX_MS);
    const jitter = Math.random() * base * 0.3; // ±30% jitter to prevent thundering herd
    const delay = Math.round(base + jitter);
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
            case 'tick_size_change':
                console.log(`  ⚠️  [${stream.date}] TICK SIZE CHANGE: ${entry.label} ${event.old_tick_size} → ${event.new_tick_size}`);
                entry.tickSize = event.new_tick_size;
                break;
            case 'market_resolved':
                console.log(`  🏁 [${stream.date}] MARKET RESOLVED: ${entry.label} winner=${event.winning_outcome}`);
                entry.resolved = true;
                entry.winningOutcome = event.winning_outcome;
                entry.winningAssetId = event.winning_asset_id;
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

    console.log(
        `  📊 [${entry.label}] book bid=$${bestBid.toFixed(3)} ask=$${bestAsk.toFixed(3)} spread=${(entry.spreadPct * 100).toFixed(1)}% depth=${bestAskDepth}`,
    );
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

// ── Session Discovery (via data-svc) ────────────────────────────────────

async function discoverSessions() {
    const result = new Map();

    try {
        // Get all session file dates from data-svc
        const listData = await svcGet(`${DATA_SVC}/api/session-files`, { timeoutMs: 10000 });
        if (!listData) return result;
        const dates = listData.dates;
        if (!dates?.length) return result;

        // Fetch each session and extract tokens
        for (const date of dates) {
            try {
                const data = await svcGet(`${DATA_SVC}/api/session-files/${date}`, { timeoutMs: 10000 });
                if (!data?.targetDate) continue;

                const latest = data.snapshots?.[data.snapshots.length - 1];
                if (!latest) continue;

                const tokenMap = new Map();

                // 1. Current snapshot ranges (target, below, above)
                for (const pos of ['target', 'below', 'above']) {
                    const range = latest[pos];
                    if (range?.clobTokenIds?.[0]) {
                        tokenMap.set(range.clobTokenIds[0], {
                            tokenId: range.clobTokenIds[0],
                            label: pos,
                            question: range.question || pos,
                        });
                    }
                }

                // 2. Buy order positions — ensures ALL purchased tokens are tracked
                if (data.buyOrder?.positions) {
                    const usedLabels = new Set([...tokenMap.values()].map((t) => t.label));

                    for (const pos of data.buyOrder.positions) {
                        let label = pos.label;
                        if (usedLabels.has(label)) {
                            const m = pos.question?.match(/between (\d+-\d+°F)|(\d+°F or higher)/);
                            label = m?.[1] || m?.[2]?.replace(' or higher', '+') || pos.label;
                        }
                        usedLabels.add(label);

                        const addToken = (tokenId) => {
                            if (!tokenMap.has(tokenId)) {
                                tokenMap.set(tokenId, { tokenId, label, question: pos.question || pos.label });
                            }
                        };

                        if (pos.clobTokenId) {
                            addToken(pos.clobTokenId);
                            continue;
                        }

                        if (pos.question && latest.allRanges) {
                            const match = latest.allRanges.find((r) => r.question === pos.question);
                            if (match?.clobTokenIds?.[0]) {
                                addToken(match.clobTokenIds[0]);
                                continue;
                            }
                        }

                        if (pos.question) {
                            let found = false;
                            for (const snap of data.snapshots || []) {
                                for (const key of ['target', 'below', 'above']) {
                                    const r = snap[key];
                                    if (r?.question === pos.question && r?.clobTokenIds?.[0]) {
                                        addToken(r.clobTokenIds[0]);
                                        found = true;
                                        break;
                                    }
                                }
                                if (found) break;
                            }
                        }
                    }
                }

                const tokens = [...tokenMap.values()];
                if (tokens.length > 0) {
                    result.set(date, tokens);
                }
            } catch {
                /* intentional: individual session parse failure */
            }
        }
    } catch (err) {
        console.warn(`  ⚠️  Session discovery failed: ${err.message}`);
    }

    return result;
}

// ── Stream Lifecycle ────────────────────────────────────────────────────

async function syncStreams() {
    const sessions = await discoverSessions();

    for (const [date, tokens] of sessions) {
        if (dateStreams.has(date)) {
            const existing = dateStreams.get(date);
            const existingIds = existing.tokens
                .map((t) => t.tokenId)
                .sort()
                .join(',');
            const newIds = tokens
                .map((t) => t.tokenId)
                .sort()
                .join(',');
            if (existingIds !== newIds) {
                console.log(`  🔄 [${date}] Tokens changed, reconnecting...`);
                stopDateStream(date);
                startDateStream(date, tokens);
            }
            continue;
        }
        startDateStream(date, tokens);
    }

    for (const [date] of dateStreams) {
        if (!sessions.has(date)) {
            console.log(`  🛑 [${date}] Session no longer active, stopping stream.`);
            stopDateStream(date);
        }
    }
}

function startDateStream(date, tokens) {
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

    const intervalMs = (svcConfig.liquidity?.checkIntervalSecs || 30) * 1000;
    stream.assessmentTimer = setInterval(() => {
        let liquidCount = 0,
            totalCount = 0;
        for (const [, entry] of stream.books) {
            totalCount++;
            if (entry.isLiquid) liquidCount++;
        }
        stream.liquidCount = liquidCount;
        stream.totalCount = totalCount;
    }, intervalMs);

    console.log(`  📡 [${date}] Stream started (${tokens.length} tokens)`);
}

function stopDateStream(date) {
    const stream = dateStreams.get(date);
    if (!stream) return;

    clearInterval(stream.heartbeatTimer);
    clearInterval(stream.assessmentTimer);
    if (stream.ws) {
        try {
            stream.ws.close();
        } catch {
            /* intentional: WS may already be closed */
        }
    }
    dateStreams.delete(date);
    console.log(`  🛑 [${date}] Stream stopped.`);
}

// ── Snapshot Building ───────────────────────────────────────────────────

function getDateSnapshot(stream) {
    const tokens = [];
    let bestScore = 0,
        bestToken = null;

    for (const [, entry] of stream.books) {
        tokens.push({
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
        });
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
        allLiquid: tokens.length > 0 && tokens.every((t) => t.isLiquid),
        liquidCount: tokens.filter((t) => t.isLiquid).length,
        thresholds: { maxSpreadPct: svcConfig.trading.maxSpreadPct, minAskDepth: svcConfig.trading.minAskDepth },
        timestamp: new Date().toISOString(),
    };
}

function getAllSnapshots() {
    const dates = {};
    for (const [date, stream] of dateStreams) {
        dates[date] = getDateSnapshot(stream);
    }
    return { dateCount: dateStreams.size, dates, timestamp: new Date().toISOString() };
}

// ── HTTP Server ─────────────────────────────────────────────────────────

const log = createLogger('liquidity-svc');

const server = http.createServer(
    requestLogger(log, (req, res) => {
        const url = new URL(req.url, `http://${req.headers.host}`);

        if (url.pathname === '/health') {
            return jsonResponse(res, healthResponse('liquidity-svc', { streams: dateStreams.size }));
        }

        if (url.pathname === '/api/liquidity') {
            const date = url.searchParams.get('date');
            if (date) {
                const stream = dateStreams.get(date);
                return jsonResponse(
                    res,
                    stream
                        ? getDateSnapshot(stream)
                        : { date, status: 'not-tracked', tokens: [], tokenCount: 0, timestamp: new Date().toISOString() },
                );
            }
            return jsonResponse(res, getAllSnapshots());
        }

        if (url.pathname === '/api/liquidity/subscribe' && req.method === 'POST') {
            return jsonResponse(res, { status: 'ok', message: 'Use polling: GET /api/liquidity?date=X' });
        }

        errorResponse(res, 'Not found', 404);
    }),
);

// ── Main ────────────────────────────────────────────────────────────────

async function main() {
    await refreshConfig();

    log.info('started', {
        port: PORT,
        dataSvc: DATA_SVC,
        maxSpread: svcConfig.trading.maxSpreadPct,
        minDepth: svcConfig.trading.minAskDepth,
    });

    await syncStreams();

    setInterval(async () => {
        await refreshConfig();
        await syncStreams();
    }, RESCAN_INTERVAL_MS);

    server.listen(PORT, '0.0.0.0', () => {
        log.info('listening', { port: PORT });
    });
}

process.on('SIGINT', () => {
    log.info('shutting down');
    for (const [date] of dateStreams) stopDateStream(date);
    server.close();
    process.exit(0);
});

process.on('SIGTERM', () => {
    log.info('SIGTERM received, shutting down');
    for (const [date] of dateStreams) stopDateStream(date);
    server.close();
    process.exit(0);
});

main();
