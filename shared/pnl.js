/**
 * Shared P&L computation for TempEdge.
 *
 * Consolidates P&L logic previously duplicated in:
 *   - services/monitor/orchestrator.js (computePnL)
 *   - services/dashboard-svc/pnl.js (computeLivePnL)
 *
 * Both callers use the same core algorithm:
 *   For each position: currentValue = currentPrice × shares, pnl = currentValue - buyCost
 *   Totals: sum across all positions
 *
 * Price resolution (how to determine "currentPrice") is handled by each caller
 * before invoking this function — the dashboard adds sold-position detection
 * as a wrapper around this core.
 */

/**
 * Compute P&L for a set of buy positions against current market prices.
 *
 * @param {Object} buyOrder - The buy order with positions array
 * @param {Object} snapshot - Latest snapshot with target/below/above ranges
 * @param {Object} [liquidityBids={}] - Map of question → best bid price from CLOB
 * @returns {Object|null} P&L summary
 */
export function computePnL(buyOrder, snapshot, liquidityBids) {
    if (!buyOrder || !buyOrder.positions) return null;
    if (!snapshot) return null;

    const currentRanges = {
        target: snapshot.target,
        below: snapshot.below,
        above: snapshot.above,
    };
    const bids = liquidityBids || {};
    let totalBuyCost = 0,
        totalCurrentValue = 0;
    const positions = [];

    for (const pos of buyOrder.positions) {
        const shares = pos.shares || 1;
        const buyCost = pos.buyPrice * shares;

        // Price resolution: CLOB bid > snapshot yesPrice > original buyPrice
        let currentPrice,
            sold = false,
            sellPrice = null;

        if (pos.soldAt && pos.soldStatus === 'placed') {
            // Position was sold — use sell price as current value
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
        positions.push({
            label: pos.label,
            question: pos.question,
            buyPrice: pos.buyPrice,
            currentPrice,
            shares,
            pnl,
            pnlPct,
            sold,
            sellPrice,
        });
    }

    const totalPnL = parseFloat((totalCurrentValue - totalBuyCost).toFixed(4));
    const totalPnLPct = totalBuyCost > 0 ? parseFloat(((totalPnL / totalBuyCost) * 100).toFixed(1)) : 0;

    return {
        positions,
        totalBuyCost: parseFloat(totalBuyCost.toFixed(4)),
        totalCurrentValue: parseFloat(totalCurrentValue.toFixed(4)),
        totalPnL,
        totalPnLPct,
    };
}
