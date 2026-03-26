/**
 * Tests for services/monitor/strategy.js — Strategy functions
 *
 * Covers: analyzeTrend, resolveRanges, shouldPlaceBuy, computePnL
 */
import {
    analyzeTrend,
    resolveRanges,
    shouldPlaceBuy,
    computePnL,
    checkStopLoss,
    computeEdge,
    analyzeTrajectory,
} from '../services/monitor/strategy.js';

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
        expect(result.confidence).toBeGreaterThanOrEqual(0.50);
        expect(result.ev).toBeGreaterThan(0.05);
    });

    it('skips on low confidence instead of buying all 3 ranges', () => {
        // T+4, diverging, high vol, neutral, 1 point
        // base 0.45 - 0.12 (diverging) - 0.08 (vol>3) - 0.10 (T+4) + 0 (neutral) - 0.05 (1pt) = 0.10 -> clamped to 0.15
        // Confidence 15% < 40% minimum -> SKIP (no more "low tier" all-3-range trades)
        const snap = makeSnapshot(0.05, 4);
        const result = computeEdge(snap, badTrend);
        expect(result.action).toBe('skip');
        expect(result.tier).toBe('low');
        expect(result.reason).toContain('below 40%');
    });

    it('skips when target exceeds max entry price cap', () => {
        // $0.80 target exceeds $0.40 max entry cap (blocked before EV calculation)
        const snap = makeSnapshot(0.8, 4);
        const result = computeEdge(snap, badTrend);
        expect(result.action).toBe('skip');
        expect(result.reason).toContain('max entry cap');
    });

    it('respects custom evThreshold', () => {
        const snap = makeSnapshot(0.3, 2);
        const neutral = { direction: 'neutral', convergence: 'stable', volatility: 1.5, points: [1, 2, 3] };
        // With very high threshold, should skip
        const result = computeEdge(snap, neutral, { evThreshold: 0.9 });
        expect(result.action).toBe('skip');

        // With threshold of 0, should buy
        const result2 = computeEdge(snap, neutral, { evThreshold: 0, maxEntryPrice: 0.5 });
        expect(result2.action).toBe('buy');
    });

    it('medium tier only includes hedge if cheap enough', () => {
        // Force medium tier: confidence around 0.40-0.49
        const neutral = { direction: 'neutral', convergence: 'stable', volatility: 1.5, points: [1, 2, 3] };
        // above at $0.05 is <= $0.10 hedge cap, should be included
        const snap = makeSnapshot(0.25, 2, {
            below: { question: 'below', yesPrice: 0.2 },
            above: { question: 'above', yesPrice: 0.05 },
        });
        const result = computeEdge(snap, neutral);
        if (result.tier === 'medium') {
            expect(result.rangesToBuy).toContain('target');
            expect(result.rangesToBuy).toContain('above'); // $0.05 <= $0.10 cap
            expect(result.rangesToBuy).not.toContain('below'); // $0.20 > $0.10 cap
        }
    });

    it('medium tier skips hedge if too expensive', () => {
        // Both hedges above $0.10 cap -> target only even at medium tier
        const neutral = { direction: 'neutral', convergence: 'stable', volatility: 1.5, points: [1, 2, 3] };
        const snap = makeSnapshot(0.25, 2, {
            below: { question: 'below', yesPrice: 0.20 },
            above: { question: 'above', yesPrice: 0.15 },
        });
        const result = computeEdge(snap, neutral);
        if (result.tier === 'medium') {
            expect(result.rangesToBuy).toEqual(['target']);
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

        // Worst case: should not go below 0.15 (but low confidence now skips)
        const snap2 = makeSnapshot(0.1, 5);
        const r2 = computeEdge(snap2, badTrend);
        expect(r2.confidence).toBeGreaterThanOrEqual(0.15);
        expect(r2.action).toBe('skip'); // below 40% minimum
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

    it('skips when target exceeds custom maxEntryPrice', () => {
        const snap = makeSnapshot(0.35, 2);
        const result = computeEdge(snap, goodTrend, { maxEntryPrice: 0.30 });
        expect(result.action).toBe('skip');
        expect(result.reason).toContain('max entry cap');
    });

    it('includes totalDeployedCost in result', () => {
        const snap = makeSnapshot(0.2, 2, {
            below: { question: 'below', yesPrice: 0.05 },
            above: { question: 'above', yesPrice: 0.08 },
        });
        const neutral = { direction: 'neutral', convergence: 'stable', volatility: 1.5, points: [1, 2, 3] };
        const result = computeEdge(snap, neutral);
        expect(result.totalDeployedCost).toBeDefined();
        // If target-only, deployed cost = target price
        if (result.rangesToBuy.length === 1) {
            expect(result.totalDeployedCost).toBe(0.2);
        }
        // If target + hedge, deployed cost includes hedge
        if (result.rangesToBuy.length === 2) {
            expect(result.totalDeployedCost).toBeGreaterThan(0.2);
        }
    });
});

// ── analyzeTrajectory ───────────────────────────────────────────────────

describe('analyzeTrajectory', () => {
    it('returns unknown for < 2 points', () => {
        const result = analyzeTrajectory([{ daysOut: 2, forecast: 65 }]);
        expect(result.rangeStability).toBe('unknown');
        expect(result.pointCount).toBe(0);
    });

    it('returns null/empty for no data', () => {
        const result = analyzeTrajectory(null);
        expect(result.rangeStability).toBe('unknown');
    });

    it('detects stable range (forecast stayed in same 2°F band)', () => {
        // All forecasts fall in the 66-67 range (Math.floor(x/2) = 33)
        const history = [
            { daysOut: 4, forecast: 66.5 },
            { daysOut: 3, forecast: 66.8 },
            { daysOut: 2, forecast: 67.0 },
        ];
        const result = analyzeTrajectory(history);
        expect(result.rangeStability).toBe('stable');
        expect(result.rangesCrossed).toBe(0);
        expect(result.pointCount).toBe(3);
    });

    it('detects volatile trajectory (crossed 2+ ranges)', () => {
        const history = [
            { daysOut: 4, forecast: 62 }, // range 31
            { daysOut: 3, forecast: 66 }, // range 33
            { daysOut: 2, forecast: 70 }, // range 35
        ];
        const result = analyzeTrajectory(history);
        expect(result.rangeStability).toBe('volatile');
        expect(result.rangesCrossed).toBeGreaterThanOrEqual(2);
    });

    it('computes drift magnitude and direction', () => {
        const warming = [
            { daysOut: 4, forecast: 60 },
            { daysOut: 2, forecast: 65 },
        ];
        const result = analyzeTrajectory(warming);
        expect(result.driftMagnitude).toBe(5);
        expect(result.driftDirection).toBe('warming');

        const cooling = [
            { daysOut: 3, forecast: 70 },
            { daysOut: 2, forecast: 65 },
        ];
        const r2 = analyzeTrajectory(cooling);
        expect(r2.driftDirection).toBe('cooling');
    });

    it('detects flat drift for small changes', () => {
        const history = [
            { daysOut: 3, forecast: 66.0 },
            { daysOut: 2, forecast: 66.5 },
        ];
        const result = analyzeTrajectory(history);
        expect(result.driftDirection).toBe('flat');
        expect(result.driftMagnitude).toBeLessThan(1);
    });

    it('computes negative acceleration (settling) for decelerating drift', () => {
        // Deltas: +4, +1 → abs deltas: 4, 1 → accel = (1-4) = -3
        const history = [
            { daysOut: 4, forecast: 60 },
            { daysOut: 3, forecast: 64 },
            { daysOut: 2, forecast: 65 },
        ];
        const result = analyzeTrajectory(history);
        expect(result.acceleration).toBeLessThan(0); // settling
    });

    it('computes positive acceleration (speeding up) for accelerating drift', () => {
        // Deltas: +1, +4 → abs deltas: 1, 4 → accel = (4-1) = 3
        const history = [
            { daysOut: 4, forecast: 60 },
            { daysOut: 3, forecast: 61 },
            { daysOut: 2, forecast: 65 },
        ];
        const result = analyzeTrajectory(history);
        expect(result.acceleration).toBeGreaterThan(0); // speeding up
    });

    it('minor-drift when crossing exactly one range boundary', () => {
        const history = [
            { daysOut: 3, forecast: 65.5 }, // range 32
            { daysOut: 2, forecast: 66.5 }, // range 33
        ];
        const result = analyzeTrajectory(history);
        expect(result.rangeStability).toBe('minor-drift');
        expect(result.rangesCrossed).toBe(1);
    });

    it('trajectory boosts computeEdge confidence when stable', () => {
        const snap = { target: { question: '66-67°F', yesPrice: 0.3 }, below: null, above: null, daysUntilTarget: 2 };
        const trend = { direction: 'neutral', convergence: 'stable', volatility: 1.5, points: [1, 2, 3] };
        const stableTrajectory = { rangeStability: 'stable', acceleration: -1, driftMagnitude: 0.5, pointCount: 3 };
        const volatileTrajectory = { rangeStability: 'volatile', acceleration: 2, driftMagnitude: 5, pointCount: 3 };

        const rStable = computeEdge(snap, trend, {}, stableTrajectory);
        const rVolatile = computeEdge(snap, trend, {}, volatileTrajectory);
        // Volatile trajectory should have lower confidence
        // (volatile may skip due to <40% confidence, but we can still compare)
        expect(rStable.confidence).toBeGreaterThan(rVolatile.confidence);
    });
});
