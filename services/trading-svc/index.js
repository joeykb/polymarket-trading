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
import { executeRealBuyOrder, executeSellOrder, retrySinglePosition, getWalletBalance, getConfig } from './trading.js';

const PORT = parseInt(process.env.TRADING_SVC_PORT || '3004');
const DATA_SVC_URL = process.env.DATA_SVC_URL || 'http://data-svc:3005';

// ── HTTP Helpers ────────────────────────────────────────────────────────

function jsonRes(res, data, status = 200) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
}

function errRes(res, message, status = 400) {
    jsonRes(res, { error: message }, status);
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try { resolve(body ? JSON.parse(body) : {}); }
            catch (e) { reject(new Error('Invalid JSON')); }
        });
        req.on('error', reject);
    });
}

// ── Request Handler ─────────────────────────────────────────────────────

async function handleRequest(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;
    const method = req.method;

    try {
        if (path === '/health' && method === 'GET') {
            const cfg = getConfig();
            return jsonRes(res, {
                status: 'ok',
                mode: cfg.mode,
                walletConfigured: !!cfg.privateKey,
            });
        }

        if (path === '/api/buy' && method === 'POST') {
            const body = await readBody(req);
            const result = await executeRealBuyOrder(body.snapshot, body.liqTokens || []);
            if (!result) return jsonRes(res, { success: false, error: 'Buy order failed or skipped' });
            return jsonRes(res, result);
        }

        if (path === '/api/sell' && method === 'POST') {
            const body = await readBody(req);
            const result = await executeSellOrder(body.positions, body.context || {});
            if (!result) return jsonRes(res, { success: false, error: 'Sell order failed or skipped' });
            return jsonRes(res, result);
        }

        if (path === '/api/retry' && method === 'POST') {
            const body = await readBody(req);
            const result = await retrySinglePosition(body.position, body.liqTokenData || null);
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

const server = http.createServer(handleRequest);
server.listen(PORT, () => {
    const cfg = getConfig();
    console.log(`\n💰 TempEdge Trading Service`);
    console.log(`   Port:    ${PORT}`);
    console.log(`   Mode:    ${cfg.mode}`);
    console.log(`   Wallet:  ${cfg.privateKey ? '✅ configured' : '❌ missing'}`);
    console.log(`   Data:    ${DATA_SVC_URL}`);
    console.log(`   Ready.\n`);
});

process.on('SIGINT', () => { server.close(); process.exit(0); });
process.on('SIGTERM', () => { server.close(); process.exit(0); });
