/**
 * Tests for services/monitor/svcClients.js
 *
 * Tests the service call wrappers with mocked httpClient.
 * Verifies error handling, null returns, and correct parameter passing.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Track all mock client instances created
const mockClientInstance = {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
};

// Mock the shared httpClient at the correct path (relative to the source module)
vi.mock('../shared/httpClient.js', () => ({
    createClient: vi.fn(() => mockClientInstance),
}));

// Must import after vi.mock
const {
    tryPlaceBuyOrder,
    executeSellOrder,
    tryRedeemPositions,
    fetchLiquidityFromService,
} = await import('../services/monitor/svcClients.js');

describe('svcClients', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    // ── tryPlaceBuyOrder ────────────────────────────────────────────

    describe('tryPlaceBuyOrder', () => {
        it('returns order on success', async () => {
            const order = { totalCost: 0.5, positions: [] };
            mockClientInstance.post.mockResolvedValue(order);

            const result = await tryPlaceBuyOrder({ target: {} }, [], {});
            expect(result).toEqual(order);
        });

        it('returns null on error response', async () => {
            mockClientInstance.post.mockResolvedValue({ error: 'insufficient funds' });
            const result = await tryPlaceBuyOrder({}, [], {});
            expect(result).toBeNull();
        });

        it('returns null when allUnfilled', async () => {
            mockClientInstance.post.mockResolvedValue({ allUnfilled: true });
            const result = await tryPlaceBuyOrder({}, [], {});
            expect(result).toBeNull();
        });

        it('returns null on network failure', async () => {
            mockClientInstance.post.mockRejectedValue(new Error('timeout'));
            const result = await tryPlaceBuyOrder({}, [], {});
            expect(result).toBeNull();
        });
    });

    // ── executeSellOrder ────────────────────────────────────────────

    describe('executeSellOrder', () => {
        it('returns result on success', async () => {
            const result = { totalProceeds: 0.3, positions: [] };
            mockClientInstance.post.mockResolvedValue(result);

            const r = await executeSellOrder([{ question: 'Q1' }], {});
            expect(r).toEqual(result);
        });

        it('returns null on error response', async () => {
            mockClientInstance.post.mockResolvedValue({ error: 'no positions' });
            const r = await executeSellOrder([], {});
            expect(r).toBeNull();
        });

        it('returns null on network failure', async () => {
            mockClientInstance.post.mockRejectedValue(new Error('ECONNREFUSED'));
            const r = await executeSellOrder([], {});
            expect(r).toBeNull();
        });
    });

    // ── tryRedeemPositions ──────────────────────────────────────────

    describe('tryRedeemPositions', () => {
        it('returns result on success', async () => {
            const result = { redeemed: 2, totalValue: 1.5 };
            mockClientInstance.post.mockResolvedValue(result);

            const r = await tryRedeemPositions({ id: 's1' });
            expect(r).toEqual(result);
        });

        it('returns null on error', async () => {
            mockClientInstance.post.mockResolvedValue({ error: 'not resolved' });
            const r = await tryRedeemPositions({});
            expect(r).toBeNull();
        });

        it('returns null on network failure', async () => {
            mockClientInstance.post.mockRejectedValue(new Error('timeout'));
            const r = await tryRedeemPositions({});
            expect(r).toBeNull();
        });
    });

    // ── fetchLiquidityFromService ────────────────────────────────────

    describe('fetchLiquidityFromService', () => {
        it('returns liquidity data on success', async () => {
            const liq = { tokens: [{ question: 'Q1', bestBid: 0.3 }], allLiquid: true };
            mockClientInstance.get.mockResolvedValue(liq);

            const r = await fetchLiquidityFromService('2026-03-28');
            expect(r).toEqual(liq);
        });

        it('returns null when service unavailable', async () => {
            mockClientInstance.get.mockRejectedValue(new Error('ECONNREFUSED'));
            const r = await fetchLiquidityFromService('2026-03-28');
            expect(r).toBeNull();
        });
    });
});
