/**
 * Backfill database from existing JSON session files
 *
 * One-time migration script. Reads all monitor-*.json files and inserts:
 *   - Sessions (from session metadata)
 *   - Trades (from buyOrder + sellOrders)
 *   - Positions (from buyOrder.positions)
 *   - Snapshots (from snapshots array)
 *   - Alerts (from alerts array)
 *
 * Safe to re-run — uses INSERT OR IGNORE for sessions and checks for existing trades.
 *
 * Usage: node src/scripts/backfill-db.js
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { config as dotenvConfig } from 'dotenv';
import { getDb, closeDb } from '../db/index.js';
import { upsertSession, insertTrade, insertPositions, insertSnapshot, insertAlert } from '../db/queries.js';

dotenvConfig();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const OUTPUT_DIR = path.resolve(__dirname, '../../output');

function main() {
    const db = getDb();
    console.log('\n📦 TempEdge Database Backfill');
    console.log('═══════════════════════════════════════\n');

    const sessionFiles = fs.readdirSync(OUTPUT_DIR)
        .filter(f => f.startsWith('monitor-2026') && f.endsWith('.json'))
        .sort();

    console.log(`Found ${sessionFiles.length} session files\n`);

    let totalSessions = 0;
    let totalTrades = 0;
    let totalPositions = 0;
    let totalSnapshots = 0;
    let totalAlerts = 0;

    for (const file of sessionFiles) {
        const filePath = path.join(OUTPUT_DIR, file);
        const date = file.replace('monitor-', '').replace('.json', '');

        let session;
        try {
            session = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        } catch (err) {
            console.log(`  ⚠️  Skipping ${file}: ${err.message}`);
            continue;
        }

        console.log(`📋 ${date}: phase=${session.phase} status=${session.status} snapshots=${(session.snapshots || []).length}`);

        // ── Insert Session ──────────────────────────────────────────
        const sessionId = session.id || `legacy-${date}`;
        try {
            upsertSession({
                id: sessionId,
                marketId: 'nyc',
                targetDate: date,
                status: session.status || 'completed',
                phase: session.phase || 'unknown',
                initialForecastTemp: session.initialForecastTempF,
                initialTargetRange: session.initialTargetRange,
                forecastSource: session.forecastSource,
                intervalMinutes: session.intervalMinutes || 15,
                rebalanceThreshold: session.rebalanceThreshold || 3.0,
            });
            totalSessions++;
        } catch (err) {
            console.log(`  ⚠️  Session: ${err.message}`);
        }

        // ── Insert Buy Trade + Positions ────────────────────────────
        if (session.buyOrder) {
            const bo = session.buyOrder;

            // Check if trade already exists for this date
            const existing = db.prepare(
                "SELECT id FROM trades WHERE target_date = ? AND type = 'buy' AND market_id = 'nyc'"
            ).get(date);

            if (!existing) {
                try {
                    const { id: tradeId } = insertTrade({
                        sessionId,
                        marketId: 'nyc',
                        targetDate: date,
                        type: 'buy',
                        mode: bo.mode || (bo.simulated ? 'dry-run' : 'live'),
                        placedAt: bo.placedAt || session.startedAt,
                        totalCost: bo.totalCost || bo.actualTotalCost || 0,
                        totalProceeds: 0,
                        status: bo.allUnfilled ? 'failed' : 'filled',
                        metadata: {
                            maxProfit: bo.maxProfit,
                            liquidityWait: bo.liquidityWait,
                            fillSummary: bo.fillSummary,
                        },
                    });

                    if (bo.positions?.length) {
                        insertPositions(tradeId, bo.positions.map(p => ({
                            label: p.label,
                            question: p.question,
                            marketId: p.marketId,
                            conditionId: p.conditionId,
                            clobTokenIds: p.clobTokenIds,
                            orderId: p.orderId,
                            tokenId: p.tokenId,
                            buyPrice: p.buyPrice || p.avgPrice || p.price,
                            shares: p.shares || p.size,
                            status: p.redeemed ? 'redeemed' : (p.soldAt ? 'sold' : (p.status || 'placed')),
                            fillPrice: p.fillPrice || p.avgPrice,
                            fillShares: p.fillShares || p.shares,
                            error: p.error,
                        })));
                        totalPositions += bo.positions.length;
                    }

                    totalTrades++;
                    console.log(`  ✅ Buy trade: $${(bo.totalCost || 0).toFixed(3)} (${(bo.positions || []).length} positions)`);
                } catch (err) {
                    console.log(`  ⚠️  Buy trade: ${err.message}`);
                }
            } else {
                console.log(`  ⏭️  Buy trade already exists (id=${existing.id})`);
            }
        }

        // ── Insert Sell Trades ──────────────────────────────────────
        if (session.sellOrders?.length) {
            for (const so of session.sellOrders) {
                try {
                    const { id: tradeId } = insertTrade({
                        sessionId,
                        marketId: 'nyc',
                        targetDate: date,
                        type: 'sell',
                        mode: so.mode || 'live',
                        placedAt: so.placedAt || so.executedAt,
                        totalCost: 0,
                        totalProceeds: so.totalProceeds || 0,
                        status: 'filled',
                    });

                    if (so.positions?.length) {
                        insertPositions(tradeId, so.positions.map(p => ({
                            label: p.label,
                            question: p.question,
                            conditionId: p.conditionId,
                            orderId: p.orderId,
                            price: p.sellPrice || p.price,
                            shares: p.shares || p.size,
                            status: 'sold',
                        })));
                        totalPositions += so.positions.length;
                    }

                    totalTrades++;
                    console.log(`  ✅ Sell trade: $${(so.totalProceeds || 0).toFixed(3)}`);
                } catch (err) {
                    console.log(`  ⚠️  Sell trade: ${err.message}`);
                }
            }
        }

        // ── Insert Snapshots (batch for performance) ────────────────
        if (session.snapshots?.length) {
            const existingCount = db.prepare(
                'SELECT COUNT(*) as cnt FROM snapshots WHERE session_id = ?'
            ).get(sessionId)?.cnt || 0;

            if (existingCount === 0) {
                const insertBatch = db.transaction((snaps) => {
                    for (const snap of snaps) {
                        try {
                            insertSnapshot({
                                sessionId,
                                timestamp: snap.timestamp,
                                forecastTempF: snap.forecastTempF,
                                forecastSource: snap.forecastSource,
                                forecastChange: snap.forecastChange || 0,
                                currentTempF: snap.currentTempF,
                                maxTodayF: snap.maxTodayF,
                                currentConditions: snap.currentConditions,
                                phase: snap.phase,
                                daysUntilTarget: snap.daysUntilTarget,
                                target: snap.target,
                                below: snap.below,
                                above: snap.above,
                                totalCost: snap.totalCost,
                                rangeShifted: snap.rangeShifted,
                                shiftedFrom: snap.shiftedFrom,
                                eventClosed: snap.eventClosed,
                            });
                        } catch { /* skip individual snapshot errors */ }
                    }
                });

                insertBatch(session.snapshots);
                totalSnapshots += session.snapshots.length;
                console.log(`  ✅ ${session.snapshots.length} snapshots`);
            } else {
                console.log(`  ⏭️  Snapshots already exist (${existingCount})`);
            }
        }

        // ── Insert Alerts ───────────────────────────────────────────
        if (session.alerts?.length) {
            const existingAlerts = db.prepare(
                'SELECT COUNT(*) as cnt FROM alerts WHERE session_id = ?'
            ).get(sessionId)?.cnt || 0;

            if (existingAlerts === 0) {
                for (const alert of session.alerts) {
                    try {
                        insertAlert({
                            sessionId,
                            timestamp: alert.timestamp,
                            type: alert.type,
                            message: alert.message,
                            data: alert.data,
                        });
                    } catch { /* skip */ }
                }
                totalAlerts += session.alerts.length;
                console.log(`  ✅ ${session.alerts.length} alerts`);
            }
        }

        console.log('');
    }

    // ── Summary ─────────────────────────────────────────────────────
    console.log('═══════════════════════════════════════');
    console.log(`  Sessions:   ${totalSessions}`);
    console.log(`  Trades:     ${totalTrades}`);
    console.log(`  Positions:  ${totalPositions}`);
    console.log(`  Snapshots:  ${totalSnapshots}`);
    console.log(`  Alerts:     ${totalAlerts}`);

    // Quick verification
    const dbStats = {
        sessions: db.prepare('SELECT COUNT(*) as cnt FROM sessions').get().cnt,
        trades: db.prepare('SELECT COUNT(*) as cnt FROM trades').get().cnt,
        positions: db.prepare('SELECT COUNT(*) as cnt FROM positions').get().cnt,
        snapshots: db.prepare('SELECT COUNT(*) as cnt FROM snapshots').get().cnt,
        alerts: db.prepare('SELECT COUNT(*) as cnt FROM alerts').get().cnt,
        markets: db.prepare('SELECT COUNT(*) as cnt FROM markets').get().cnt,
    };
    console.log(`\n  DB totals: ${JSON.stringify(dbStats)}`);
    console.log('═══════════════════════════════════════');

    closeDb();
}

main();
