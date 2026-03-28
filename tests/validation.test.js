/**
 * Tests for trading-svc request body validation
 */
import { describe, it, expect } from 'vitest';
import {
    validateBuyRequest,
    validateSellRequest,
    validateRetryRequest,
    validateRedeemRequest,
} from '../services/trading-svc/validation.js';

describe('validateBuyRequest', () => {
    it('accepts valid buy request with all fields', () => {
        const result = validateBuyRequest({
            snapshot: { target: { yesPrice: 0.30, question: 'test?' } },
            liqTokens: [{ question: 'test?', bestAsk: 0.31 }],
            context: { sessionId: 'abc' },
        });
        expect(result.valid).toBe(true);
        expect(result.data.snapshot.target.yesPrice).toBe(0.30);
        expect(result.data.liqTokens).toHaveLength(1);
        expect(result.data.context.sessionId).toBe('abc');
    });

    it('accepts buy request with only snapshot', () => {
        const result = validateBuyRequest({
            snapshot: { target: { yesPrice: 0.30 } },
        });
        expect(result.valid).toBe(true);
        expect(result.data.liqTokens).toEqual([]);
        expect(result.data.context).toEqual({});
    });

    it('rejects null body', () => {
        expect(validateBuyRequest(null).valid).toBe(false);
    });

    it('rejects missing snapshot', () => {
        expect(validateBuyRequest({ liqTokens: [] }).valid).toBe(false);
        expect(validateBuyRequest({ liqTokens: [] }).error).toContain('snapshot');
    });

    it('rejects snapshot without target', () => {
        const result = validateBuyRequest({ snapshot: { below: {} } });
        expect(result.valid).toBe(false);
        expect(result.error).toContain('target');
    });

    it('rejects non-array liqTokens', () => {
        const result = validateBuyRequest({
            snapshot: { target: { yesPrice: 0.30 } },
            liqTokens: 'not-an-array',
        });
        expect(result.valid).toBe(false);
        expect(result.error).toContain('liqTokens');
    });

    it('rejects non-object context', () => {
        const result = validateBuyRequest({
            snapshot: { target: { yesPrice: 0.30 } },
            context: 'string',
        });
        expect(result.valid).toBe(false);
        expect(result.error).toContain('context');
    });
});

describe('validateSellRequest', () => {
    it('accepts valid sell request', () => {
        const result = validateSellRequest({
            positions: [{ clobTokenId: 'abc', shares: 5, label: 'target' }],
            context: { sessionId: '123' },
        });
        expect(result.valid).toBe(true);
        expect(result.data.positions).toHaveLength(1);
    });

    it('accepts positions with clobTokenIds array', () => {
        const result = validateSellRequest({
            positions: [{ clobTokenIds: ['abc'], shares: 5 }],
        });
        expect(result.valid).toBe(true);
    });

    it('rejects empty positions array', () => {
        const result = validateSellRequest({ positions: [] });
        expect(result.valid).toBe(false);
    });

    it('rejects position without token ID', () => {
        const result = validateSellRequest({
            positions: [{ shares: 5, label: 'target' }],
        });
        expect(result.valid).toBe(false);
        expect(result.error).toContain('clobTokenId');
    });

    it('rejects non-array positions', () => {
        const result = validateSellRequest({ positions: 'not-array' });
        expect(result.valid).toBe(false);
    });
});

describe('validateRetryRequest', () => {
    it('accepts valid retry request', () => {
        const result = validateRetryRequest({
            position: { clobTokenIds: ['xyz'], label: 'target' },
            liqTokenData: { bestAsk: 0.31 },
        });
        expect(result.valid).toBe(true);
        expect(result.data.liqTokenData.bestAsk).toBe(0.31);
    });

    it('accepts retry with null liqTokenData', () => {
        const result = validateRetryRequest({
            position: { clobTokenId: 'xyz' },
        });
        expect(result.valid).toBe(true);
        expect(result.data.liqTokenData).toBeNull();
    });

    it('rejects missing position', () => {
        expect(validateRetryRequest({}).valid).toBe(false);
    });

    it('rejects position without token IDs', () => {
        const result = validateRetryRequest({ position: { label: 'target' } });
        expect(result.valid).toBe(false);
    });
});

describe('validateRedeemRequest', () => {
    it('accepts valid redeem request', () => {
        const result = validateRedeemRequest({
            session: { id: 'abc', buyOrder: { positions: [] } },
        });
        expect(result.valid).toBe(true);
    });

    it('rejects missing session', () => {
        expect(validateRedeemRequest({}).valid).toBe(false);
    });

    it('rejects non-object session', () => {
        expect(validateRedeemRequest({ session: 'str' }).valid).toBe(false);
    });

    it('rejects null body', () => {
        expect(validateRedeemRequest(null).valid).toBe(false);
    });
});
