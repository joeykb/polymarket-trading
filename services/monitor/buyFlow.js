/**
 * TempEdge Monitor — Buy Flow Logic
 *
 * All buy-related operations extracted from orchestrator.js:
 *   - Snapshot filtering by confidence tier
 *   - Immediate buy execution
 *   - Liquidity-gated polling with deadline fallback
 *   - Session context attachment
 *
 * Dependencies: svcClients (trading), strategy (edge/PnL), persistence (save).
 */

import { createLogger } from '../../shared/logger.js';
import { nowISO } from '../../shared/dates.js';
import { computeEdge, computePnL } from './strategy.js';
import { tryPlaceBuyOrder, fetchLiquidityFromService } from './svcClients.js';
import { saveSession } from './persistence.js';
import { getConfig } from './monitorConfig.js';

const log = createLogger('monitor-buy');

// ── Snapshot Filtering by Confidence Tier ────────────────────────────────

/**
 * Create a filtered snapshot containing only the ranges specified by rangesToBuy.
 * This controls which positions the trading service will buy.
 *
 * @param {Object} snapshot - Full snapshot with target/below/above
 * @param {Array<string>} rangesToBuy - e.g. ['target'] or ['target', 'below']
 * @returns {Object} Filtered snapshot
 */
export function filterSnapshotByTier(snapshot, rangesToBuy) {
    const rangeSet = new Set(rangesToBuy);
    return {
        ...snapshot,
        target: rangeSet.has('target') ? snapshot.target : null,
        below: rangeSet.has('below') ? snapshot.below : null,
        above: rangeSet.has('above') ? snapshot.above : null,
    };
}

// ── Session Context ─────────────────────────────────────────────────────

export function attachSessionContext(order, session) {
    if (!order) return;
    order._sessionId = session.id;
    order._targetDate = session.targetDate;
    order._marketId = session.marketId || 'nyc';
}

// ── Liquidity-Gated Buy Flow ────────────────────────────────────────────

/**
 * Start a polling loop that waits for liquidity before placing a buy.
 * If the deadline passes before liquidity is met, forces the buy.
 *
 * @param {Object} session - Active session
 * @param {Object} snapshot - Current market snapshot
 * @param {Function} takeSnapshotFn - Async function to take a fresh snapshot
 */
export function startLiquidityGatedBuy(session, snapshot, takeSnapshotFn) {
    const config = getConfig();
    session.awaitingLiquidity = true;
    session.liquidityWaitStart = nowISO();
    saveSession(session);

    const targetDate = session.targetDate;
    const pollIntervalMs = (config.liquidity.checkIntervalSecs || 30) * 1000;
    const deadlineHour = config.liquidity.buyDeadlineHour || 10.5;
    const deadlineH = Math.floor(deadlineHour);
    const deadlineM = Math.round((deadlineHour - deadlineH) * 60);

    log.info('liquidity_gate_start', { targetDate, pollIntervalSecs: pollIntervalMs / 1000, deadlineHour });
    console.log(`\n  ⏳ Liquidity gate activated for ${targetDate}`);
    console.log(`     Polling:   every ${pollIntervalMs / 1000}s`);
    console.log(`     Deadline:  ${deadlineH}:${String(deadlineM).padStart(2, '0')} ET`);

    // Mutex: prevents TOCTOU race where two interval ticks could both
    // pass the guard before either completes the async buy operation.
    let bought = false;
    let _buyInProgress = false;

    const pollTimer = setInterval(async () => {
        // Fast exit: already bought or buy currently executing
        if (bought || session.buyOrder || _buyInProgress) {
            if (bought || session.buyOrder) clearInterval(pollTimer);
            return;
        }

        // Acquire lock
        _buyInProgress = true;

        try {
            const nowET = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
            const nowDate = new Date(nowET);
            const currentDecimalHour = nowDate.getHours() + nowDate.getMinutes() / 60;

            if (currentDecimalHour >= deadlineHour) {
                clearInterval(pollTimer);
                if (bought || session.buyOrder) return;
                bought = true;
                session.awaitingLiquidity = false;

                const waitMs = Date.now() - new Date(session.liquidityWaitStart).getTime();
                const waitStr = `${(waitMs / 60000).toFixed(1)}m`;
                log.info('deadline_buy_forced', { targetDate, waitStr });
                console.log(`\n  ⏰ DEADLINE — forcing buy after ${waitStr}`);

                const deadlineLiq = await fetchLiquidityFromService(targetDate, session.marketId);
                // Take fresh snapshot so buy uses latest forecast
                let freshSnapshot;
                try {
                    freshSnapshot = await takeSnapshotFn(targetDate, null);
                } catch {
                    freshSnapshot = snapshot; /* intentional: use last known snapshot */
                }
                // Re-evaluate edge with fresh data (deadline still forces buy but respects tier)
                const edge =
                    session.pendingEdge ||
                    computeEdge(
                        freshSnapshot,
                        session.trend,
                        {
                            evThreshold: config.monitor.evThreshold ?? 0.05,
                        },
                        session.trajectory,
                    );
                const filteredSnapshot = filterSnapshotByTier(freshSnapshot, edge.rangesToBuy);
                const order = await tryPlaceBuyOrder(filteredSnapshot, deadlineLiq?.tokens || [], {
                    sessionId: session.id,
                    targetDate: session.targetDate,
                    marketId: session.marketId || 'nyc',
                });
                if (!order) {
                    log.warn('deadline_buy_failed', { targetDate });
                    return;
                }
                order.edge = edge;
                attachSessionContext(order, session);
                order.liquidityWait = waitStr;
                order.forcedByDeadline = true;
                session.buyOrder = order;
                session.pnl = computePnL(order, snapshot);
                session.alerts.push({
                    timestamp: nowISO(),
                    type: 'buy_executed',
                    message: `Buy forced at deadline after ${waitStr}`,
                    data: { waitMs, forced: true },
                });
                await saveSession(session);
                log.info('deadline_buy_success', { targetDate, cost: order.totalCost.toFixed(3) });
                console.log(`  💰 Deadline buy: $${order.totalCost.toFixed(3)}`);
                return;
            }

            const liqData = await fetchLiquidityFromService(targetDate, session.marketId);
            if (!liqData || !liqData.tokens || liqData.tokens.length === 0) return;

            const requireAll = config.liquidity.requireAllLiquid;
            const liquidCount = liqData.liquidCount || 0;
            const totalCount = liqData.tokenCount || liqData.tokens.length;
            const allLiquid = liqData.allLiquid || false;
            const conditionMet = requireAll ? allLiquid : liquidCount > 0;

            if (!conditionMet) return;

            clearInterval(pollTimer);
            if (bought || session.buyOrder) return;
            bought = true;
            session.awaitingLiquidity = false;

            const waitMs = Date.now() - new Date(session.liquidityWaitStart).getTime();
            const waitStr = `${(waitMs / 60000).toFixed(1)}m`;
            log.info('liquidity_met', { targetDate, liquidCount, totalCount, waitStr });
            console.log(`\n  ✅ LIQUIDITY MET — buying (${liquidCount}/${totalCount} liquid, waited ${waitStr})`);

            // Take fresh snapshot so buy uses latest forecast
            let freshSnapshot;
            try {
                freshSnapshot = await takeSnapshotFn(targetDate, null);
            } catch {
                freshSnapshot = snapshot; /* intentional: use last known snapshot */
            }
            // Re-evaluate edge with fresh data
            const edge = computeEdge(
                freshSnapshot,
                session.trend,
                {
                    evThreshold: config.monitor.evThreshold ?? 0.05,
                    maxEntryPrice: config.monitor.maxEntryPrice ?? 0.40,
                    maxHedgeCost: config.monitor.maxHedgeCost ?? 0.10,
                },
                session.trajectory,
            );
            if (edge.action === 'skip') {
                log.info('buy_skip_liquidity', { reason: edge.reason, ev: edge.ev });
                console.log(`  ⏭️  SKIP BUY (liquidity-gated): ${edge.reason}`);
                session.awaitingLiquidity = false;
                session.lastEdge = edge;
                await saveSession(session);
                return;
            }
            const filteredSnapshot = filterSnapshotByTier(freshSnapshot, edge.rangesToBuy);
            const order = await tryPlaceBuyOrder(filteredSnapshot, liqData.tokens, {
                sessionId: session.id,
                targetDate: session.targetDate,
                marketId: session.marketId || 'nyc',
            });
            if (!order) {
                log.warn('liquidity_buy_failed', { targetDate });
                return;
            }
            order.edge = edge;
            attachSessionContext(order, session);
            order.liquidityWait = waitStr;
            session.buyOrder = order;
            session.lastEdge = edge;
            session.pnl = computePnL(order, snapshot);
            session.alerts.push({
                timestamp: nowISO(),
                type: 'buy_executed',
                message: `Buy after ${waitStr} liquidity wait (EV: $${edge.ev.toFixed(3)}, tier: ${edge.tier})`,
                data: { waitMs, liquidCount, totalCount, edge },
            });
            await saveSession(session);
            log.info('liquidity_buy_success', { targetDate, cost: order.totalCost.toFixed(3), tier: edge.tier, waitStr });
            console.log(`  💰 Buy order placed: $${order.totalCost.toFixed(3)} [waited ${waitStr}, tier: ${edge.tier}]`);
        } finally {
            // Release lock
            _buyInProgress = false;
        }
    }, pollIntervalMs);
}
