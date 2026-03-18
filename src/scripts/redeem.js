/**
 * Redeem resolved winning positions on Polymarket
 *
 * Two-phase approach:
 *  Phase 1: Scan on-chain CTF token balances for all known positions
 *  Phase 2: For positions with balance > 0 on resolved markets, call redeemPositions
 *
 * This checks actual on-chain state, not just session logs, so it catches
 * positions that were filled but recorded as "failed" in our data.
 *
 * Usage: node src/scripts/redeem.js [--dry-run]
 */

import { ethers } from 'ethers';
import { config as dotenvConfig } from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

dotenvConfig();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const OUTPUT_DIR = path.resolve(__dirname, '../../output');

const POLYGON_RPC = process.env.POLYGON_RPC_URL || 'https://polygon.drpc.org';
const GAMMA_API = process.env.GAMMA_BASE_URL || 'https://gamma-api.polymarket.com';

// Polymarket contracts on Polygon
const USDC_E_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const CTF_CONTRACT = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
const NEG_RISK_ADAPTER = '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296';

// ABIs
const CTF_ABI = [
    'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)',
    'function balanceOf(address owner, uint256 id) view returns (uint256)',
    'function payoutDenominator(bytes32 conditionId) view returns (uint256)',
    'function payoutNumerators(bytes32 conditionId, uint256 index) view returns (uint256)',
];

const NEG_RISK_ADAPTER_ABI = [
    'function redeemPositions(bytes32 conditionId, uint256[] indexSets)',
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
 * Check if a market has resolved via Gamma API
 */
/**
 * Check if a market has resolved using ON-CHAIN payout data.
 * The CTF contract's payoutDenominator > 0 means the condition is resolved.
 * payoutNumerators(conditionId, 0) > 0 means YES won.
 * 
 * Falls back to Gamma API for neg_risk flag only.
 */
async function checkMarketResolution(conditionId, ctfContract) {
    try {
        // On-chain check — authoritative source of truth
        const denom = await ctfContract.payoutDenominator(conditionId);
        const resolved = denom.gt(0);

        if (!resolved) {
            return { resolved: false, winner: null, negRisk: false };
        }

        const yesNumerator = await ctfContract.payoutNumerators(conditionId, 0);
        const winner = yesNumerator.gt(0) ? 'YES' : 'NO';

        // Check neg_risk from Gamma API (needed to pick CTF vs NegRiskAdapter)
        let negRisk = false;
        try {
            const url = `${GAMMA_API}/markets?condition_id=${conditionId}`;
            const res = await fetch(url);
            if (res.ok) {
                const markets = await res.json();
                const market = Array.isArray(markets) ? markets[0] : markets;
                negRisk = market?.neg_risk === true || market?.negRisk === true;
            }
        } catch { /* default to false */ }

        return { resolved, winner, negRisk };
    } catch (err) {
        console.log(`  ⚠️  Could not check resolution for ${conditionId?.substring(0, 12)}: ${err.message}`);
        return { resolved: false, winner: null, negRisk: false };
    }
}

/**
 * Look up conditionId by matching clobTokenId against the event's markets.
 * Uses the event slug to find the correct event, then matches by tokenId.
 */
async function lookupConditionId(question, tokenId, date) {
    try {
        // Parse the month/day from the question or date
        const dateObj = new Date(date + 'T12:00:00');
        const monthNames = ['january','february','march','april','may','june',
                            'july','august','september','october','november','december'];
        const month = monthNames[dateObj.getMonth()];
        const day = dateObj.getDate();
        const slug = `highest-temperature-in-nyc-on-${month}-${day}`;

        const url = `${GAMMA_API}/events?slug=${slug}`;
        const res = await fetch(url);
        if (!res.ok) return null;
        const events = await res.json();
        if (!Array.isArray(events) || events.length === 0) return null;

        // Search through the event's markets for matching clobTokenId or question
        for (const event of events) {
            if (!event.markets) continue;
            for (const m of event.markets) {
                // Match by clobTokenId
                let mTokenIds = [];
                try {
                    mTokenIds = typeof m.clobTokenIds === 'string'
                        ? JSON.parse(m.clobTokenIds) : (m.clobTokenIds || []);
                } catch {}
                if (tokenId && mTokenIds.includes(tokenId)) {
                    return m.conditionId;
                }
                // Fall back to question match
                if (m.question === question) {
                    return m.conditionId;
                }
            }
        }
        return null;
    } catch {
        return null;
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
    const ctf = new ethers.Contract(CTF_CONTRACT, CTF_ABI, wallet);

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

    // Collect all known token IDs with metadata
    const knownTokens = []; // { tokenId, question, conditionId, date, key, negRisk }

    for (const file of sessionFiles) {
        const session = JSON.parse(fs.readFileSync(path.join(OUTPUT_DIR, file), 'utf8'));
        const date = file.replace('monitor-', '').replace('.json', '');
        const lastSnap = session.snapshots?.[session.snapshots.length - 1];
        if (!lastSnap) continue;

        for (const key of ['target', 'below', 'above']) {
            const range = lastSnap[key];
            if (!range || !range.clobTokenIds) continue;

            // Resolve conditionId if missing
            let conditionId = range.conditionId;
            if (!conditionId && range.question) {
                conditionId = await lookupConditionId(range.question, range.clobTokenIds[0], date);
            }

            // Also check buyOrder positions for conditionId
            if (!conditionId && session.buyOrder) {
                const pos = session.buyOrder.positions.find(p => p.question === range.question);
                if (pos?.conditionId) conditionId = pos.conditionId;
            }

            for (const tokenId of range.clobTokenIds) {
                knownTokens.push({
                    tokenId,
                    question: range.question,
                    conditionId,
                    date,
                    key,
                });
            }
        }
    }

    console.log(`  Found ${knownTokens.length} known token IDs across ${sessionFiles.length} sessions\n`);

    // Check on-chain balances for all tokens
    const heldPositions = [];
    for (const token of knownTokens) {
        try {
            const bal = await ctf.balanceOf(wallet.address, token.tokenId);
            const balNum = parseFloat(ethers.utils.formatUnits(bal, 6));
            if (balNum > 0.001) { // Filter dust
                heldPositions.push({ ...token, shares: balNum, rawBalance: bal });
            }
        } catch {
            // Token ID might be invalid format, skip
        }
    }

    console.log(`  ${heldPositions.length} position(s) with on-chain balance:\n`);

    if (heldPositions.length === 0) {
        console.log(`  No on-chain positions found.`);
        return;
    }

    // ── Phase 2: Check resolution and redeem winners ─────────────────
    console.log(`📋 Phase 2: Checking market resolution...\n`);

    let totalRedeemed = 0;
    let totalValue = 0;

    // Group by conditionId to avoid duplicate redemption calls
    const byCondition = {};
    for (const pos of heldPositions) {
        if (!pos.conditionId) {
            console.log(`  ⚠️  ${pos.date} ${pos.key}: ${pos.question?.substring(55, 80)} — no conditionId, skipping`);
            continue;
        }
        if (!byCondition[pos.conditionId]) {
            byCondition[pos.conditionId] = [];
        }
        byCondition[pos.conditionId].push(pos);
    }

    for (const [conditionId, positions] of Object.entries(byCondition)) {
        const pos0 = positions[0];
        const { resolved, winner, negRisk } = await checkMarketResolution(conditionId, ctf);
        const rangeDesc = pos0.question?.substring(55, 80) || 'unknown';

        if (!resolved) {
            const totalShares = positions.reduce((s, p) => s + p.shares, 0);
            console.log(`  ⏳ ${pos0.date} ${rangeDesc}: ${totalShares.toFixed(2)} shares — not yet resolved`);
            continue;
        }

        if (winner !== 'YES') {
            // Resolved NO — still try to redeem (burns worthless tokens, recovers nothing but cleans up)
            console.log(`  ❌ ${pos0.date} ${rangeDesc}: Resolved ${winner || 'NO'} — no payout`);
            continue;
        }

        // WINNER!
        const totalShares = positions.reduce((s, p) => s + p.shares, 0);
        const value = totalShares; // $1.00 per share
        console.log(`  🏆 ${pos0.date} ${rangeDesc}: WON! ${totalShares.toFixed(2)} shares = $${value.toFixed(2)}`);
        console.log(`     conditionId: ${conditionId}`);
        console.log(`     negRisk: ${negRisk}`);

        if (dryRun) {
            console.log(`     🧪 DRY RUN — would redeem $${value.toFixed(2)}`);
            totalValue += value;
            continue;
        }

        // Execute redemption
        try {
            let tx;
            if (negRisk) {
                const adapter = new ethers.Contract(NEG_RISK_ADAPTER, NEG_RISK_ADAPTER_ABI, wallet);
                console.log(`     📝 Calling NegRiskAdapter.redeemPositions...`);
                tx = await adapter.redeemPositions(
                    conditionId,
                    [1, 2],
                    GAS_OVERRIDES,
                );
            } else {
                console.log(`     📝 Calling CTF.redeemPositions...`);
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
            console.log(`     ✅ Redeemed! Gas used: ${receipt.gasUsed.toString()}`);

            totalRedeemed++;
            totalValue += value;

            // Update session file with redemption info
            const sessionFile = path.join(OUTPUT_DIR, `monitor-${pos0.date}.json`);
            if (fs.existsSync(sessionFile)) {
                const session = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
                if (session.buyOrder?.positions) {
                    for (const p of session.buyOrder.positions) {
                        if (p.question === pos0.question || p.conditionId === conditionId) {
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
