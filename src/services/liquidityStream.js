/**
 * Liquidity Stream — WebSocket-based real-time order book monitoring
 *
 * Connects to Polymarket's CLOB WebSocket to stream live order book
 * data for T+2 (BUY phase) markets. Tracks bid/ask/spread/depth and
 * computes a liquidity score to help time optimal purchases.
 *
 * Endpoint: wss://ws-subscriptions-clob.polymarket.com/ws/market
 * Auth: None required (public market data)
 *
 * Usage:
 *   import { liquidityMonitor } from './liquidityStream.js';
 *   liquidityMonitor.start([{ tokenId, label, question }]);
 *   const snapshot = liquidityMonitor.getSnapshot();
 */

import WebSocket from 'ws';
import { config } from '../config.js';

const WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
const HEARTBEAT_INTERVAL_MS = 10_000; // Polymarket requires PING every 10s
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 60_000;
const MAX_HISTORY = 200;  // Keep last 200 data points per token

// ── State ───────────────────────────────────────────────────────────────

/** @type {WebSocket|null} */
let ws = null;
let reconnectAttempts = 0;
let heartbeatTimer = null;
let assessmentTimer = null;
let isRunning = false;

/**
 * Per-token live order book state
 * @type {Map<string, {
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
 *   lastUpdate: string,
 *   history: Array<{time: string, spread: number, depth: number, score: number}>,
 *   isLiquid: boolean,
 * }>}
 */
const books = new Map();

/** @type {Array<function>} */
const liquidityCallbacks = [];

/** @type {string|null} */
let lastError = null;

/** @type {string} */
let connectionStatus = 'disconnected';

// ── Score Calculation ───────────────────────────────────────────────────

/**
 * Compute a 0–1 liquidity score.
 * Higher = better liquidity for buying.
 * @param {number} spreadPct - 0..1 (e.g. 0.15 = 15%)
 * @param {number} askDepth - shares available at ask
 * @returns {number}
 */
function liquidityScore(spreadPct, askDepth) {
    if (spreadPct >= 1 || askDepth <= 0) return 0;
    const spreadFactor = Math.max(0, 1 - spreadPct / config.trading.maxSpreadPct);
    const depthFactor = Math.min(askDepth / (config.trading.minAskDepth * 2), 1);
    return parseFloat((spreadFactor * 0.6 + depthFactor * 0.4).toFixed(3));
}

/**
 * Assess liquidity for a token book entry.
 */
function assessLiquidity(entry) {
    const maxSpread = config.trading.maxSpreadPct;
    const minDepth = config.trading.minAskDepth;

    entry.isLiquid = entry.spreadPct <= maxSpread && entry.askDepth >= minDepth;
    entry.score = liquidityScore(entry.spreadPct, entry.askDepth);

    // Record history
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

// ── WebSocket Management ────────────────────────────────────────────────

function connect(tokens) {
    if (ws) {
        try { ws.close(); } catch { /* ignore */ }
    }

    connectionStatus = 'connecting';
    console.log(`  📡 Connecting to Polymarket WebSocket (${tokens.length} tokens)...`);

    ws = new WebSocket(WS_URL);

    ws.on('open', () => {
        connectionStatus = 'connected';
        reconnectAttempts = 0;
        lastError = null;
        console.log('  ✅ WebSocket connected.');

        // Subscribe all tokens in a single message with assets_ids (plural, array)
        const tokenIds = tokens.map(t => t.tokenId);
        const sub = {
            type: 'market',
            assets_ids: tokenIds,
            custom_feature_enabled: true, // Enables best_bid_ask, market_resolved events
        };
        const subStr = JSON.stringify(sub);
        ws.send(subStr);
        console.log(`  📡 Subscribed to ${tokenIds.length} tokens: ${tokens.map(t => t.label).join(', ')}`);
        console.log(`  📡 Sub payload: ${subStr.substring(0, 300)}`);

        // Start heartbeat
        clearInterval(heartbeatTimer);
        heartbeatTimer = setInterval(() => {
            if (ws?.readyState === WebSocket.OPEN) {
                ws.send('PING'); // Must be text message, not protocol-level ping
            }
        }, HEARTBEAT_INTERVAL_MS);
    });

    ws.on('message', (raw) => {
        const text = raw.toString();
        if (text === 'PONG') return; // Heartbeat response — ignore
        try {
            const data = JSON.parse(text);
            handleMessage(data);
        } catch (err) {
            // Occasionally non-JSON heartbeats come through
        }
    });

    ws.on('close', (code, reason) => {
        connectionStatus = 'disconnected';
        clearInterval(heartbeatTimer);
        console.log(`  ⚠️  WebSocket closed (code=${code}). Reconnecting...`);
        scheduleReconnect(tokens);
    });

    ws.on('error', (err) => {
        lastError = err.message;
        console.log(`  ❌ WebSocket error: ${err.message}`);
    });
}

function scheduleReconnect(tokens) {
    if (!isRunning) return;
    const delay = Math.min(
        RECONNECT_BASE_MS * Math.pow(2, reconnectAttempts),
        RECONNECT_MAX_MS
    );
    reconnectAttempts++;
    console.log(`  🔄 Reconnecting in ${(delay / 1000).toFixed(0)}s (attempt ${reconnectAttempts})...`);
    setTimeout(() => {
        if (isRunning) connect(tokens);
    }, delay);
}

// ── Message Handling ────────────────────────────────────────────────────

let eventCount = 0;
function handleMessage(data) {
    // Polymarket WS sends an array of events
    const events = Array.isArray(data) ? data : [data];

    for (const event of events) {
        const assetId = event.asset_id;
        const type = event.event_type || event.type;

        // Price_change events nest asset_ids in price_changes array
        if (type === 'price_change' && !assetId && event.price_changes) {
            for (const pc of event.price_changes) {
                if (pc.asset_id) {
                    const pcEntry = books.get(pc.asset_id);
                    if (pcEntry) {
                        handlePriceChange(pcEntry, pc);
                    }
                }
            }
            continue;
        }

        if (!assetId) continue;

        const entry = books.get(assetId);
        if (!entry) continue;

        switch (type) {
            case 'book':
                handleBookSnapshot(entry, event);
                break;
            case 'price_change':
                handlePriceChange(entry, event);
                break;
            case 'last_trade_price':
                handleLastTrade(entry, event);
                break;
            case 'tick_size_change':
                // Critical: if tick size changes and we use the old one, orders are rejected
                console.log(`  ⚠️  TICK SIZE CHANGE: ${entry.label} ${event.old_tick_size} → ${event.new_tick_size}`);
                entry.tickSize = event.new_tick_size;
                break;
            case 'market_resolved':
                console.log(`  🏁 MARKET RESOLVED: ${entry.label} winner=${event.winning_outcome}`);
                entry.resolved = true;
                entry.winningOutcome = event.winning_outcome;
                entry.winningAssetId = event.winning_asset_id;
                break;
            default:
                break;
        }
    }
}

function handleBookSnapshot(entry, event) {
    const bids = event.bids || [];
    const asks = event.asks || [];

    // Polymarket sorts: bids ascending (worst→best), asks descending (worst→best)
    // Best bid = last element, best ask = last element
    const bestBid = bids.length > 0 ? parseFloat(bids[bids.length - 1].price) : 0;
    const bestAsk = asks.length > 0 ? parseFloat(asks[asks.length - 1].price) : 0;

    // Ask depth: total shares available near the best ask (what we'd buy into)
    // Use the best ask level's size for immediate fill assessment
    const bestAskDepth = asks.length > 0 ? parseFloat(asks[asks.length - 1].size || 0) : 0;
    // Total depth across all levels
    const totalBidDepth = bids.reduce((sum, b) => sum + parseFloat(b.size || 0), 0);
    const totalAskDepth = asks.reduce((sum, a) => sum + parseFloat(a.size || 0), 0);

    entry.bestBid = bestBid;
    entry.bestAsk = bestAsk;
    entry.bidDepth = parseFloat(totalBidDepth.toFixed(2));
    entry.askDepth = parseFloat(bestAskDepth.toFixed(2));  // Depth at best ask for fill check
    entry.totalAskDepth = parseFloat(totalAskDepth.toFixed(2));
    entry.bidLevels = bids.length;
    entry.askLevels = asks.length;
    entry.spread = bestAsk > 0 && bestBid > 0 ? parseFloat((bestAsk - bestBid).toFixed(4)) : 0;
    entry.spreadPct = bestAsk > 0 && bestBid > 0 ? parseFloat(((bestAsk - bestBid) / bestAsk).toFixed(4)) : 1;

    // last_trade_price comes on the book event itself
    if (event.last_trade_price) {
        entry.lastTrade = parseFloat(event.last_trade_price);
    }

    entry.lastUpdate = new Date().toISOString();
    assessLiquidity(entry);

    console.log(`  📊 ${entry.label}: book bid=$${bestBid.toFixed(3)} ask=$${bestAsk.toFixed(3)} spread=${(entry.spreadPct * 100).toFixed(1)}% depth=${bestAskDepth} last=$${entry.lastTrade || 0}`);
}

function handlePriceChange(entry, event) {
    // price_change events may contain:
    //   - changes: array of {price, side, size} updates
    //   - OR direct: price, side, size fields
    //   - Plus: best_bid, best_ask fields (if available)

    // Direct best_bid/best_ask from the event (most reliable)
    if (event.best_bid) {
        entry.bestBid = parseFloat(event.best_bid);
    }
    if (event.best_ask) {
        entry.bestAsk = parseFloat(event.best_ask);
    }

    // Process changes array if present
    if (event.changes && Array.isArray(event.changes)) {
        for (const change of event.changes) {
            const price = parseFloat(change.price || 0);
            const size = parseFloat(change.size || 0);
            // Updates to ask levels affect depth
            if (price === entry.bestAsk) {
                entry.askDepth = size;
            }
        }
    }

    // Recalculate spread
    if (entry.bestAsk > 0 && entry.bestBid > 0) {
        entry.spread = parseFloat((entry.bestAsk - entry.bestBid).toFixed(4));
        entry.spreadPct = parseFloat(((entry.bestAsk - entry.bestBid) / entry.bestAsk).toFixed(4));
    }

    entry.lastUpdate = new Date().toISOString();
    assessLiquidity(entry);
}

function handleLastTrade(entry, event) {
    const price = parseFloat(event.price || event.last_trade_price || 0);
    if (price > 0) {
        entry.lastTrade = price;
        entry.lastUpdate = new Date().toISOString();
    }
}

// ── Periodic Assessment ─────────────────────────────────────────────────

function startAssessmentLoop() {
    clearInterval(assessmentTimer);
    const intervalMs = config.liquidity.checkIntervalSecs * 1000;

    assessmentTimer = setInterval(() => {
        // Check liquidity state across all tokens
        let liquidCount = 0;
        let totalCount = 0;
        for (const [, entry] of books) {
            totalCount++;
            if (entry.isLiquid) liquidCount++;
        }

        const anyLiquid = liquidCount > 0;
        const allLiquid = totalCount > 0 && liquidCount === totalCount;

        if (anyLiquid) {
            // Fire callbacks with snapshot + flags
            const snap = getSnapshot();
            snap.allLiquid = allLiquid;
            snap.liquidCount = liquidCount;
            snap.totalCount = totalCount;

            for (const cb of liquidityCallbacks) {
                try { cb(snap); } catch { /* ignore */ }
            }
        }
    }, intervalMs);
}

// ── Public API ──────────────────────────────────────────────────────────

export const liquidityMonitor = {
    /**
     * Start streaming for a set of tokens.
     * @param {Array<{tokenId: string, label: string, question: string}>} tokens
     */
    start(tokens) {
        if (isRunning) this.stop();
        if (!tokens || tokens.length === 0) {
            console.log('  📡 No tokens to stream — liquidity monitor idle.');
            return;
        }

        isRunning = true;

        // Initialize book entries
        for (const token of tokens) {
            books.set(token.tokenId, {
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

        connect(tokens);
        startAssessmentLoop();

        console.log(`  📡 Liquidity monitor started (${tokens.length} tokens, ${config.liquidity.checkIntervalSecs}s assessment interval).`);
        for (const [id, entry] of books) {
            console.log(`     📌 ${entry.label}: ${id.substring(0, 40)}...`);
        }
    },

    /** Stop streaming. */
    stop() {
        isRunning = false;
        clearInterval(heartbeatTimer);
        clearInterval(assessmentTimer);
        if (ws) {
            try { ws.close(); } catch { /* ignore */ }
            ws = null;
        }
        books.clear();
        liquidityCallbacks.length = 0;
        connectionStatus = 'disconnected';
        console.log('  📡 Liquidity monitor stopped.');
    },

    /**
     * Register a callback for when a liquidity window opens.
     * Called with the full snapshot when any token crosses the threshold.
     * @param {function} cb
     */
    onLiquidityWindow(cb) {
        liquidityCallbacks.push(cb);
    },

    /**
     * Get current snapshot of all tracked tokens.
     * @returns {Object}
     */
    getSnapshot() {
        return getSnapshot();
    },

    /** Is the monitor running? */
    isRunning() { return isRunning; },

    /** Connection status */
    status() { return connectionStatus; },
};

/**
 * Build a snapshot object suitable for the dashboard API.
 */
function getSnapshot() {
    const tokens = [];
    let bestScore = 0;
    let bestToken = null;

    for (const [, entry] of books) {
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
            // Last 20 history points for sparkline
            recentHistory: entry.history.slice(-20),
        };

        tokens.push(data);

        if (entry.score > bestScore) {
            bestScore = entry.score;
            bestToken = entry.label;
        }
    }

    return {
        status: connectionStatus,
        lastError,
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

export default liquidityMonitor;
