/**
 * Trading service — places real orders on Polymarket via the CLOB API
 * 
 * Modes:
 *   TRADING_MODE=disabled  → No orders, no logging (default)
 *   TRADING_MODE=dry-run   → Logs what WOULD be ordered, no actual execution
 *   TRADING_MODE=live      → Places real orders with real USDC
 * 
 * Safety:
 *   - Max per-position cost cap (MAX_POSITION_COST)
 *   - Max daily spend cap (MAX_DAILY_SPEND)
 *   - All orders are GTC limit orders (no market orders)
 *   - Order confirmation logged with IDs for audit trail
 */

import { ClobClient, Side, OrderType } from '@polymarket/clob-client';
import { Wallet, Contract, providers, constants, utils } from 'ethers';

const DATA_SVC_URL = process.env.DATA_SVC_URL || 'http://data-svc:3005';

// Helper for data-svc calls
async function dataSvc(method, path, body) {
    const opts = { method, headers: { 'Content-Type': 'application/json' } };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(`${DATA_SVC_URL}${path}`, opts);
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`data-svc ${method} ${path} → ${res.status}: ${text.slice(0, 200)}`);
    }
    return res.json();
}

// CLOB_HOST and CHAIN_ID are read at call time via getClient() which uses config.trading
// No module-level caching — supports hot-reload.

// ── Config (from env vars) ──────────────────────────────────────────────

function getConfig() {
    return {
        privateKey: process.env.POLYMARKET_PRIVATE_KEY || '',
        mode: process.env.TRADING_MODE || 'disabled',
        maxPositionCost: parseFloat(process.env.MAX_POSITION_COST || '3'),
        maxDailySpend: parseFloat(process.env.MAX_DAILY_SPEND || '10'),
        buySize: parseFloat(process.env.BUY_SIZE || '5'),
        minOrderValue: parseFloat(process.env.MIN_ORDER_VALUE || '1.05'),
        clobHost: process.env.CLOB_HOST || 'https://clob.polymarket.com',
        chainId: parseInt(process.env.CHAIN_ID || '137'),
        maxSpreadPct: parseFloat(process.env.MAX_SPREAD_PCT || '0.4'),
        minAskDepth: parseFloat(process.env.MIN_ASK_DEPTH || '3'),
    };
}

// ── CLOB Client Singleton ───────────────────────────────────────────────

let _client = null;
let _signer = null;

/**
 * Initialize the CLOB client with wallet credentials
 * @returns {Promise<ClobClient>}
 */
async function getClient() {
    if (_client) return _client;

    const tradingCfg = getConfig();
    if (!tradingCfg.privateKey) {
        throw new Error('POLYMARKET_PRIVATE_KEY not set');
    }

    _signer = new Wallet(tradingCfg.privateKey);
    console.log(`  🔑 Wallet: ${_signer.address}`);

    // Derive API credentials from wallet
    const tempClient = new ClobClient(tradingCfg.clobHost, tradingCfg.chainId, _signer);
    let apiCreds;
    try {
        apiCreds = await tempClient.createOrDeriveApiKey();
        console.log(`  🔐 API key derived successfully`);
    } catch (err) {
        console.log(`  ❌ API key derivation failed: ${err.message}`);
        // Try deriving without nonce (some wallets need this)
        try {
            apiCreds = await tempClient.deriveApiKey();
            console.log(`  🔐 API key derived via fallback`);
        } catch (err2) {
            throw new Error(`Cannot derive API key: ${err2.message}. You may need to log in to polymarket.com with this wallet first.`);
        }
    }

    // Initialize full trading client
    _client = new ClobClient(
        tradingCfg.clobHost,
        tradingCfg.chainId,
        _signer,
        apiCreds,
        0, // Signature type: 0 = EOA
        _signer.address, // Funder address
    );

    return _client;
}

// ── Daily Spend Tracking (via data-svc) ─────────────────────────────────

async function getTodaySpend() {
    try {
        const data = await dataSvc('GET', '/api/spend');
        return data.totalSpent || 0;
    } catch { return 0; }
}

async function recordSpend(amount, orderDetails) {
    try {
        await dataSvc('POST', '/api/spend', {
            date: new Date().toISOString().slice(0, 10),
            amount,
            details: orderDetails,
        });
    } catch (err) {
        console.warn(`  ⚠️  Spend tracking failed: ${err.message}`);
    }
}

// ── Post-Trade Fill Verification ────────────────────────────────────────

/**
 * Verify the actual fill price/size of an order by polling the CLOB API.
 * The price we send to the exchange (bestAsk/bestBid) may differ from
 * the actual execution price. This function resolves the real fill data.
 *
 * @param {string} orderId - The order ID returned from CLOB
 * @param {string} side - 'BUY' or 'SELL'
 * @param {number} intendedPrice - The price we sent to the exchange
 * @param {number} intendedSize - The size we sent to the exchange
 * @param {string} label - Position label for logging
 * @returns {Promise<{fillPrice: number, fillSize: number, fillCost: number, verified: boolean}>}
 */
async function verifyOrderFill(orderId, side, intendedPrice, intendedSize, label, opts = {}) {
    const maxRetries = opts.maxRetries || (side === 'SELL' ? 6 : 3);
    const initialDelay = opts.initialDelayMs ?? (side === 'SELL' ? 5000 : 3000);
    const retryDelay = opts.retryDelayMs ?? (side === 'SELL' ? 10000 : 5000);

    const result = {
        fillPrice: 0,  // default to 0 — do NOT fall back to intended price
        fillSize: 0,
        fillCost: 0,
        verified: false,
        orderStatus: null,
    };

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            await new Promise(r => setTimeout(r, attempt === 1 ? initialDelay : retryDelay));
            const client = await getClient();
            const orderInfo = await client.getOrder(orderId);
            if (!orderInfo) continue;

            result.orderStatus = orderInfo.status || null;

            // Method 1: average_price field (most reliable)
            if (orderInfo.average_price && parseFloat(orderInfo.average_price) > 0) {
                result.fillPrice = parseFloat(orderInfo.average_price);
                const matched = parseFloat(orderInfo.size_matched || intendedSize);
                result.fillSize = matched > 0 ? matched : intendedSize;
                result.fillCost = parseFloat((result.fillPrice * result.fillSize).toFixed(4));
                result.verified = true;
                console.log(`  ✅ ${label} ${side} VERIFIED (avg_price): $${result.fillPrice.toFixed(4)} × ${result.fillSize} = $${result.fillCost.toFixed(4)}`);
                if (Math.abs(result.fillPrice - intendedPrice) > 0.005) {
                    console.log(`     ⚠️  Fill differs from intended: $${intendedPrice.toFixed(4)} → $${result.fillPrice.toFixed(4)} (Δ$${(result.fillPrice - intendedPrice).toFixed(4)})`);
                }
                break;
            }

            // Method 2: Calculate from associate_trades
            if (orderInfo.associate_trades?.length > 0) {
                const totalFillValue = orderInfo.associate_trades.reduce(
                    (acc, t) => acc + parseFloat(t.price || 0) * parseFloat(t.size || 0), 0
                );
                const totalFillSize = orderInfo.associate_trades.reduce(
                    (acc, t) => acc + parseFloat(t.size || 0), 0
                );
                if (totalFillSize > 0) {
                    result.fillPrice = totalFillValue / totalFillSize;
                    result.fillSize = totalFillSize;
                    result.fillCost = parseFloat(totalFillValue.toFixed(4));
                    result.verified = true;
                    console.log(`  ✅ ${label} ${side} VERIFIED (trades): $${result.fillPrice.toFixed(4)} × ${result.fillSize} = $${result.fillCost.toFixed(4)}`);
                    if (Math.abs(result.fillPrice - intendedPrice) > 0.005) {
                        console.log(`     ⚠️  Fill differs from intended: $${intendedPrice.toFixed(4)} → $${result.fillPrice.toFixed(4)} (Δ$${(result.fillPrice - intendedPrice).toFixed(4)})`);
                    }
                    break;
                }
            }

            // Method 3: Check if partially matched but no trade details yet
            const matched = parseFloat(orderInfo.size_matched || 0);
            if (matched > 0 && attempt < maxRetries) {
                console.log(`  ⏳ ${label}: ${matched} shares matched but no trade details yet (attempt ${attempt}/${maxRetries})`);
                continue;
            }

            // If order is still LIVE (on the book), keep waiting
            if (orderInfo.status === 'LIVE' && attempt < maxRetries) {
                console.log(`  ⏳ ${label}: order still LIVE on book (attempt ${attempt}/${maxRetries})`);
                continue;
            }
        } catch (err) {
            console.log(`  ℹ️  ${label} fill verification attempt ${attempt} failed: ${err.message}`);
        }
    }

    if (!result.verified) {
        console.log(`  ⚠️  ${label}: Could not verify fill — will NOT record unverified price`);
        console.log(`     Order ${orderId} — status: ${result.orderStatus || 'unknown'}`);
        console.log(`     ❗ Price will be verified asynchronously before DB write`);
    }

    return result;
}

// ── Order Placement ─────────────────────────────────────────────────────

/**
 * Place a buy order for a single position
 * @param {Object} position - { label, question, marketId, conditionId, clobTokenIds, buyPrice }
 * @param {Object} config
 * @returns {Promise<Object>} - order result
 */
async function placeSingleOrder(position, tradingCfg, liqTokenData = null) {
    const tokenId = position.clobTokenIds?.[0]; // YES token
    if (!tokenId) {
        return { success: false, error: 'No clobTokenId for YES token', position };
    }

    let price = position.buyPrice;
    const MAX_SPREAD_PCT = tradingCfg.maxSpreadPct;
    const MIN_ASK_DEPTH = tradingCfg.minAskDepth;

    // For LIVE orders, check liquidity and use real ask price for immediate fill
    if (tradingCfg.mode === 'live') {
        let bestBid = null, bestAsk = null, askSize = 0;

        // Prefer WebSocket-sourced liquidity data (accurate) over REST API (unreliable)
        if (liqTokenData) {
            bestBid = liqTokenData.bestBid || null;
            bestAsk = liqTokenData.bestAsk || null;
            askSize = liqTokenData.askDepth || 0;
            console.log(`  📡 ${position.label}: Using live WS data — bid=$${bestBid?.toFixed(4)} | ask=$${bestAsk?.toFixed(4)} | depth=${askSize}`);
        } else {
            // Fallback: direct CLOB REST API call
            try {
                const client = await getClient();
                const book = await client.getOrderBook(tokenId);
                bestBid = book.bids?.[0]?.price ? parseFloat(book.bids[0].price) : null;
                bestAsk = book.asks?.[0]?.price ? parseFloat(book.asks[0].price) : null;
                askSize = book.asks?.[0]?.size ? parseFloat(book.asks[0].size) : 0;
                console.log(`  📊 ${position.label}: REST API — bid=$${bestBid?.toFixed(4)} | ask=$${bestAsk?.toFixed(4)} | depth=${askSize}`);
            } catch (err) {
                console.log(`  ⚠️  Could not fetch order book: ${err.message} — skipping`);
                return { success: false, error: `Order book fetch failed: ${err.message}`, position };
            }
        }

        if (!bestAsk || !bestBid) {
            console.log(`  🚫 ${position.label}: No ${!bestAsk ? 'asks' : 'bids'} in order book — ILLIQUID, skipping`);
            return { success: false, error: 'No liquidity — empty order book', position };
        }

        const spread = bestAsk - bestBid;
        const spreadPct = spread / bestAsk;

        console.log(`  📊 ${position.label}: bid=$${bestBid.toFixed(4)} | ask=$${bestAsk.toFixed(4)} | spread=${(spreadPct * 100).toFixed(1)}% | depth=${askSize} shares`);

        // Liquidity check 1: Spread must be reasonable
        if (spreadPct > MAX_SPREAD_PCT) {
            console.log(`  🚫 ${position.label}: Spread ${(spreadPct * 100).toFixed(1)}% > ${MAX_SPREAD_PCT * 100}% max — ILLIQUID, skipping`);
            return { success: false, error: `Spread ${(spreadPct * 100).toFixed(1)}% too wide (max ${MAX_SPREAD_PCT * 100}%)`, position };
        }

        // Liquidity check 2: Enough shares available at ask
        if (askSize < MIN_ASK_DEPTH) {
            console.log(`  🚫 ${position.label}: Only ${askSize} shares at ask (need ${MIN_ASK_DEPTH}) — THIN, skipping`);
            return { success: false, error: `Ask depth ${askSize} < min ${MIN_ASK_DEPTH}`, position };
        }

        // Use bestAsk for immediate fill
        console.log(`  ✅ ${position.label}: LIQUID — buying at bestAsk $${bestAsk.toFixed(4)}`);
        price = bestAsk;
    }

    // Auto-calculate size to target exactly $1.05 per position (fractional shares OK)
    let size = tradingCfg.buySize;
    if (size <= 0) {
        size = parseFloat((tradingCfg.minOrderValue / price).toFixed(2));
    }
    let cost = parseFloat((price * size).toFixed(4));

    console.log(`  📐 ${position.label}: price=$${price.toFixed(4)} × ${size} shares = $${cost.toFixed(4)}`);

    // Safety: per-position cap
    if (cost > tradingCfg.maxPositionCost) {
        return {
            success: false,
            error: `Cost $${cost.toFixed(4)} exceeds max $${tradingCfg.maxPositionCost}`,
            position,
        };
    }

    // Safety: daily spend cap
    const todaySpend = await getTodaySpend();
    if (todaySpend + cost > tradingCfg.maxDailySpend) {
        return {
            success: false,
            error: `Daily spend $${(todaySpend + cost).toFixed(4)} would exceed max $${tradingCfg.maxDailySpend}`,
            position,
        };
    }

    if (tradingCfg.mode === 'dry-run') {
        console.log(`  🧪 DRY-RUN: Would buy ${size} share(s) of "${position.question}" at $${price.toFixed(4)}`);
        console.log(`     Token: ${tokenId}`);
        console.log(`     Cost:  $${cost.toFixed(4)}`);
        return {
            success: true,
            dryRun: true,
            orderId: `dry-run-${Date.now()}`,
            price,
            size,
            cost,
            tokenId,
        };
    }

    // LIVE mode — place real order
    try {
        const client = await getClient();

        // Get market details for tick size and neg risk
        const market = await client.getMarket(position.conditionId);
        const tickSize = String(market.minimum_tick_size || '0.01');
        const negRisk = market.neg_risk || false;
        const minSize = parseFloat(market.minimum_order_size || '0');

        // Bump size to market minimum if needed
        if (minSize > 0 && size < minSize) {
            console.log(`  ⚠️  Size ${size} below market min ${minSize}, bumping up`);
            size = minSize;
            cost = parseFloat((price * size).toFixed(4));
        }

        // Re-check per-position cap after size bump
        if (cost > tradingCfg.maxPositionCost) {
            return {
                success: false,
                error: `Cost $${cost.toFixed(4)} (after min-size bump) exceeds max $${tradingCfg.maxPositionCost}`,
                position,
            };
        }

        console.log(`  💰 LIVE: Buying ${size} share(s) of "${position.question}" at $${price.toFixed(4)}`);
        console.log(`     Token: ${tokenId} | Tick: ${tickSize} | NegRisk: ${negRisk} | MinSize: ${minSize}`);

        // ── Self-trade prevention ───────────────────────────────────
        // Cancel any existing orders on this token to prevent matching
        // against our own resting sell orders (wash trades).
        try {
            await client.cancelMarketOrders({ asset_id: tokenId });
            console.log(`  🧹 Cleared existing orders for token (self-trade prevention)`);
        } catch (cancelErr) {
            // Non-fatal — may mean no existing orders (which is fine)
            if (!cancelErr.message?.includes('404') && !cancelErr.message?.includes('no orders')) {
                console.log(`  ⚠️  Could not cancel existing orders: ${cancelErr.message} (proceeding)`);
            }
        }

        const response = await client.createAndPostOrder(
            {
                tokenID: tokenId,
                price,
                size,
                side: Side.BUY,
            },
            {
                tickSize,
                negRisk,
            },
            OrderType.GTC,
        );

        // Log full response for debugging
        console.log(`  📨 CLOB Response: ${JSON.stringify(response)}`);

        // Check for failure — CLOB may return error in response body without throwing
        if (!response.orderID || response.status === 400 || response.status === 'error') {
            const errMsg = response.errorMsg || response.error || response.data?.error || `status ${response.status}`;
            console.log(`  ❌ Order REJECTED: ${errMsg}`);
            return {
                success: false,
                error: errMsg,
                position,
            };
        }

        console.log(`  ✅ Order placed: ${response.orderID} (status: ${response.status})`);

        // Verify actual fill price — the CLOB may fill at a different price than our limit
        const fill = await verifyOrderFill(response.orderID, 'BUY', price, size, position.label);

        // Use verified fill data if available, otherwise fall back to intended
        const actualPrice = fill.fillPrice;
        const actualSize = fill.fillSize;
        const actualCost = fill.fillCost;

        // Record spend with verified amounts
        await recordSpend(actualCost, {
            orderId: response.orderID,
            label: position.label,
            question: position.question,
            tokenId,
            price: actualPrice,
            size: actualSize,
            verified: fill.verified,
        });

        return {
            success: true,
            dryRun: false,
            orderId: response.orderID,
            status: response.status,
            price: actualPrice,
            size: actualSize,
            cost: actualCost,
            tokenId,
            verified: fill.verified,
        };
    } catch (err) {
        const detail = err.response?.data || err.data || '';
        console.log(`  ❌ Order FAILED for "${position.question}": ${err.message}`);
        if (detail) console.log(`     Detail: ${JSON.stringify(detail)}`);
        return {
            success: false,
            error: err.message,
            position,
        };
    }
}

// ── Main Entry Point ────────────────────────────────────────────────────

/**
 * Place buy orders for all positions in a snapshot
 * Called by monitor.js instead of the simulated placeBuyOrder()
 * 
 * @param {Object} snapshot - MonitoringSnapshot with target/below/above ranges
 * @param {Array} liqTokens - live liquidity token data
 * @param {Object} sessionContext - { sessionId, targetDate, marketId } for DB persistence
 * @returns {Promise<Object>} - buyOrder object compatible with existing P&L logic
 */
export async function executeRealBuyOrder(snapshot, liqTokens = [], sessionContext = {}) {
    const tradingCfg = getConfig();

    if (tradingCfg.mode === 'disabled') {
        console.log('  ⚠️  Trading disabled (TRADING_MODE=disabled)');
        return null; // Fall through to simulated buy
    }

    // Only place real orders during buy phase
    if (snapshot.phase && snapshot.phase !== 'buy') {
        console.log(`  ⚠️  Skipping real trade — phase is "${snapshot.phase}" (only trades in "buy" phase)`);
        return null; // Fall through to simulated buy
    }

    console.log(`\n  🏦 Trading Mode: ${tradingCfg.mode.toUpperCase()}`);
    console.log(`  💳 Max/position: $${tradingCfg.maxPositionCost} | Max/day: $${tradingCfg.maxDailySpend}`);
    console.log(`  📊 Today's spend so far: $${(await getTodaySpend()).toFixed(4)}`);

    // Build liquidity lookup by question for matching
    const liqByQuestion = new Map();
    for (const t of liqTokens) {
        if (t.question) liqByQuestion.set(t.question, t);
    }

    // Build positions from snapshot
    const positions = [];
    const rangeKeys = ['target', 'below', 'above'];

    for (const label of rangeKeys) {
        const range = snapshot[label];
        if (!range) continue;

        positions.push({
            label,
            question: range.question,
            marketId: range.marketId,
            conditionId: range.conditionId,
            clobTokenIds: range.clobTokenIds,
            buyPrice: range.yesPrice,
        });
    }

    // Place orders, passing live WS liquidity data when available
    const results = [];
    for (const position of positions) {
        const liqTokenData = liqByQuestion.get(position.question) || null;
        const result = await placeSingleOrder(position, tradingCfg, liqTokenData);
        results.push({ ...position, ...result });
    }

    // Build buyOrder object compatible with existing P&L logic
    const successfulOrders = results.filter(r => r.success);
    const totalCost = successfulOrders.reduce((sum, r) => sum + (r.cost || r.buyPrice), 0);

    console.log(`\n  📋 Order Summary: ${successfulOrders.length}/${positions.length} succeeded`);

    // If no positions succeeded, return null so the system retries
    if (successfulOrders.length === 0) {
        console.log(`  ❌ All positions failed — no buy recorded, will retry`);
        for (const r of results) {
            console.log(`     • ${r.label}: ${r.error || 'unknown error'}`);
        }
        return null;
    }

    const buyOrder = {
        placedAt: new Date().toISOString(),
        mode: tradingCfg.mode,
        positions: results.map(r => ({
            label: r.label,
            question: r.question,
            marketId: r.marketId,
            conditionId: r.conditionId,
            clobTokenIds: r.clobTokenIds,
            buyPrice: r.price || r.buyPrice,
            shares: r.size || tradingCfg.buySize,
            orderId: r.orderId || null,
            tokenId: r.tokenId || null,
            status: r.success ? (r.dryRun ? 'dry-run' : 'placed') : 'failed',
            error: r.error || null,
        })),
        totalCost: parseFloat(totalCost.toFixed(4)),
        maxPayout: 1.0,
        maxProfit: parseFloat((1.0 - totalCost).toFixed(4)),
        simulated: tradingCfg.mode === 'dry-run',
    };

    console.log(`  💰 Total cost: $${buyOrder.totalCost.toFixed(4)}`);

    // ── Post-Trade Verification ─────────────────────────────────────
    // Verify order fills via CLOB API to confirm positions are actually open
    if (tradingCfg.mode === 'live') {
        await verifyOrderFills(buyOrder);
    }

    // ── Persist to Database (via data-svc) ──────────────────────────
    try {
        const { id: dbTradeId } = await dataSvc('POST', '/api/trades', {
            sessionId: sessionContext.sessionId || buyOrder._sessionId || null,
            marketId: sessionContext.marketId || buyOrder._marketId || 'nyc',
            targetDate: sessionContext.targetDate || buyOrder._targetDate || null,
            type: 'buy',
            mode: tradingCfg.mode,
            placedAt: buyOrder.placedAt,
            totalCost: buyOrder.actualTotalCost || buyOrder.totalCost,
            totalProceeds: 0,
            status: buyOrder.allUnfilled ? 'failed' : 'filled',
            metadata: {
                maxProfit: buyOrder.maxProfit,
                fillSummary: buyOrder.fillSummary,
            },
        });
        await dataSvc('POST', '/api/positions', { tradeId: dbTradeId, positions: buyOrder.positions });
        buyOrder.dbTradeId = dbTradeId;
        console.log(`  📦 DB: buy trade #${dbTradeId} saved (${buyOrder.positions.length} positions)`);
    } catch (dbErr) {
        console.warn(`  ⚠️  DB write failed (non-fatal): ${dbErr.message}`);
    }

    return buyOrder;
}

// ── Post-Trade Fill Verification ────────────────────────────────────────

/**
 * Poll the CLOB API to verify that placed orders were actually filled.
 * Updates the buyOrder positions in-place with fill data.
 *
 * Order statuses from CLOB:
 *   MATCHED  = fully filled
 *   LIVE     = still sitting in the order book (not yet filled)
 *   CANCELLED = cancelled (by user, system, or expiry)
 *
 * @param {Object} buyOrder - the buyOrder object to verify
 */
async function verifyOrderFills(buyOrder) {
    const POLL_DELAY_MS = 3000;   // Wait 3s before first check
    const POLL_INTERVAL_MS = 2000; // Check every 2s
    const MAX_POLLS = 5;           // Max 5 checks (total ~13s)

    console.log(`\n  🔍 Verifying order fills (waiting ${POLL_DELAY_MS / 1000}s for settlement)...`);
    await new Promise(r => setTimeout(r, POLL_DELAY_MS));

    let client;
    try {
        client = await getClient();
    } catch (err) {
        console.warn(`  ⚠️  Cannot verify fills — client init failed: ${err.message}`);
        return;
    }

    const placedPositions = buyOrder.positions.filter(p => p.orderId && p.status === 'placed');
    if (placedPositions.length === 0) return;

    let allSettled = false;

    for (let attempt = 1; attempt <= MAX_POLLS && !allSettled; attempt++) {
        if (attempt > 1) await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));

        allSettled = true;
        for (const pos of placedPositions) {
            if (pos.fillStatus && pos.fillStatus !== 'pending') continue;

            try {
                const order = await client.getOrder(pos.orderId);
                const sizeMatched = parseFloat(order.size_matched) || 0;
                const originalSize = parseFloat(order.original_size) || pos.shares;

                if (order.status === 'MATCHED') {
                    pos.fillStatus = sizeMatched >= originalSize ? 'filled' : 'partial';
                    pos.sharesMatched = sizeMatched;
                    pos.originalSize = originalSize;
                    pos.fillPct = parseFloat(((sizeMatched / originalSize) * 100).toFixed(1));
                    pos.status = 'filled';
                    console.log(`  ✅ ${pos.label}: FILLED ${sizeMatched}/${originalSize} shares (${pos.fillPct}%)`);
                } else if (order.status === 'CANCELLED') {
                    pos.fillStatus = 'cancelled';
                    pos.sharesMatched = sizeMatched;
                    pos.originalSize = originalSize;
                    pos.fillPct = parseFloat(((sizeMatched / originalSize) * 100).toFixed(1));
                    pos.status = sizeMatched > 0 ? 'partial' : 'cancelled';
                    console.log(`  ❌ ${pos.label}: CANCELLED — matched ${sizeMatched}/${originalSize} shares before cancel`);
                } else if (order.status === 'LIVE') {
                    // Still in the book, not filled yet
                    pos.fillStatus = 'pending';
                    allSettled = false;
                    if (attempt === MAX_POLLS) {
                        // Last attempt — mark as unfilled
                        pos.fillStatus = 'unfilled';
                        pos.sharesMatched = sizeMatched;
                        pos.originalSize = originalSize;
                        pos.fillPct = parseFloat(((sizeMatched / originalSize) * 100).toFixed(1));
                        pos.status = sizeMatched > 0 ? 'partial' : 'unfilled';
                        console.log(`  ⏳ ${pos.label}: STILL OPEN in book — ${sizeMatched}/${originalSize} matched so far`);
                    }
                } else {
                    console.log(`  ❓ ${pos.label}: Unknown order status "${order.status}"`);
                    allSettled = false;
                }
            } catch (err) {
                console.warn(`  ⚠️  ${pos.label}: Verification error — ${err.message}`);
                allSettled = false;
            }
        }

        if (!allSettled && attempt < MAX_POLLS) {
            console.log(`  🔄 Poll ${attempt}/${MAX_POLLS}: some orders still settling...`);
        }
    }

    // Recalculate actual total cost based on verified fills
    let actualTotalCost = 0;
    let filledCount = 0;
    let partialCount = 0;
    let unfilledCount = 0;

    for (const pos of buyOrder.positions) {
        if (pos.fillStatus === 'filled') {
            actualTotalCost += pos.buyPrice * (pos.sharesMatched || pos.shares);
            filledCount++;
        } else if (pos.fillStatus === 'partial' && pos.sharesMatched > 0) {
            actualTotalCost += pos.buyPrice * pos.sharesMatched;
            partialCount++;
        } else if (pos.fillStatus === 'unfilled' || pos.fillStatus === 'cancelled') {
            unfilledCount++;
        } else {
            // Unverified — use original estimate
            actualTotalCost += pos.buyPrice * pos.shares;
        }
    }

    buyOrder.verifiedAt = new Date().toISOString();
    buyOrder.actualTotalCost = parseFloat(actualTotalCost.toFixed(4));
    buyOrder.fillSummary = { filled: filledCount, partial: partialCount, unfilled: unfilledCount };

    console.log(`\n  📋 Fill Verification Complete:`);
    console.log(`     Filled: ${filledCount} | Partial: ${partialCount} | Unfilled: ${unfilledCount}`);
    console.log(`     Actual cost: $${buyOrder.actualTotalCost.toFixed(4)} (estimated: $${buyOrder.totalCost.toFixed(4)})`);

    // If ALL orders are unfilled/cancelled, the positions aren't real
    if (filledCount === 0 && partialCount === 0) {
        console.log(`  ❌ NO FILLS — all orders unfilled or cancelled. Clearing buy order.`);
        // Signal to caller that this buy should be treated as failed
        buyOrder.allUnfilled = true;
    }
}

// ── Sell Order Execution ────────────────────────────────────────────────

/**
 * Place a sell order for a single position (to exit/rebalance)
 * @param {Object} position - { label, question, clobTokenId, shares, conditionId }
 * @param {Object} tradingCfg
 * @returns {Promise<Object>} - order result
 */
async function placeSellOrder(position, tradingCfg) {
    const tokenId = position.clobTokenId;
    if (!tokenId) {
        return { success: false, error: 'No clobTokenId for sell', position };
    }

    if (tradingCfg.mode === 'disabled') {
        return { success: false, error: 'Trading disabled', position };
    }

    // Fetch order book to find best bid (= price we'd receive)
    let price = 0;
    let bidSize = 0;
    try {
        const client = await getClient();
        const book = await client.getOrderBook(tokenId);
        const bestBid = book.bids?.[0]?.price ? parseFloat(book.bids[0].price) : null;
        bidSize = book.bids?.[0]?.size ? parseFloat(book.bids[0].size) : 0;

        if (!bestBid || bestBid <= 0) {
            console.log(`  🚫 ${position.label}: No bids in order book — cannot sell`);
            return { success: false, error: 'No bids in order book', position };
        }

        price = bestBid;
        console.log(`  📊 ${position.label} SELL: bestBid=$${price.toFixed(4)} depth=${bidSize} shares`);
    } catch (err) {
        console.log(`  ⚠️  Could not fetch order book for sell: ${err.message}`);
        return { success: false, error: `Order book fetch failed: ${err.message}`, position };
    }

    const size = position.shares || 1;
    const proceeds = parseFloat((price * size).toFixed(4));

    if (tradingCfg.mode === 'dry-run') {
        console.log(`  🧪 DRY-RUN SELL: Would sell ${size} share(s) of "${position.question}" at $${price.toFixed(4)}`);
        console.log(`     Token: ${tokenId}`);
        console.log(`     Proceeds: $${proceeds.toFixed(4)}`);
        return {
            success: true,
            dryRun: true,
            orderId: `dry-run-sell-${Date.now()}`,
            price,
            size,
            proceeds,
            tokenId,
        };
    }

    // LIVE mode — place real sell order
    try {
        const client = await getClient();

        const market = await client.getMarket(position.conditionId);
        const tickSize = String(market.minimum_tick_size || '0.01');
        const negRisk = market.neg_risk || false;

        console.log(`  💰 LIVE SELL: Selling ${size} share(s) of "${position.question}" at $${price.toFixed(4)}`);
        console.log(`     Token: ${tokenId} | Tick: ${tickSize} | NegRisk: ${negRisk}`);

        // Cancel any existing orders on this token to prevent self-matching
        try {
            await client.cancelMarketOrders({ asset_id: tokenId });
            console.log(`     Cleared existing orders for token (self-trade prevention)`);
        } catch (cancelErr) {
            console.log(`     Could not cancel existing orders: ${cancelErr.message}`);
        }

        // Create order first, then post separately for better error handling
        const order = await client.createOrder(
            {
                tokenID: tokenId,
                price,
                size,
                side: Side.SELL,
            },
            {
                tickSize,
                negRisk,
            },
        );

        console.log(`  📝 Order signed: maker=${order.maker} sigType=${order.signatureType}`);

        const response = await client.postOrder(order, OrderType.GTC);

        console.log(`  📨 CLOB Response: ${JSON.stringify(response)}`);

        if (response.error || response.status === 400) {
            const errMsg = response.error || response.errorMsg || `status ${response.status}`;
            console.log(`  ❌ Sell order REJECTED: ${errMsg}`);
            return { success: false, error: errMsg, position };
        }

        const orderID = response.orderID || response.order_id;
        if (!orderID) {
            console.log(`  ❌ Sell order REJECTED: no orderID in response`);
            return { success: false, error: 'No orderID in response', position };
        }

        console.log(`  ✅ Sell order placed: ${orderID}`);

        // Verify actual fill price — SELLs get extra retries (GTC may not fill instantly)
        const fill = await verifyOrderFill(orderID, 'SELL', price, size, position.label);

        return {
            success: true,
            dryRun: false,
            orderId: orderID,
            status: response.status,
            price: fill.verified ? fill.fillPrice : 0,  // 0 = unverified, don't record fake price
            size: fill.verified ? fill.fillSize : size,
            proceeds: fill.verified ? fill.fillCost : 0,
            tokenId,
            verified: fill.verified,
        };
    } catch (err) {
        const detail = err.response?.data || err.data || '';
        console.log(`  ❌ Sell order FAILED for "${position.question}": ${err.message}`);
        if (detail) console.log(`     Detail: ${JSON.stringify(detail)}`);
        return { success: false, error: err.message, position };
    }
}

/**
 * Execute sell orders for out-of-range positions during rebalance.
 * Called by the monitor when forecast shifts beyond the rebalance threshold.
 *
 * @param {Array<Object>} positions - positions to sell, each { label, question, clobTokenId, shares, conditionId }
 * @returns {Promise<Object>} - sellOrder result
 */
export async function executeSellOrder(positions, sessionContext = {}) {
    const tradingCfg = getConfig();

    if (tradingCfg.mode === 'disabled') {
        console.log('  ⚠️  Trading disabled — skipping sell');
        return null;
    }

    console.log(`\n  📉 Rebalance Sell — ${tradingCfg.mode.toUpperCase()} mode`);
    console.log(`  Selling ${positions.length} out-of-range position(s):`);
    for (const p of positions) {
        console.log(`    • ${p.label}: "${p.question}"`);
    }

    const results = [];
    for (const position of positions) {
        const result = await placeSellOrder(position, tradingCfg);
        results.push({ ...position, ...result });
    }

    const successCount = results.filter(r => r.success).length;
    const totalProceeds = results.filter(r => r.success).reduce((sum, r) => sum + (r.proceeds || 0), 0);

    const verifiedCount = results.filter(r => r.verified).length;
    const unverifiedSuccesses = results.filter(r => r.success && !r.verified);

    const sellOrder = {
        executedAt: new Date().toISOString(),
        mode: tradingCfg.mode,
        positions: results.map(r => ({
            label: r.label,
            question: r.question,
            clobTokenId: r.clobTokenId || r.tokenId,
            sellPrice: r.verified ? r.price : 0,
            shares: r.verified ? r.size : (r.shares || 0),
            orderId: r.orderId || null,
            status: r.success
                ? (r.dryRun ? 'dry-run' : (r.verified ? 'filled' : 'pending_verification'))
                : 'failed',
            error: r.error || null,
            verified: r.verified || false,
            buyPositionId: r.buyPositionId || null,  // ID of original buy position in DB
        })),
        totalProceeds: parseFloat(totalProceeds.toFixed(4)),
    };

    console.log(`\n  📋 Sell Summary: ${successCount}/${positions.length} succeeded, ${verifiedCount} verified`);
    console.log(`  💰 Total proceeds: $${sellOrder.totalProceeds.toFixed(4)}`);

    // ── Persist to Database (via data-svc) ──────────────────────────
    try {
        const tradeStatus = verifiedCount > 0 ? 'filled'
            : successCount > 0 ? 'pending_verification'
            : 'failed';

        const { id: dbTradeId } = await dataSvc('POST', '/api/trades', {
            sessionId: sessionContext.sessionId || sellOrder._sessionId || null,
            marketId: sessionContext.marketId || sellOrder._marketId || 'nyc',
            targetDate: sessionContext.targetDate || sellOrder._targetDate || null,
            type: 'sell',
            mode: tradingCfg.mode,
            placedAt: sellOrder.executedAt,
            totalCost: 0,
            totalProceeds: sellOrder.totalProceeds,
            status: tradeStatus,
        });
        await dataSvc('POST', '/api/positions', {
            tradeId: dbTradeId,
            positions: sellOrder.positions.map(p => ({
                label: p.label, question: p.question, price: p.sellPrice,
                shares: p.shares, orderId: p.orderId, status: p.status, error: p.error,
            })),
        });
        sellOrder.dbTradeId = dbTradeId;
        console.log(`  📦 DB: sell trade #${dbTradeId} saved (status: ${tradeStatus})`);

        // ── Mark buy positions as sold (only if fill is verified) ──
        for (const pos of sellOrder.positions) {
            if (pos.verified && pos.buyPositionId) {
                try {
                    await dataSvc('PATCH', `/api/positions/${pos.buyPositionId}/sold`, {
                        sellPrice: pos.sellPrice,
                        soldAt: sellOrder.executedAt,
                        sellOrderId: pos.orderId,
                    });
                    console.log(`  🏷️  Buy position #${pos.buyPositionId} marked SOLD at $${pos.sellPrice.toFixed(4)}`);
                } catch (err) {
                    console.warn(`  ⚠️  Could not mark buy position #${pos.buyPositionId} as sold: ${err.message}`);
                }
            }
        }
    } catch (dbErr) {
        console.warn(`  ⚠️  DB write failed (non-fatal): ${dbErr.message}`);
    }

    // ── Deferred verification for unverified fills ───────────────────
    if (unverifiedSuccesses.length > 0) {
        console.log(`  🔄 ${unverifiedSuccesses.length} sell(s) pending verification — starting background check`);
        deferredVerifySells(unverifiedSuccesses, sellOrder, sessionContext);
    }

    return sellOrder;
}

/**
 * Background re-verification for sell orders that weren't confirmed on initial check.
 * Retries every 30s for up to 5 minutes. Once verified, updates the DB with the
 * real on-chain fill price.
 */
async function deferredVerifySells(unverifiedResults, sellOrder, sessionContext) {
    const maxAttempts = 10;
    const delayMs = 30000;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        await new Promise(r => setTimeout(r, delayMs));

        let allDone = true;
        for (const r of unverifiedResults) {
            if (r._deferredVerified) continue;

            try {
                const fill = await verifyOrderFill(
                    r.orderId, 'SELL', 0, r.shares || 0, r.label,
                    { maxRetries: 1, initialDelayMs: 0, retryDelayMs: 0 },
                );

                if (fill.verified) {
                    r._deferredVerified = true;
                    console.log(`  🔔 DEFERRED VERIFIED: ${r.label} SELL at $${fill.fillPrice.toFixed(4)} × ${fill.fillSize} = $${fill.fillCost.toFixed(4)} (attempt ${attempt})`);

                    // Update sell trade position in DB
                    if (sellOrder.dbTradeId) {
                        try {
                            // Update the sell trade total proceeds
                            await dataSvc('PATCH', `/api/trades/${sellOrder.dbTradeId}`, {
                                totalProceeds: fill.fillCost,
                                status: 'filled',
                                verifiedAt: new Date().toISOString(),
                                actualCost: fill.fillCost,
                            });
                        } catch (err) {
                            console.warn(`  ⚠️  Deferred DB trade update failed: ${err.message}`);
                        }
                    }

                    // Mark the original buy position as sold with verified price
                    if (r.buyPositionId) {
                        try {
                            await dataSvc('PATCH', `/api/positions/${r.buyPositionId}/sold`, {
                                sellPrice: fill.fillPrice,
                                soldAt: sellOrder.executedAt,
                                sellOrderId: r.orderId,
                            });
                            console.log(`  🏷️  Deferred: Buy position #${r.buyPositionId} marked SOLD at $${fill.fillPrice.toFixed(4)}`);
                        } catch (err) {
                            console.warn(`  ⚠️  Deferred position-sold update failed: ${err.message}`);
                        }
                    }

                    // Update session file via data-svc
                    const targetDate = sessionContext.targetDate || sellOrder._targetDate;
                    if (targetDate) {
                        try {
                            const session = await dataSvc('GET', `/api/session-files/${targetDate}`);
                            if (session?.buyOrder?.positions) {
                                const pos = session.buyOrder.positions.find(p => p.question === r.question);
                                if (pos) {
                                    pos.soldAt = sellOrder.executedAt;
                                    pos.soldStatus = 'placed';
                                    pos.sellPrice = fill.fillPrice;
                                    pos.sellShares = fill.fillSize;
                                    pos.sellProceeds = fill.fillCost;
                                    await dataSvc('PUT', `/api/session-files/${targetDate}`, session);
                                    console.log(`  📄 Session file updated with verified sell price`);
                                }
                            }
                        } catch (err) {
                            console.warn(`  ⚠️  Deferred session update failed: ${err.message}`);
                        }
                    }
                } else {
                    allDone = false;
                }
            } catch (err) {
                allDone = false;
                console.log(`  ℹ️  Deferred verification attempt ${attempt} for ${r.label}: ${err.message}`);
            }
        }

        if (allDone) {
            console.log(`  ✅ All deferred sell verifications complete`);
            return;
        }
    }

    // After all attempts, log remaining unverified
    const stillUnverified = unverifiedResults.filter(r => !r._deferredVerified);
    if (stillUnverified.length > 0) {
        console.warn(`  ❌ ${stillUnverified.length} sell(s) could NOT be verified after ${maxAttempts} attempts:`);
        for (const r of stillUnverified) {
            console.warn(`     • ${r.label}: order ${r.orderId} — CHECK POLYMARKET ACTIVITY MANUALLY`);
        }
    }
}

/**
 * Check wallet USDC balance
 * @returns {Promise<number>}
 */
export async function getWalletBalance() {
    const config = getConfig();
    if (!config.privateKey || config.mode === 'disabled') return null;

    try {
        const client = await getClient();
        // The CLOB client doesn't directly expose balance — we can check via API
        return null; // TODO: implement balance check via Polygon RPC
    } catch (err) {
        console.warn(`  ⚠️  Could not check balance: ${err.message}`);
        return null;
    }
}

export { getConfig };

/**
 * Retry a single failed position — called from the dashboard API.
 * @param {Object} position - { label, question, conditionId, clobTokenIds, buyPrice }
 * @param {Object|null} liqTokenData - WebSocket liquidity data for this token (preferred over REST)
 * @returns {Promise<Object>} - { success, orderId, shares, cost, error }
 */
export async function retrySinglePosition(position, liqTokenData = null) {
    const tradingCfg = getConfig();

    if (tradingCfg.mode !== 'live') {
        return { success: false, error: `Trading mode is "${tradingCfg.mode}" — must be "live" to retry` };
    }

    // Parse clobTokenIds if it's a JSON string
    if (typeof position.clobTokenIds === 'string') {
        try { position.clobTokenIds = JSON.parse(position.clobTokenIds); } catch {}
    }

    console.log(`\n  🔄 RETRY: ${position.label} — ${position.question}`);
    console.log(`     Daily spend: $${(await getTodaySpend()).toFixed(4)} / $${tradingCfg.maxDailySpend}`);

    const result = await placeSingleOrder(position, tradingCfg, liqTokenData);

    if (result.success) {
        await recordSpend(result.cost, { position: position.label, question: position.question, retry: true });
        console.log(`  ✅ RETRY SUCCESS: ${result.size} shares at $${result.price.toFixed(4)} = $${result.cost.toFixed(4)}`);
    } else {
        console.log(`  ❌ RETRY FAILED: ${result.error}`);
    }

    return {
        success: result.success || false,
        orderId: result.orderId || null,
        shares: result.size || 0,
        cost: result.cost || 0,
        price: result.price || 0,
        error: result.error || null,
    };
}

// ── On-Chain Redeem ─────────────────────────────────────────────────────

// Polymarket contracts on Polygon
const USDC_E_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const CTF_ADDRESS = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
const NEG_RISK_ADAPTER = '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296';

const CTF_ABI = [
    'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)',
    'function balanceOf(address owner, uint256 id) view returns (uint256)',
    'function isApprovedForAll(address owner, address operator) view returns (bool)',
    'function setApprovalForAll(address operator, bool approved)',
];

const NEG_RISK_ADAPTER_ABI = [
    'function redeemPositions(bytes32 conditionId, uint256[] amounts)',
];

const ERC20_ABI = [
    'function balanceOf(address owner) view returns (uint256)',
    'function decimals() view returns (uint8)',
];

const REDEEM_GAS_OVERRIDES = {
    gasLimit: 300000,
    maxFeePerGas: utils.parseUnits('200', 'gwei'),
    maxPriorityFeePerGas: utils.parseUnits('30', 'gwei'),
};

/**
 * Get a provider that bypasses the VPN proxy.
 * Polygon RPC is not geo-blocked, and sending it through the VPN
 * proxy can cause connection issues.
 */
function getPolygonProvider() {
    const rpc = process.env.POLYGON_RPC_URL || 'https://polygon.drpc.org';
    // Use a separate agent without proxy for RPC calls
    return new providers.StaticJsonRpcProvider(rpc, 137);
}

/**
 * Check market resolution via CLOB client
 */
async function checkMarketResolution(conditionId) {
    try {
        const client = await getClient();
        const market = await client.getMarket(conditionId);

        if (!market.closed) {
            return { resolved: false, winner: null, negRisk: false, winnerTokenId: null };
        }

        const negRisk = market.neg_risk === true;
        const winningToken = market.tokens?.find(t => t.winner === true);
        const winner = winningToken ? winningToken.outcome?.toUpperCase() : null;
        const winnerTokenId = winningToken?.token_id || null;

        return { resolved: true, winner, negRisk, winnerTokenId };
    } catch (err) {
        console.log(`  ⚠️  Could not check market ${conditionId?.substring(0, 12)}: ${err.message}`);
        return { resolved: false, winner: null, negRisk: false, winnerTokenId: null };
    }
}

/**
 * Redeem resolved winning positions on-chain.
 * 
 * Called by the monitor when a market closes (eventClosed === true).
 * 
 * Handles both:
 *   - Neg-risk markets → NegRiskAdapter.redeemPositions(conditionId, [yesAmt, noAmt])
 *   - Standard markets → CTF.redeemPositions(USDC_E, HashZero, conditionId, [1, 2])
 * 
 * @param {Object} session - The full monitoring session with buyOrder.positions[]
 * @returns {Promise<Object>} - { redeemed, totalValue, positions[] }
 */
export async function redeemPositions(session) {
    const tradingCfg = getConfig();

    if (tradingCfg.mode === 'disabled') {
        console.log('  ⚠️  Trading disabled — skipping redeem');
        return null;
    }

    if (!session?.buyOrder?.positions?.length) {
        console.log('  ⚠️  No positions in session to redeem');
        return null;
    }

    const dryRun = tradingCfg.mode === 'dry-run';
    const provider = getPolygonProvider();
    const wallet = new Wallet(tradingCfg.privateKey, provider);
    const ctf = new Contract(CTF_ADDRESS, CTF_ABI, wallet);
    const adapter = new Contract(NEG_RISK_ADAPTER, NEG_RISK_ADAPTER_ABI, wallet);

    console.log(`\n  🏆 Redeeming positions — ${dryRun ? '🧪 DRY RUN' : '💰 LIVE'}`);
    console.log(`  Wallet: ${wallet.address}`);

    // Check USDC.e balance before
    let balBefore;
    try {
        const usdc = new Contract(USDC_E_ADDRESS, ERC20_ABI, provider);
        balBefore = await usdc.balanceOf(wallet.address);
        console.log(`  USDC.e before: $${utils.formatUnits(balBefore, 6)}`);
    } catch (err) {
        console.log(`  ⚠️  Could not check USDC balance: ${err.message}`);
        balBefore = null;
    }

    // Ensure CTF approval for NegRiskAdapter
    try {
        const isApproved = await ctf.isApprovedForAll(wallet.address, NEG_RISK_ADAPTER);
        if (!isApproved && !dryRun) {
            console.log(`  🔐 Setting CTF approval for NegRiskAdapter...`);
            const approveTx = await ctf.setApprovalForAll(NEG_RISK_ADAPTER, true, REDEEM_GAS_OVERRIDES);
            await approveTx.wait();
            console.log(`  ✅ CTF approval granted`);
        }
    } catch (err) {
        console.log(`  ⚠️  CTF approval check failed: ${err.message}`);
    }

    // Group positions by conditionId
    const byCondition = {};
    for (const pos of session.buyOrder.positions) {
        if (!pos.conditionId) continue;
        if (pos.status === 'failed' || pos.status === 'rejected') continue;

        // Parse clobTokenIds if needed
        let tokenIds = pos.clobTokenIds;
        if (typeof tokenIds === 'string') {
            try { tokenIds = JSON.parse(tokenIds); } catch { tokenIds = []; }
        }

        if (!byCondition[pos.conditionId]) byCondition[pos.conditionId] = [];
        byCondition[pos.conditionId].push({ ...pos, clobTokenIds: tokenIds || [] });
    }

    const results = [];
    let totalRedeemed = 0;
    let totalValue = 0;

    for (const [conditionId, positions] of Object.entries(byCondition)) {
        const pos0 = positions[0];
        const rangeDesc = pos0.question?.substring(0, 60) || pos0.label || 'unknown';

        // Check on-chain balance for YES token
        const tokenId = pos0.clobTokenIds?.[0] || pos0.tokenId;
        if (!tokenId) {
            console.log(`  ⚠️  ${pos0.label}: No token ID, skipping redeem`);
            results.push({ label: pos0.label, question: pos0.question, status: 'skipped', error: 'No token ID' });
            continue;
        }

        let onChainBalance;
        try {
            const rawBal = await ctf.balanceOf(wallet.address, tokenId);
            onChainBalance = parseFloat(utils.formatUnits(rawBal, 6));
            console.log(`  📊 ${pos0.label}: On-chain balance = ${onChainBalance.toFixed(4)} tokens`);

            if (onChainBalance < 0.001) {
                console.log(`     No on-chain tokens to redeem`);
                results.push({ label: pos0.label, question: pos0.question, status: 'no_balance', shares: 0 });
                continue;
            }
        } catch (err) {
            console.log(`  ⚠️  ${pos0.label}: Balance check failed: ${err.message}`);
            results.push({ label: pos0.label, question: pos0.question, status: 'error', error: `Balance check: ${err.message}` });
            continue;
        }

        // Check market resolution
        const { resolved, winner, negRisk, winnerTokenId } = await checkMarketResolution(conditionId);

        if (!resolved) {
            console.log(`  ⏳ ${pos0.label}: Market not yet resolved — skipping`);
            results.push({ label: pos0.label, question: pos0.question, status: 'not_resolved', shares: onChainBalance });
            continue;
        }

        const isWinner = winner === 'YES' && (!winnerTokenId || winnerTokenId === tokenId);
        const value = isWinner ? onChainBalance : 0;

        console.log(`  ${isWinner ? '🏆' : '❌'} ${pos0.label}: Resolved ${winner || 'NO'} — ${isWinner ? `$${value.toFixed(2)} payout` : '$0 (losing)'}`);
        console.log(`     conditionId: ${conditionId} | negRisk: ${negRisk}`);

        if (dryRun) {
            console.log(`     🧪 DRY RUN — would ${isWinner ? `redeem $${value.toFixed(2)}` : 'burn losing tokens'}`);
            results.push({
                label: pos0.label, question: pos0.question,
                status: 'dry-run', winner: isWinner, value,
                shares: onChainBalance, conditionId,
            });
            totalRedeemed++;
            totalValue += value;
            continue;
        }

        // Execute on-chain redeem
        try {
            let tx;
            const rawBal = await ctf.balanceOf(wallet.address, tokenId);

            if (negRisk) {
                // NegRiskAdapter: amounts = [yesTokenAmount, noTokenAmount]
                const amounts = isWinner ? [rawBal, 0] : [rawBal, 0];
                console.log(`     📝 NegRiskAdapter.redeemPositions(${conditionId.substring(0, 12)}..., [${utils.formatUnits(rawBal, 6)}, 0])`);
                tx = await adapter.redeemPositions(conditionId, amounts, REDEEM_GAS_OVERRIDES);
            } else {
                // Standard CTF: indexSets = [1, 2] (redeem both YES and NO, only winner pays)
                console.log(`     📝 CTF.redeemPositions(${conditionId.substring(0, 12)}..., [1, 2])`);
                tx = await ctf.redeemPositions(
                    USDC_E_ADDRESS,
                    constants.HashZero,
                    conditionId,
                    [1, 2],
                    REDEEM_GAS_OVERRIDES,
                );
            }

            console.log(`     TX: ${tx.hash}`);
            const receipt = await tx.wait();

            if (receipt.status === 0) {
                console.log(`     ❌ Transaction reverted on-chain!`);
                results.push({ label: pos0.label, question: pos0.question, status: 'reverted', txHash: tx.hash });
                continue;
            }

            console.log(`     ✅ ${isWinner ? 'Redeemed' : 'Burned'}! Gas: ${receipt.gasUsed.toString()}`);
            totalRedeemed++;
            totalValue += value;

            results.push({
                label: pos0.label, question: pos0.question,
                status: isWinner ? 'redeemed' : 'burned',
                winner: isWinner, value,
                shares: onChainBalance, conditionId,
                txHash: tx.hash,
                gasUsed: receipt.gasUsed.toString(),
            });

        } catch (err) {
            console.log(`     ❌ Redeem failed: ${err.message}`);
            if (err.error?.reason) console.log(`        Reason: ${err.error.reason}`);
            results.push({
                label: pos0.label, question: pos0.question,
                status: 'failed', error: err.message, conditionId,
            });
        }
    }

    // Check USDC.e balance after
    if (!dryRun && totalRedeemed > 0 && balBefore !== null) {
        try {
            const usdc = new Contract(USDC_E_ADDRESS, ERC20_ABI, provider);
            const balAfter = await usdc.balanceOf(wallet.address);
            const gained = balAfter.sub(balBefore);
            console.log(`\n  💰 USDC.e: $${utils.formatUnits(balBefore, 6)} → $${utils.formatUnits(balAfter, 6)} (+$${utils.formatUnits(gained, 6)})`);
        } catch {}
    }

    console.log(`\n  📋 Redeem Summary: ${totalRedeemed} position(s), $${totalValue.toFixed(2)} value`);

    // Persist to database
    if (totalRedeemed > 0) {
        try {
            await dataSvc('POST', '/api/trades', {
                sessionId: session.id || null,
                marketId: 'nyc',
                targetDate: session.targetDate || null,
                type: 'redeem',
                mode: tradingCfg.mode,
                placedAt: new Date().toISOString(),
                totalCost: 0,
                totalProceeds: totalValue,
                status: 'filled',
                metadata: { redeemed: totalRedeemed, results },
            });
        } catch (dbErr) {
            console.warn(`  ⚠️  DB write failed (non-fatal): ${dbErr.message}`);
        }
    }

    return {
        redeemed: totalRedeemed,
        totalValue,
        positions: results,
        dryRun,
    };
}
