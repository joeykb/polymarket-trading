/**
 * Manual trade insertion for Mar 20 and Mar 21
 * These trades exist on Polymarket but were lost when pods restarted
 * 
 * Based on Polymarket activity showing:
 * Mar 20: 52-53°F (10.0 shares), 54-55°F (6.2 shares)  
 * Mar 21: 54-55°F (7.5 shares), 56-57°F (5.0 shares)
 *
 * Usage: node src/scripts/insert-missing-trades.js
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { config as dotenvConfig } from 'dotenv';
import { getDb, closeDb } from '../db/index.js';
import { insertTrade, insertPositions, getSession, upsertSession } from '../db/queries.js';

dotenvConfig();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const OUTPUT_DIR = path.resolve(__dirname, '../../output');

function main() {
    const db = getDb();

    console.log('\n📋 Inserting missing trades for Mar 20 & Mar 21');
    console.log('═══════════════════════════════════════\n');

    // Check what we already have
    const existing20 = db.prepare("SELECT id FROM trades WHERE target_date = '2026-03-20' AND type = 'buy'").get();
    const existing21 = db.prepare("SELECT id FROM trades WHERE target_date = '2026-03-21' AND type = 'buy'").get();

    if (existing20) {
        console.log('⏭️  Mar 20 buy trade already exists (id=' + existing20.id + ')');
    }
    if (existing21) {
        console.log('⏭️  Mar 21 buy trade already exists (id=' + existing21.id + ')');
    }

    // Read session files for market/condition data
    const sessions = {};
    for (const d of ['20', '21']) {
        const filePath = path.join(OUTPUT_DIR, `monitor-2026-03-${d}.json`);
        if (fs.existsSync(filePath)) {
            const s = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            const snap = s.snapshots[0];
            sessions[d] = { session: s, snap };
            console.log(`📁 Loaded session for Mar ${d}: ${s.id}`);
            console.log(`   Target: ${snap.target?.question}`);
            console.log(`   Below:  ${snap.below?.question || 'none'}`);
            console.log(`   Above:  ${snap.above?.question || 'none'}`);
        }
    }

    // ── Mar 20 ──────────────────────────────────────────────────────
    // From Polymarket activity (13h ago = ~06:30 AM ET on Mar 19):
    //   52-53°F: 10.0 shares bought
    //   54-55°F: 6.2 shares bought  (this was the "target" in the session)
    if (!existing20 && sessions['20']) {
        const s = sessions['20'];

        // Look up existing session from DB (created by backfill) or use file ID
        const dbSession = db.prepare("SELECT id FROM sessions WHERE target_date = '2026-03-20' AND market_id = 'nyc'").get();
        const sessionId = dbSession?.id || s.session.id;

        // The trades were placed around Mar 19 06:30 AM ET (10:30 UTC)
        const { id: tradeId } = insertTrade({
            sessionId,
            marketId: 'nyc',
            targetDate: '2026-03-20',
            type: 'buy',
            mode: 'live',
            placedAt: '2026-03-19T10:30:00.000Z', // Approximate from Polymarket activity
            totalCost: 0, // Will be calculated from positions
            totalProceeds: 0,
            status: 'filled',
            metadata: { source: 'manual-recovery', note: 'Trade lost due to pod restart overwriting session' },
        });

        // Insert positions based on Polymarket activity
        const positions = [];
        
        // Find the below range (52-53°F) from snapshot ranges
        const snap = s.snap;
        if (snap.below) {
            positions.push({
                label: 'below',
                question: snap.below.question,
                marketId: snap.below.marketId,
                conditionId: snap.below.conditionId,
                clobTokenIds: snap.below.clobTokenIds,
                buyPrice: snap.below.yesPrice || 0.14, // Approximate buy price
                shares: 10.0,
                status: 'filled',
            });
        }
        
        // Target range (54-55°F)
        if (snap.target) {
            positions.push({
                label: 'target',
                question: snap.target.question,
                marketId: snap.target.marketId,
                conditionId: snap.target.conditionId,
                clobTokenIds: snap.target.clobTokenIds,
                buyPrice: snap.target.yesPrice || 0.17, // Approximate buy price
                shares: 6.2,
                status: 'filled',
            });
        }

        if (positions.length > 0) {
            insertPositions(tradeId, positions);
            const totalCost = positions.reduce((s, p) => s + (p.buyPrice * p.shares), 0);
            db.prepare('UPDATE trades SET total_cost = ? WHERE id = ?').run(parseFloat(totalCost.toFixed(4)), tradeId);
            console.log(`\n✅ Mar 20 buy trade inserted (id=${tradeId}):`);
            for (const p of positions) {
                console.log(`   ${p.label}: ${p.question.substring(50)} — ${p.shares} shares @$${p.buyPrice}`);
            }
            console.log(`   Total cost: $${totalCost.toFixed(4)}`);
        }
    }

    // ── Mar 21 ──────────────────────────────────────────────────────
    // From Polymarket activity:
    //   54-55°F: 7.5 shares bought  (target)
    //   56-57°F: 5.0 shares bought  (above)
    if (!existing21 && sessions['21']) {
        const s = sessions['21'];

        const dbSession = db.prepare("SELECT id FROM sessions WHERE target_date = '2026-03-21' AND market_id = 'nyc'").get();
        const sessionId = dbSession?.id || s.session.id;

        const { id: tradeId } = insertTrade({
            sessionId,
            marketId: 'nyc',
            targetDate: '2026-03-21',
            type: 'buy',
            mode: 'live',
            placedAt: '2026-03-19T10:30:00.000Z', // Approximate
            totalCost: 0,
            totalProceeds: 0,
            status: 'filled',
            metadata: { source: 'manual-recovery', note: 'Trade lost due to pod restart overwriting session' },
        });

        const snap = s.snap;
        const positions = [];

        // Target range (54-55°F)
        if (snap.target) {
            positions.push({
                label: 'target',
                question: snap.target.question,
                marketId: snap.target.marketId,
                conditionId: snap.target.conditionId,
                clobTokenIds: snap.target.clobTokenIds,
                buyPrice: snap.target.yesPrice || 0.17,
                shares: 7.5,
                status: 'filled',
            });
        }

        // Above range (56-57°F)
        if (snap.above) {
            positions.push({
                label: 'above',
                question: snap.above.question,
                marketId: snap.above.marketId,
                conditionId: snap.above.conditionId,
                clobTokenIds: snap.above.clobTokenIds,
                buyPrice: snap.above.yesPrice || 0.26,
                shares: 5.0,
                status: 'filled',
            });
        }

        if (positions.length > 0) {
            insertPositions(tradeId, positions);
            const totalCost = positions.reduce((s, p) => s + (p.buyPrice * p.shares), 0);
            db.prepare('UPDATE trades SET total_cost = ? WHERE id = ?').run(parseFloat(totalCost.toFixed(4)), tradeId);
            console.log(`\n✅ Mar 21 buy trade inserted (id=${tradeId}):`);
            for (const p of positions) {
                console.log(`   ${p.label}: ${p.question.substring(50)} — ${p.shares} shares @$${p.buyPrice}`);
            }
            console.log(`   Total cost: $${totalCost.toFixed(4)}`);
        }
    }

    // Verify
    console.log('\n═══════════════════════════════════════');
    const allTrades = db.prepare("SELECT target_date, type, total_cost, status FROM trades ORDER BY target_date").all();
    for (const t of allTrades) {
        console.log(`${t.target_date} ${t.type} $${t.total_cost.toFixed(3)} [${t.status}]`);
    }
    console.log(`Total trades: ${allTrades.length}`);

    closeDb();
}

main();
