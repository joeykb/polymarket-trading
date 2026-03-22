/**
 * TempEdge Dashboard — P&L Computation & Price Overlay
 *
 * Extracted from the monolithic dashboard.js.
 * Contains overlayLivePrices, enrichBuyOrderWithDbIds, computeLivePnL.
 */

import { getDb } from '../db/index.js';

/**
 * Overlay live CLOB prices onto a snapshot's range objects.
 * Uses bestAsk as the displayed price (= what you'd pay to buy YES).
 * Mutates snapshot in-place for efficiency.
 *
 * @param {Object|null} snapshot
 * @param {{bids: Object, asks: Object, live: boolean}} liveData
 * @returns {Object|null}
 */
export function overlayLivePrices(snapshot, liveData) {
    if (!snapshot || !liveData.live) return snapshot;

    for (const key of ['target', 'below', 'above']) {
        const range = snapshot[key];
        if (!range?.question) continue;

        const liveAsk = liveData.asks[range.question];
        const liveBid = liveData.bids[range.question];

        if (liveAsk > 0) {
            range.yesPrice = liveAsk;
            range._live = true;
        }
        if (liveBid > 0) {
            range.bestBid = liveBid;
        }
    }

    const t = snapshot.target?.yesPrice || 0;
    const b = snapshot.below?.yesPrice || 0;
    const a = snapshot.above?.yesPrice || 0;
    snapshot.totalCost = parseFloat((t + b + a).toFixed(4));
    snapshot._liveOverlay = true;

    return snapshot;
}

/**
 * Enrich buyOrder positions with database position IDs.
 * The session JSON doesn't store DB IDs, so we look them up by trade/question.
 */
export function enrichBuyOrderWithDbIds(buyOrder, targetDate) {
    if (!buyOrder || !buyOrder.positions) return buyOrder || null;
    try {
        const db = getDb();
        const trade = db.prepare(`SELECT id FROM trades WHERE target_date = ? AND type = 'buy' ORDER BY id DESC LIMIT 1`).get(targetDate);
        if (!trade) return buyOrder;

        const dbPositions = db.prepare(`SELECT id, question, status, sold_at FROM positions WHERE trade_id = ?`).all(trade.id);
        const posMap = {};
        for (const p of dbPositions) {
            posMap[p.question] = p;
        }

        buyOrder.positions = buyOrder.positions.map(p => {
            const dbPos = posMap[p.question];
            return {
                ...p,
                positionId: dbPos?.id || null,
                soldAt: dbPos?.sold_at || p.soldAt || null,
            };
        });
    } catch (err) {
        console.warn(`  ⚠️  enrichBuyOrderWithDbIds: ${err.message}`);
    }
    return buyOrder;
}

/**
 * Compute P&L from buyOrder vs latest snapshot.
 * Uses live CLOB bids from the liquidity microservice for accurate sell pricing.
 *
 * @param {Object} buyOrder
 * @param {Object} latestSnapshot
 * @param {Object} liquidityBids - { questionText: bestBid } from CLOB
 */
export function computeLivePnL(buyOrder, latestSnapshot, liquidityBids) {
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
            sold = true;
            sellPrice = typeof pos.soldAt === 'number' ? pos.soldAt : parseFloat(pos.soldAt) || 0;
            currentPrice = sellPrice;
        } else {
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
