/**
 * Tests for services/monitor/positions.js
 *
 * Covers the two extracted helpers: resolveTokenId and collectSellablePositions.
 */

import { describe, it, expect } from 'vitest';
import { resolveTokenId, collectSellablePositions } from '../services/monitor/positions.js';

// ── resolveTokenId ──────────────────────────────────────────────────────

describe('resolveTokenId', () => {
    it('returns clobTokenId when directly available', () => {
        const pos = { question: 'Will it be 60-62°F?', clobTokenId: 'tok-1' };
        expect(resolveTokenId(pos, {})).toBe('tok-1');
    });

    it('returns clobTokenIds[0] when clobTokenId is missing', () => {
        const pos = { question: 'Will it be 60-62°F?', clobTokenIds: ['tok-2'] };
        expect(resolveTokenId(pos, {})).toBe('tok-2');
    });

    it('returns tokenId as last direct fallback', () => {
        const pos = { question: 'Will it be 60-62°F?', tokenId: 'tok-3' };
        expect(resolveTokenId(pos, {})).toBe('tok-3');
    });

    it('resolves from snapshot target range', () => {
        const pos = { question: 'Will it be 60-62°F?' };
        const snapshot = {
            target: { question: 'Will it be 60-62°F?', clobTokenIds: ['snap-tok-1'] },
            below: null,
            above: null,
        };
        const result = resolveTokenId(pos, snapshot);
        expect(result).toBe('snap-tok-1');
        // Should also mutate position
        expect(pos.clobTokenIds).toEqual(['snap-tok-1']);
        expect(pos.tokenId).toBe('snap-tok-1');
    });

    it('resolves from snapshot below range', () => {
        const pos = { question: 'Will it be 58-60°F?' };
        const snapshot = {
            target: { question: 'Will it be 60-62°F?', clobTokenIds: ['snap-tok-1'] },
            below: { question: 'Will it be 58-60°F?', clobTokenIds: ['snap-tok-2'] },
            above: null,
        };
        expect(resolveTokenId(pos, snapshot)).toBe('snap-tok-2');
    });

    it('returns null when no resolution possible', () => {
        const pos = { question: 'Unknown range?' };
        const snapshot = {
            target: { question: 'Will it be 60-62°F?', clobTokenIds: ['snap-tok-1'] },
            below: null,
            above: null,
        };
        expect(resolveTokenId(pos, snapshot)).toBeNull();
    });

    it('handles null snapshot gracefully', () => {
        const pos = { question: 'Test?' };
        expect(resolveTokenId(pos, null)).toBeNull();
    });
});

// ── collectSellablePositions ────────────────────────────────────────────

describe('collectSellablePositions', () => {
    const makeSession = (positions) => ({
        buyOrder: { positions },
    });

    const snapshot = {
        target: { question: 'Will it be 60-62°F?', clobTokenIds: ['tok-target'] },
        below: { question: 'Will it be 58-60°F?', clobTokenIds: ['tok-below'] },
        above: { question: 'Will it be 62-64°F?', clobTokenIds: ['tok-above'] },
    };

    it('returns all eligible positions by default', () => {
        const session = makeSession([
            { label: 'target', question: 'Will it be 60-62°F?', conditionId: 'c1', shares: 10 },
            { label: 'below', question: 'Will it be 58-60°F?', conditionId: 'c2', shares: 5 },
        ]);
        const result = collectSellablePositions(session, snapshot);
        expect(result).toHaveLength(2);
        expect(result[0]).toEqual({
            label: 'target',
            question: 'Will it be 60-62°F?',
            clobTokenId: 'tok-target',
            conditionId: 'c1',
            shares: 10,
        });
    });

    it('excludes failed and rejected positions', () => {
        const session = makeSession([
            { label: 'target', question: 'Q1', status: 'failed', conditionId: 'c1', shares: 10 },
            { label: 'below', question: 'Q2', status: 'rejected', conditionId: 'c2', shares: 5 },
            { label: 'above', question: 'Will it be 62-64°F?', status: 'filled', conditionId: 'c3', shares: 8 },
        ]);
        const result = collectSellablePositions(session, snapshot);
        expect(result).toHaveLength(1);
        expect(result[0].label).toBe('above');
    });

    it('excludes already-sold positions', () => {
        const session = makeSession([
            { label: 'target', question: 'Will it be 60-62°F?', soldAt: '2026-03-26T10:00:00Z', conditionId: 'c1', shares: 10 },
            { label: 'below', question: 'Will it be 58-60°F?', conditionId: 'c2', shares: 5 },
        ]);
        const result = collectSellablePositions(session, snapshot);
        expect(result).toHaveLength(1);
        expect(result[0].label).toBe('below');
    });

    it('applies custom filterFn', () => {
        const session = makeSession([
            { label: 'target', question: 'Will it be 60-62°F?', conditionId: 'c1', shares: 10 },
            { label: 'below', question: 'Will it be 58-60°F?', conditionId: 'c2', shares: 5 },
            { label: 'above', question: 'Will it be 62-64°F?', conditionId: 'c3', shares: 8 },
        ]);
        // Only sell hedges (not target)
        const targetQ = 'Will it be 60-62°F?';
        const result = collectSellablePositions(session, snapshot, (pos) => pos.question !== targetQ);
        expect(result).toHaveLength(2);
        expect(result.map((p) => p.label)).toEqual(['below', 'above']);
    });

    it('returns empty array when no buyOrder', () => {
        expect(collectSellablePositions({}, snapshot)).toEqual([]);
        expect(collectSellablePositions({ buyOrder: null }, snapshot)).toEqual([]);
    });

    it('defaults shares to 1 when missing', () => {
        const session = makeSession([
            { label: 'target', question: 'Will it be 60-62°F?', conditionId: 'c1' },
        ]);
        const result = collectSellablePositions(session, snapshot);
        expect(result[0].shares).toBe(1);
    });
});
