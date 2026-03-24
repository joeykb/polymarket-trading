/**
 * Tests for services/monitor/strategy.js — Strategy functions
 *
 * Covers: analyzeTrend, resolveRanges, shouldPlaceBuy, computePnL
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { analyzeTrend, resolveRanges, shouldPlaceBuy, computePnL } from '../services/monitor/strategy.js';

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
