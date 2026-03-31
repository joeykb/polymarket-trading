/**
 * Tests for data-svc/schemas.js — request body validation
 *
 * Ensures zod schemas correctly validate and reject malformed data
 * before it reaches the database or triggers trades.
 */
import { describe, it, expect } from 'vitest';
import {
    tradeSchema,
    tradeUpdateSchema,
    sessionSchema,
    sessionUpdateSchema,
    positionsInsertSchema,
    positionSoldSchema,
    positionRedeemedSchema,
    positionUpdateSchema,
    snapshotSchema,
    alertSchema,
    spendSchema,
    validate,
} from '../services/data-svc/schemas.js';

// ── validate helper ─────────────────────────────────────────────────

describe('validate helper', () => {
    it('returns data on valid input', () => {
        const { data, error } = validate(spendSchema, { date: '2026-03-23', amount: 1.5 });
        expect(error).toBeNull();
        expect(data.date).toBe('2026-03-23');
    });

    it('returns human-readable error on invalid input', () => {
        const { data, error } = validate(spendSchema, { date: 'not-a-date', amount: -5 });
        expect(data).toBeNull();
        expect(error).toContain('Validation failed');
    });
});

// ── Trade Schema ────────────────────────────────────────────────────

describe('tradeSchema', () => {
    const validTrade = {
        marketId: 'nyc',
        targetDate: '2026-03-25',
        type: 'buy',
        totalCost: 3.15,
    };

    it('accepts a valid trade', () => {
        const { data, error } = validate(tradeSchema, validTrade);
        expect(error).toBeNull();
        expect(data.type).toBe('buy');
        expect(data.marketId).toBe('nyc');
        expect(data.mode).toBe('live'); // default
    });

    it('rejects missing targetDate', () => {
        const { error } = validate(tradeSchema, { type: 'buy' });
        expect(error).toContain('targetDate');
    });

    it('rejects invalid targetDate format', () => {
        const { error } = validate(tradeSchema, { ...validTrade, targetDate: 'March 25' });
        expect(error).toContain('YYYY-MM-DD');
    });

    it('rejects invalid type', () => {
        const { error } = validate(tradeSchema, { ...validTrade, type: 'swap' });
        expect(error).toContain('type');
    });

    it('rejects negative totalCost', () => {
        const { error } = validate(tradeSchema, { ...validTrade, totalCost: -1 });
        expect(error).toContain('totalCost');
    });

    it('accepts null sessionId', () => {
        const { data, error } = validate(tradeSchema, { ...validTrade, sessionId: null });
        expect(error).toBeNull();
        expect(data.sessionId).toBeNull();
    });
});

// ── Session Schema ──────────────────────────────────────────────────

describe('sessionSchema', () => {
    const validSession = {
        id: 'sess-abc',
        marketId: 'nyc',
        targetDate: '2026-03-25',
        status: 'active',
        phase: 'buy',
    };

    it('accepts a valid session', () => {
        const { data, error } = validate(sessionSchema, validSession);
        expect(error).toBeNull();
        expect(data.id).toBe('sess-abc');
        expect(data.marketId).toBe('nyc');
    });

    it('rejects empty id', () => {
        const { error } = validate(sessionSchema, { ...validSession, id: '' });
        expect(error).toContain('id');
    });

    it('rejects invalid phase', () => {
        const { error } = validate(sessionSchema, { ...validSession, phase: 'waiting' });
        expect(error).toContain('phase');
    });
});

// ── Session Update Schema ───────────────────────────────────────────

describe('sessionUpdateSchema', () => {
    it('accepts valid partial update', () => {
        const { data, error } = validate(sessionUpdateSchema, { status: 'completed' });
        expect(error).toBeNull();
        expect(data.status).toBe('completed');
    });

    it('rejects empty update', () => {
        const { error } = validate(sessionUpdateSchema, {});
        expect(error).toContain('At least one field');
    });
});

// ── Positions Insert Schema ─────────────────────────────────────────

describe('positionsInsertSchema', () => {
    it('accepts valid positions batch', () => {
        const { data, error } = validate(positionsInsertSchema, {
            tradeId: 1,
            positions: [{ question: 'Between 72-73°F', buyPrice: 0.5, shares: 5 }],
        });
        expect(error).toBeNull();
        expect(data.positions).toHaveLength(1);
    });

    it('rejects missing tradeId', () => {
        const { error } = validate(positionsInsertSchema, {
            positions: [{ question: 'Test' }],
        });
        expect(error).toContain('tradeId');
    });

    it('rejects empty positions array', () => {
        const { error } = validate(positionsInsertSchema, {
            tradeId: 1,
            positions: [],
        });
        expect(error).toContain('At least one position');
    });
});

// ── Position Sold Schema ────────────────────────────────────────────

describe('positionSoldSchema', () => {
    it('accepts valid sold data', () => {
        const { data, error } = validate(positionSoldSchema, {
            sellPrice: 0.45,
            soldAt: '2026-03-23T14:30:00Z',
        });
        expect(error).toBeNull();
        expect(data.sellPrice).toBe(0.45);
    });

    it('rejects missing sellPrice', () => {
        const { error } = validate(positionSoldSchema, { soldAt: '2026-03-23T14:30:00Z' });
        expect(error).toContain('sellPrice');
    });
});

// ── Position Update Schema ──────────────────────────────────────────

describe('positionUpdateSchema', () => {
    it('accepts valid partial update', () => {
        const { data, error } = validate(positionUpdateSchema, {
            status: 'filled',
            fillPrice: 0.52,
        });
        expect(error).toBeNull();
        expect(data.status).toBe('filled');
        expect(data.fillPrice).toBe(0.52);
    });

    it('accepts sell-related fields', () => {
        const { data, error } = validate(positionUpdateSchema, {
            sellPrice: 0.45,
            soldAt: '2026-03-23T14:30:00Z',
            sellOrderId: 'order-abc',
        });
        expect(error).toBeNull();
        expect(data.sellPrice).toBe(0.45);
    });

    it('rejects empty update', () => {
        const { error } = validate(positionUpdateSchema, {});
        expect(error).toContain('At least one field');
    });

    it('strips unknown fields (SQL injection attempt)', () => {
        const { data, error } = validate(positionUpdateSchema, {
            status: 'filled',
            'id = 1; DROP TABLE sessions --': 'x',
        });
        // Zod .object() with defined keys strips unrecognized keys by default
        // The dangerous key is not in the schema, so it won't be in data
        expect(error).toBeNull();
        expect(data.status).toBe('filled');
        expect(data).not.toHaveProperty('id = 1; DROP TABLE sessions --');
    });

    it('rejects invalid status enum', () => {
        const { error } = validate(positionUpdateSchema, { status: 'hacked' });
        expect(error).toContain('status');
    });
});

// ── Snapshot Schema ─────────────────────────────────────────────────

describe('snapshotSchema', () => {
    it('accepts valid snapshot', () => {
        const { data, error } = validate(snapshotSchema, {
            sessionId: 'sess-1',
            timestamp: '2026-03-23T14:00:00Z',
            forecastTempF: 72.5,
        });
        expect(error).toBeNull();
        expect(data.forecastTempF).toBe(72.5);
    });

    it('rejects missing sessionId', () => {
        const { error } = validate(snapshotSchema, { timestamp: '2026-03-23T14:00:00Z' });
        expect(error).toContain('sessionId');
    });
});

// ── Alert Schema ────────────────────────────────────────────────────

describe('alertSchema', () => {
    it('accepts valid alert', () => {
        const { data, error } = validate(alertSchema, {
            sessionId: 'sess-1',
            timestamp: '2026-03-23T14:00:00Z',
            type: 'forecast_shift',
            message: 'Temp shifted +2°F',
        });
        expect(error).toBeNull();
        expect(data.type).toBe('forecast_shift');
    });

    it('rejects empty alert type', () => {
        const { error } = validate(alertSchema, {
            sessionId: 'sess-1',
            timestamp: '2026-03-23T14:00:00Z',
            type: '',
        });
        expect(error).toContain('type');
    });
});

// ── Spend Schema ────────────────────────────────────────────────────

describe('spendSchema', () => {
    it('accepts valid spend', () => {
        const { data, error } = validate(spendSchema, { date: '2026-03-23', amount: 2.5 });
        expect(error).toBeNull();
    });

    it('rejects zero amount', () => {
        const { error } = validate(spendSchema, { date: '2026-03-23', amount: 0 });
        expect(error).toContain('amount');
    });
});
