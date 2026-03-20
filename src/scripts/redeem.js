/**
 * Redeem resolved winning positions on Polymarket
 *
 * For neg-risk markets: calls NegRiskAdapter.redeemPositions(conditionId, amounts[])
 *   - amounts = [yesTokenAmount, noTokenAmount] (NOT indexSets!)
 *   - The adapter pulls tokens from msg.sender via ctf.safeBatchTransferFrom
 *   - Requires CTF approval for the NegRiskAdapter (setApprovalForAll)
 *   - Source: https://github.com/Polymarket/neg-risk-ctf-adapter/blob/main/src/NegRiskAdapter.sol
 *
 * For standard markets: calls CTF.redeemPositions(collateral, parentId, conditionId, indexSets[])
 *
 * Usage: node src/scripts/redeem.js [--dry-run]
 */

import { ethers } from 'ethers';
import { config as dotenvConfig } from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ClobClient } from '@polymarket/clob-client';

dotenvConfig();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const OUTPUT_DIR = path.resolve(__dirname, '../../output');

const POLYGON_RPC = process.env.POLYGON_RPC_URL || 'https://polygon.drpc.org';

// Polymarket contracts on Polygon
const USDC_E_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const CTF_ADDRESS = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
const NEG_RISK_ADAPTER = '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296';

// ABIs
const CTF_ABI = [
    'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)',
    'function balanceOf(address owner, uint256 id) view returns (uint256)',
    'function isApprovedForAll(address owner, address operator) view returns (bool)',
    'function setApprovalForAll(address operator, bool approved)',
];

// NegRiskAdapter.redeemPositions takes AMOUNTS not indexSets
// amounts[0] = yes token amount, amounts[1] = no token amount
const NEG_RISK_ADAPTER_ABI = [
    'function redeemPositions(bytes32 conditionId, uint256[] amounts)',
    'function getPositionId(bytes32 questionId, bool outcome) view returns (uint256)',
];

const ERC20_ABI = [
    'function balanceOf(address owner) view returns (uint256)',
    'function decimals() view returns (uint8)',
];

const GAS_OVERRIDES = {
    gasLimit: 300000,
    maxFeePerGas: ethers.utils.parseUnits('200', 'gwei'),
    maxPriorityFeePerGas: ethers.utils.parseUnits('30', 'gwei'),
};

const PARENT_COLLECTION_ID = ethers.constants.HashZero;

/**
 * Check market resolution via CLOB client
 */
async function checkMarketResolution(conditionId, clobClient) {
    try {
        const market = await clobClient.getMarket(conditionId);

        if (!market.closed) {
            return { resolved: false, winner: null, negRisk: false, winnerTokenId: null };
        }

        const negRisk = market.neg_risk === true;
        const winningToken = market.tokens?.find(t => t.winner === true);
        const winner = winningToken ? winningToken.outcome?.toUpperCase() : null;
        const winnerTokenId = winningToken?.token_id || null;

        return { resolved: true, winner, negRisk, winnerTokenId };
    } catch (err) {
        console.log(`  ⚠️  Could not check market ${conditionId?.substring(0, 12)}: ${err.message}`);
        return { resolved: false, winner: null, negRisk: false, winnerTokenId: null };
    }
}

async function main() {
    const dryRun = process.argv.includes('--dry-run');
    const privateKey = process.env.POLYMARKET_PRIVATE_KEY;

    if (!privateKey) {
        console.error('POLYMARKET_PRIVATE_KEY not set');
        process.exit(1);
    }

    const provider = new ethers.providers.StaticJsonRpcProvider(POLYGON_RPC, 137);
    const wallet = new ethers.Wallet(privateKey, provider);
    const ctf = new ethers.Contract(CTF_ADDRESS, CTF_ABI, wallet);
    const adapter = new ethers.Contract(NEG_RISK_ADAPTER, NEG_RISK_ADAPTER_ABI, wallet);

    // Initialize CLOB client
    const clobClient = new ClobClient(
        'https://clob.polymarket.com',
        137,
        wallet,
        {
            key: process.env.CLOB_API_KEY,
            secret: process.env.CLOB_SECRET,
            passphrase: process.env.CLOB_PASSPHRASE,
        },
    );

    console.log(`\n🏆 TempEdge Position Redeemer`);
    console.log(`═══════════════════════════════════════`);
    console.log(`  Wallet:   ${wallet.address}`);
    console.log(`  Mode:     ${dryRun ? '🧪 DRY RUN' : '💰 LIVE'}`);
    console.log(`  RPC:      ${POLYGON_RPC}`);

    const usdcE = new ethers.Contract(USDC_E_ADDRESS, ERC20_ABI, provider);
    const balBefore = await usdcE.balanceOf(wallet.address);
    const decimals = await usdcE.decimals();
    console.log(`  USDC.e:   $${ethers.utils.formatUnits(balBefore, decimals)}`);
    console.log(`═══════════════════════════════════════\n`);

    // ── Phase 1: Scan all on-chain positions from sessions ────────────
    console.log(`📡 Phase 1: Scanning on-chain token balances...\n`);

    const sessionFiles = fs.readdirSync(OUTPUT_DIR)
        .filter(f => f.startsWith('monitor-2026') && f.endsWith('.json'))
        .sort();

    const knownTokens = [];

    for (const file of sessionFiles) {
        const session = JSON.parse(fs.readFileSync(path.join(OUTPUT_DIR, file), 'utf8'));
        const date = file.replace('monitor-', '').replace('.json', '');
        const lastSnap = session.snapshots?.[session.snapshots.length - 1];
        if (!lastSnap) continue;

        for (const key of ['target', 'below', 'above']) {
            const range = lastSnap[key];
            if (!range || !range.clobTokenIds) continue;

            let conditionId = range.conditionId;
            if (!conditionId && session.buyOrder) {
                const pos = session.buyOrder.positions.find(p => p.question === range.question);
                if (pos?.conditionId) conditionId = pos.conditionId;
            }

            for (const tokenId of range.clobTokenIds) {
                knownTokens.push({ tokenId, question: range.question, conditionId, date, key });
            }
        }
    }

    console.log(`  Found ${knownTokens.length} known token IDs across ${sessionFiles.length} sessions\n`);

    const heldPositions = [];
    for (const token of knownTokens) {
        try {
            const bal = await ctf.balanceOf(wallet.address, token.tokenId);
            const balNum = parseFloat(ethers.utils.formatUnits(bal, 6));
            if (balNum > 0.001) {
                heldPositions.push({ ...token, shares: balNum, rawBalance: bal });
            }
        } catch { /* skip */ }
    }

    console.log(`  ${heldPositions.length} position(s) with on-chain balance:\n`);

    if (heldPositions.length === 0) {
        console.log(`  No on-chain positions found.`);
        return;
    }

    // ── Ensure CTF approval for NegRiskAdapter ──────────────────────
    const isApproved = await ctf.isApprovedForAll(wallet.address, NEG_RISK_ADAPTER);
    if (!isApproved) {
        console.log(`  🔐 Setting CTF approval for NegRiskAdapter...`);
        if (!dryRun) {
            const approveTx = await ctf.setApprovalForAll(NEG_RISK_ADAPTER, true, GAS_OVERRIDES);
            await approveTx.wait();
            console.log(`  ✅ Approved\n`);
        }
    }

    // ── Phase 2: Check resolution via CLOB and redeem ─────────────────
    console.log(`📋 Phase 2: Checking market resolution via CLOB...\n`);

    let totalRedeemed = 0;
    let totalValue = 0;

    const byCondition = {};
    for (const pos of heldPositions) {
        if (!pos.conditionId) {
            console.log(`  ⚠️  ${pos.date} ${pos.key}: no conditionId, skipping`);
            continue;
        }
        if (!byCondition[pos.conditionId]) byCondition[pos.conditionId] = [];
        byCondition[pos.conditionId].push(pos);
    }

    for (const [conditionId, positions] of Object.entries(byCondition)) {
        const pos0 = positions[0];
        const rangeDesc = pos0.question?.substring(55, 80) || 'unknown';

        const { resolved, winner, negRisk, winnerTokenId } = await checkMarketResolution(conditionId, clobClient);

        if (!resolved) {
            const totalShares = positions.reduce((s, p) => s + p.shares, 0);
            console.log(`  ⏳ ${pos0.date} ${rangeDesc}: ${totalShares.toFixed(2)} shares — not yet resolved`);
            continue;
        }

        if (winner !== 'YES') {
            // Losing positions can still be redeemed to clear tokens from wallet
            const totalShares = positions.reduce((s, p) => s + p.shares, 0);
            console.log(`  ❌ ${pos0.date} ${rangeDesc}: Resolved ${winner || 'NO'} — $0 payout, clearing ${totalShares.toFixed(2)} tokens`);

            if (dryRun) {
                console.log(`     🧪 DRY RUN — would redeem (burn) ${totalShares.toFixed(2)} losing tokens`);
                totalRedeemed++;
                continue;
            }

            // Redeem to burn tokens (returns $0 but clears them from portfolio)
            try {
                let tx;
                const bal = positions[0].rawBalance;
                if (negRisk) {
                    console.log(`     📝 NegRiskAdapter.redeemPositions (burn losing)...`);
                    tx = await adapter.redeemPositions(conditionId, [bal, 0], GAS_OVERRIDES);
                } else {
                    console.log(`     📝 CTF.redeemPositions (burn losing)...`);
                    tx = await ctf.redeemPositions(USDC_E_ADDRESS, PARENT_COLLECTION_ID, conditionId, [1, 2], GAS_OVERRIDES);
                }
                console.log(`     TX: ${tx.hash}`);
                await tx.wait();
                console.log(`     ✅ Tokens burned — position cleared from portfolio`);
                totalRedeemed++;
            } catch (err) {
                console.log(`     ⚠️  Burn failed: ${err.message}`);
            }
            continue;
        }

        const winnerPosition = winnerTokenId
            ? positions.find(p => p.tokenId === winnerTokenId)
            : positions[0];

        if (!winnerPosition) {
            // We hold the losing side — still redeem to clear
            const totalShares = positions.reduce((s, p) => s + p.shares, 0);
            console.log(`  ℹ️  ${pos0.date} ${rangeDesc}: Resolved YES but we hold the NO token (${totalShares.toFixed(2)} shares)`);

            if (dryRun) {
                console.log(`     🧪 DRY RUN — would burn ${totalShares.toFixed(2)} losing NO tokens`);
                totalRedeemed++;
                continue;
            }

            try {
                let tx;
                const bal = positions[0].rawBalance;
                if (negRisk) {
                    tx = await adapter.redeemPositions(conditionId, [0, bal], GAS_OVERRIDES);
                } else {
                    tx = await ctf.redeemPositions(USDC_E_ADDRESS, PARENT_COLLECTION_ID, conditionId, [1, 2], GAS_OVERRIDES);
                }
                console.log(`     TX: ${tx.hash}`);
                await tx.wait();
                console.log(`     ✅ NO tokens burned — cleared from portfolio`);
                totalRedeemed++;
            } catch (err) {
                console.log(`     ⚠️  Burn failed: ${err.message}`);
            }
            continue;
        }

        const totalShares = positions.reduce((s, p) => s + p.shares, 0);
        const value = totalShares;
        console.log(`  🏆 ${pos0.date} ${rangeDesc}: WON! ${totalShares.toFixed(2)} shares = $${value.toFixed(2)}`);
        console.log(`     conditionId: ${conditionId}`);
        console.log(`     negRisk: ${negRisk}`);

        if (dryRun) {
            console.log(`     🧪 DRY RUN — would redeem $${value.toFixed(2)}`);
            totalValue += value;
            continue;
        }

        try {
            let tx;

            if (negRisk) {
                // Neg-risk: NegRiskAdapter.redeemPositions(conditionId, amounts[])
                // amounts = [yesTokenAmount, noTokenAmount]
                // The adapter calls ctf.safeBatchTransferFrom(msg.sender, ...) to pull tokens
                const yesBalance = winnerPosition.rawBalance;
                console.log(`     📝 NegRiskAdapter.redeemPositions(conditionId, [${ethers.utils.formatUnits(yesBalance, 6)}, 0])...`);
                tx = await adapter.redeemPositions(
                    conditionId,
                    [yesBalance, 0],
                    GAS_OVERRIDES,
                );
            } else {
                // Standard: CTF.redeemPositions
                console.log(`     📝 CTF.redeemPositions...`);
                tx = await ctf.redeemPositions(
                    USDC_E_ADDRESS,
                    PARENT_COLLECTION_ID,
                    conditionId,
                    [1, 2],
                    GAS_OVERRIDES,
                );
            }

            console.log(`     TX: ${tx.hash}`);
            const receipt = await tx.wait();

            if (receipt.status === 0) {
                console.log(`     ❌ Transaction reverted on-chain!`);
                continue;
            }

            console.log(`     ✅ Redeemed! Gas used: ${receipt.gasUsed.toString()}`);
            totalRedeemed++;
            totalValue += value;

            // Update session file
            const sessionFile = path.join(OUTPUT_DIR, `monitor-${pos0.date}.json`);
            if (fs.existsSync(sessionFile)) {
                const session = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
                if (session.buyOrder?.positions) {
                    for (const p of session.buyOrder.positions) {
                        if (p.conditionId === conditionId) {
                            p.redeemed = true;
                            p.redeemedAt = new Date().toISOString();
                            p.redeemedTx = tx.hash;
                            p.redeemedValue = value;
                        }
                    }
                    fs.writeFileSync(sessionFile, JSON.stringify(session, null, 2));
                }
            }

        } catch (err) {
            console.log(`     ❌ Redeem failed: ${err.message}`);
            if (err.error?.reason) console.log(`        Reason: ${err.error.reason}`);
        }
    }

    // Summary
    const balAfter = !dryRun && totalRedeemed > 0 ? await usdcE.balanceOf(wallet.address) : balBefore;
    console.log(`\n═══════════════════════════════════════`);
    if (totalRedeemed > 0) {
        const gained = balAfter.sub(balBefore);
        console.log(`  Redeemed:  ${totalRedeemed} position(s)`);
        console.log(`  Expected:  $${totalValue.toFixed(2)}`);
        console.log(`  USDC.e:    $${ethers.utils.formatUnits(balBefore, decimals)} → $${ethers.utils.formatUnits(balAfter, decimals)}`);
        console.log(`  Gained:    +$${ethers.utils.formatUnits(gained, decimals)}`);
    } else if (dryRun && totalValue > 0) {
        console.log(`  Redeemable: $${totalValue.toFixed(2)}`);
    } else {
        console.log(`  No positions ready for redemption.`);
    }
    console.log(`═══════════════════════════════════════`);
}

main().catch((err) => {
    console.error('Fatal:', err.message);
    process.exit(1);
});
