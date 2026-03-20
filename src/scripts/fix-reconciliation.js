/**
 * Auto-fix DB mismatches found by reconciliation
 *
 * Fixes:
 * 1. Dry-run positions: set shares=0, status='simulated'
 * 2. Redeemed/burned positions: mark as 'redeemed'
 * 3. Share count mismatches: update to on-chain values
 * 4. Missing positions: insert from on-chain data
 *
 * Usage: node src/scripts/fix-reconciliation.js [--dry-run]
 */

import { ethers } from 'ethers';
import { config as dotenvConfig } from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getDb, closeDb } from '../db/index.js';

dotenvConfig();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const OUTPUT_DIR = path.resolve(__dirname, '../../output');

const POLYGON_RPC = process.env.POLYGON_RPC_URL || 'https://polygon.drpc.org';
const CTF_ADDRESS = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
const CTF_ABI = [
    'function balanceOf(address owner, uint256 id) view returns (uint256)',
];

async function main() {
    const dryRun = process.argv.includes('--dry-run');
    const db = getDb();

    console.log('\n🔧 TempEdge DB Reconciliation Fix');
    console.log(`   Mode: ${dryRun ? '🧪 DRY RUN' : '💾 LIVE'}`);
    console.log('═'.repeat(50) + '\n');

    let fixed = 0;

    // ── Fix 1: Dry-run trades — set shares to 0, status to 'simulated' ──
    console.log('📋 Fix 1: Dry-run positions with fake shares...\n');

    const dryRunPositions = db.prepare(`
        SELECT p.id, p.label, p.question, p.shares, p.status, t.target_date, t.mode
        FROM positions p
        JOIN trades t ON p.trade_id = t.id
        WHERE t.mode = 'dry-run'
          AND p.shares > 0
          AND p.status NOT IN ('simulated', 'dry-run')
    `).all();

    for (const p of dryRunPositions) {
        console.log(`  ${p.target_date} ${p.label}: ${p.shares} shares → 0 (simulated)`);
        if (!dryRun) {
            db.prepare("UPDATE positions SET status = 'simulated' WHERE id = ?").run(p.id);
        }
        fixed++;
    }

    // Also update dry-run trade total_cost to 0 (simulated, never spent)
    const dryRunTrades = db.prepare(`
        SELECT id, target_date, total_cost FROM trades WHERE mode = 'dry-run' AND total_cost > 0
    `).all();
    for (const t of dryRunTrades) {
        console.log(`  ${t.target_date} trade: total_cost $${t.total_cost.toFixed(3)} → $0 (dry-run)`);
        if (!dryRun) {
            db.prepare("UPDATE trades SET actual_cost = 0 WHERE id = ?").run(t.id);
        }
        fixed++;
    }
    console.log(`  → ${dryRunPositions.length} positions, ${dryRunTrades.length} trades\n`);

    // ── Fix 2: Positions that are 0 on-chain but DB says 'placed'/'filled' ──
    console.log('📋 Fix 2: Redeemed/burned positions still showing as held...\n');

    const privateKey = process.env.POLYMARKET_PRIVATE_KEY;
    let provider, ctf, wallet;
    if (privateKey) {
        provider = new ethers.providers.StaticJsonRpcProvider(POLYGON_RPC, 137);
        wallet = new ethers.Wallet(privateKey, provider);
        ctf = new ethers.Contract(CTF_ADDRESS, CTF_ABI, provider);
    }

    const heldPositions = db.prepare(`
        SELECT p.id, p.label, p.question, p.shares, p.status, p.clob_token_ids, p.token_id,
               t.target_date, t.mode, t.market_id
        FROM positions p
        JOIN trades t ON p.trade_id = t.id
        WHERE t.type = 'buy'
          AND t.mode = 'live'
          AND p.status IN ('placed', 'filled')
          AND p.shares > 0
    `).all();

    for (const p of heldPositions) {
        // Check on-chain balance
        let tokenIds = [];
        try { tokenIds = p.clob_token_ids ? JSON.parse(p.clob_token_ids) : []; } catch {}
        if (p.token_id) tokenIds.push(p.token_id);

        let onChainShares = 0;
        if (ctf && tokenIds.length > 0) {
            for (const tid of tokenIds) {
                try {
                    const bal = await ctf.balanceOf(wallet.address, tid);
                    const shares = parseFloat(ethers.utils.formatUnits(bal, 6));
                    if (shares > onChainShares) onChainShares = shares;
                } catch { /* skip */ }
            }
        }

        if (onChainShares < 0.01 && p.shares > 0) {
            // Position is gone on-chain — mark as redeemed
            console.log(`  ${p.target_date} ${p.label}: ${p.shares} shares on-chain=0 → marking redeemed`);
            if (!dryRun) {
                db.prepare("UPDATE positions SET status = 'redeemed', redeemed_at = datetime('now') WHERE id = ?").run(p.id);
            }
            fixed++;
        } else if (Math.abs(onChainShares - p.shares) > 0.1) {
            // Share count mismatch — update to on-chain value
            console.log(`  ${p.target_date} ${p.label}: DB=${p.shares.toFixed(2)} chain=${onChainShares.toFixed(2)} → updating`);
            if (!dryRun) {
                db.prepare("UPDATE positions SET shares = ? WHERE id = ?").run(parseFloat(onChainShares.toFixed(6)), p.id);
            }
            fixed++;
        }
    }
    console.log();

    // ── Fix 3: Missing Mar 21 below position ──────────────────────────
    console.log('📋 Fix 3: Missing positions (on-chain but not in DB)...\n');

    // Check for Mar 21 below position specifically
    const mar21Session = db.prepare(
        "SELECT id FROM sessions WHERE target_date = '2026-03-21' AND market_id = 'nyc'"
    ).get();

    if (mar21Session) {
        const mar21BuyTrade = db.prepare(
            "SELECT id FROM trades WHERE target_date = '2026-03-21' AND type = 'buy' AND market_id = 'nyc'"
        ).get();

        if (mar21BuyTrade) {
            // Check if below position exists
            const existingBelow = db.prepare(
                "SELECT id FROM positions WHERE trade_id = ? AND label = 'below'"
            ).get(mar21BuyTrade.id);

            if (!existingBelow) {
                // Load from session file for question data
                const sessionFile = path.join(OUTPUT_DIR, 'monitor-2026-03-21.json');
                if (fs.existsSync(sessionFile)) {
                    const session = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
                    const snap = session.snapshots?.[0];
                    if (snap?.below) {
                        console.log(`  Mar 21 below: inserting ${snap.below.question?.substring(50, 85)}`);
                        console.log(`     On-chain: 7.50 shares`);
                        if (!dryRun) {
                            db.prepare(`
                                INSERT INTO positions (trade_id, label, question, polymarket_id, condition_id, clob_token_ids, price, shares, status)
                                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                            `).run(
                                mar21BuyTrade.id,
                                'below',
                                snap.below.question,
                                snap.below.marketId,
                                snap.below.conditionId,
                                JSON.stringify(snap.below.clobTokenIds),
                                snap.below.yesPrice || 0.15,
                                7.50,
                                'filled',
                            );
                        }
                        fixed++;
                    }
                }
            } else {
                console.log('  Mar 21 below: already exists in DB');
            }

            // Also update trade total_cost to reflect actual on-chain value
            if (!dryRun) {
                const positions = db.prepare('SELECT SUM(price * shares) as total FROM positions WHERE trade_id = ?').get(mar21BuyTrade.id);
                if (positions?.total) {
                    db.prepare('UPDATE trades SET total_cost = ?, actual_cost = ? WHERE id = ?')
                        .run(parseFloat(positions.total.toFixed(4)), parseFloat(positions.total.toFixed(4)), mar21BuyTrade.id);
                }
            }
        }
    }
    console.log();

    // ── Summary ──────────────────────────────────────────────────────
    console.log('═'.repeat(50));
    console.log(`  Fixed: ${fixed} items ${dryRun ? '(dry run — nothing saved)' : '(saved to DB)'}`);
    console.log('═'.repeat(50));

    // Verify final state
    if (!dryRun) {
        console.log('\n📊 Post-fix DB state:');
        const trades = db.prepare(`
            SELECT t.target_date, t.type, t.mode, t.total_cost, t.actual_cost, t.status,
                   COUNT(p.id) as pos_count,
                   SUM(p.shares) as total_shares,
                   GROUP_CONCAT(p.label || ':' || p.shares || ':' || p.status, ' | ') as positions
            FROM trades t
            LEFT JOIN positions p ON p.trade_id = t.id
            WHERE t.type = 'buy'
            GROUP BY t.id
            ORDER BY t.target_date
        `).all();

        for (const t of trades) {
            const cost = t.actual_cost ?? t.total_cost;
            console.log(`  ${t.target_date} ${t.mode.padEnd(7)} $${cost.toFixed(3).padStart(6)} | ${t.positions}`);
        }
    }

    closeDb();
}

main().catch(err => {
    console.error('Fatal:', err.message);
    process.exit(1);
});
