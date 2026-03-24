/**
 * Tests for shared/health.js — health check responses and dependency checking
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { healthResponse, checkDependency, checkDependencies } from '../shared/health.js';

// ── healthResponse ──────────────────────────────────────────────────

describe('healthResponse', () => {
    it('returns ok status with standard fields', () => {
        const res = healthResponse('test-svc');
        expect(res.status).toBe('ok');
        expect(res.service).toBe('test-svc');
        expect(res.uptime).toBeTypeOf('number');
        expect(res.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        expect(res.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('merges extra fields', () => {
        const res = healthResponse('test-svc', { streams: 3, mode: 'live' });
        expect(res.streams).toBe(3);
        expect(res.mode).toBe('live');
    });

    it('returns ok when all dependencies are healthy', () => {
        const deps = {
            dataSvc: { status: 'ok', latencyMs: 5 },
            tradingSvc: { status: 'ok', latencyMs: 8 },
        };
        const res = healthResponse('dashboard-svc', { dependencies: deps });
        expect(res.status).toBe('ok');
    });

    it('returns degraded when a dependency is down', () => {
        const deps = {
            dataSvc: { status: 'ok', latencyMs: 5 },
            tradingSvc: { status: 'down', latencyMs: 2000, error: 'timeout' },
        };
        const res = healthResponse('dashboard-svc', { dependencies: deps });
        expect(res.status).toBe('degraded');
    });

    it('returns degraded when all dependencies are down', () => {
        const deps = {
            dataSvc: { status: 'down', latencyMs: 2000, error: 'ECONNREFUSED' },
        };
        const res = healthResponse('trading-svc', { dependencies: deps });
        expect(res.status).toBe('degraded');
    });
});

// ── checkDependency ─────────────────────────────────────────────────

describe('checkDependency', () => {
    beforeEach(() => {
        vi.stubGlobal('fetch', vi.fn());
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('returns ok with latency on successful health check', async () => {
        fetch.mockResolvedValue({ ok: true, status: 200 });

        const result = await checkDependency('http://localhost:3005');
        expect(result.status).toBe('ok');
        expect(result.latencyMs).toBeTypeOf('number');
        expect(result.latencyMs).toBeGreaterThanOrEqual(0);
        expect(fetch).toHaveBeenCalledWith('http://localhost:3005/health', expect.any(Object));
    });

    it('returns down with error on HTTP error', async () => {
        fetch.mockResolvedValue({ ok: false, status: 503 });

        const result = await checkDependency('http://localhost:3005');
        expect(result.status).toBe('down');
        expect(result.error).toContain('503');
    });

    it('returns down on network error', async () => {
        fetch.mockRejectedValue(new Error('ECONNREFUSED'));

        const result = await checkDependency('http://localhost:3005');
        expect(result.status).toBe('down');
        expect(result.error).toContain('ECONNREFUSED');
    });
});

// ── checkDependencies ───────────────────────────────────────────────

describe('checkDependencies', () => {
    beforeEach(() => {
        vi.stubGlobal('fetch', vi.fn());
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('checks multiple services in parallel', async () => {
        fetch.mockResolvedValue({ ok: true, status: 200 });

        const result = await checkDependencies({
            dataSvc: 'http://data-svc:3005',
            tradingSvc: 'http://trading-svc:3004',
        });

        expect(result.dataSvc.status).toBe('ok');
        expect(result.tradingSvc.status).toBe('ok');
        expect(fetch).toHaveBeenCalledTimes(2);
    });

    it('reports mixed results correctly', async () => {
        fetch.mockResolvedValueOnce({ ok: true, status: 200 }).mockRejectedValueOnce(new Error('ECONNREFUSED'));

        const result = await checkDependencies({
            dataSvc: 'http://data-svc:3005',
            tradingSvc: 'http://trading-svc:3004',
        });

        expect(result.dataSvc.status).toBe('ok');
        expect(result.tradingSvc.status).toBe('down');
    });
});
