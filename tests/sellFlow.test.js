/**
 * Tests for services/monitor/sellFlow.js
 *
 * Covers the three sell strategies:
 *   - Resolve-day sell (hedge liquidation)
 *   - Rebalance sell (forecast shift)
 *   - Stop-loss sell (P&L floor breach)
 *
 * executeSellOrder is mocked via vi.mock to avoid hitting the trading service.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the svcClients module — executeSellOrder is the only external dep
vi.mock('../services/monitor/svcClients.js', () => ({
    executeSellOrder: vi.fn(),
}));

import { executeResolveDaySell, executeRebalanceSell, executeStopLossSell } from '../services/monitor/sellFlow.js';
import { executeSellOrder } from '../services/monitor/svcClients.js';

// ── Test Fixtures ───────────────────────────────────────────────────────

function makeSession(overrides = {}) {
    return {
        id: 'sess-1',
        targetDate: '2026-03-28',
        initialForecastTempF: 68,
        buyOrder: {
            positions: [
                { label: 'target', question: 'Will it be 66-68°F?', conditionId: 'c1', shares: 10, clobTokenIds: ['tok-1'] },
                { label: 'below', question: 'Will it be 64-66°F?', conditionId: 'c2', shares: 5, clobTokenIds: ['tok-2'] },
                { label: 'above', question: 'Will it be 68-70°F?', conditionId: 'c3', shares: 5, clobTokenIds: ['tok-3'] },
            ],
        },
        alerts: [],
        sellOrders: [],
        ...overrides,
    };
}

function makeSnapshot(overrides = {}) {
    return {
        phase: 'buy',
        forecastTempF: 68,
        daysUntilTarget: 2,
        eventClosed: false,
        target: { question: 'Will it be 66-68°F?', clobTokenIds: ['tok-1'] },
        below: { question: 'Will it be 64-66°F?', clobTokenIds: ['tok-2'] },
        above: { question: 'Will it be 68-70°F?', clobTokenIds: ['tok-3'] },
        ...overrides,
    };
}

function makeSellResult(positions) {
    return {
        positions: positions.map((q) => ({
            question: q,
            sellPrice: 0.45,
            orderId: `order-${q.slice(0, 5)}`,
            status: 'filled',
        })),
        totalProceeds: positions.length * 0.45,
    };
}

// ── Resolve-Day Sell ────────────────────────────────────────────────────

describe('executeResolveDaySell', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('returns empty alerts when no buyOrder', async () => {
        const session = makeSession({ buyOrder: null });
        const snapshot = makeSnapshot({ phase: 'resolve' });
        const alerts = await executeResolveDaySell(session, snapshot, { buyHourEST: 0 });
        expect(alerts).toEqual([]);
    });

    it('returns empty alerts when event is closed', async () => {
        const session = makeSession();
        const snapshot = makeSnapshot({ phase: 'resolve', eventClosed: true });
        const alerts = await executeResolveDaySell(session, snapshot, { buyHourEST: 0 });
        expect(alerts).toEqual([]);
    });

    it('returns empty alerts when already executed', async () => {
        const session = makeSession({ resolveSellExecuted: true });
        const snapshot = makeSnapshot({ phase: 'resolve' });
        const alerts = await executeResolveDaySell(session, snapshot, { buyHourEST: 0 });
        expect(alerts).toEqual([]);
    });

    it('returns empty alerts when not in resolve phase', async () => {
        const session = makeSession();
        const snapshot = makeSnapshot({ phase: 'buy' });
        const alerts = await executeResolveDaySell(session, snapshot, { buyHourEST: 0 });
        expect(alerts).toEqual([]);
    });

    it('marks session as executed when no positions to sell', async () => {
        // All positions match current target — nothing to sell
        const session = makeSession({
            buyOrder: {
                positions: [
                    { label: 'target', question: 'Will it be 66-68°F?', conditionId: 'c1', shares: 10 },
                ],
            },
        });
        const snapshot = makeSnapshot({ phase: 'resolve' });
        const alerts = await executeResolveDaySell(session, snapshot, { buyHourEST: 0 });
        expect(alerts).toEqual([]);
        expect(session.resolveSellExecuted).toBe(true);
    });

    it('sells hedge positions and generates alerts', async () => {
        const session = makeSession();
        const snapshot = makeSnapshot({ phase: 'resolve' });

        executeSellOrder.mockResolvedValue(
            makeSellResult(['Will it be 64-66°F?', 'Will it be 68-70°F?']),
        );

        const alerts = await executeResolveDaySell(session, snapshot, { buyHourEST: 0 });

        expect(executeSellOrder).toHaveBeenCalledOnce();
        expect(alerts).toHaveLength(1);
        expect(alerts[0].type).toBe('resolve_sell');
        expect(session.resolveSellExecuted).toBe(true);
        expect(session.sellOrders).toHaveLength(1);

        // Check that sell results were applied back to positions
        const below = session.buyOrder.positions.find((p) => p.label === 'below');
        expect(below.sellPrice).toBe(0.45);
        expect(below.soldStatus).toBe('filled');
    });

    it('handles sell failure gracefully (no alert, no crash)', async () => {
        const session = makeSession();
        const snapshot = makeSnapshot({ phase: 'resolve' });

        executeSellOrder.mockResolvedValue(null);

        const alerts = await executeResolveDaySell(session, snapshot, { buyHourEST: 0 });
        expect(alerts).toEqual([]);
        expect(session.sellOrders).toEqual([]);
    });
});

// ── Rebalance Sell ──────────────────────────────────────────────────────

describe('executeRebalanceSell', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('returns empty alerts when no buyOrder', async () => {
        const session = makeSession({ buyOrder: null });
        const snapshot = makeSnapshot({ phase: 'buy', forecastTempF: 75 });
        const alerts = await executeRebalanceSell(session, snapshot, { rebalanceThreshold: 3 });
        expect(alerts).toEqual([]);
    });

    it('returns empty alerts when shift is below threshold', async () => {
        const session = makeSession();
        // 1°F shift with T+2 threshold of 2°F
        const snapshot = makeSnapshot({ phase: 'buy', forecastTempF: 69, daysUntilTarget: 2 });
        const alerts = await executeRebalanceSell(session, snapshot, { rebalanceThreshold: 3 });
        expect(alerts).toEqual([]);
    });

    it('returns empty in scout/resolve phase', async () => {
        const session = makeSession();
        const snapshot = makeSnapshot({ phase: 'resolve', forecastTempF: 75 });
        const alerts = await executeRebalanceSell(session, snapshot, { rebalanceThreshold: 3 });
        expect(alerts).toEqual([]);
    });

    it('uses dynamic threshold based on daysUntilTarget', async () => {
        const session = makeSession();
        // T+1: 1°F threshold — 1.5°F shift should trigger
        const snapshot = makeSnapshot({
            phase: 'buy',
            forecastTempF: 69.5, // shift of 1.5°F from initialForecast of 68
            daysUntilTarget: 1,
            // Shifted to new range
            target: { question: 'Will it be 68-70°F?', clobTokenIds: ['tok-new'] },
            below: null,
            above: null,
        });

        executeSellOrder.mockResolvedValue(
            makeSellResult(['Will it be 64-66°F?']),
        );

        const alerts = await executeRebalanceSell(session, snapshot, { rebalanceThreshold: 3 });
        expect(alerts).toHaveLength(1);
        expect(alerts[0].type).toBe('rebalance_sell');
    });

    it('sells out-of-range positions when threshold met', async () => {
        const session = makeSession();
        // 5°F shift exceeds T+3 threshold of 3°F
        const snapshot = makeSnapshot({
            phase: 'buy',
            forecastTempF: 73,
            daysUntilTarget: 3,
            // Forecast shifted to entirely new range
            target: { question: 'Will it be 72-74°F?', clobTokenIds: ['tok-new'] },
            below: null,
            above: null,
        });

        executeSellOrder.mockResolvedValue(
            makeSellResult(['Will it be 66-68°F?', 'Will it be 64-66°F?', 'Will it be 68-70°F?']),
        );

        const alerts = await executeRebalanceSell(session, snapshot, { rebalanceThreshold: 3 });
        expect(executeSellOrder).toHaveBeenCalledOnce();
        expect(alerts).toHaveLength(1);
        expect(session.lastRebalanceForecastF).toBe(73);
        expect(session.sellOrders).toHaveLength(1);
    });

    it('uses lastRebalanceForecastF as reference when available', async () => {
        const session = makeSession({ lastRebalanceForecastF: 70 });
        // 0.5°F shift from last rebalance — below T+2 threshold (2°F)
        const snapshot = makeSnapshot({ phase: 'buy', forecastTempF: 70.5, daysUntilTarget: 2 });
        const alerts = await executeRebalanceSell(session, snapshot, { rebalanceThreshold: 3 });
        expect(alerts).toEqual([]);
        expect(executeSellOrder).not.toHaveBeenCalled();
    });
});

// ── Stop-Loss Sell ──────────────────────────────────────────────────────

describe('executeStopLossSell', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('returns empty alerts when stop-loss not triggered', async () => {
        const session = makeSession();
        const snapshot = makeSnapshot();
        const alerts = await executeStopLossSell(session, snapshot, { triggered: false });
        expect(alerts).toEqual([]);
        expect(executeSellOrder).not.toHaveBeenCalled();
    });

    it('sells all positions when triggered', async () => {
        const session = makeSession();
        const snapshot = makeSnapshot();
        const stopLoss = { triggered: true, reason: 'P&L -25%', pnlPct: -25, totalPnL: -0.15 };

        executeSellOrder.mockResolvedValue(
            makeSellResult(['Will it be 66-68°F?', 'Will it be 64-66°F?', 'Will it be 68-70°F?']),
        );

        const alerts = await executeStopLossSell(session, snapshot, stopLoss);

        expect(executeSellOrder).toHaveBeenCalledOnce();
        expect(alerts).toHaveLength(1);
        expect(alerts[0].type).toBe('stop_loss');
        expect(alerts[0].data.positionsSold).toBe(3);
        expect(session.stopLossExecuted).toBe(true);
    });

    it('handles sell failure gracefully', async () => {
        const session = makeSession();
        const snapshot = makeSnapshot();
        const stopLoss = { triggered: true, reason: 'floor breach', pnlPct: -30, totalPnL: -0.20 };

        executeSellOrder.mockResolvedValue(null);

        const alerts = await executeStopLossSell(session, snapshot, stopLoss);
        expect(alerts).toEqual([]);
        expect(session.stopLossExecuted).toBeUndefined();
    });

    it('handles no sellable positions', async () => {
        const session = makeSession({
            buyOrder: {
                positions: [
                    { label: 'target', question: 'Q1', conditionId: 'c1', shares: 10, soldAt: '2026-03-26T10:00:00Z' },
                ],
            },
        });
        const snapshot = makeSnapshot();
        const stopLoss = { triggered: true, reason: 'test', pnlPct: -20, totalPnL: -0.10 };

        const alerts = await executeStopLossSell(session, snapshot, stopLoss);
        expect(alerts).toEqual([]);
        expect(executeSellOrder).not.toHaveBeenCalled();
    });
});
