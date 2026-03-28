/**
 * Trading Service — Order Fill Verification
 *
 * Polls the CLOB API after order placement to confirm actual fill
 * prices and sizes. Critical for accurate P&L and DB records.
 *
 * Extracted from the monolithic trading.js.
 */

import { getClient, clobCall } from './client.js';
import { createLogger } from '../../shared/logger.js';


const log = createLogger('trading-svc');
// ── Single Order Verification ───────────────────────────────────────────

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
 * @param {Object} [opts] - { maxRetries, initialDelayMs, retryDelayMs }
 * @returns {Promise<{fillPrice: number, fillSize: number, fillCost: number, verified: boolean}>}
 */
export async function verifyOrderFill(orderId, side, intendedPrice, intendedSize, label, opts = {}) {
    const maxRetries = opts.maxRetries || (side === 'SELL' ? 6 : 3);
    const initialDelay = opts.initialDelayMs ?? (side === 'SELL' ? 5000 : 3000);
    const retryDelay = opts.retryDelayMs ?? (side === 'SELL' ? 10000 : 5000);

    const result = {
        fillPrice: 0,
        fillSize: 0,
        fillCost: 0,
        verified: false,
        orderStatus: null,
    };

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            await new Promise((r) => setTimeout(r, attempt === 1 ? initialDelay : retryDelay));
            const client = await getClient();
            const orderInfo = await clobCall(() => client.getOrder(orderId));
            if (!orderInfo) continue;

            result.orderStatus = orderInfo.status || null;

            // Method 1: average_price field (most reliable)
            if (orderInfo.average_price && parseFloat(orderInfo.average_price) > 0) {
                result.fillPrice = parseFloat(orderInfo.average_price);
                const matched = parseFloat(orderInfo.size_matched || intendedSize);
                result.fillSize = matched > 0 ? matched : intendedSize;
                result.fillCost = parseFloat((result.fillPrice * result.fillSize).toFixed(4));
                result.verified = true;
                log.info(
                    `  ✅ ${label} ${side} VERIFIED (avg_price): $${result.fillPrice.toFixed(4)} × ${result.fillSize} = $${result.fillCost.toFixed(4)}`,
                );
                if (Math.abs(result.fillPrice - intendedPrice) > 0.005) {
                    log.info(
                        `     ⚠️  Fill differs from intended: $${intendedPrice.toFixed(4)} → $${result.fillPrice.toFixed(4)} (Δ$${(result.fillPrice - intendedPrice).toFixed(4)})`,
                    );
                }
                break;
            }

            // Method 2: Calculate from associate_trades
            if (orderInfo.associate_trades?.length > 0) {
                const totalFillValue = orderInfo.associate_trades.reduce(
                    (acc, t) => acc + parseFloat(t.price || 0) * parseFloat(t.size || 0),
                    0,
                );
                const totalFillSize = orderInfo.associate_trades.reduce((acc, t) => acc + parseFloat(t.size || 0), 0);
                if (totalFillSize > 0) {
                    result.fillPrice = totalFillValue / totalFillSize;
                    result.fillSize = totalFillSize;
                    result.fillCost = parseFloat(totalFillValue.toFixed(4));
                    result.verified = true;
                    log.info(
                        `  ✅ ${label} ${side} VERIFIED (trades): $${result.fillPrice.toFixed(4)} × ${result.fillSize} = $${result.fillCost.toFixed(4)}`,
                    );
                    if (Math.abs(result.fillPrice - intendedPrice) > 0.005) {
                        log.info(
                            `     ⚠️  Fill differs from intended: $${intendedPrice.toFixed(4)} → $${result.fillPrice.toFixed(4)} (Δ$${(result.fillPrice - intendedPrice).toFixed(4)})`,
                        );
                    }
                    break;
                }
            }

            // Method 3: Check if partially matched but no trade details yet
            const matched = parseFloat(orderInfo.size_matched || 0);
            if (matched > 0 && attempt < maxRetries) {
                log.info(`  ⏳ ${label}: ${matched} shares matched but no trade details yet (attempt ${attempt}/${maxRetries})`);
                continue;
            }

            // If order is still LIVE (on the book), keep waiting
            if (orderInfo.status === 'LIVE' && attempt < maxRetries) {
                log.info(`  ⏳ ${label}: order still LIVE on book (attempt ${attempt}/${maxRetries})`);
                continue;
            }
        } catch (err) {
            log.info(`  ℹ️  ${label} fill verification attempt ${attempt} failed: ${err.message}`);
        }
    }

    if (!result.verified) {
        log.info(`  ⚠️  ${label}: Could not verify fill — will NOT record unverified price`);
        log.info(`     Order ${orderId} — status: ${result.orderStatus || 'unknown'}`);
        log.info(`     ❗ Price will be verified asynchronously before DB write`);
    }

    return result;
}

// ── Batch Order Verification ────────────────────────────────────────────

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
export async function verifyOrderFills(buyOrder) {
    const POLL_DELAY_MS = 3000;
    const POLL_INTERVAL_MS = 2000;
    const MAX_POLLS = 5;

    log.info(`\n  🔍 Verifying order fills (waiting ${POLL_DELAY_MS / 1000}s for settlement)...`);
    await new Promise((r) => setTimeout(r, POLL_DELAY_MS));

    let client;
    try {
        client = await getClient();
    } catch (err) {
        log.warn(`  ⚠️  Cannot verify fills — client init failed: ${err.message}`);
        return;
    }

    const placedPositions = buyOrder.positions.filter((p) => p.orderId && p.status === 'placed');
    if (placedPositions.length === 0) return;

    let allSettled = false;

    for (let attempt = 1; attempt <= MAX_POLLS && !allSettled; attempt++) {
        if (attempt > 1) await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

        allSettled = true;
        for (const pos of placedPositions) {
            if (pos.fillStatus && pos.fillStatus !== 'pending') continue;

            try {
                const order = await clobCall(() => client.getOrder(pos.orderId));
                const sizeMatched = parseFloat(order.size_matched) || 0;
                const originalSize = parseFloat(order.original_size) || pos.shares;

                if (order.status === 'MATCHED') {
                    pos.fillStatus = sizeMatched >= originalSize ? 'filled' : 'partial';
                    pos.sharesMatched = sizeMatched;
                    pos.originalSize = originalSize;
                    pos.fillPct = parseFloat(((sizeMatched / originalSize) * 100).toFixed(1));
                    pos.status = 'filled';
                    log.info(`  ✅ ${pos.label}: FILLED ${sizeMatched}/${originalSize} shares (${pos.fillPct}%)`);
                } else if (order.status === 'CANCELLED') {
                    pos.fillStatus = 'cancelled';
                    pos.sharesMatched = sizeMatched;
                    pos.originalSize = originalSize;
                    pos.fillPct = parseFloat(((sizeMatched / originalSize) * 100).toFixed(1));
                    pos.status = sizeMatched > 0 ? 'partial' : 'cancelled';
                    log.info(`  ❌ ${pos.label}: CANCELLED — matched ${sizeMatched}/${originalSize} shares before cancel`);
                } else if (order.status === 'LIVE') {
                    pos.fillStatus = 'pending';
                    allSettled = false;
                    if (attempt === MAX_POLLS) {
                        pos.fillStatus = 'unfilled';
                        pos.sharesMatched = sizeMatched;
                        pos.originalSize = originalSize;
                        pos.fillPct = parseFloat(((sizeMatched / originalSize) * 100).toFixed(1));
                        pos.status = sizeMatched > 0 ? 'partial' : 'unfilled';
                        log.info(`  ⏳ ${pos.label}: STILL OPEN in book — ${sizeMatched}/${originalSize} matched so far`);
                    }
                } else {
                    log.info(`  ❓ ${pos.label}: Unknown order status "${order.status}"`);
                    allSettled = false;
                }
            } catch (err) {
                log.warn(`  ⚠️  ${pos.label}: Verification error — ${err.message}`);
                allSettled = false;
            }
        }

        if (!allSettled && attempt < MAX_POLLS) {
            log.info(`  🔄 Poll ${attempt}/${MAX_POLLS}: some orders still settling...`);
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
            actualTotalCost += pos.buyPrice * pos.shares;
        }
    }

    buyOrder.verifiedAt = new Date().toISOString();
    buyOrder.actualTotalCost = parseFloat(actualTotalCost.toFixed(4));
    buyOrder.fillSummary = { filled: filledCount, partial: partialCount, unfilled: unfilledCount };

    log.info(`\n  📋 Fill Verification Complete:`);
    log.info(`     Filled: ${filledCount} | Partial: ${partialCount} | Unfilled: ${unfilledCount}`);
    log.info(`     Actual cost: $${buyOrder.actualTotalCost.toFixed(4)} (estimated: $${buyOrder.totalCost.toFixed(4)})`);

    if (filledCount === 0 && partialCount === 0) {
        log.info(`  ❌ NO FILLS — all orders unfilled or cancelled. Clearing buy order.`);
        buyOrder.allUnfilled = true;
    }
}
