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

const __dirname = dirname(fileURLToPath(import.meta.url));

const CLOB_HOST = 'https://clob.polymarket.com';
const CHAIN_ID = 137; // Polygon mainnet

// ── Config ──────────────────────────────────────────────────────────────

function getConfig() {
    return {
        privateKey: process.env.POLYMARKET_PRIVATE_KEY || '',
        mode: (process.env.TRADING_MODE || 'disabled').toLowerCase(),
        maxPositionCost: parseFloat(process.env.MAX_POSITION_COST || '2.00'),
        maxDailySpend: parseFloat(process.env.MAX_DAILY_SPEND || '5.00'),
        buySize: parseFloat(process.env.BUY_SIZE || '0'), // 0 = auto-calculate to meet $1 min
        minOrderValue: 1.05, // Polymarket min is $1 — add 5% buffer
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

    const config = getConfig();
    if (!config.privateKey) {
        throw new Error('POLYMARKET_PRIVATE_KEY not set');
    }

    _signer = new Wallet(config.privateKey);
    console.log(`  🔑 Wallet: ${_signer.address}`);

    // Derive API credentials from wallet
    const tempClient = new ClobClient(CLOB_HOST, CHAIN_ID, _signer);
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
        CLOB_HOST,
        CHAIN_ID,
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
async function placeSingleOrder(position, config) {
    const tokenId = position.clobTokenIds?.[0]; // YES token
    if (!tokenId) {
        return { success: false, error: 'No clobTokenId for YES token', position };
    }

    let price = position.buyPrice;
    const MAX_SPREAD_PCT = 0.20; // Skip if bid-ask spread > 20%
    const MIN_ASK_DEPTH = 5;     // Need at least 5 shares available at ask

    // For LIVE orders, check liquidity and use real ask price for immediate fill
    if (config.mode === 'live') {
        try {
            const client = await getClient();
            const book = await client.getOrderBook(tokenId);
            const bestBid = book.bids?.[0]?.price ? parseFloat(book.bids[0].price) : null;
            const bestAsk = book.asks?.[0]?.price ? parseFloat(book.asks[0].price) : null;
            const askSize = book.asks?.[0]?.size ? parseFloat(book.asks[0].size) : 0;

            if (!bestAsk || !bestBid) {
                console.log(`  🚫 ${position.label}: No ${!bestAsk ? 'asks' : 'bids'} in order book — ILLIQUID, skipping`);
                return { success: false, error: 'No liquidity — empty order book', position };
            }

            const spread = bestAsk - bestBid;
            const spreadPct = spread / bestAsk;
            const midPrice = (bestBid + bestAsk) / 2;

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
        } catch (err) {
            console.log(`  ⚠️  Could not fetch order book: ${err.message} — skipping`);
            return { success: false, error: `Order book fetch failed: ${err.message}`, position };
        }
    }

    // Auto-calculate size to target exactly $1.05 per position (fractional shares OK)
    let size = config.buySize;
    if (size <= 0) {
        size = parseFloat((config.minOrderValue / price).toFixed(2));
    }
    let cost = parseFloat((price * size).toFixed(4));

    console.log(`  📐 ${position.label}: price=$${price.toFixed(4)} × ${size} shares = $${cost.toFixed(4)}`);

    // Safety: per-position cap
    if (cost > config.maxPositionCost) {
        return {
            success: false,
            error: `Cost $${cost.toFixed(4)} exceeds max $${config.maxPositionCost}`,
            position,
        };
    }

    // Safety: daily spend cap
    const todaySpend = getTodaySpend();
    if (todaySpend + cost > config.maxDailySpend) {
        return {
            success: false,
            error: `Daily spend $${(todaySpend + cost).toFixed(4)} would exceed max $${config.maxDailySpend}`,
            position,
        };
    }

    if (config.mode === 'dry-run') {
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
        if (cost > config.maxPositionCost) {
            return {
                success: false,
                error: `Cost $${cost.toFixed(4)} (after min-size bump) exceeds max $${config.maxPositionCost}`,
                position,
            };
        }

        console.log(`  💰 LIVE: Buying ${size} share(s) of "${position.question}" at $${price.toFixed(4)}`);
        console.log(`     Token: ${tokenId} | Tick: ${tickSize} | NegRisk: ${negRisk} | MinSize: ${minSize}`);

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
export async function executeRealBuyOrder(snapshot) {
    const config = getConfig();

    if (config.mode === 'disabled') {
        console.log('  ⚠️  Trading disabled (TRADING_MODE=disabled)');
        return null; // Fall through to simulated buy
    }

    // Only place real orders during buy phase
    if (snapshot.phase && snapshot.phase !== 'buy') {
        console.log(`  ⚠️  Skipping real trade — phase is "${snapshot.phase}" (only trades in "buy" phase)`);
        return null; // Fall through to simulated buy
    }

    console.log(`\n  🏦 Trading Mode: ${config.mode.toUpperCase()}`);
    console.log(`  💳 Max/position: $${config.maxPositionCost} | Max/day: $${config.maxDailySpend}`);
    console.log(`  📊 Today's spend so far: $${getTodaySpend().toFixed(4)}`);

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

    // Place orders
    const results = [];
    for (const position of positions) {
        const result = await placeSingleOrder(position, config);
        results.push({ ...position, ...result });
    }

    // Build buyOrder object compatible with existing P&L logic
    const successfulOrders = results.filter(r => r.success);
    const totalCost = successfulOrders.reduce((sum, r) => sum + (r.cost || r.buyPrice), 0);

    const buyOrder = {
        placedAt: new Date().toISOString(),
        mode: config.mode,
        positions: results.map(r => ({
            label: r.label,
            question: r.question,
            marketId: r.marketId,
            buyPrice: r.price || r.buyPrice,
            shares: r.size || config.buySize,
            orderId: r.orderId || null,
            status: r.success ? (r.dryRun ? 'dry-run' : 'placed') : 'failed',
            error: r.error || null,
        })),
        totalCost: parseFloat(totalCost.toFixed(4)),
        maxPayout: 1.0,
        maxProfit: parseFloat((1.0 - totalCost).toFixed(4)),
        simulated: config.mode === 'dry-run',
    };

    console.log(`\n  📋 Order Summary: ${successfulOrders.length}/${positions.length} succeeded`);
    console.log(`  💰 Total cost: $${buyOrder.totalCost.toFixed(4)}`);

    return buyOrder;
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
