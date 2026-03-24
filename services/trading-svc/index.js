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

const log = createLogger('trading-svc');

const PORT = parseInt(process.env.TRADING_SVC_PORT || '3004');
const DATA_SVC_URL = process.env.DATA_SVC_URL || 'http://data-svc:3005';

// ── HTTP Helpers (shared) ───────────────────────────────────────────────

import { jsonResponse as jsonRes, errorResponse as errRes, readJsonBody as readBody } from '../../shared/httpServer.js';

// ── Request Handler ─────────────────────────────────────────────────────

async function handleRequest(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;
    const method = req.method;

    try {
        if (path === '/health' && method === 'GET') {
            const cfg = getConfig();
            const deps = await checkDependencies({ dataSvc: cfg.dataSvcUrl || 'http://data-svc:3005' });
            return jsonRes(
                res,
                healthResponse('trading-svc', {
                    mode: cfg.mode,
                    walletConfigured: !!process.env.POLYMARKET_PRIVATE_KEY,
                    dependencies: deps,
                }),
            );
        }

        if (path === '/api/buy' && method === 'POST') {
            await refreshTradingConfig();
            const body = await readBody(req);
            const result = await executeRealBuyOrder(body.snapshot, body.liqTokens || [], body.context || {});
            if (!result) return jsonRes(res, { success: false, error: 'Buy order failed or skipped' });
            return jsonRes(res, result);
        }

        if (path === '/api/sell' && method === 'POST') {
            await refreshTradingConfig();
            const body = await readBody(req);
            const result = await executeSellOrder(body.positions, body.context || {});
            if (!result) return jsonRes(res, { success: false, error: 'Sell order failed or skipped' });
            return jsonRes(res, result);
        }

        if (path === '/api/retry' && method === 'POST') {
            await refreshTradingConfig();
            const body = await readBody(req);
            const result = await retrySinglePosition(body.position, body.liqTokenData || null);
            return jsonRes(res, result);
        }

        if (path === '/api/redeem' && method === 'POST') {
            await refreshTradingConfig();
            const body = await readBody(req);
            if (!body.session) return errRes(res, 'session is required');
            const result = await redeemPositions(body.session);
            if (!result) return jsonRes(res, { success: false, error: 'Redeem skipped or no positions' });
            return jsonRes(res, result);
        }

        if (path === '/api/wallet' && method === 'GET') {
            const balance = await getWalletBalance();
            return jsonRes(res, { balance });
        }

        if (path === '/api/spend' && method === 'GET') {
            // Proxy to data-svc
            const spendRes = await fetch(`${DATA_SVC_URL}/api/spend`);
            const data = await spendRes.json();
            return jsonRes(res, data);
        }

        errRes(res, `Not found: ${method} ${path}`, 404);
    } catch (err) {
        console.error(`❌ ${method} ${path}:`, err.message);
        errRes(res, err.message, 500);
    }
}

// ── Server ──────────────────────────────────────────────────────────────

const server = http.createServer(requestLogger(log, handleRequest));
server.listen(PORT, async () => {
    await refreshTradingConfig();
    const cfg = getConfig();
    log.info('started', { port: PORT, mode: cfg.mode, wallet: process.env.POLYMARKET_PRIVATE_KEY ? 'configured' : 'missing', dataSvc: DATA_SVC_URL });
});

process.on('SIGINT', () => {
    server.close();
    process.exit(0);
});
process.on('SIGTERM', () => {
    server.close();
    process.exit(0);
});
