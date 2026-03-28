/**
 * Trading Service — Buy Order Execution
 *
 * Handles single position orders and the main executeRealBuyOrder flow.
 * Uses liquidity-gated entry: checks spread, depth, and uses bestAsk for fills.
 *
 * Extracted from the monolithic trading.js.
 */

import { Side, OrderType } from '@polymarket/clob-client';
import { getClient, getConfig, dataSvc, getTodaySpend, recordSpend, clobCall } from './client.js';
import { verifyOrderFill, verifyOrderFills } from './verify.js';
import { createLogger } from '../../shared/logger.js';


const log = createLogger('trading-svc');
// ── Single Position Order ───────────────────────────────────────────────

/**
 * Place a buy order for a single position
 * @param {Object} position - { label, question, marketId, conditionId, clobTokenIds, buyPrice }
 * @param {Object} tradingCfg - config from getConfig()
 * @param {Object|null} liqTokenData - WebSocket liquidity data
 * @returns {Promise<Object>} - order result
 */
export async function placeSingleOrder(position, tradingCfg, liqTokenData = null) {
    const tokenId = position.clobTokenIds?.[0]; // YES token
    if (!tokenId) {
        return { success: false, error: 'No clobTokenId for YES token', position };
    }

    let price = position.buyPrice;
    const MAX_SPREAD_PCT = tradingCfg.maxSpreadPct;
    const MIN_ASK_DEPTH = tradingCfg.minAskDepth;

    // For LIVE orders, check liquidity and use real ask price for immediate fill
    if (tradingCfg.mode === 'live') {
        let bestBid, bestAsk, askSize;

        // Prefer WebSocket-sourced liquidity data (accurate) over REST API (unreliable)
        if (liqTokenData) {
            bestBid = liqTokenData.bestBid || null;
            bestAsk = liqTokenData.bestAsk || null;
            askSize = liqTokenData.askDepth || 0;
            log.info(
                `  📡 ${position.label}: Using live WS data — bid=$${bestBid?.toFixed(4)} | ask=$${bestAsk?.toFixed(4)} | depth=${askSize}`,
            );
        } else {
            // Fallback: direct CLOB REST API call
            try {
                const client = await getClient();
                const book = await clobCall(() => client.getOrderBook(tokenId));
                bestBid = book.bids?.[0]?.price ? parseFloat(book.bids[0].price) : null;
                bestAsk = book.asks?.[0]?.price ? parseFloat(book.asks[0].price) : null;
                askSize = book.asks?.[0]?.size ? parseFloat(book.asks[0].size) : 0;
                log.info(
                    `  📈 ${position.label}: REST API — bid=$${bestBid?.toFixed(4)} | ask=$${bestAsk?.toFixed(4)} | depth=${askSize}`,
                );
            } catch (err) {
                log.info(`  ⚠️  Could not fetch order book: ${err.message} — skipping`);
                return { success: false, error: `Order book fetch failed: ${err.message}`, position };
            }
        }

        if (!bestAsk || !bestBid) {
            log.info(`  🚫 ${position.label}: No ${!bestAsk ? 'asks' : 'bids'} in order book — ILLIQUID, skipping`);
            return { success: false, error: 'No liquidity — empty order book', position };
        }

        const spread = bestAsk - bestBid;
        const spreadPct = spread / bestAsk;

        log.info(
            `  📈 ${position.label}: bid=$${bestBid.toFixed(4)} | ask=$${bestAsk.toFixed(4)} | spread=${(spreadPct * 100).toFixed(1)}% | depth=${askSize} shares`,
        );

        // Liquidity check 1: Spread must be reasonable
        if (spreadPct > MAX_SPREAD_PCT) {
            log.info(
                `  🚫 ${position.label}: Spread ${(spreadPct * 100).toFixed(1)}% > ${MAX_SPREAD_PCT * 100}% max — ILLIQUID, skipping`,
            );
            return { success: false, error: `Spread ${(spreadPct * 100).toFixed(1)}% too wide (max ${MAX_SPREAD_PCT * 100}%)`, position };
        }

        // Liquidity check 2: Enough shares available at ask
        if (askSize < MIN_ASK_DEPTH) {
            log.info(`  🚫 ${position.label}: Only ${askSize} shares at ask (need ${MIN_ASK_DEPTH}) — THIN, skipping`);
            return { success: false, error: `Ask depth ${askSize} < min ${MIN_ASK_DEPTH}`, position };
        }

        // Use bestAsk for immediate fill
        log.info(`  ✅ ${position.label}: LIQUID — buying at bestAsk $${bestAsk.toFixed(4)}`);
        price = bestAsk;
    }

    // Auto-calculate size to target exactly $1.05 per position (fractional shares OK)
    let size = tradingCfg.buySize;
    if (size <= 0) {
        size = parseFloat((tradingCfg.minOrderValue / price).toFixed(2));
    }
    let cost = parseFloat((price * size).toFixed(4));

    log.info(`  📋 ${position.label}: price=$${price.toFixed(4)} × ${size} shares = $${cost.toFixed(4)}`);

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
        log.info(`  🧪 DRY-RUN: Would buy ${size} share(s) of "${position.question}" at $${price.toFixed(4)}`);
        log.info(`     Token: ${tokenId}`);
        log.info(`     Cost:  $${cost.toFixed(4)}`);
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
        const market = await clobCall(() => client.getMarket(position.conditionId));
        const tickSize = String(market.minimum_tick_size || '0.01');
        const negRisk = market.neg_risk || false;
        const minSize = parseFloat(market.minimum_order_size || '0');

        // Bump size to market minimum if needed
        if (minSize > 0 && size < minSize) {
            log.info(`  ⚠️  Size ${size} below market min ${minSize}, bumping up`);
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

        log.info(`  💰 LIVE: Buying ${size} share(s) of "${position.question}" at $${price.toFixed(4)}`);
        log.info(`     Token: ${tokenId} | Tick: ${tickSize} | NegRisk: ${negRisk} | MinSize: ${minSize}`);

        // Self-trade prevention
        try {
            await clobCall(() => client.cancelMarketOrders({ asset_id: tokenId }));
            log.info(`  🧹 Cleared existing orders for token (self-trade prevention)`);
        } catch (cancelErr) {
            if (!cancelErr.message?.includes('404') && !cancelErr.message?.includes('no orders')) {
                log.info(`  ⚠️  Could not cancel existing orders: ${cancelErr.message} (proceeding)`);
            }
        }

        const response = await clobCall(() => client.createAndPostOrder(
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
            OrderType.GTC, // createAndPostOrder only supports GTC|GTD; FOK requires createAndPostMarketOrder
        ));

        log.info(`  📨 CLOB Response: ${JSON.stringify(response)}`);

        if (!response.orderID || response.status === 400 || response.status === 'error') {
            const errMsg = response.errorMsg || response.error || response.data?.error || `status ${response.status}`;
            log.info(`  ❌ Order REJECTED: ${errMsg}`);
            return {
                success: false,
                error: errMsg,
                position,
            };
        }

        log.info(`  ✅ Order placed: ${response.orderID} (status: ${response.status})`);

        // Verify actual fill price
        const fill = await verifyOrderFill(response.orderID, 'BUY', price, size, position.label);

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

        // Track slippage: delta between ask price at decision time and actual fill
        const slippage = parseFloat((actualPrice - price).toFixed(4)); // positive = paid more
        if (slippage !== 0) {
            log.info(`  📉 Slippage: ${slippage > 0 ? '+' : ''}$${slippage.toFixed(4)} (asked $${price.toFixed(4)}, filled $${actualPrice.toFixed(4)})`);
        }

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
            slippage,
            askPriceAtDecision: price,
        };
    } catch (err) {
        const detail = err.response?.data || err.data || '';
        log.info(`  ❌ Order FAILED for "${position.question}": ${err.message}`);
        if (detail) log.info(`     Detail: ${JSON.stringify(detail)}`);
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
        log.info('  ⚠️  Trading disabled (TRADING_MODE=disabled)');
        return null;
    }

    if (snapshot.phase && snapshot.phase !== 'buy') {
        log.info(`  ⚠️  Skipping real trade — phase is "${snapshot.phase}" (only trades in "buy" phase)`);
        return null;
    }

    log.info(`\n  🏦 Trading Mode: ${tradingCfg.mode.toUpperCase()}`);
    log.info(`  💳 Max/position: $${tradingCfg.maxPositionCost} | Max/day: $${tradingCfg.maxDailySpend}`);
    log.info(`  📈 Today's spend so far: $${(await getTodaySpend()).toFixed(4)}`);

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

    // Place orders concurrently — each position targets a different conditionId,
    // so there's no self-trade risk from parallel execution.
    const orderPromises = positions.map((position) => {
        const liqTokenData = liqByQuestion.get(position.question) || null;
        return placeSingleOrder(position, tradingCfg, liqTokenData)
            .then((result) => ({ ...position, ...result }))
            .catch((err) => ({ ...position, success: false, error: err.message }));
    });
    const results = await Promise.all(orderPromises);

    // Build buyOrder object compatible with existing P&L logic
    const successfulOrders = results.filter((r) => r.success);
    const totalCost = successfulOrders.reduce((sum, r) => sum + (r.cost || r.buyPrice), 0);

    log.info(`\n  📋 Order Summary: ${successfulOrders.length}/${positions.length} succeeded`);

    if (successfulOrders.length === 0) {
        log.info(`  ❌ All positions failed — no buy recorded, will retry`);
        for (const r of results) {
            log.info(`     • ${r.label}: ${r.error || 'unknown error'}`);
        }
        return null;
    }

    const buyOrder = {
        placedAt: new Date().toISOString(),
        mode: tradingCfg.mode,
        positions: results.map((r) => ({
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

    log.info(`  💰 Total cost: $${buyOrder.totalCost.toFixed(4)}`);

    // Post-Trade Verification
    if (tradingCfg.mode === 'live') {
        await verifyOrderFills(buyOrder);
    }

    // Persist to Database (via data-svc)
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
        log.info(`  📦 DB: buy trade #${dbTradeId} saved (${buyOrder.positions.length} positions)`);
    } catch (dbErr) {
        log.warn(`  ⚠️  DB write failed (non-fatal): ${dbErr.message}`);
    }

    return buyOrder;
}
