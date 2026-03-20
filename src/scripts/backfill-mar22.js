/**
 * Backfill the Mar 22 buy trade that failed to write to DB
 * (due to missing _targetDate on buyOrder)
 */
import { getDb, closeDb } from '../db/index.js';
import { config as dotenvConfig } from 'dotenv';
import crypto from 'crypto';
dotenvConfig();

const db = getDb();

// Check if already exists
const existing = db.prepare("SELECT id FROM trades WHERE target_date = '2026-03-22' AND type = 'buy'").get();
if (existing) {
    console.log('Mar 22 trade already in DB:', existing.id);
    closeDb();
    process.exit(0);
}

// Ensure session exists
let session = db.prepare("SELECT id FROM sessions WHERE target_date = '2026-03-22' AND market_id = 'nyc'").get();
if (!session) {
    const sid = crypto.randomUUID();
    db.prepare(`
        INSERT INTO sessions (id, market_id, target_date, status, phase)
        VALUES (?, 'nyc', '2026-03-22', 'active', 'buy')
    `).run(sid);
    session = { id: sid };
    console.log('Created session:', sid);
} else {
    console.log('Using existing session:', session.id);
}

// Insert trade — 2 of 3 positions filled, total $2.1006
const result = db.prepare(`
    INSERT INTO trades (session_id, market_id, target_date, type, mode, placed_at, total_cost, actual_cost, status)
    VALUES (?, 'nyc', '2026-03-22', 'buy', 'live', '2026-03-20T13:30:00.000Z', 2.1006, 2.1006, 'filled')
`).run(session.id);
const tradeId = result.lastInsertRowid;
console.log('Inserted trade:', tradeId);

// Insert positions
const posStmt = db.prepare(`
    INSERT INTO positions (trade_id, label, question, price, shares, status, order_id, error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

posStmt.run(tradeId, 'target',
    'Will the highest temperature in New York City be between 54-55°F on March 22?',
    0.17, 6.18, 'filled',
    '0x85a898a2be51a9950940f9626794b5d78529f01bad8879842b6d56e91f990762', null);

posStmt.run(tradeId, 'below',
    'Will the highest temperature in New York City be 53°F or below on March 22?',
    0.15, 7, 'filled',
    '0xe9c9f2fc9a62fa022268d628999f307200f3d3371ce11fd8d3ae1f6756627fa5', null);

posStmt.run(tradeId, 'above',
    'Will the highest temperature in New York City be between 56-57°F on March 22?',
    0.20, 0, 'failed', null,
    'Daily spend would exceed max $7.5');

console.log('Inserted 3 positions (2 filled, 1 failed)');

// Verify
const count = db.prepare("SELECT COUNT(*) as c FROM positions WHERE trade_id = ?").get(tradeId);
console.log(`Total positions for trade #${tradeId}:`, count.c);

closeDb();
console.log('Done!');
