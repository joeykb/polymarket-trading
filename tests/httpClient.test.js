/**
 * Tests for shared/httpClient.js — HTTP client utilities
 *
 * Tests the svcRequest, createClient, svcGet, svcPost functions
 * with mocked fetch() to verify timeout, error handling, JSON parsing,
 * and X-Request-Id propagation.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { svcRequest, createClient, svcGet, svcPost, createSoftClient } from '../shared/httpClient.js';

// Mock fetch globally
beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
    vi.unstubAllGlobals();
});

// ── svcRequest ──────────────────────────────────────────────────────

describe('svcRequest', () => {
    it('makes a GET request and returns JSON', async () => {
        fetch.mockResolvedValue({
            ok: true,
            status: 200,
            headers: { get: () => 'application/json' },
            json: () => Promise.resolve({ data: 'hello' }),
        });

        const result = await svcRequest('http://svc:3000/api/test');
        expect(result).toEqual({ data: 'hello' });
        expect(fetch).toHaveBeenCalledWith('http://svc:3000/api/test', expect.objectContaining({ method: 'GET' }));
    });

    it('returns text when content-type is not JSON', async () => {
        fetch.mockResolvedValue({
            ok: true,
            status: 200,
            headers: { get: () => 'text/plain' },
            text: () => Promise.resolve('OK'),
        });

        const result = await svcRequest('http://svc:3000/health');
        expect(result).toBe('OK');
    });

    it('throws on non-ok response', async () => {
        fetch.mockResolvedValue({
            ok: false,
            status: 404,
            text: () => Promise.resolve('Not found'),
        });

        await expect(svcRequest('http://svc:3000/missing')).rejects.toThrow('404');
    });

    it('includes error body in thrown message', async () => {
        fetch.mockResolvedValue({
            ok: false,
            status: 400,
            text: () => Promise.resolve('{"error":"bad request"}'),
        });

        await expect(svcRequest('http://svc:3000/api/trades', { method: 'POST', body: {} })).rejects.toThrow('bad request');
    });

    it('sends POST with JSON body', async () => {
        fetch.mockResolvedValue({
            ok: true,
            status: 201,
            headers: { get: () => 'application/json' },
            json: () => Promise.resolve({ id: 1 }),
        });

        const result = await svcRequest('http://svc:3000/api/trades', {
            method: 'POST',
            body: { type: 'buy', targetDate: '2026-03-25' },
        });

        expect(result).toEqual({ id: 1 });
        const callArgs = fetch.mock.calls[0];
        expect(JSON.parse(callArgs[1].body)).toEqual({ type: 'buy', targetDate: '2026-03-25' });
    });

    it('does not send body on GET even if provided', async () => {
        fetch.mockResolvedValue({
            ok: true,
            status: 200,
            headers: { get: () => 'application/json' },
            json: () => Promise.resolve({}),
        });

        await svcRequest('http://svc:3000/api/test', { method: 'GET', body: { ignored: true } });
        const callArgs = fetch.mock.calls[0];
        expect(callArgs[1].body).toBeUndefined();
    });

    it('forwards X-Request-Id when requestId is provided', async () => {
        fetch.mockResolvedValue({
            ok: true,
            status: 200,
            headers: { get: () => 'application/json' },
            json: () => Promise.resolve({}),
        });

        await svcRequest('http://svc:3000/api/test', { requestId: 'req-abc-123' });
        const callArgs = fetch.mock.calls[0];
        expect(callArgs[1].headers['X-Request-Id']).toBe('req-abc-123');
    });

    it('does not include X-Request-Id when requestId is not provided', async () => {
        fetch.mockResolvedValue({
            ok: true,
            status: 200,
            headers: { get: () => 'application/json' },
            json: () => Promise.resolve({}),
        });

        await svcRequest('http://svc:3000/api/test');
        const callArgs = fetch.mock.calls[0];
        expect(callArgs[1].headers['X-Request-Id']).toBeUndefined();
    });
});

// ── createClient ────────────────────────────────────────────────────

describe('createClient', () => {
    it('creates a client with get/post/put/patch/del methods', () => {
        const client = createClient('http://data-svc:3005');
        expect(client.get).toBeTypeOf('function');
        expect(client.post).toBeTypeOf('function');
        expect(client.put).toBeTypeOf('function');
        expect(client.patch).toBeTypeOf('function');
        expect(client.del).toBeTypeOf('function');
    });

    it('strips trailing slash from base URL', async () => {
        fetch.mockResolvedValue({
            ok: true,
            status: 200,
            headers: { get: () => 'application/json' },
            json: () => Promise.resolve({ ok: true }),
        });

        const client = createClient('http://data-svc:3005/');
        await client.get('/api/sessions');

        const calledUrl = fetch.mock.calls[0][0];
        expect(calledUrl).toBe('http://data-svc:3005/api/sessions');
    });
});

// ── svcGet (soft/non-throwing) ──────────────────────────────────────

describe('svcGet', () => {
    it('returns data on success', async () => {
        fetch.mockResolvedValue({
            ok: true,
            status: 200,
            headers: { get: () => 'application/json' },
            json: () => Promise.resolve({ value: 42 }),
        });

        const result = await svcGet('http://svc:3000/api/test');
        expect(result).toEqual({ value: 42 });
    });

    it('returns null on network error', async () => {
        fetch.mockRejectedValue(new Error('ECONNREFUSED'));

        const result = await svcGet('http://svc:3000/api/test');
        expect(result).toBeNull();
    });

    it('returns null on HTTP error', async () => {
        fetch.mockResolvedValue({
            ok: false,
            status: 500,
            text: () => Promise.resolve('Internal error'),
        });

        const result = await svcGet('http://svc:3000/api/test');
        expect(result).toBeNull();
    });
});

// ── svcPost (soft/non-throwing) ─────────────────────────────────────

describe('svcPost', () => {
    it('returns data on success', async () => {
        fetch.mockResolvedValue({
            ok: true,
            status: 201,
            headers: { get: () => 'application/json' },
            json: () => Promise.resolve({ id: 5 }),
        });

        const result = await svcPost('http://svc:3000/api/trades', { type: 'buy' });
        expect(result).toEqual({ id: 5 });
    });

    it('returns null on error', async () => {
        fetch.mockRejectedValue(new Error('timeout'));

        const result = await svcPost('http://svc:3000/api/trades', { type: 'buy' });
        expect(result).toBeNull();
    });
});

// ── createSoftClient ────────────────────────────────────────────────

describe('createSoftClient', () => {
    it('provides get and post methods that return null on error', async () => {
        fetch.mockRejectedValue(new Error('ECONNREFUSED'));

        const client = createSoftClient('http://data-svc:3005');
        const getResult = await client.get('/api/sessions');
        const postResult = await client.post('/api/trades', { type: 'buy' });

        expect(getResult).toBeNull();
        expect(postResult).toBeNull();
    });
});
