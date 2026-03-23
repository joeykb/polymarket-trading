/**
 * Trading service — Facade module
 *
 * All trading logic has been split into focused modules:
 *   client.js  → CLOB client singleton, config, dataSvc helper, spend tracking
 *   verify.js  → Order fill verification (single + batch)
 *   buy.js     → Buy order placement and execution
 *   sell.js    → Sell order execution, deferred verification
 *   redeem.js  → On-chain position redemption
 *
 * This file re-exports the public API for backward compatibility
 * with index.js and the monitor service.
 */

// ── Re-exports from client.js ───────────────────────────────────────────
export { getConfig, refreshTradingConfig, getClient, dataSvc, getTodaySpend, recordSpend } from './client.js';

// ── Re-exports from verify.js ───────────────────────────────────────────
export { verifyOrderFill, verifyOrderFills } from './verify.js';

// ── Re-exports from buy.js ──────────────────────────────────────────────
export { executeRealBuyOrder } from './buy.js';

// ── Re-exports from sell.js ─────────────────────────────────────────────
export { executeSellOrder } from './sell.js';

// ── Re-exports from redeem.js ───────────────────────────────────────────
export { redeemPositions } from './redeem.js';

// ── Wallet Balance (lightweight, stays here) ────────────────────────────
import { getConfig, getClient } from './client.js';

export async function getWalletBalance() {
    const config = getConfig();
    if (!config.privateKey || config.mode === 'disabled') return null;

    try {
        const _client = await getClient();
        return null; // TODO: implement balance check via Polygon RPC
    } catch (err) {
        console.warn(`  ⚠️  Could not check balance: ${err.message}`);
        return null;
    }
}

// ── Retry Single Position (lightweight, stays here) ─────────────────────
import { placeSingleOrder } from './buy.js';

/**
 * Retry a single failed position — called from the dashboard API.
 */
export async function retrySinglePosition(position, liqTokenData = null) {
    const tradingCfg = getConfig();

    if (tradingCfg.mode === 'disabled') {
        return { success: false, error: 'Trading disabled' };
    }

    console.log(`\n  🔄 Retry: ${position.label}`);
    const result = await placeSingleOrder(position, tradingCfg, liqTokenData);
    return result;
}
