/**
 * TempEdge Dashboard — P&L Computation & Price Overlay (Microservice Edition)
 *
 * overlayLivePrices is a pure function (no I/O).
 * computeLivePnL delegates to shared/pnl.js.
 * enrichBuyOrderWithDbIds calls data-svc.
 */

import { services } from '../../shared/services.js';
import { computePnL } from '../../shared/pnl.js';

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
 * Calls data-svc to look up trades/positions.
 */
export async function enrichBuyOrderWithDbIds(buyOrder, targetDate) {
    if (!buyOrder || !buyOrder.positions) return buyOrder || null;
    try {
        // Single call to get active positions (already joined with trades in data-svc)
        const posRes = await fetch(`${DATA_SVC}/api/positions/active?date=${targetDate}`, { signal: AbortSignal.timeout(3000) });
        if (!posRes.ok) return buyOrder;
        const positions = await posRes.json();

        const posMap = {};
        for (const p of Array.isArray(positions) ? positions : []) {
            posMap[p.question] = p;
        }

        buyOrder.positions = buyOrder.positions.map((p) => {
            const dbPos = posMap[p.question];
            return {
                ...p,
                positionId: dbPos?.id || p.positionId || null,
                soldAt: dbPos?.sold_at || p.soldAt || null,
            };
        });
    } catch {
        // Silent — DB enrichment is optional, sell works via question+date fallback
    }
    return buyOrder;
}

/**
 * Compute P&L from buyOrder vs latest snapshot.
 * Delegates to shared/pnl.js core computation.
 */
export function computeLivePnL(buyOrder, latestSnapshot, liquidityBids) {
    return computePnL(buyOrder, latestSnapshot, liquidityBids);
}
