/**
 * TempEdge Trading Service — HTTP API for buy/sell/redeem via CLOB
 *
 * This is the ONLY service that needs the VPN sidecar.
 * All CLOB API calls route through the VPN tunnel transparently
 * via shared pod network namespace.
 *
 * Port: 3004
 *
 * API:
 *   POST /api/buy       → execute buy order from snapshot
 *   POST /api/sell      → execute sell order for positions
 *   POST /api/redeem    → redeem resolved positions
 *   POST /api/retry     → retry a single failed position
 *   GET  /api/spend     → today's spend summary
 *   GET  /health        → health check
 */

import 'dotenv/config';
import http from 'http';
import { healthResponse, checkDependencies } from '../../shared/health.js';
import { createLogger, requestLogger } from '../../shared/logger.js';
import {
    executeRealBuyOrder,
    executeSellOrder,
    retrySinglePosition,
    redeemPositions,
    getWalletBalance,
    getConfig,
    refreshTradingConfig,
} from './trading.js';
import { getClobBreakerStats } from './client.js';

const log = createLogger('trading-svc');

const PORT = parseInt(process.env.TRADING_SVC_PORT || '3004');
const DATA_SVC_URL = process.env.DATA_SVC_URL || 'http://data-svc:3005';

// ── HTTP Helpers (shared) ───────────────────────────────────────────────

import { jsonResponse as jsonRes, errorResponse as errRes, readJsonBody as readBody } from '../../shared/httpServer.js';
import { svcGet } from '../../shared/httpClient.js';
import { validateBuyRequest, validateSellRequest, validateRetryRequest, validateRedeemRequest } from './validation.js';
import { createRateLimiter } from '../../shared/rateLimiter.js';
import { requireServiceAuth, getAuthStatus } from '../../shared/serviceAuth.js';
import { createMetrics, createHttpMetrics } from '../../shared/metrics.js';

// ── Prometheus Metrics ──────────────────────────────────────────────────
const metrics = createMetrics('trading_svc');
const { wrapHandler } = createHttpMetrics(metrics);
const tradeOps = metrics.counter('trade_operations_total', 'Trade operations executed', ['type', 'result']);
const tradeLatency = metrics.histogram('trade_operation_duration_ms', 'Trade operation latency', ['type']);

// Rate limiters: trading operations are expensive (real money), so strict limits.
// 5 trade ops/min prevents runaway loops from draining the wallet.
const tradeLimiter = createRateLimiter({ windowMs: 60_000, maxRequests: 5 });
const retryLimiter = createRateLimiter({ windowMs: 60_000, maxRequests: 10 });

// ── Request Handler ─────────────────────────────────────────────────────

async function handleRequest(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;
    const method = req.method;

    try {
        // Auth gate: POST endpoints require service key, GET/health are public
        if (!requireServiceAuth(req, res, { allowPublicGet: true })) return;

        if (path === '/metrics' && method === 'GET') {
            return metrics.handleRequest(res);
        }

        if (path === '/health' && method === 'GET') {
            const cfg = getConfig();
            const deps = await checkDependencies({ dataSvc: cfg.dataSvcUrl || 'http://data-svc:3005' });
            return jsonRes(
                res,
                healthResponse('trading-svc', {
                    mode: cfg.mode,
                    walletConfigured: !!process.env.POLYMARKET_PRIVATE_KEY,
                    dependencies: deps,
                    circuitBreaker: getClobBreakerStats(),
                    auth: getAuthStatus(),
                }),
            );
        }

        if (path === '/api/buy' && method === 'POST') {
            if (tradeLimiter.isLimited('trade')) {
                log.warn('rate_limited', { path, remaining: 0 });
                res.setHeader('Retry-After', '60');
                return errRes(res, 'Rate limit exceeded — max 5 trades/min', 429);
            }
            await refreshTradingConfig();
            const body = await readBody(req);
            const v = validateBuyRequest(body);
            if (!v.valid) return errRes(res, v.error);
            const result = await executeRealBuyOrder(v.data.snapshot, v.data.liqTokens, v.data.context);
            if (!result) return jsonRes(res, { success: false, error: 'Buy order failed or skipped' });
            return jsonRes(res, result);
        }

        if (path === '/api/sell' && method === 'POST') {
            if (tradeLimiter.isLimited('trade')) {
                log.warn('rate_limited', { path, remaining: 0 });
                res.setHeader('Retry-After', '60');
                return errRes(res, 'Rate limit exceeded — max 5 trades/min', 429);
            }
            await refreshTradingConfig();
            const body = await readBody(req);
            const v = validateSellRequest(body);
            if (!v.valid) return errRes(res, v.error);
            const result = await executeSellOrder(v.data.positions, v.data.context);
            if (!result) return jsonRes(res, { success: false, error: 'Sell order failed or skipped' });
            return jsonRes(res, result);
        }

        if (path === '/api/retry' && method === 'POST') {
            if (retryLimiter.isLimited('retry')) {
                log.warn('rate_limited', { path, remaining: 0 });
                res.setHeader('Retry-After', '60');
                return errRes(res, 'Rate limit exceeded — max 10 retries/min', 429);
            }
            await refreshTradingConfig();
            const body = await readBody(req);
            const v = validateRetryRequest(body);
            if (!v.valid) return errRes(res, v.error);
            const result = await retrySinglePosition(v.data.position, v.data.liqTokenData);
            return jsonRes(res, result);
        }

        if (path === '/api/redeem' && method === 'POST') {
            if (tradeLimiter.isLimited('trade')) {
                log.warn('rate_limited', { path, remaining: 0 });
                res.setHeader('Retry-After', '60');
                return errRes(res, 'Rate limit exceeded — max 5 trades/min', 429);
            }
            await refreshTradingConfig();
            const body = await readBody(req);
            const v = validateRedeemRequest(body);
            if (!v.valid) return errRes(res, v.error);
            const result = await redeemPositions(v.data.session);
            if (!result) return jsonRes(res, { success: false, error: 'Redeem skipped or no positions' });
            return jsonRes(res, result);
        }

        if (path === '/api/wallet' && method === 'GET') {
            const balance = await getWalletBalance();
            return jsonRes(res, { balance });
        }

        if (path === '/api/spend' && method === 'GET') {
            const data = await svcGet(`${DATA_SVC_URL}/api/spend`);
            return jsonRes(res, data || { error: 'spend data unavailable' });
        }

        errRes(res, `Not found: ${method} ${path}`, 404);
    } catch (err) {
        log.error('request_error', { method, path, error: err.message });
        errRes(res, err.message, 500);
    }
}

// ── Server ──────────────────────────────────────────────────────────────

const server = http.createServer(wrapHandler(requestLogger(log, handleRequest)));
server.listen(PORT, async () => {
    await refreshTradingConfig();
    const cfg = getConfig();
    log.info('started', { port: PORT, mode: cfg.mode, wallet: process.env.POLYMARKET_PRIVATE_KEY ? 'configured' : 'missing', dataSvc: DATA_SVC_URL });
});

// ── Graceful Shutdown ───────────────────────────────────────────────────

function gracefulShutdown(signal) {
    log.info('shutdown_initiated', { signal });
    server.close(() => {
        log.info('shutdown_complete', { signal });
        process.exit(0);
    });
    // Force exit after 10s if connections don't drain
    setTimeout(() => {
        log.warn('shutdown_forced', { signal, reason: 'timeout after 10s' });
        process.exit(1);
    }, 10_000).unref();
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
