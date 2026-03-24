/**
 * Patch a session JSON file to add missing buyOrder from DB data.
 * Usage: node src/scripts/patch-session-buyorder.js 2026-03-20
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { getDb, closeDb } from '../db/index.js';

const targetDate = process.argv[2];
if (!targetDate) {
    console.error('Usage: node src/scripts/patch-session-buyorder.js <YYYY-MM-DD>');
    process.exit(1);
}

const OUTPUT_DIR = process.env.OUTPUT_DIR || './output';
const sessionPath = path.join(OUTPUT_DIR, `monitor-${targetDate}.json`);

if (!fs.existsSync(sessionPath)) {
    console.error(`Session file not found: ${sessionPath}`);
    process.exit(1);
}

const session = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));

if (session.buyOrder) {
    console.log(`Session for ${targetDate} already has a buyOrder. Nothing to patch.`);
    process.exit(0);
}

console.log(`\n📋 Patching session for ${targetDate}...`);
console.log(`   Current buyOrder: ${session.buyOrder}`);

// Get the buy trade from DB
const db = getDb();
const trade = db.prepare(`
    SELECT * FROM trades WHERE target_date = ? AND type = 'buy' ORDER BY id DESC LIMIT 1
`).get(targetDate);

if (!trade) {
    console.error(`No buy trade found in DB for ${targetDate}`);
    closeDb();
    process.exit(1);
}

const positions = db.prepare(`SELECT * FROM positions WHERE trade_id = ?`).all(trade.id);

console.log(`   Found trade #${trade.id} with ${positions.length} positions:`);

// Get the latest snapshot to resolve market data
const latestSnap = session.snapshots?.[session.snapshots.length - 1];

// Build the buyOrder object matching the expected structure
const buyOrder = {
    success: true,
    type: 'buy',
    mode: trade.mode,
    totalCost: trade.total_cost || trade.actual_cost,
    placedAt: trade.created_at,
    _sessionId: trade.session_id,
    _targetDate: targetDate,
    _marketId: trade.market_id,
    positions: positions.map(p => {
        // Try to resolve clobTokenIds and conditionId from snapshot
        let conditionId = p.condition_id;
        let clobTokenIds = p.clob_token_ids ? JSON.parse(p.clob_token_ids) : null;

        if (latestSnap && (!conditionId || !clobTokenIds)) {
            for (const key of ['target', 'below', 'above']) {
                const range = latestSnap[key];
                if (range && range.question === p.question) {
                    conditionId = conditionId || range.conditionId;
                    clobTokenIds = clobTokenIds || range.clobTokenIds;
                    console.log(`   📡 Resolved ${key} from snapshot: conditionId=${conditionId?.substring(0,20)}...`);
                    break;
                }
            }
        }

        return {
            label: p.label,
            question: p.question,
            conditionId,
            clobTokenIds,
            tokenId: clobTokenIds?.[0] || null,
            clobTokenId: clobTokenIds?.[0] || null,
            buyPrice: p.price,
            shares: p.shares,
            orderId: p.order_id,
            status: p.status,
        };
    }),
};

for (const pos of buyOrder.positions) {
    console.log(`   • ${pos.label}: ${pos.question.substring(55, 85)} — ${pos.shares} shares @ $${pos.buyPrice}`);
}

// Apply the patch
session.buyOrder = buyOrder;

// Write back
fs.writeFileSync(sessionPath, JSON.stringify(session, null, 2));
console.log(`\n✅ Patched session with buyOrder (${positions.length} positions)`);
console.log(`   The monitor will now execute resolve-day sell on the next cycle.`);

closeDb();
