/**
 * Trading Service — CLOB Client, Config & Data-svc Access
 *
 * Shared infrastructure used by buy.js, sell.js, verify.js, and redeem.js.
 * Extracted from the monolithic trading.js.
 */

import { ClobClient } from '@polymarket/clob-client';
import { Wallet } from 'ethers';
import { svcRequest } from '../../shared/httpClient.js';

// ── Data-svc Connection ─────────────────────────────────────────────────

const DATA_SVC_URL = process.env.DATA_SVC_URL || 'http://data-svc:3005';

export async function dataSvc(method, path, body) {
    return svcRequest(`${DATA_SVC_URL}${path}`, { method, body });
}

// ── Config (data-svc overrides > env vars > defaults) ───────────────────

let _configCache = null;
let _configCacheTime = 0;
const CONFIG_CACHE_TTL_MS = 10_000;

async function _fetchRemoteConfig() {
    try {
        const data = await svcRequest(`${DATA_SVC_URL}/api/config`, { timeoutMs: 3000 });
        return data?.trading || {};
    } catch {
        /* intentional: falls back to env defaults */
        return {};
    }
}

export function getConfig() {
    const remote = _configCache || {};
    return {
        privateKey: process.env.POLYMARKET_PRIVATE_KEY || '',
        mode: remote.mode ?? process.env.TRADING_MODE ?? 'disabled',
        maxPositionCost: remote.maxPositionCost ?? parseFloat(process.env.MAX_POSITION_COST || '3'),
        maxDailySpend: remote.maxDailySpend ?? parseFloat(process.env.MAX_DAILY_SPEND || '10'),
        buySize: remote.buySize ?? parseFloat(process.env.BUY_SIZE || '5'),
        minOrderValue: remote.minOrderValue ?? parseFloat(process.env.MIN_ORDER_VALUE || '1.05'),
        clobHost: process.env.CLOB_HOST || 'https://clob.polymarket.com',
        chainId: parseInt(process.env.CHAIN_ID || '137'),
        maxSpreadPct: remote.maxSpreadPct ?? parseFloat(process.env.MAX_SPREAD_PCT || '0.4'),
        minAskDepth: remote.minAskDepth ?? parseFloat(process.env.MIN_ASK_DEPTH || '3'),
    };
}

export async function refreshTradingConfig() {
    const now = Date.now();
    if (_configCache && now - _configCacheTime < CONFIG_CACHE_TTL_MS) return;
    _configCache = await _fetchRemoteConfig();
    _configCacheTime = now;
}

// ── CLOB Client Singleton ───────────────────────────────────────────────

let _client = null;
let _signer = null;

export async function getClient() {
    if (_client) return _client;

    const tradingCfg = getConfig();
    if (!tradingCfg.privateKey) {
        throw new Error('POLYMARKET_PRIVATE_KEY not set');
    }

    _signer = new Wallet(tradingCfg.privateKey);
    console.log(`  🔑 Wallet: ${_signer.address}`);

    const tempClient = new ClobClient(tradingCfg.clobHost, tradingCfg.chainId, _signer);
    let apiCreds;
    try {
        apiCreds = await tempClient.createOrDeriveApiKey();
        console.log(`  🔐 API key derived successfully`);
    } catch (_err) {
        try {
            apiCreds = await tempClient.deriveApiKey();
            console.log(`  🔐 API key derived via fallback`);
        } catch (err2) {
            throw new Error(`Cannot derive API key: ${err2.message}. You may need to log in to polymarket.com with this wallet first.`, {
                cause: err2,
            });
        }
    }

    _client = new ClobClient(tradingCfg.clobHost, tradingCfg.chainId, _signer, apiCreds, 0, _signer.address);

    return _client;
}

export function getSigner() {
    return _signer;
}

// ── Daily Spend Tracking (via data-svc) ─────────────────────────────────

export async function getTodaySpend() {
    try {
        const data = await dataSvc('GET', '/api/spend');
        return data.totalSpent || 0;
    } catch {
        return 0; /* intentional: data-svc unreachable → assume $0 spent */
    }
}

export async function recordSpend(amount, orderDetails) {
    try {
        await dataSvc('POST', '/api/spend', {
            date: new Date().toISOString().slice(0, 10),
            amount,
            details: orderDetails,
        });
    } catch (err) {
        console.warn(`  ⚠️  Spend tracking failed: ${err.message}`);
    }
}
