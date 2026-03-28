/**
 * Manual Redeem Script — Based on working commit 38f02ec
 *
 * Scans on-chain CTF token balances and redeems resolved positions.
 * Does NOT rely on session file status — checks actual chain state.
 *
 * Usage (from repo root):
 *   cd services/trading-svc && node ../../scripts/manual-redeem.mjs --dry-run
 *   cd services/trading-svc && node ../../scripts/manual-redeem.mjs
 *
 * Or with env vars (no dotenv needed):
 *   $env:SERVICE_AUTH_KEY="..."; $env:POLYMARKET_PRIVATE_KEY="..."; node ...
 */

// Load .env from repo root
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __script_dir = dirname(fileURLToPath(import.meta.url));
try {
    const envFile = readFileSync(resolve(__script_dir, '..', '.env'), 'utf8');
    for (const line of envFile.split('\n')) {
        const match = line.trim().match(/^([^#=]+)=(.*)$/);
        if (match && !process.env[match[1].trim()]) {
            process.env[match[1].trim()] = match[2].trim().replace(/^["']|["']$/g, '');
        }
    }
} catch { /* .env not found — rely on env vars */ }

// Dynamic import since ethers lives in trading-svc workspace
const { ethers } = await import('ethers');

// ── Config ──────────────────────────────────────────────────────────────

const DATA_SVC = process.env.DATA_SVC_URL || 'http://localhost:3005';
const SERVICE_KEY = process.env.SERVICE_AUTH_KEY || '';
const POLYGON_RPC = process.env.POLYGON_RPC_URL || 'https://polygon.drpc.org';
const dryRun = process.argv.includes('--dry-run');
const privateKey = process.env.POLYMARKET_PRIVATE_KEY;

if (!privateKey) {
    console.error('❌ Set POLYMARKET_PRIVATE_KEY env var first');
    process.exit(1);
}

// ── Contracts (Polygon) ─────────────────────────────────────────────────

const USDC_E = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const CTF = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
const NEG_RISK_ADAPTER = '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296';

const CTF_ABI = [
    'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)',
    'function balanceOf(address owner, uint256 id) view returns (uint256)',
    'function isApprovedForAll(address owner, address operator) view returns (bool)',
    'function setApprovalForAll(address operator, bool approved)',
];

const NEG_RISK_ABI = [
    'function redeemPositions(bytes32 conditionId, uint256[] amounts)',
];

const ERC20_ABI = [
    'function balanceOf(address owner) view returns (uint256)',
    'function decimals() view returns (uint8)',
];

const GAS = {
    gasLimit: 300000,
    maxFeePerGas: ethers.utils.parseUnits('200', 'gwei'),
    maxPriorityFeePerGas: ethers.utils.parseUnits('30', 'gwei'),
};

// ── Helpers ─────────────────────────────────────────────────────────────

async function apiGet(path) {
    const res = await fetch(`${DATA_SVC}${path}`, {
        headers: { 'x-service-key': SERVICE_KEY },
    });
    if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
    return res.json();
}

async function apiPut(path, body) {
    const res = await fetch(`${DATA_SVC}${path}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'x-service-key': SERVICE_KEY },
        body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`PUT ${path} → ${res.status}`);
    return res.json();
}

// ── Main ────────────────────────────────────────────────────────────────

const provider = new ethers.providers.StaticJsonRpcProvider(POLYGON_RPC, 137);
const wallet = new ethers.Wallet(privateKey, provider);
const ctf = new ethers.Contract(CTF, CTF_ABI, wallet);
const adapter = new ethers.Contract(NEG_RISK_ADAPTER, NEG_RISK_ABI, wallet);
const usdcE = new ethers.Contract(USDC_E, ERC20_ABI, provider);

console.log(`\n🏆 TempEdge Position Redeemer`);
console.log(`═══════════════════════════════════════`);
console.log(`  Wallet: ${wallet.address}`);
console.log(`  Mode:   ${dryRun ? '🧪 DRY RUN' : '💰 LIVE'}`);

const balBefore = await usdcE.balanceOf(wallet.address);
const decimals = await usdcE.decimals();
console.log(`  USDC.e: $${ethers.utils.formatUnits(balBefore, decimals)}`);
console.log(`═══════════════════════════════════════\n`);

// ── Phase 1: Scan all session files for token IDs ───────────────────────
console.log(`📡 Phase 1: Scanning on-chain token balances...\n`);

const { dates } = await apiGet('/api/session-files');
const knownTokens = [];

for (const date of dates) {
    const session = await apiGet(`/api/session-files/${date}`);
    if (session.redeemExecuted) continue;

    const snap = session.snapshots?.[session.snapshots.length - 1];
    if (!snap) continue;

    for (const key of ['target', 'below', 'above']) {
        const range = snap[key];
        if (!range?.clobTokenIds) continue;

        let conditionId = range.conditionId;
        if (!conditionId && session.buyOrder) {
            const pos = session.buyOrder.positions?.find(p => p.question === range.question);
            if (pos?.conditionId) conditionId = pos.conditionId;
        }

        for (const tokenId of range.clobTokenIds) {
            knownTokens.push({
                tokenId, conditionId, date, key,
                question: range.question,
                negRisk: range.neg_risk === true ||
                         session.buyOrder?.positions?.[0]?.neg_risk === true ||
                         session.buyOrder?.positions?.[0]?.isNegRisk === true,
            });
        }
    }
}

console.log(`  ${knownTokens.length} known token IDs across ${dates.length} sessions`);

// Check actual on-chain balances
const held = [];
for (const t of knownTokens) {
    try {
        const bal = await ctf.balanceOf(wallet.address, t.tokenId);
        const amt = parseFloat(ethers.utils.formatUnits(bal, 6));
        if (amt > 0.001) {
            held.push({ ...t, shares: amt, rawBal: bal });
            console.log(`  📦 ${t.date} ${t.key}: ${amt.toFixed(2)} shares`);
        }
    } catch { /* skip */ }
}

console.log(`\n  ${held.length} position(s) with on-chain balance\n`);

if (held.length === 0) {
    console.log(`  ✅ Nothing to redeem.`);
    process.exit(0);
}

// ── Ensure CTF approval ─────────────────────────────────────────────────
const approved = await ctf.isApprovedForAll(wallet.address, NEG_RISK_ADAPTER);
if (!approved) {
    console.log(`  🔓 Approving NegRiskAdapter...`);
    if (!dryRun) {
        const tx = await ctf.setApprovalForAll(NEG_RISK_ADAPTER, true, GAS);
        await tx.wait();
        console.log(`  ✅ Approved\n`);
    } else {
        console.log(`  🧪 DRY RUN — would approve\n`);
    }
}

// ── Phase 2: Redeem by conditionId ──────────────────────────────────────
console.log(`\n📤 Phase 2: Redeeming...\n`);

let totalRedeemed = 0;
let totalValue = 0;

const byCondition = {};
for (const p of held) {
    if (!p.conditionId) { console.log(`  ⚠️ ${p.date} ${p.key}: no conditionId`); continue; }
    (byCondition[p.conditionId] ??= []).push(p);
}

for (const [cid, positions] of Object.entries(byCondition)) {
    const p0 = positions[0];
    const shares = positions.reduce((s, p) => s + p.shares, 0);
    const label = p0.question?.substring(55, 80) || p0.key;

    console.log(`  📦 ${p0.date} ${label}`);
    console.log(`     cid: ${cid.slice(0, 16)}... | negRisk: ${p0.negRisk} | ${shares.toFixed(2)} shares`);

    if (dryRun) {
        console.log(`     🧪 Would redeem ${shares.toFixed(2)} shares`);
        totalRedeemed++;
        totalValue += shares;
        continue;
    }

    try {
        let tx;
        if (p0.negRisk) {
            // Neg-risk: amounts = [yesBalance, 0] — use ACTUAL raw on-chain balance
            const bal = p0.rawBal;
            console.log(`     📤 NegRiskAdapter.redeemPositions(cid, [${ethers.utils.formatUnits(bal, 6)}, 0])`);
            tx = await adapter.redeemPositions(cid, [bal, 0], GAS);
        } else {
            // Standard: indexSets [1,2] — burns entire balance automatically
            console.log(`     📤 CTF.redeemPositions(USDC_E, 0x0, cid, [1,2])`);
            tx = await ctf.redeemPositions(USDC_E, ethers.constants.HashZero, cid, [1, 2], GAS);
        }

        console.log(`     TX: ${tx.hash}`);
        const receipt = await tx.wait();
        if (receipt.status === 0) { console.log(`     ❌ Reverted on-chain`); continue; }

        console.log(`     ✅ Redeemed! Gas: ${receipt.gasUsed}`);
        totalRedeemed++;
        totalValue += shares;

        // Update session file
        try {
            const session = await apiGet(`/api/session-files/${p0.date}`);
            if (session.buyOrder?.positions) {
                for (const pos of session.buyOrder.positions) {
                    if (pos.conditionId === cid) {
                        pos.redeemed = true;
                        pos.redeemedAt = new Date().toISOString();
                        pos.redeemedTx = tx.hash;
                    }
                }
            }
            session.redeemExecuted = true;
            session.status = 'completed';
            await apiPut(`/api/session-files/${p0.date}`, session);
            console.log(`     💾 Session updated`);
        } catch (e) { console.log(`     ⚠️ Session update failed: ${e.message}`); }
    } catch (err) {
        console.log(`     ❌ Failed: ${err.message}`);
        if (err.error?.reason) console.log(`        Reason: ${err.error.reason}`);
    }
}

// ── Summary ─────────────────────────────────────────────────────────────
const balAfter = !dryRun && totalRedeemed > 0 ? await usdcE.balanceOf(wallet.address) : balBefore;
console.log(`\n═══════════════════════════════════════`);
if (totalRedeemed > 0 && !dryRun) {
    const gained = balAfter.sub(balBefore);
    console.log(`  Redeemed: ${totalRedeemed} position(s)`);
    console.log(`  USDC.e:   $${ethers.utils.formatUnits(balBefore, decimals)} → $${ethers.utils.formatUnits(balAfter, decimals)}`);
    console.log(`  Gained:   +$${ethers.utils.formatUnits(gained, decimals)}`);
} else if (dryRun) {
    console.log(`  Redeemable: ${totalRedeemed} condition(s), ~${totalValue.toFixed(2)} shares`);
} else {
    console.log(`  No positions ready for redemption.`);
}
console.log(`═══════════════════════════════════════`);
