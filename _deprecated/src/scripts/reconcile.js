/**
 * Reconciliation Script — Cross-reference 3 sources of truth:
 *
 *   1. On-chain (Polygon CTF contract) — actual token balances
 *   2. Polymarket CLOB API — order history, market status
 *   3. Our SQLite database — what we recorded
 *
 * Outputs a reconciliation report with mismatches.
 *
 * Usage: node src/scripts/reconcile.js
 */

import { ethers } from 'ethers';
import { config as dotenvConfig } from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ClobClient } from '@polymarket/clob-client';
import { getDb, closeDb } from '../db/index.js';

dotenvConfig();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const OUTPUT_DIR = path.resolve(__dirname, '../../output');

const POLYGON_RPC = process.env.POLYGON_RPC_URL || 'https://polygon.drpc.org';
const USDC_E_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const CTF_ADDRESS = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';

const CTF_ABI = [
    'function balanceOf(address owner, uint256 id) view returns (uint256)',
];
const ERC20_ABI = [
    'function balanceOf(address owner) view returns (uint256)',
    'function decimals() view returns (uint8)',
];

async function main() {
    const privateKey = process.env.POLYMARKET_PRIVATE_KEY;
    if (!privateKey) { console.error('POLYMARKET_PRIVATE_KEY not set'); process.exit(1); }

    const provider = new ethers.providers.StaticJsonRpcProvider(POLYGON_RPC, 137);
    const wallet = new ethers.Wallet(privateKey, provider);
    const ctf = new ethers.Contract(CTF_ADDRESS, CTF_ABI, provider);
    const usdcE = new ethers.Contract(USDC_E_ADDRESS, ERC20_ABI, provider);

    const clobClient = new ClobClient(
        'https://clob.polymarket.com', 137, wallet,
        { key: process.env.CLOB_API_KEY, secret: process.env.CLOB_SECRET, passphrase: process.env.CLOB_PASSPHRASE },
    );

    const db = getDb();

    console.log('\n' + '═'.repeat(68));
    console.log('  📊 TempEdge Reconciliation Report');
    console.log('  ' + new Date().toISOString());
    console.log('═'.repeat(68));

    // ── 1. USDC Balance ──────────────────────────────────────────────
    const decimals = await usdcE.decimals();
    const usdcBal = parseFloat(ethers.utils.formatUnits(await usdcE.balanceOf(wallet.address), decimals));
    console.log(`\n💰 USDC.e Balance: $${usdcBal.toFixed(6)}`);
    console.log(`   Wallet: ${wallet.address}`);

    // ── 2. Collect all known token IDs from sessions + DB ────────────
    console.log('\n📡 Phase 1: Collecting token IDs from all sources...\n');

    const tokenMap = new Map(); // tokenId -> { question, date, label, conditionId, source }

    // From session JSON files
    const sessionFiles = fs.readdirSync(OUTPUT_DIR)
        .filter(f => f.startsWith('monitor-2026') && f.endsWith('.json'))
        .sort();

    for (const file of sessionFiles) {
        try {
            const session = JSON.parse(fs.readFileSync(path.join(OUTPUT_DIR, file), 'utf8'));
            const date = file.replace('monitor-', '').replace('.json', '');

            // From snapshots
            for (const snap of (session.snapshots || []).slice(-1)) { // Just last snapshot
                for (const key of ['target', 'below', 'above']) {
                    const range = snap[key];
                    if (!range?.clobTokenIds) continue;
                    for (const tid of range.clobTokenIds) {
                        tokenMap.set(tid, {
                            question: range.question,
                            date, label: key,
                            conditionId: range.conditionId,
                            marketId: range.marketId,
                            source: 'session',
                        });
                    }
                }
            }

            // From buyOrder positions
            if (session.buyOrder?.positions) {
                for (const pos of session.buyOrder.positions) {
                    if (pos.clobTokenIds) {
                        for (const tid of pos.clobTokenIds) {
                            if (!tokenMap.has(tid)) {
                                tokenMap.set(tid, {
                                    question: pos.question, date, label: pos.label,
                                    conditionId: pos.conditionId, source: 'buyOrder',
                                });
                            }
                        }
                    }
                    if (pos.tokenId && !tokenMap.has(pos.tokenId)) {
                        tokenMap.set(pos.tokenId, {
                            question: pos.question, date, label: pos.label,
                            conditionId: pos.conditionId, source: 'buyOrder-tokenId',
                        });
                    }
                }
            }
        } catch { /* skip bad files */ }
    }

    // From DB positions
    const dbPositions = db.prepare(`
        SELECT p.*, t.target_date, t.type as trade_type, t.mode, t.market_id
        FROM positions p
        JOIN trades t ON p.trade_id = t.id
        WHERE t.type = 'buy'
        ORDER BY t.target_date, p.label
    `).all();

    for (const p of dbPositions) {
        let tokenIds = [];
        try { tokenIds = p.clob_token_ids ? JSON.parse(p.clob_token_ids) : []; } catch {}
        if (p.token_id) tokenIds.push(p.token_id);
        for (const tid of tokenIds) {
            if (!tokenMap.has(tid)) {
                tokenMap.set(tid, {
                    question: p.question, date: p.target_date, label: p.label,
                    conditionId: p.condition_id, source: 'db',
                });
            }
        }
    }

    console.log(`  Found ${tokenMap.size} unique token IDs across ${sessionFiles.length} sessions + DB\n`);

    // ── 3. Check on-chain balances for ALL tokens ────────────────────
    console.log('🔗 Phase 2: Checking on-chain CTF token balances...\n');

    const onChainPositions = [];
    let scanned = 0;

    for (const [tokenId, meta] of tokenMap) {
        scanned++;
        if (scanned % 20 === 0) process.stdout.write(`  Scanned ${scanned}/${tokenMap.size}...\r`);
        try {
            const bal = await ctf.balanceOf(wallet.address, tokenId);
            const shares = parseFloat(ethers.utils.formatUnits(bal, 6));
            if (shares > 0.001) {
                onChainPositions.push({ tokenId, shares, rawBalance: bal, ...meta });
            }
        } catch { /* skip */ }
    }
    console.log(`  Scanned ${tokenMap.size} tokens — ${onChainPositions.length} have on-chain balance\n`);

    // ── 4. Check CLOB market status for held positions ───────────────
    console.log('📋 Phase 3: Checking market resolution status via CLOB...\n');

    const checkedConditions = new Set();
    const marketStatus = new Map(); // conditionId -> { closed, winner, negRisk }

    for (const pos of onChainPositions) {
        if (!pos.conditionId || checkedConditions.has(pos.conditionId)) continue;
        checkedConditions.add(pos.conditionId);
        try {
            const market = await clobClient.getMarket(pos.conditionId);
            const winnerToken = market.tokens?.find(t => t.winner === true);
            marketStatus.set(pos.conditionId, {
                closed: market.closed || false,
                winner: winnerToken?.outcome?.toUpperCase() || null,
                winnerTokenId: winnerToken?.token_id || null,
                negRisk: market.neg_risk || false,
                question: market.question,
            });
        } catch (err) {
            marketStatus.set(pos.conditionId, { closed: false, error: err.message });
        }
    }

    // ── 5. Build reconciliation table ────────────────────────────────
    console.log('\n' + '═'.repeat(68));
    console.log('  📊 ON-CHAIN POSITIONS (what you actually hold)');
    console.log('═'.repeat(68));

    // Group by date
    const byDate = {};
    for (const pos of onChainPositions) {
        if (!byDate[pos.date]) byDate[pos.date] = [];
        byDate[pos.date].push(pos);
    }

    let totalOnChainValue = 0;
    const dates = Object.keys(byDate).sort();

    for (const date of dates) {
        console.log(`\n  📅 ${date}`);
        for (const pos of byDate[date]) {
            const status = marketStatus.get(pos.conditionId);
            let statusStr = '⏳ Open';
            let estValue = 0;

            if (status?.closed) {
                if (status.winner === 'YES' && status.winnerTokenId === pos.tokenId) {
                    statusStr = '🏆 WON (YES)';
                    estValue = pos.shares; // $1 per share
                } else if (status.winner) {
                    statusStr = '❌ LOST';
                    estValue = 0;
                } else {
                    statusStr = '❓ Closed (no winner data)';
                }
            }

            totalOnChainValue += estValue;
            const qShort = pos.question?.substring(50, 85) || 'unknown';
            console.log(`     ${pos.label || '?'}: ${qShort}`);
            console.log(`        Shares: ${pos.shares.toFixed(2)} | Status: ${statusStr} | Est: $${estValue.toFixed(2)}`);
        }
    }

    // ── 6. Cross-reference with DB ──────────────────────────────────
    console.log('\n\n' + '═'.repeat(68));
    console.log('  🔄 RECONCILIATION: DB vs On-Chain');
    console.log('═'.repeat(68));

    // Get DB buy trades grouped by date
    const dbTrades = db.prepare(`
        SELECT t.*, GROUP_CONCAT(p.question, '|||') as questions,
               GROUP_CONCAT(p.shares, '|||') as share_counts,
               GROUP_CONCAT(p.label, '|||') as labels,
               GROUP_CONCAT(p.status, '|||') as statuses,
               GROUP_CONCAT(p.price, '|||') as prices
        FROM trades t
        LEFT JOIN positions p ON p.trade_id = t.id
        WHERE t.type = 'buy'
        GROUP BY t.id
        ORDER BY t.target_date
    `).all();

    const mismatches = [];

    for (const trade of dbTrades) {
        const dateOnChain = byDate[trade.target_date] || [];
        const dbQuestions = trade.questions?.split('|||') || [];
        const dbShares = trade.share_counts?.split('|||').map(Number) || [];
        const dbLabels = trade.labels?.split('|||') || [];
        const dbStatuses = trade.statuses?.split('|||') || [];
        const dbPrices = trade.prices?.split('|||').map(Number) || [];

        let hasMismatch = false;

        for (let i = 0; i < dbQuestions.length; i++) {
            const dbQ = dbQuestions[i];
            const dbS = dbShares[i] || 0;
            const dbLabel = dbLabels[i] || '?';
            const dbStatus = dbStatuses[i] || 'unknown';
            const dbPrice = dbPrices[i] || 0;

            // Skip failed positions (never held on-chain)
            if (dbStatus === 'failed') continue;

            // Find matching on-chain position
            const onChain = dateOnChain.find(p => p.question === dbQ);
            const onChainShares = onChain?.shares || 0;

            // Status check
            const statusMarket = onChain ? marketStatus.get(onChain.conditionId) : null;

            if (dbStatus === 'sold' || dbStatus === 'redeemed') {
                // Should NOT be on-chain (unless redeem failed)
                if (onChainShares > 0.01) {
                    hasMismatch = true;
                    mismatches.push({
                        date: trade.target_date,
                        label: dbLabel,
                        question: dbQ?.substring(50, 85),
                        issue: `DB says "${dbStatus}" but ${onChainShares.toFixed(2)} shares still on-chain`,
                        dbShares: dbS,
                        onChainShares,
                        action: dbStatus === 'redeemed' ? 'Re-run redeem' : 'Verify sell filled',
                    });
                }
            } else if (dbStatus === 'placed' || dbStatus === 'filled') {
                // Should be on-chain
                if (Math.abs(dbS - onChainShares) > 0.1 && dbS > 0) {
                    hasMismatch = true;
                    mismatches.push({
                        date: trade.target_date,
                        label: dbLabel,
                        question: dbQ?.substring(50, 85),
                        issue: `Share count mismatch: DB=${dbS.toFixed(2)} vs Chain=${onChainShares.toFixed(2)}`,
                        dbShares: dbS,
                        onChainShares,
                        action: onChainShares > 0 ? `Update DB shares to ${onChainShares.toFixed(2)}` : 'Position may have been sold/redeemed outside system',
                    });
                }
                if (onChainShares === 0 && dbS > 0) {
                    hasMismatch = true;
                    mismatches.push({
                        date: trade.target_date,
                        label: dbLabel,
                        question: dbQ?.substring(50, 85),
                        issue: `DB shows ${dbS.toFixed(2)} shares but NOTHING on-chain`,
                        dbShares: dbS,
                        onChainShares: 0,
                        action: 'Position was sold/redeemed outside system — update DB status',
                    });
                }
            }
        }

        if (!hasMismatch) {
            console.log(`  ✅ ${trade.target_date}: OK (${trade.mode})`);
        }
    }

    // Check for on-chain positions NOT in DB
    for (const pos of onChainPositions) {
        const dbMatch = dbPositions.find(p => p.question === pos.question);
        if (!dbMatch) {
            mismatches.push({
                date: pos.date,
                label: pos.label || '?',
                question: pos.question?.substring(50, 85),
                issue: `On-chain position (${pos.shares.toFixed(2)} shares) NOT found in DB`,
                dbShares: 0,
                onChainShares: pos.shares,
                action: 'Insert trade record into DB',
            });
        }
    }

    // ── 7. Report mismatches ────────────────────────────────────────
    if (mismatches.length > 0) {
        console.log('\n\n' + '═'.repeat(68));
        console.log(`  ⚠️  ${mismatches.length} MISMATCH(ES) FOUND`);
        console.log('═'.repeat(68));

        for (const m of mismatches) {
            console.log(`\n  📅 ${m.date} | ${m.label}`);
            console.log(`     ${m.question}`);
            console.log(`     Issue: ${m.issue}`);
            console.log(`     DB: ${m.dbShares.toFixed(2)} shares | Chain: ${m.onChainShares.toFixed(2)} shares`);
            console.log(`     → Action: ${m.action}`);
        }
    } else {
        console.log('\n  🎉 No mismatches found!');
    }

    // ── 8. Summary ──────────────────────────────────────────────────
    const dbTradeCount = db.prepare("SELECT COUNT(*) as c FROM trades").get().c;
    const dbPositionCount = db.prepare("SELECT COUNT(*) as c FROM positions").get().c;
    const dbBuyCost = db.prepare("SELECT SUM(total_cost) as s FROM trades WHERE type = 'buy' AND status != 'failed'").get().s || 0;
    const dbSellProceeds = db.prepare("SELECT SUM(total_proceeds) as s FROM trades WHERE type = 'sell'").get().s || 0;
    const dbRedeemProceeds = db.prepare("SELECT SUM(total_proceeds) as s FROM trades WHERE type = 'redeem'").get().s || 0;

    console.log('\n\n' + '═'.repeat(68));
    console.log('  📊 SUMMARY');
    console.log('═'.repeat(68));
    console.log(`  USDC.e Balance:      $${usdcBal.toFixed(6)}`);
    console.log(`  On-chain positions:  ${onChainPositions.length} (est. $${totalOnChainValue.toFixed(2)})`);
    console.log(`  DB trades:           ${dbTradeCount} (${dbPositionCount} positions)`);
    console.log(`  DB total bought:     $${dbBuyCost.toFixed(4)}`);
    console.log(`  DB total sold:       $${dbSellProceeds.toFixed(4)}`);
    console.log(`  DB total redeemed:   $${dbRedeemProceeds.toFixed(4)}`);
    console.log(`  DB realized P&L:     $${(dbSellProceeds + dbRedeemProceeds - dbBuyCost).toFixed(4)}`);
    console.log(`  Mismatches:          ${mismatches.length}`);
    console.log('═'.repeat(68) + '\n');

    closeDb();
    return mismatches;
}

main().catch(err => {
    console.error('Fatal:', err.message);
    process.exit(1);
});
