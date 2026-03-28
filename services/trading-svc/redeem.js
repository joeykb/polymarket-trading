/**
 * Trading Service — On-Chain Redeem Operations
 *
 * Handles redemption of resolved winning positions on Polygon.
 * Supports both standard CTF redeems and Neg-Risk Adapter redeems.
 *
 * Extracted from the monolithic trading.js.
 */

import { Wallet, Contract, providers, constants, utils } from 'ethers';
import { getClient, getConfig, dataSvc, clobCall } from './client.js';
import { createLogger } from '../../shared/logger.js';


const log = createLogger('trading-svc');
// ── Polymarket Contracts on Polygon ─────────────────────────────────────

const USDC_E_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const CTF_ADDRESS = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
const NEG_RISK_ADAPTER = '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296';

const CTF_ABI = [
    'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)',
    'function balanceOf(address owner, uint256 id) view returns (uint256)',
    'function isApprovedForAll(address owner, address operator) view returns (bool)',
    'function setApprovalForAll(address operator, bool approved)',
];

const NEG_RISK_ADAPTER_ABI = ['function redeemPositions(bytes32 conditionId, uint256[] amounts)'];

const ERC20_ABI = ['function balanceOf(address owner) view returns (uint256)', 'function decimals() view returns (uint8)'];

const REDEEM_GAS_OVERRIDES = {
    gasLimit: 300000,
    maxFeePerGas: utils.parseUnits('200', 'gwei'),
    maxPriorityFeePerGas: utils.parseUnits('30', 'gwei'),
};

// ── Polygon Provider ────────────────────────────────────────────────────

/**
 * Get a provider that bypasses the VPN proxy.
 * Polygon RPC is not geo-blocked, and sending it through the VPN
 * proxy can cause connection issues.
 */
function getPolygonProvider() {
    const rpc = process.env.POLYGON_RPC_URL || 'https://polygon.drpc.org';
    return new providers.StaticJsonRpcProvider(rpc, 137);
}

// ── Market Resolution Check ─────────────────────────────────────────────

/**
 * Check market resolution via CLOB client
 */
export async function checkMarketResolution(conditionId) {
    try {
        const client = await getClient();
        const market = await clobCall(() => client.getMarket(conditionId));

        if (!market) return { resolved: false };

        return {
            resolved: market.closed || false,
            question: market.question || '',
            outcome: market.winning_outcome !== undefined ? market.winning_outcome : null,
            outcomes: market.outcomes,
        };
    } catch (err) {
        log.warn(`  ⚠️  Market resolution check failed: ${err.message}`);
        return { resolved: false, error: err.message };
    }
}

// ── On-Chain Redeem ─────────────────────────────────────────────────────

/**
 * Redeem resolved winning positions on-chain.
 *
 * Called by the monitor when a market closes (eventClosed === true).
 *
 * Handles both:
 *   - Neg-risk markets → NegRiskAdapter.redeemPositions(conditionId, [yesAmt, noAmt])
 *   - Standard markets → CTF.redeemPositions(USDC_E, HashZero, conditionId, [1, 2])
 *
 * @param {Object} session - The full monitoring session with buyOrder.positions[]
 * @returns {Promise<Object>} - { redeemed, totalValue, positions[] }
 */
export async function redeemPositions(session) {
    const tradingCfg = getConfig();

    if (tradingCfg.mode === 'disabled') {
        log.info('  ⚠️  Trading disabled — skipping redeem');
        return null;
    }

    if (!session?.buyOrder?.positions?.length) {
        log.info('  ⚠️  No positions in session to redeem');
        return null;
    }

    const dryRun = tradingCfg.mode === 'dry-run';
    const provider = getPolygonProvider();
    const privateKey = process.env.POLYMARKET_PRIVATE_KEY || '';
    if (!privateKey) {
        log.info('  ⚠️  POLYMARKET_PRIVATE_KEY not set — skipping redeem');
        return null;
    }
    const wallet = new Wallet(privateKey, provider);
    const ctf = new Contract(CTF_ADDRESS, CTF_ABI, wallet);
    const adapter = new Contract(NEG_RISK_ADAPTER, NEG_RISK_ADAPTER_ABI, wallet);

    log.info(`\n  🏆 Redeeming positions — ${dryRun ? '🧪 DRY RUN' : '💰 LIVE'}`);

    // Check USDC.e balance before
    let balBefore = null;
    if (!dryRun) {
        try {
            const usdc = new Contract(USDC_E_ADDRESS, ERC20_ABI, provider);
            balBefore = await usdc.balanceOf(wallet.address);
            log.info(`  💰 USDC.e balance before: $${utils.formatUnits(balBefore, 6)}`);
        } catch (err) {
            log.warn(`  ⚠️  Could not check USDC.e balance: ${err.message}`);
        }
    }

    // Group positions by conditionId for batch redemption
    const byCondition = {};
    for (const pos of session.buyOrder.positions) {
        if (pos.soldAt || pos.soldStatus === 'placed') {
            log.info(`  ⏭️  ${pos.label}: already sold — skipping redeem`);
            continue;
        }
        const cid = pos.conditionId;
        if (!cid) continue;
        if (!byCondition[cid]) byCondition[cid] = [];
        byCondition[cid].push(pos);
    }

    const results = [];
    let totalRedeemed = 0;
    let totalValue = 0;

    for (const [conditionId, positions] of Object.entries(byCondition)) {
        const pos0 = positions[0];
        log.info(`\n  📦 Condition: ${conditionId.slice(0, 10)}...`);
        log.info(`     Positions: ${positions.map((p) => p.label).join(', ')}`);

        try {
            // Check resolution via CLOB — don't let CLOB failures block redemption
            let resolution = { resolved: false };
            try {
                resolution = await checkMarketResolution(conditionId);
            } catch (clobErr) {
                log.warn('clob_resolution_failed', { conditionId: conditionId.slice(0, 10), error: clobErr.message });
                const targetDate = session.targetDate;
                const isExpired = targetDate && new Date(targetDate + 'T23:59:59-05:00') < new Date();
                if (isExpired) {
                    log.info('redeem_past_date', { targetDate, action: 'proceeding_on_chain' });
                    resolution = { resolved: true, outcome: null, clobFailed: true };
                } else {
                    results.push({ label: pos0.label, question: pos0.question, status: 'clob_error', conditionId, error: clobErr.message });
                    continue;
                }
            }
            if (!resolution.resolved) {
                log.info(`  ⏳ Market not yet resolved — skipping`);
                results.push({
                    label: pos0.label,
                    question: pos0.question,
                    status: 'pending',
                    conditionId,
                });
                continue;
            }
            log.info(`  ✅ Market resolved: outcome=${resolution.outcome}`);

            // Check CTF balance for YES token
            const yesTokenId = pos0.clobTokenIds?.[0] || pos0.clobTokenId;
            let yesBalance = null;
            if (yesTokenId && !dryRun) {
                try {
                    yesBalance = await ctf.balanceOf(wallet.address, yesTokenId);
                    log.info(`  📊 YES token balance: ${utils.formatUnits(yesBalance, 6)} (tokenId: ${yesTokenId.slice(0, 10)}...)`);
                } catch (err) {
                    log.warn(`  ⚠️  Could not check balance: ${err.message}`);
                }
            }

            if (dryRun) {
                log.info(`  🧪 DRY RUN: Would redeem ${positions.length} position(s)`);
                for (const p of positions) {
                    const value = p.shares * 1; // Each winning share = $1
                    results.push({
                        label: p.label,
                        question: p.question,
                        status: 'dry-run',
                        shares: p.shares,
                        value: parseFloat(value.toFixed(4)),
                        conditionId,
                    });
                    totalRedeemed++;
                    totalValue += value;
                }
                continue;
            }

            // Determine if neg-risk market
            const isNegRisk = pos0.neg_risk === true || pos0.isNegRisk === true;

            if (isNegRisk) {
                // NegRiskAdapter redeem
                const yesAmt = yesBalance || utils.parseUnits(String(pos0.shares || 1), 6);
                const noAmt = 0;

                // Ensure approval
                const isApproved = await ctf.isApprovedForAll(wallet.address, NEG_RISK_ADAPTER);
                if (!isApproved) {
                    log.info(`  🔓 Approving NegRiskAdapter...`);
                    const approveTx = await ctf.setApprovalForAll(NEG_RISK_ADAPTER, true, REDEEM_GAS_OVERRIDES);
                    await approveTx.wait();
                    log.info(`  ✅ Approved`);
                }

                log.info(`  📤 Redeeming via NegRiskAdapter...`);
                const tx = await adapter.redeemPositions(conditionId, [yesAmt, noAmt], REDEEM_GAS_OVERRIDES);
                const receipt = await tx.wait();
                log.info(`  ✅ Redeemed: tx ${receipt.transactionHash}`);

                for (const p of positions) {
                    const value = p.shares * 1;
                    results.push({
                        label: p.label,
                        question: p.question,
                        status: 'redeemed',
                        shares: p.shares,
                        value: parseFloat(value.toFixed(4)),
                        txHash: receipt.transactionHash,
                        conditionId,
                    });
                    totalRedeemed++;
                    totalValue += value;
                }
            } else {
                // Standard CTF redeem
                log.info(`  📤 Redeeming via CTF...`);
                const tx = await ctf.redeemPositions(USDC_E_ADDRESS, constants.HashZero, conditionId, [1, 2], REDEEM_GAS_OVERRIDES);
                const receipt = await tx.wait();
                log.info(`  ✅ Redeemed: tx ${receipt.transactionHash}`);

                for (const p of positions) {
                    const value = p.shares * 1;
                    results.push({
                        label: p.label,
                        question: p.question,
                        status: 'redeemed',
                        shares: p.shares,
                        value: parseFloat(value.toFixed(4)),
                        txHash: receipt.transactionHash,
                        conditionId,
                    });
                    totalRedeemed++;
                    totalValue += value;
                }
            }
        } catch (err) {
            log.error(`  ❌ Redeem failed for ${pos0.label}: ${err.message}`);
            results.push({
                label: pos0.label,
                question: pos0.question,
                status: 'failed',
                error: err.message,
                conditionId,
            });
        }
    }

    // Check USDC.e balance after
    if (!dryRun && totalRedeemed > 0 && balBefore !== null) {
        try {
            const usdc = new Contract(USDC_E_ADDRESS, ERC20_ABI, provider);
            const balAfter = await usdc.balanceOf(wallet.address);
            const gained = balAfter.sub(balBefore);
            log.info(
                `\n  💰 USDC.e: $${utils.formatUnits(balBefore, 6)} → $${utils.formatUnits(balAfter, 6)} (+$${utils.formatUnits(gained, 6)})`,
            );
        } catch (err) {
            log.warn(`  ⚠️  Could not check USDC.e balance after: ${err.message}`);
        }
    }

    log.info(`\n  📋 Redeem Summary: ${totalRedeemed} position(s), $${totalValue.toFixed(2)} value`);

    // Persist to database
    if (totalRedeemed > 0) {
        try {
            await dataSvc('POST', '/api/trades', {
                sessionId: session.id || null,
                marketId: 'nyc',
                targetDate: session.targetDate || null,
                type: 'redeem',
                mode: tradingCfg.mode,
                placedAt: new Date().toISOString(),
                totalCost: 0,
                totalProceeds: totalValue,
                status: 'filled',
                metadata: { redeemed: totalRedeemed, results },
            });
        } catch (dbErr) {
            log.warn(`  ⚠️  DB write failed (non-fatal): ${dbErr.message}`);
        }
    }

    return {
        redeemed: totalRedeemed,
        totalValue,
        positions: results,
        dryRun,
    };
}
