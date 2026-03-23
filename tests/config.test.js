/**
 * Tests for shared/configSchema.js — config resolution
 *
 * Correct config resolution is critical: wrong values for maxSpreadPct,
 * maxDailySpend, or tradingMode can cause real financial impact.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CONFIG_SCHEMA, resolveConfigValue, buildAdminConfig, buildFlatConfig } from '../shared/configSchema.js';

// ── Config Schema Integrity ─────────────────────────────────────────

describe('CONFIG_SCHEMA', () => {
    it('contains all expected sections', () => {
        const sections = new Set(Object.keys(CONFIG_SCHEMA).map((k) => k.split('.')[0]));
        expect(sections).toContain('trading');
        expect(sections).toContain('monitor');
        expect(sections).toContain('liquidity');
        expect(sections).toContain('weather');
        expect(sections).toContain('polymarket');
        expect(sections).toContain('dashboard');
        expect(sections).toContain('phases');
    });

    it('every entry has key, default, and description', () => {
        for (const [dotPath, schema] of Object.entries(CONFIG_SCHEMA)) {
            expect(schema.key, `${dotPath} missing 'key'`).toBeDefined();
            expect(schema.default, `${dotPath} missing 'default'`).toBeDefined();
            expect(schema.description, `${dotPath} missing 'description'`).toBeDefined();
        }
    });

    it('all env keys are unique', () => {
        const keys = Object.values(CONFIG_SCHEMA).map((s) => s.key);
        const unique = new Set(keys);
        expect(unique.size).toBe(keys.length);
    });

    it('readOnly entries are always sensitive', () => {
        for (const [dotPath, schema] of Object.entries(CONFIG_SCHEMA)) {
            if (schema.readOnly) {
                expect(schema.sensitive, `${dotPath} is readOnly but not sensitive`).toBe(true);
            }
        }
    });
});

// ── resolveConfigValue ──────────────────────────────────────────────

describe('resolveConfigValue', () => {
    const originalEnv = { ...process.env };

    afterEach(() => {
        // Restore original env
        for (const key of Object.keys(process.env)) {
            if (!(key in originalEnv)) delete process.env[key];
        }
        Object.assign(process.env, originalEnv);
    });

    it('returns default when no env or override', () => {
        const { value, source } = resolveConfigValue('trading.mode');
        expect(value).toBe('disabled');
        expect(source).toBe('default');
    });

    it('returns env value when set', () => {
        process.env.TRADING_MODE = 'live';
        const { value, source } = resolveConfigValue('trading.mode');
        expect(value).toBe('live');
        expect(source).toBe('env');
    });

    it('coerces numeric env values to numbers', () => {
        process.env.MAX_POSITION_COST = '3.5';
        const { value, source } = resolveConfigValue('trading.maxPositionCost');
        expect(value).toBe(3.5);
        expect(typeof value).toBe('number');
        expect(source).toBe('env');
    });

    it('override takes priority over env', () => {
        process.env.TRADING_MODE = 'dry-run';
        const overrides = { trading: { mode: 'live' } };
        const { value, source } = resolveConfigValue('trading.mode', overrides);
        expect(value).toBe('live');
        expect(source).toBe('override');
    });

    it('returns undefined for unknown paths', () => {
        const { value, source } = resolveConfigValue('nonexistent.key');
        expect(value).toBeUndefined();
        expect(source).toBe('default');
    });

    it('ignores empty string env values', () => {
        process.env.TRADING_MODE = '';
        const { value, source } = resolveConfigValue('trading.mode');
        expect(value).toBe('disabled');
        expect(source).toBe('default');
    });
});

// ── buildAdminConfig ────────────────────────────────────────────────

describe('buildAdminConfig', () => {
    it('returns section-keyed object with metadata', () => {
        const config = buildAdminConfig();
        expect(config.trading).toBeDefined();
        expect(config.trading.mode).toBeDefined();
        expect(config.trading.mode.envKey).toBe('TRADING_MODE');
        expect(config.trading.mode.value).toBe('disabled');
        expect(config.trading.mode.description).toBeTruthy();
    });

    it('marks sensitive fields with hidden default', () => {
        const config = buildAdminConfig();
        expect(config.trading.privateKey.default).toBe('(hidden)');
        expect(config.trading.privateKey.sensitive).toBe(true);
    });

    it('includes choices when defined', () => {
        const config = buildAdminConfig();
        expect(config.trading.mode.choices).toEqual(['disabled', 'dry-run', 'live']);
    });

    it('applies overrides', () => {
        const config = buildAdminConfig({ trading: { mode: 'live' } });
        expect(config.trading.mode.value).toBe('live');
        expect(config.trading.mode.source).toBe('override');
    });
});

// ── buildFlatConfig ─────────────────────────────────────────────────

describe('buildFlatConfig', () => {
    it('returns section-keyed flat config', () => {
        const config = buildFlatConfig();
        expect(config.monitor.intervalMinutes).toBe(15);
        expect(config.liquidity.wsEnabled).toBe(true);
    });

    it('merges overrides into defaults', () => {
        const config = buildFlatConfig({ monitor: { intervalMinutes: 5 } });
        expect(config.monitor.intervalMinutes).toBe(5);
        // Other monitors stay default
        expect(config.monitor.rebalanceThreshold).toBe(3);
    });

    it('creates new sections from overrides', () => {
        const config = buildFlatConfig({ custom: { foo: 'bar' } });
        expect(config.custom.foo).toBe('bar');
    });
});
