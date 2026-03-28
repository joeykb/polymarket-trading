/**
 * Tests for shared inter-service authentication middleware
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// We need to test with different env values, so we mock the module loading
describe('serviceAuth', () => {
    let originalKey;

    beforeEach(() => {
        originalKey = process.env.SERVICE_AUTH_KEY;
    });

    afterEach(() => {
        if (originalKey !== undefined) {
            process.env.SERVICE_AUTH_KEY = originalKey;
        } else {
            delete process.env.SERVICE_AUTH_KEY;
        }
        vi.resetModules();
    });

    function createMockReq(method, path, headers = {}) {
        return {
            method,
            url: path,
            headers: { ...headers },
        };
    }

    function createMockRes() {
        const res = {
            writeHead: vi.fn(),
            end: vi.fn(),
            _status: null,
            _body: null,
        };
        // Capture what errorResponse would do
        res.writeHead.mockImplementation((status) => {
            res._status = status;
        });
        res.end.mockImplementation((body) => {
            res._body = body;
        });
        return res;
    }

    it('allows all requests when SERVICE_AUTH_KEY is not set', async () => {
        delete process.env.SERVICE_AUTH_KEY;
        const { requireServiceAuth } = await import('../shared/serviceAuth.js');

        const req = createMockReq('POST', '/api/buy');
        const res = createMockRes();

        const result = requireServiceAuth(req, res);
        expect(result).toBe(true);
        expect(res.writeHead).not.toHaveBeenCalled();
    });

    it('always allows health endpoint', async () => {
        process.env.SERVICE_AUTH_KEY = 'test-secret-key';
        const { requireServiceAuth } = await import('../shared/serviceAuth.js');

        const req = createMockReq('GET', '/health');
        const res = createMockRes();

        expect(requireServiceAuth(req, res)).toBe(true);
    });

    it('always allows healthz endpoint', async () => {
        process.env.SERVICE_AUTH_KEY = 'test-secret-key';
        const { requireServiceAuth } = await import('../shared/serviceAuth.js');

        const req = createMockReq('GET', '/healthz');
        const res = createMockRes();

        expect(requireServiceAuth(req, res)).toBe(true);
    });

    it('allows GET with allowPublicGet option', async () => {
        process.env.SERVICE_AUTH_KEY = 'test-secret-key';
        const { requireServiceAuth } = await import('../shared/serviceAuth.js');

        const req = createMockReq('GET', '/api/sessions');
        const res = createMockRes();

        expect(requireServiceAuth(req, res, { allowPublicGet: true })).toBe(true);
    });

    it('rejects POST without auth header', async () => {
        process.env.SERVICE_AUTH_KEY = 'test-secret-key';
        const { requireServiceAuth } = await import('../shared/serviceAuth.js');

        const req = createMockReq('POST', '/api/buy');
        const res = createMockRes();

        const result = requireServiceAuth(req, res);
        expect(result).toBe(false);
        expect(res._status).toBe(401);
    });

    it('rejects POST with wrong auth key', async () => {
        process.env.SERVICE_AUTH_KEY = 'test-secret-key';
        const { requireServiceAuth } = await import('../shared/serviceAuth.js');

        const req = createMockReq('POST', '/api/buy', { 'x-service-key': 'wrong-key' });
        const res = createMockRes();

        const result = requireServiceAuth(req, res);
        expect(result).toBe(false);
        expect(res._status).toBe(403);
    });

    it('allows POST with correct auth key', async () => {
        process.env.SERVICE_AUTH_KEY = 'test-secret-key';
        const { requireServiceAuth } = await import('../shared/serviceAuth.js');

        const req = createMockReq('POST', '/api/buy', { 'x-service-key': 'test-secret-key' });
        const res = createMockRes();

        const result = requireServiceAuth(req, res);
        expect(result).toBe(true);
        expect(res.writeHead).not.toHaveBeenCalled();
    });

    it('allows custom public paths', async () => {
        process.env.SERVICE_AUTH_KEY = 'test-secret-key';
        const { requireServiceAuth } = await import('../shared/serviceAuth.js');

        const req = createMockReq('POST', '/api/webhook');
        const res = createMockRes();

        const result = requireServiceAuth(req, res, { publicPaths: new Set(['/api/webhook']) });
        expect(result).toBe(true);
    });

    it('reports auth status correctly', async () => {
        process.env.SERVICE_AUTH_KEY = 'test-secret-key';
        const { getAuthStatus } = await import('../shared/serviceAuth.js');
        expect(getAuthStatus().enabled).toBe(true);
    });
});
