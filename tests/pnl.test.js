/**
 * Tests for shared/pnl.js — P&L computation
 *
 * These are the most critical tests: incorrect P&L means incorrect
 * trading decisions and misleading dashboard data.
 */
import { describe, it, expect } from 'vitest';
import { computePnL } from '../shared/pnl.js';

// ── Test fixtures ─────────────────────────────────────────────────────

const makeBuyOrder = (positions) => ({ positions });

const makeSnapshot = (target = {}, below = {}, above = {}) => ({
    target: { yesPrice: 0.5, question: 'Between 66-67°F', ...target },
    below: { yesPrice: 0.3, question: 'Between 64-65°F', ...below },
    above: { yesPrice: 0.2, question: 'Between 68-69°F', ...above },
});

// ── Null/Edge Cases ──────────────────────────────────────────────────

describe('computePnL — null/edge cases', () => {
    it('returns null when buyOrder is null', () => {
        expect(computePnL(null, makeSnapshot())).toBeNull();
    });

    it('returns null when buyOrder has no positions', () => {
        expect(computePnL({}, makeSnapshot())).toBeNull();
    });

    it('returns null when snapshot is null', () => {
        expect(computePnL(makeBuyOrder([{ label: 'target', buyPrice: 0.5 }]), null)).toBeNull();
    });
});

// ── Basic P&L Calculations ──────────────────────────────────────────

describe('computePnL — basic calculations', () => {
    it('computes profit when price increases', () => {
        const buyOrder = makeBuyOrder([{ label: 'target', question: 'Between 66-67°F', buyPrice: 0.3, shares: 10 }]);
        const snapshot = makeSnapshot({ yesPrice: 0.5 });

        const result = computePnL(buyOrder, snapshot);

        expect(result.totalBuyCost).toBe(3.0);
        expect(result.totalCurrentValue).toBe(5.0);
        expect(result.totalPnL).toBe(2.0);
        expect(result.totalPnLPct).toBeGreaterThan(0);
        expect(result.positions).toHaveLength(1);
        expect(result.positions[0].pnl).toBe(2.0);
    });

    it('computes loss when price decreases', () => {
        const buyOrder = makeBuyOrder([{ label: 'target', question: 'Between 66-67°F', buyPrice: 0.5, shares: 10 }]);
        const snapshot = makeSnapshot({ yesPrice: 0.3 });

        const result = computePnL(buyOrder, snapshot);

        expect(result.totalPnL).toBe(-2.0);
        expect(result.totalPnLPct).toBeLessThan(0);
    });

    it('returns zero P&L when price is unchanged', () => {
        const buyOrder = makeBuyOrder([{ label: 'target', question: 'Between 66-67°F', buyPrice: 0.5, shares: 10 }]);
        const snapshot = makeSnapshot({ yesPrice: 0.5 });

        const result = computePnL(buyOrder, snapshot);

        expect(result.totalPnL).toBe(0);
        expect(result.totalPnLPct).toBe(0);
    });

    it('defaults shares to 1 when not specified', () => {
        const buyOrder = makeBuyOrder([{ label: 'target', question: 'Between 66-67°F', buyPrice: 0.3 }]);
        const snapshot = makeSnapshot({ yesPrice: 0.5 });

        const result = computePnL(buyOrder, snapshot);

        expect(result.totalBuyCost).toBe(0.3);
        expect(result.totalCurrentValue).toBe(0.5);
    });
});

// ── Multi-Position P&L ──────────────────────────────────────────────

describe('computePnL — multi-position', () => {
    it('sums P&L across target + hedges', () => {
        const buyOrder = makeBuyOrder([
            { label: 'target', question: 'Between 66-67°F', buyPrice: 0.3, shares: 5 },
            { label: 'below', question: 'Between 64-65°F', buyPrice: 0.2, shares: 5 },
            { label: 'above', question: 'Between 68-69°F', buyPrice: 0.1, shares: 5 },
        ]);
        const snapshot = makeSnapshot({ yesPrice: 0.4 }, { yesPrice: 0.15 }, { yesPrice: 0.05 });

        const result = computePnL(buyOrder, snapshot);

        // target: (0.40 - 0.30) * 5 = +0.50
        // below:  (0.15 - 0.20) * 5 = -0.25
        // above:  (0.05 - 0.10) * 5 = -0.25
        // total: 0.00
        expect(result.totalPnL).toBeCloseTo(0.0, 4);
        expect(result.positions).toHaveLength(3);
    });
});

// ── CLOB Bid Price Priority ─────────────────────────────────────────

describe('computePnL — CLOB bid priority', () => {
    it('prefers CLOB bid over snapshot yesPrice', () => {
        const buyOrder = makeBuyOrder([{ label: 'target', question: 'Between 66-67°F', buyPrice: 0.3, shares: 10 }]);
        const snapshot = makeSnapshot({ yesPrice: 0.4 });
        const liquidityBids = { 'Between 66-67°F': 0.55 };

        const result = computePnL(buyOrder, snapshot, liquidityBids);

        expect(result.positions[0].currentPrice).toBe(0.55);
        expect(result.totalCurrentValue).toBe(5.5);
    });

    it('falls back to snapshot when CLOB bid is 0', () => {
        const buyOrder = makeBuyOrder([{ label: 'target', question: 'Between 66-67°F', buyPrice: 0.3, shares: 10 }]);
        const snapshot = makeSnapshot({ yesPrice: 0.4 });
        const liquidityBids = { 'Between 66-67°F': 0 };

        const result = computePnL(buyOrder, snapshot, liquidityBids);

        expect(result.positions[0].currentPrice).toBe(0.4);
    });

    it('falls back to buyPrice when label has no matching range in snapshot', () => {
        const buyOrder = makeBuyOrder([{ label: 'hedge', question: 'Unknown Range', buyPrice: 0.3, shares: 10 }]);
        const snapshot = makeSnapshot({ yesPrice: 0.4 });

        const result = computePnL(buyOrder, snapshot);

        // label 'hedge' not in currentRanges (target/below/above) → undefined → fallback to buyPrice
        expect(result.positions[0].currentPrice).toBe(0.3);
    });
});

// ── Sold Positions ──────────────────────────────────────────────────

describe('computePnL — sold positions', () => {
    it('uses sell price for sold positions', () => {
        const buyOrder = makeBuyOrder([
            {
                label: 'target',
                question: 'Between 66-67°F',
                buyPrice: 0.3,
                shares: 10,
                soldAt: '0.45',
                soldStatus: 'placed',
            },
        ]);
        const snapshot = makeSnapshot({ yesPrice: 0.6 }); // should be ignored for sold

        const result = computePnL(buyOrder, snapshot);

        expect(result.positions[0].sold).toBe(true);
        expect(result.positions[0].currentPrice).toBe(0.45);
        expect(result.positions[0].sellPrice).toBe(0.45);
        // P&L: (0.45 - 0.30) * 10 = 1.50
        expect(result.totalPnL).toBe(1.5);
    });

    it('handles numeric soldAt value', () => {
        const buyOrder = makeBuyOrder([
            {
                label: 'target',
                question: 'Between 66-67°F',
                buyPrice: 0.5,
                shares: 5,
                soldAt: 0.4,
                soldStatus: 'placed',
            },
        ]);
        const snapshot = makeSnapshot();

        const result = computePnL(buyOrder, snapshot);

        expect(result.positions[0].sold).toBe(true);
        expect(result.positions[0].currentPrice).toBe(0.4);
        // Loss: (0.40 - 0.50) * 5 = -0.50
        expect(result.totalPnL).toBe(-0.5);
    });
});
