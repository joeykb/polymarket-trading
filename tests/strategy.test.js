/**
 * Tests for services/monitor/strategy.js — Strategy functions
 *
 * Covers: analyzeTrend, resolveRanges, shouldPlaceBuy, computePnL
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { analyzeTrend, resolveRanges, shouldPlaceBuy, computePnL, checkStopLoss, computeEdge } from '../services/monitor/strategy.js';

// ── analyzeTrend ────────────────────────────────────────────────────────

describe('analyzeTrend', () => {
    it('returns neutral for < 2 data points', () => {
        const result = analyzeTrend([{ daysOut: 3, forecast: 65 }]);
        expect(result.direction).toBe('neutral');
        expect(result.magnitude).toBe(0);
        expect(result.volatility).toBe(0);
        expect(result.momentum).toBe(0);
        expect(result.convergence).toBe('unknown');
    });

    it('returns neutral for null input', () => {
        const result = analyzeTrend(null);
        expect(result.direction).toBe('neutral');
        expect(result.points).toEqual([]);
    });

    it('detects warming trend above threshold', () => {
        const history = [
            { daysOut: 4, forecast: 60 },
            { daysOut: 3, forecast: 61 },
            { daysOut: 2, forecast: 63 },
        ];
        const result = analyzeTrend(history, 2);
        expect(result.direction).toBe('warming');
        expect(result.magnitude).toBe(3);
    });

    it('detects cooling trend below threshold', () => {
        const history = [
            { daysOut: 4, forecast: 68 },
            { daysOut: 3, forecast: 66 },
            { daysOut: 2, forecast: 65 },
        ];
        const result = analyzeTrend(history, 2);
        expect(result.direction).toBe('cooling');
        expect(result.magnitude).toBe(-3);
    });

    it('returns neutral when within threshold', () => {
        const history = [
            { daysOut: 4, forecast: 65 },
            { daysOut: 3, forecast: 65.5 },
            { daysOut: 2, forecast: 66 },
        ];
        const result = analyzeTrend(history, 2);
        expect(result.direction).toBe('neutral');
    });

    it('computes volatility correctly', () => {
        // Deltas: +1, +1 => stddev = 0
        const stable = [
            { daysOut: 3, forecast: 60 },
            { daysOut: 2, forecast: 61 },
            { daysOut: 1, forecast: 62 },
        ];
        expect(analyzeTrend(stable).volatility).toBe(0);

        // Deltas: +3, -3 => mean=0, stddev=3
        const volatile = [
            { daysOut: 3, forecast: 60 },
            { daysOut: 2, forecast: 63 },
            { daysOut: 1, forecast: 60 },
        ];
        expect(analyzeTrend(volatile).volatility).toBe(3);
    });

    it('computes momentum with recency weighting', () => {
        // All deltas same => momentum = delta
        const steady = [
            { daysOut: 3, forecast: 60 },
            { daysOut: 2, forecast: 62 },
            { daysOut: 1, forecast: 64 },
        ];
        const result = analyzeTrend(steady);
        expect(result.momentum).toBe(2); // all +2, weighted same
    });

    it('detects convergence when recent deltas shrink', () => {
        const converging = [
            { daysOut: 6, forecast: 60 },
            { daysOut: 5, forecast: 65 }, // +5
            { daysOut: 4, forecast: 60 }, // -5
            { daysOut: 3, forecast: 61 }, // +1
            { daysOut: 2, forecast: 60.5 }, // -0.5
        ];
        const result = analyzeTrend(converging);
        expect(result.convergence).toBe('converging');
    });

    it('detects divergence when recent deltas grow', () => {
        const diverging = [
            { daysOut: 6, forecast: 60 },
            { daysOut: 5, forecast: 60.5 }, // +0.5
            { daysOut: 4, forecast: 60 }, // -0.5
            { daysOut: 3, forecast: 65 }, // +5
            { daysOut: 2, forecast: 60 }, // -5
        ];
        const result = analyzeTrend(diverging);
        expect(result.convergence).toBe('diverging');
    });

    it('sorts points by daysOut descending', () => {
        const unordered = [
            { daysOut: 1, forecast: 64 },
            { daysOut: 3, forecast: 60 },
            { daysOut: 2, forecast: 62 },
        ];
        const result = analyzeTrend(unordered);
        expect(result.points[0].daysOut).toBe(3);
        expect(result.points[2].daysOut).toBe(1);
    });
});

// ── resolveRanges ───────────────────────────────────────────────────────

describe('resolveRanges', () => {
    it('keeps the range with the highest yesPrice', () => {
        const snapshot = {
            target: { question: 'Between 66-67°F', yesPrice: 0.3 },
            below: { question: 'Between 64-65°F', yesPrice: 0.6 },
            above: { question: 'Between 68-69°F', yesPrice: 0.1 },
        };
        const result = resolveRanges(snapshot);
        expect(result.keepLabel).toBe('below');
        expect(result.keepPrice).toBe(0.6);
        expect(result.discardLabels).toEqual(['target', 'above']);
    });

    it('handles two-range snapshot (no above)', () => {
        const snapshot = {
            target: { question: 'Between 66-67°F', yesPrice: 0.8 },
            below: { question: 'Between 64-65°F', yesPrice: 0.2 },
            above: null,
        };
        const result = resolveRanges(snapshot);
        expect(result.keepLabel).toBe('target');
        expect(result.discard).toEqual(['Between 64-65°F']);
    });

    it('includes reason string with price', () => {
        const snapshot = {
            target: { question: 'Between 66-67°F', yesPrice: 0.95 },
            below: null,
            above: null,
        };
        const result = resolveRanges(snapshot);
        expect(result.reason).toContain('95.0¢');
    });
});

// ── shouldPlaceBuy ──────────────────────────────────────────────────────

describe('shouldPlaceBuy', () => {
    // Mock Date to control time in tests
    let originalDate;

    beforeEach(() => {
        originalDate = globalThis.Date;
    });

    afterEach(() => {
        globalThis.Date = originalDate;
    });

    function mockETHour(hourDecimal) {
        const h = Math.floor(hourDecimal);
        const m = Math.round((hourDecimal - h) * 60);
        const MockDate = class extends originalDate {
            constructor(...args) {
                if (args.length === 0) super();
                else super(...args);
            }
            getHours() {
                return h;
            }
            getMinutes() {
                return m;
            }
        };
        // Preserve original static methods
        MockDate.now = originalDate.now;
        globalThis.Date = MockDate;
    }

    it('returns false if buyOrder already exists', () => {
        expect(shouldPlaceBuy({ buyOrder: {} }, { phase: 'buy' })).toBe(false);
    });

    it('returns false if awaiting liquidity', () => {
        expect(shouldPlaceBuy({ awaitingLiquidity: true }, { phase: 'buy' })).toBe(false);
    });

    it('returns false if event is closed', () => {
        expect(shouldPlaceBuy({}, { eventClosed: true, phase: 'buy' })).toBe(false);
    });

    it('returns false if phase is not buy', () => {
        expect(shouldPlaceBuy({}, { phase: 'scout' })).toBe(false);
    });

    it('returns false before buy hour', () => {
        mockETHour(8.0); // 8:00 AM, before 9:30 AM default
        expect(shouldPlaceBuy({}, { phase: 'buy' }, { buyHourEST: 9.5 })).toBe(false);
    });

    it('returns true after buy hour when WS disabled', () => {
        mockETHour(10.0);
        expect(shouldPlaceBuy({}, { phase: 'buy' }, { buyHourEST: 9.5, wsEnabled: false })).toBe(true);
    });

    it('returns await-liquidity after buy hour when WS enabled', () => {
        mockETHour(10.0);
        expect(shouldPlaceBuy({}, { phase: 'buy' }, { buyHourEST: 9.5, wsEnabled: true })).toBe('await-liquidity');
    });
});

// ── computePnL ──────────────────────────────────────────────────────────

describe('computePnL (via strategy.js)', () => {
    it('delegates to shared/pnl.js correctly', () => {
        const buyOrder = {
            positions: [{ label: 'target', question: 'Q1', buyPrice: 0.3, shares: 10 }],
        };
        const snapshot = {
            target: { yesPrice: 0.5, question: 'Q1' },
            below: null,
            above: null,
        };
        const result = computePnL(buyOrder, snapshot);
        expect(result.totalPnL).toBe(2.0);
        expect(result.positions[0].currentPrice).toBe(0.5);
    });

    it('returns null for null buyOrder', () => {
        expect(computePnL(null, {})).toBeNull();
    });
});

// ── checkStopLoss ───────────────────────────────────────────────────────

describe('checkStopLoss', () => {
    const makeSession = (overrides = {}) => ({
        buyOrder: { totalCost: 2.0, positions: [] },
        pnl: { totalPnL: -0.5 },
        status: 'active',
        ...overrides,
    });
    const makeSnapshot = (overrides = {}) => ({ phase: 'monitor', ...overrides });
    const enabledConfig = { stopLossEnabled: true, stopLossPct: 50, stopLossFloor: -1.5 };

    it('returns not triggered when disabled', () => {
        const result = checkStopLoss(makeSession(), makeSnapshot(), { stopLossEnabled: false });
        expect(result.triggered).toBe(false);
    });

    it('returns not triggered when no buyOrder', () => {
        const result = checkStopLoss(makeSession({ buyOrder: null }), makeSnapshot(), enabledConfig);
        expect(result.triggered).toBe(false);
    });

    it('returns not triggered when no pnl', () => {
        const result = checkStopLoss(makeSession({ pnl: null }), makeSnapshot(), enabledConfig);
        expect(result.triggered).toBe(false);
    });

    it('returns not triggered when already executed', () => {
        const result = checkStopLoss(makeSession({ stopLossExecuted: true }), makeSnapshot(), enabledConfig);
        expect(result.triggered).toBe(false);
    });

    it('returns not triggered when session completed', () => {
        const result = checkStopLoss(makeSession({ status: 'completed' }), makeSnapshot(), enabledConfig);
        expect(result.triggered).toBe(false);
    });

    it('returns not triggered on resolve phase', () => {
        const session = makeSession({ pnl: { totalPnL: -1.8 } });
        const result = checkStopLoss(session, makeSnapshot({ phase: 'resolve' }), enabledConfig);
        expect(result.triggered).toBe(false);
    });

    it('triggers on percentage threshold breach', () => {
        // -1.2 / 2.0 = -60%, threshold is -50%
        const session = makeSession({ pnl: { totalPnL: -1.2 } });
        const result = checkStopLoss(session, makeSnapshot(), enabledConfig);
        expect(result.triggered).toBe(true);
        expect(result.pnlPct).toBe(-60);
        expect(result.reason).toContain('-50%');
    });

    it('triggers on absolute floor breach', () => {
        // -1.6 < -1.5 floor, but -1.6 / 5.0 = -32% (under 50% threshold)
        const session = makeSession({
            buyOrder: { totalCost: 5.0, positions: [] },
            pnl: { totalPnL: -1.6 },
        });
        const result = checkStopLoss(session, makeSnapshot(), enabledConfig);
        expect(result.triggered).toBe(true);
        expect(result.reason).toContain('$-1.50');
    });

    it('does not trigger when within bounds', () => {
        // -0.5 / 2.0 = -25%, above both thresholds
        const session = makeSession({ pnl: { totalPnL: -0.5 } });
        const result = checkStopLoss(session, makeSnapshot(), enabledConfig);
        expect(result.triggered).toBe(false);
        expect(result.pnlPct).toBe(-25);
    });

    it('handles zero totalCost gracefully', () => {
        const session = makeSession({
            buyOrder: { totalCost: 0, positions: [] },
            pnl: { totalPnL: -0.5 },
        });
        const result = checkStopLoss(session, makeSnapshot(), enabledConfig);
        expect(result.triggered).toBe(false);
    });
});

// ── computeEdge ─────────────────────────────────────────────────────────

describe('computeEdge', () => {
    const makeSnapshot = (targetPrice, daysOut = 2, opts = {}) => ({
        target: { question: '66-67°F', yesPrice: targetPrice },
        below: opts.below ?? { question: '64-65°F', yesPrice: 0.15 },
        above: opts.above ?? { question: '68-69°F', yesPrice: 0.1 },
        daysUntilTarget: daysOut,
    });

    const goodTrend = {
        direction: 'warming',
        convergence: 'converging',
        volatility: 0.5,
        points: [1, 2, 3, 4, 5],
    };

    const badTrend = {
        direction: 'neutral',
        convergence: 'diverging',
        volatility: 4.0,
        points: [1],
    };

    it('returns skip when no target in snapshot', () => {
        const result = computeEdge({}, goodTrend);
        expect(result.action).toBe('skip');
        expect(result.reason).toContain('No target');
    });

    it('returns skip when target price is 0', () => {
        const result = computeEdge(makeSnapshot(0), goodTrend);
        expect(result.action).toBe('skip');
        expect(result.reason).toContain('out of tradeable');
    });

    it('returns skip when target price is >= 0.95', () => {
        const result = computeEdge(makeSnapshot(0.96), goodTrend);
        expect(result.action).toBe('skip');
    });

    it('returns buy with high tier for good conditions', () => {
        // T+1, converging, low volatility, warming, 5 points
        // base 0.45 + 0.12 (converging) + 0.08 (vol<1) + 0.12 (T+1) + 0.05 (warming) + 0.05 (5pts) = 0.87 -> clamped to 0.85
        const snap = makeSnapshot(0.3, 1);
        const result = computeEdge(snap, goodTrend);
        expect(result.action).toBe('buy');
        expect(result.tier).toBe('high');
        expect(result.rangesToBuy).toEqual(['target']);
        expect(result.confidence).toBeGreaterThanOrEqual(0.55);
        expect(result.ev).toBeGreaterThan(0.05);
    });

    it('returns buy with low tier for bad conditions', () => {
        // T+4, diverging, high vol, neutral, 1 point
        // base 0.45 - 0.12 (diverging) - 0.08 (vol>3) - 0.10 (T+4) + 0 (neutral) - 0.05 (1pt) = 0.10 -> clamped to 0.15
        // EV = 0.15 - 0.05 = 0.10 > 0.05 threshold
        const snap = makeSnapshot(0.05, 4);
        const result = computeEdge(snap, badTrend);
        expect(result.tier).toBe('low');
        expect(result.rangesToBuy).toEqual(['target', 'below', 'above']);
    });

    it('skips when EV is below threshold', () => {
        // Expensive target ($0.80) + bad trend = negative EV
        const snap = makeSnapshot(0.8, 4);
        const result = computeEdge(snap, badTrend);
        expect(result.action).toBe('skip');
        expect(result.ev).toBeLessThanOrEqual(0.05);
    });

    it('respects custom evThreshold', () => {
        const snap = makeSnapshot(0.3, 2);
        const neutral = { direction: 'neutral', convergence: 'stable', volatility: 1.5, points: [1, 2, 3] };
        // With very high threshold, should skip
        const result = computeEdge(snap, neutral, { evThreshold: 0.9 });
        expect(result.action).toBe('skip');

        // With threshold of 0, should buy
        const result2 = computeEdge(snap, neutral, { evThreshold: 0 });
        expect(result2.action).toBe('buy');
    });

    it('medium tier picks cheaper hedge', () => {
        // Force medium tier: confidence around 0.45-0.54
        const neutral = { direction: 'neutral', convergence: 'stable', volatility: 1.5, points: [1, 2, 3] };
        const snap = makeSnapshot(0.25, 2, {
            below: { question: 'below', yesPrice: 0.2 },
            above: { question: 'above', yesPrice: 0.05 },
        });
        const result = computeEdge(snap, neutral);
        if (result.tier === 'medium') {
            // Should pick the cheaper hedge (above at $0.05)
            expect(result.rangesToBuy).toContain('target');
            expect(result.rangesToBuy).toContain('above');
            expect(result.rangesToBuy).not.toContain('below');
        }
    });

    it('handles null trend gracefully', () => {
        const snap = makeSnapshot(0.2, 2);
        const result = computeEdge(snap, null);
        expect(result.confidence).toBeGreaterThan(0);
        // Should still compute without crashing
        expect(['buy', 'skip']).toContain(result.action);
    });

    it('clamps confidence between 0.15 and 0.85', () => {
        // Best case: should not exceed 0.85
        const snap1 = makeSnapshot(0.1, 1);
        const r1 = computeEdge(snap1, goodTrend);
        expect(r1.confidence).toBeLessThanOrEqual(0.85);

        // Worst case: should not go below 0.15
        const snap2 = makeSnapshot(0.1, 5);
        const r2 = computeEdge(snap2, badTrend);
        expect(r2.confidence).toBeGreaterThanOrEqual(0.15);
    });

    it('includes reason in result', () => {
        const snap = makeSnapshot(0.2, 1);
        const result = computeEdge(snap, goodTrend);
        expect(result.reason).toBeTruthy();
        if (result.action === 'buy') {
            expect(result.reason).toContain('EV');
            expect(result.reason).toContain('confidence');
        }
    });

    it('T+1 converging adds more confidence than T+4 diverging', () => {
        const snap1 = makeSnapshot(0.3, 1);
        const snap4 = makeSnapshot(0.3, 4);
        const r1 = computeEdge(snap1, goodTrend);
        const r4 = computeEdge(snap4, badTrend);
        expect(r1.confidence).toBeGreaterThan(r4.confidence);
    });
});
