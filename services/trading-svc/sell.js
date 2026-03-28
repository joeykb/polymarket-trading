/**
 * Trading Service — Sell Order Execution
 *
 * Handles individual sell orders and the main executeSellOrder flow.
 * Includes deferred background verification for unconfirmed fills.
 *
 * Extracted from the monolithic trading.js.
 */

import { Side, OrderType } from '@polymarket/clob-client';
import { getClient, getConfig, dataSvc, clobCall } from './client.js';
import { verifyOrderFill } from './verify.js';
import { createLogger } from '../../shared/logger.js';


const log = createLogger('trading-svc');
// ── Single Position Sell ────────────────────────────────────────────────

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
    let price, bidSize;
    try {
        const client = await getClient();
        const book = await clobCall(() => client.getOrderBook(tokenId));
        const bestBid = book.bids?.[0]?.price ? parseFloat(book.bids[0].price) : null;
        bidSize = book.bids?.[0]?.size ? parseFloat(book.bids[0].size) : 0;

        if (!bestBid || bestBid <= 0) {
            log.info(`  🚫 ${position.label}: No bids in order book — cannot sell`);
            return { success: false, error: 'No bids in order book', position };
        }

        price = bestBid;
        log.info(`  📈 ${position.label} SELL: bestBid=$${price.toFixed(4)} depth=${bidSize} shares`);
    } catch (err) {
        log.info(`  ⚠️  Could not fetch order book for sell: ${err.message}`);
        return { success: false, error: `Order book fetch failed: ${err.message}`, position };
    }

    const size = position.shares || 1;
    const proceeds = parseFloat((price * size).toFixed(4));

    if (tradingCfg.mode === 'dry-run') {
        log.info(`  🧪 DRY-RUN SELL: Would sell ${size} share(s) of "${position.question}" at $${price.toFixed(4)}`);
        log.info(`     Token: ${tokenId}`);
        log.info(`     Proceeds: $${proceeds.toFixed(4)}`);
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

        const market = await clobCall(() => client.getMarket(position.conditionId));
        const tickSize = String(market.minimum_tick_size || '0.01');
        const negRisk = market.neg_risk || false;

        log.info(`  💰 LIVE SELL: Selling ${size} share(s) of "${position.question}" at $${price.toFixed(4)}`);
        log.info(`     Token: ${tokenId} | Tick: ${tickSize} | NegRisk: ${negRisk}`);

        // Cancel any existing orders on this token to prevent self-matching
        try {
            await clobCall(() => client.cancelMarketOrders({ asset_id: tokenId }));
            log.info(`     Cleared existing orders for token (self-trade prevention)`);
        } catch (cancelErr) {
            log.info(`     Could not cancel existing orders: ${cancelErr.message}`);
        }

        // Create order first, then post separately for better error handling
        const order = await clobCall(() => client.createOrder(
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
        ));

        log.info(`  📝 Order signed: maker=${order.maker} sigType=${order.signatureType}`);

        const response = await clobCall(() => client.postOrder(order, OrderType.GTC));

        log.info(`  📨 CLOB Response: ${JSON.stringify(response)}`);

        if (response.error || response.status === 400) {
            const errMsg = response.error || response.errorMsg || `status ${response.status}`;
            log.info(`  ❌ Sell order REJECTED: ${errMsg}`);
            return { success: false, error: errMsg, position };
        }

        const orderID = response.orderID || response.order_id;
        if (!orderID) {
            log.info(`  ❌ Sell order REJECTED: no orderID in response`);
            return { success: false, error: 'No orderID in response', position };
        }

        log.info(`  ✅ Sell order placed: ${orderID}`);

        // Verify actual fill price — SELLs get extra retries (GTC may not fill instantly)
        const fill = await verifyOrderFill(orderID, 'SELL', price, size, position.label);

        return {
            success: true,
            dryRun: false,
            orderId: orderID,
            status: response.status,
            price: fill.verified ? fill.fillPrice : 0, // 0 = unverified, don't record fake price
            size: fill.verified ? fill.fillSize : size,
            proceeds: fill.verified ? fill.fillCost : 0,
            tokenId,
            verified: fill.verified,
        };
    } catch (err) {
        const detail = err.response?.data || err.data || '';
        log.info(`  ❌ Sell order FAILED for "${position.question}": ${err.message}`);
        if (detail) log.info(`     Detail: ${JSON.stringify(detail)}`);
        return { success: false, error: err.message, position };
    }
}

// ── Sell Order Orchestrator ─────────────────────────────────────────────

/**
 * Execute sell orders for out-of-range positions during rebalance.
 * Called by the monitor when forecast shifts beyond the rebalance threshold.
 *
 * @param {Array<Object>} positions - positions to sell
 * @param {Object} sessionContext - { sessionId, targetDate, marketId }
 * @returns {Promise<Object>} - sellOrder result
 */
export async function executeSellOrder(positions, sessionContext = {}) {
    const tradingCfg = getConfig();

    if (tradingCfg.mode === 'disabled') {
        log.info('  ⚠️  Trading disabled — skipping sell');
        return null;
    }

    log.info(`\n  📉 Rebalance Sell — ${tradingCfg.mode.toUpperCase()} mode`);
    log.info(`  Selling ${positions.length} out-of-range position(s):`);
    for (const p of positions) {
        log.info(`    • ${p.label}: "${p.question}"`);
    }

    // Execute sell orders concurrently — each position targets a different conditionId,
    // so there's no self-trade risk from parallel execution (same pattern as buy.js).
    const orderPromises = positions.map((position) =>
        placeSellOrder(position, tradingCfg)
            .then((result) => ({ ...position, ...result }))
            .catch((err) => ({ ...position, success: false, error: err.message })),
    );
    const results = await Promise.all(orderPromises);

    const successCount = results.filter((r) => r.success).length;
    const totalProceeds = results.filter((r) => r.success).reduce((sum, r) => sum + (r.proceeds || 0), 0);

    const verifiedCount = results.filter((r) => r.verified).length;
    const unverifiedSuccesses = results.filter((r) => r.success && !r.verified);

    const sellOrder = {
        executedAt: new Date().toISOString(),
        mode: tradingCfg.mode,
        positions: results.map((r) => ({
            label: r.label,
            question: r.question,
            clobTokenId: r.clobTokenId || r.tokenId,
            sellPrice: r.verified ? r.price : 0,
            shares: r.verified ? r.size : r.shares || 0,
            orderId: r.orderId || null,
            status: r.success ? (r.dryRun ? 'dry-run' : r.verified ? 'filled' : 'pending_verification') : 'failed',
            error: r.error || null,
            verified: r.verified || false,
            buyPositionId: r.buyPositionId || null,
        })),
        totalProceeds: parseFloat(totalProceeds.toFixed(4)),
    };

    log.info(`\n  📋 Sell Summary: ${successCount}/${positions.length} succeeded, ${verifiedCount} verified`);
    log.info(`  💰 Total proceeds: $${sellOrder.totalProceeds.toFixed(4)}`);

    // Persist to Database (via data-svc)
    try {
        const tradeStatus = verifiedCount > 0 ? 'filled' : successCount > 0 ? 'pending_verification' : 'failed';

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
            positions: sellOrder.positions.map((p) => ({
                label: p.label,
                question: p.question,
                price: p.sellPrice,
                shares: p.shares,
                orderId: p.orderId,
                status: p.status,
                error: p.error,
            })),
        });
        sellOrder.dbTradeId = dbTradeId;
        log.info(`  📦 DB: sell trade #${dbTradeId} saved (status: ${tradeStatus})`);

        // Mark buy positions as sold (only if fill is verified)
        for (const pos of sellOrder.positions) {
            if (pos.verified && pos.buyPositionId) {
                try {
                    await dataSvc('PATCH', `/api/positions/${pos.buyPositionId}/sold`, {
                        sellPrice: pos.sellPrice,
                        soldAt: sellOrder.executedAt,
                        sellOrderId: pos.orderId,
                    });
                    log.info(`  🏷️  Buy position #${pos.buyPositionId} marked SOLD at $${pos.sellPrice.toFixed(4)}`);
                } catch (err) {
                    log.warn(`  ⚠️  Could not mark buy position #${pos.buyPositionId} as sold: ${err.message}`);
                }
            }
        }
    } catch (dbErr) {
        log.warn(`  ⚠️  DB write failed (non-fatal): ${dbErr.message}`);
    }

    // Deferred verification for unverified fills
    if (unverifiedSuccesses.length > 0) {
        log.info(`  🔄 ${unverifiedSuccesses.length} sell(s) pending verification — starting background check`);
        deferredVerifySells(unverifiedSuccesses, sellOrder, sessionContext);
    }

    return sellOrder;
}

// ── Deferred Sell Verification ──────────────────────────────────────────

/**
 * Background re-verification for sell orders that weren't confirmed on initial check.
 * Retries every 30s for up to 5 minutes. Once verified, updates the DB with the
 * real on-chain fill price.
 */
async function deferredVerifySells(unverifiedResults, sellOrder, sessionContext) {
    const maxAttempts = 10;
    const delayMs = 30000;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        await new Promise((r) => setTimeout(r, delayMs));

        let allDone = true;
        for (const r of unverifiedResults) {
            if (r._deferredVerified) continue;

            try {
                const fill = await verifyOrderFill(r.orderId, 'SELL', 0, r.shares || 0, r.label, {
                    maxRetries: 1,
                    initialDelayMs: 0,
                    retryDelayMs: 0,
                });

                if (fill.verified) {
                    r._deferredVerified = true;
                    log.info(
                        `  🔔 DEFERRED VERIFIED: ${r.label} SELL at $${fill.fillPrice.toFixed(4)} × ${fill.fillSize} = $${fill.fillCost.toFixed(4)} (attempt ${attempt})`,
                    );

                    // Update sell trade position in DB
                    if (sellOrder.dbTradeId) {
                        try {
                            await dataSvc('PATCH', `/api/trades/${sellOrder.dbTradeId}`, {
                                totalProceeds: fill.fillCost,
                                status: 'filled',
                                verifiedAt: new Date().toISOString(),
                                actualCost: fill.fillCost,
                            });
                        } catch (err) {
                            log.warn(`  ⚠️  Deferred DB trade update failed: ${err.message}`);
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
                            log.info(`  🏷️  Deferred: Buy position #${r.buyPositionId} marked SOLD at $${fill.fillPrice.toFixed(4)}`);
                        } catch (err) {
                            log.warn(`  ⚠️  Deferred position-sold update failed: ${err.message}`);
                        }
                    }

                    // Update session file via data-svc
                    const targetDate = sessionContext.targetDate || sellOrder._targetDate;
                    if (targetDate) {
                        try {
                            const session = await dataSvc('GET', `/api/session-files/${targetDate}`);
                            if (session?.buyOrder?.positions) {
                                const pos = session.buyOrder.positions.find((p) => p.question === r.question);
                                if (pos) {
                                    pos.soldAt = sellOrder.executedAt;
                                    pos.soldStatus = 'placed';
                                    pos.sellPrice = fill.fillPrice;
                                    pos.sellShares = fill.fillSize;
                                    pos.sellProceeds = fill.fillCost;
                                    await dataSvc('PUT', `/api/session-files/${targetDate}`, session);
                                    log.info(`  📄 Session file updated with verified sell price`);
                                }
                            }
                        } catch (err) {
                            log.warn(`  ⚠️  Deferred session update failed: ${err.message}`);
                        }
                    }
                } else {
                    allDone = false;
                }
            } catch (err) {
                allDone = false;
                log.info(`  ℹ️  Deferred verification attempt ${attempt} for ${r.label}: ${err.message}`);
            }
        }

        if (allDone) {
            log.info(`  ✅ All deferred sell verifications complete`);
            return;
        }
    }

    // After all attempts, log remaining unverified
    const stillUnverified = unverifiedResults.filter((r) => !r._deferredVerified);
    if (stillUnverified.length > 0) {
        log.warn(`  ❌ ${stillUnverified.length} sell(s) could NOT be verified after ${maxAttempts} attempts:`);
        for (const r of stillUnverified) {
            log.warn(`     • ${r.label}: order ${r.orderId} — CHECK POLYMARKET ACTIVITY MANUALLY`);
        }
    }
}
