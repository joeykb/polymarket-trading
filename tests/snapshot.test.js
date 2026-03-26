/**
 * Tests for services/monitor/snapshot.js — Snapshot construction
 *
 * Uses dependency injection for service calls, no real HTTP needed.
 */
import { describe, it, expect } from 'vitest';
import { buildSnapshotRange, takeSnapshot } from '../services/monitor/snapshot.js';

// ── buildSnapshotRange ──────────────────────────────────────────────────

describe('buildSnapshotRange', () => {
    const baseRange = {
        marketId: 'market-123',
        conditionId: 'cond-456',
        clobTokenIds: ['tok-1', 'tok-2'],
        question: 'Between 66-67°F',
        yesPrice: 0.45,
        noPrice: 0.55,
        bestBid: 0.44,
        bestAsk: 0.46,
        impliedProbability: 45.0,
        volume: 5000,
    };

    it('copies all range fields correctly', () => {
        const result = buildSnapshotRange(baseRange, null);
        expect(result.marketId).toBe('market-123');
        expect(result.question).toBe('Between 66-67°F');
        expect(result.yesPrice).toBe(0.45);
        expect(result.volume).toBe(5000);
    });

    it('computes zero priceChange when no previous', () => {
        const result = buildSnapshotRange(baseRange, null);
        expect(result.priceChange).toBe(0);
    });

    it('computes priceChange from previous', () => {
        const previous = { ...baseRange, yesPrice: 0.4 };
        const result = buildSnapshotRange(baseRange, previous);
        expect(result.priceChange).toBeCloseTo(0.05, 4);
    });

    it('handles negative priceChange', () => {
        const previous = { ...baseRange, yesPrice: 0.5 };
        const result = buildSnapshotRange(baseRange, previous);
        expect(result.priceChange).toBeCloseTo(-0.05, 4);
    });

    it('defaults noPrice and bestBid to 0 when missing', () => {
        const minimal = { ...baseRange, noPrice: undefined, bestBid: undefined, bestAsk: undefined };
        const result = buildSnapshotRange(minimal, null);
        expect(result.noPrice).toBe(0);
        expect(result.bestBid).toBe(0);
        expect(result.bestAsk).toBe(0);
    });
});

// ── takeSnapshot ────────────────────────────────────────────────────────

describe('takeSnapshot', () => {
    const mockSvcFns = {
        fetchWeatherData: async () => ({
            forecast: { highTempF: 67.5, source: 'weather-company' },
            current: { tempF: 62.3, maxSince7amF: 64.1, conditions: 'Partly Cloudy' },
        }),
        discoverMarket: async () => ({
            id: 'event-1',
            title: 'NYC Temperature',
            active: true,
            closed: false,
            ranges: [
                { marketId: 'm1', question: 'Between 66-67°F', yesPrice: 0.4, clobTokenIds: ['t1'], impliedProbability: 40, volume: 1000 },
                { marketId: 'm2', question: 'Between 68-69°F', yesPrice: 0.3, clobTokenIds: ['t2'], impliedProbability: 30, volume: 800 },
            ],
        }),
        selectRanges: async () => ({
            target: {
                marketId: 'm1',
                conditionId: 'c1',
                clobTokenIds: ['t1'],
                question: 'Between 66-67°F',
                yesPrice: 0.4,
                noPrice: 0.6,
                bestBid: 0.39,
                bestAsk: 0.41,
                impliedProbability: 40,
                volume: 1000,
            },
            below: {
                marketId: 'm2',
                conditionId: 'c2',
                clobTokenIds: ['t2'],
                question: 'Between 64-65°F',
                yesPrice: 0.25,
                noPrice: 0.75,
                bestBid: 0.24,
                bestAsk: 0.26,
                impliedProbability: 25,
                volume: 500,
            },
            above: null,
            totalCost: 0.65,
        }),
    };

    it('builds a complete snapshot with weather and market data', async () => {
        const snapshot = await takeSnapshot('2026-03-26', null, mockSvcFns);

        expect(snapshot.forecastTempF).toBe(67.5);
        expect(snapshot.forecastSource).toBe('weather-company');
        expect(snapshot.currentTempF).toBe(62.3);
        expect(snapshot.maxTodayF).toBe(64.1);
        expect(snapshot.currentConditions).toBe('Partly Cloudy');
        expect(snapshot.target.question).toBe('Between 66-67°F');
        expect(snapshot.below.question).toBe('Between 64-65°F');
        expect(snapshot.above).toBeNull();
        expect(snapshot.totalCost).toBe(0.65);
        expect(snapshot.eventActive).toBe(true);
        expect(snapshot.eventClosed).toBe(false);
        expect(snapshot.timestamp).toBeDefined();
    });

    it('computes forecastChange from previous snapshot', async () => {
        const previous = { forecastTempF: 66.0, target: { yesPrice: 0.35 } };
        const snapshot = await takeSnapshot('2026-03-26', previous, mockSvcFns);

        expect(snapshot.forecastChange).toBeCloseTo(1.5, 1);
    });

    it('detects range shift from previous', async () => {
        const previous = {
            forecastTempF: 66.0,
            target: { question: 'Between 64-65°F', yesPrice: 0.5 },
        };
        const snapshot = await takeSnapshot('2026-03-26', previous, mockSvcFns);

        expect(snapshot.rangeShifted).toBe(true);
        expect(snapshot.shiftedFrom).toBe('Between 64-65°F');
    });

    it('no range shift when target unchanged', async () => {
        const previous = {
            forecastTempF: 67.0,
            target: { question: 'Between 66-67°F', yesPrice: 0.38 },
        };
        const snapshot = await takeSnapshot('2026-03-26', previous, mockSvcFns);

        expect(snapshot.rangeShifted).toBe(false);
        expect(snapshot.shiftedFrom).toBeNull();
    });

    it('includes allRanges from event', async () => {
        const snapshot = await takeSnapshot('2026-03-26', null, mockSvcFns);

        expect(snapshot.allRanges).toHaveLength(2);
        expect(snapshot.allRanges[0].question).toBe('Between 66-67°F');
        expect(snapshot.allRanges[1].question).toBe('Between 68-69°F');
    });
});
