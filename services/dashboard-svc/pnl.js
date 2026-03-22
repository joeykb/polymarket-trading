/**
 * TempEdge Dashboard — P&L Computation & Price Overlay (Microservice Edition)
 *
 * overlayLivePrices and computeLivePnL are pure functions (no I/O).
 * enrichBuyOrderWithDbIds now calls data-svc instead of querying DB directly.
 */

import { services } from '../../shared/services.js';

const DATA_SVC = services.dataSvc;

/**
 * Overlay live CLOB prices onto a snapshot's range objects.
 * Mutates snapshot in-place.
 */
export function overlayLivePrices(snapshot, liveData) {
    if (!snapshot || !liveData.live) return snapshot;

    for (const key of ['target', 'below', 'above']) {
        const range = snapshot[key];
        if (!range?.question) continue;
        const liveAsk = liveData.asks[range.question];
        const liveBid = liveData.bids[range.question];
        if (liveAsk > 0) { range.yesPrice = liveAsk; range._live = true; }
        if (liveBid > 0) { range.bestBid = liveBid; }
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
 * Calls data-svc to look up trades/positions.
 */
export async function enrichBuyOrderWithDbIds(buyOrder, targetDate) {
    if (!buyOrder || !buyOrder.positions) return buyOrder || null;
    try {
        const res = await fetch(`${DATA_SVC}/api/trades?date=${targetDate}`, { signal: AbortSignal.timeout(5000) });
        if (!res.ok) return buyOrder;
        const trades = await res.json();
        // Find the most recent buy trade
        const buyTrades = (Array.isArray(trades) ? trades : []).filter(t => t.type === 'buy');
        if (buyTrades.length === 0) return buyOrder;
        const trade = buyTrades[buyTrades.length - 1];

        // Get positions for that trade
        const posRes = await fetch(`${DATA_SVC}/api/positions/active?date=${targetDate}`, { signal: AbortSignal.timeout(5000) });
        if (!posRes.ok) return buyOrder;
        const positions = await posRes.json();

        const posMap = {};
        for (const p of (Array.isArray(positions) ? positions : [])) {
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
 * Uses live CLOB bids for accurate sell pricing.
 */
export function computeLivePnL(buyOrder, latestSnapshot, liquidityBids) {
    if (!buyOrder || !buyOrder.positions || !latestSnapshot) return null;

    const currentRanges = { target: latestSnapshot.target, below: latestSnapshot.below, above: latestSnapshot.above };
    const bids = liquidityBids || {};
    let totalBuyCost = 0, totalCurrentValue = 0;
    const positions = [];

    for (const pos of buyOrder.positions) {
        const shares = pos.shares || 1;
        const buyCost = pos.buyPrice * shares;
        let currentPrice, sold = false, sellPrice = 0;

        if (pos.soldAt && pos.soldStatus === 'placed') {
            sold = true;
            sellPrice = typeof pos.soldAt === 'number' ? pos.soldAt : parseFloat(pos.soldAt) || 0;
            currentPrice = sellPrice;
        } else {
            const currentRange = currentRanges[pos.label];
            const clobBid = bids[pos.question];
            currentPrice = clobBid > 0 ? clobBid : (currentRange?.yesPrice ?? pos.buyPrice);
        }

        const currentValue = currentPrice * shares;
        const pnl = parseFloat((currentValue - buyCost).toFixed(4));
        const pnlPct = buyCost > 0 ? parseFloat(((pnl / buyCost) * 100).toFixed(1)) : 0;
        totalBuyCost += buyCost;
        totalCurrentValue += currentValue;
        positions.push({ label: pos.label, question: pos.question, buyPrice: pos.buyPrice, currentPrice, shares, pnl, pnlPct, sold, sellPrice: sold ? sellPrice : null });
    }

    const totalPnL = parseFloat((totalCurrentValue - totalBuyCost).toFixed(4));
    const totalPnLPct = totalBuyCost > 0 ? parseFloat(((totalPnL / totalBuyCost) * 100).toFixed(1)) : 0;
    return { positions, totalBuyCost: parseFloat(totalBuyCost.toFixed(4)), totalCurrentValue: parseFloat(totalCurrentValue.toFixed(4)), totalPnL, totalPnLPct };
}
