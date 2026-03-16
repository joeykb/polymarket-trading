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
import { Wallet } from 'ethers';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { config } from '../config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// CLOB_HOST and CHAIN_ID are read at call time via getClient() which uses config.trading
// No module-level caching — supports hot-reload.

// ── Config ──────────────────────────────────────────────────────────────

function getConfig() {
    return {
        privateKey: config.trading.privateKey,
        mode: config.trading.mode,
        maxPositionCost: config.trading.maxPositionCost,
        maxDailySpend: config.trading.maxDailySpend,
        buySize: config.trading.buySize,
        minOrderValue: config.trading.minOrderValue,
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
    const tempClient = new ClobClient(config.trading.clobHost, config.trading.chainId, _signer);
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
        config.trading.clobHost,
        config.trading.chainId,
        _signer,
        apiCreds,
        0, // Signature type: 0 = EOA
        _signer.address, // Funder address
    );

    return _client;
}

// ── Daily Spend Tracking ────────────────────────────────────────────────

const SPEND_LOG_DIR = process.env.OUTPUT_DIR || join(__dirname, '../../output');

function getSpendLogPath() {
    const today = new Date().toISOString().slice(0, 10);
    return join(SPEND_LOG_DIR, `spend-${today}.json`);
}

function getTodaySpend() {
    const path = getSpendLogPath();
    if (!existsSync(path)) return 0;
    try {
        const data = JSON.parse(readFileSync(path, 'utf-8'));
        return data.totalSpent || 0;
    } catch { return 0; }
}

function recordSpend(amount, orderDetails) {
    const path = getSpendLogPath();
    let data = { totalSpent: 0, orders: [] };
    if (existsSync(path)) {
        try { data = JSON.parse(readFileSync(path, 'utf-8')); } catch { }
    }
    data.totalSpent = parseFloat((data.totalSpent + amount).toFixed(4));
    data.orders.push({
        timestamp: new Date().toISOString(),
        amount,
        ...orderDetails,
    });
    writeFileSync(path, JSON.stringify(data, null, 2));
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
    const MAX_SPREAD_PCT = config.trading.maxSpreadPct;
    const MIN_ASK_DEPTH = config.trading.minAskDepth;

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
    const todaySpend = getTodaySpend();
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
                orderType: OrderType.GTC,
            },
            {
                tickSize,
                negRisk,
            },
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

        // Record spend
        recordSpend(cost, {
            orderId: response.orderID,
            label: position.label,
            question: position.question,
            tokenId,
            price,
            size,
        });

        return {
            success: true,
            dryRun: false,
            orderId: response.orderID,
            status: response.status,
            price,
            size,
            cost,
            tokenId,
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
 * @returns {Promise<Object>} - buyOrder object compatible with existing P&L logic
 */
export async function executeRealBuyOrder(snapshot, liqTokens = []) {
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
    console.log(`  📊 Today's spend so far: $${getTodaySpend().toFixed(4)}`);

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

        const response = await client.createAndPostOrder(
            {
                tokenID: tokenId,
                price,
                size,
                side: Side.SELL,
                orderType: OrderType.GTC,
            },
            {
                tickSize,
                negRisk,
            },
        );

        console.log(`  📨 CLOB Response: ${JSON.stringify(response)}`);

        if (!response.orderID || response.status === 400 || response.status === 'error') {
            const errMsg = response.errorMsg || response.error || response.data?.error || `status ${response.status}`;
            console.log(`  ❌ Sell order REJECTED: ${errMsg}`);
            return { success: false, error: errMsg, position };
        }

        console.log(`  ✅ Sell order placed: ${response.orderID}`);
        return {
            success: true,
            dryRun: false,
            orderId: response.orderID,
            status: response.status,
            price,
            size,
            proceeds,
            tokenId,
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
export async function executeSellOrder(positions) {
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

    const sellOrder = {
        executedAt: new Date().toISOString(),
        mode: tradingCfg.mode,
        positions: results.map(r => ({
            label: r.label,
            question: r.question,
            clobTokenId: r.clobTokenId || r.tokenId,
            sellPrice: r.price || 0,
            shares: r.size || r.shares,
            orderId: r.orderId || null,
            status: r.success ? (r.dryRun ? 'dry-run' : 'placed') : 'failed',
            error: r.error || null,
        })),
        totalProceeds: parseFloat(totalProceeds.toFixed(4)),
    };

    console.log(`\n  📋 Sell Summary: ${successCount}/${positions.length} succeeded`);
    console.log(`  💰 Total proceeds: $${sellOrder.totalProceeds.toFixed(4)}`);

    return sellOrder;
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
