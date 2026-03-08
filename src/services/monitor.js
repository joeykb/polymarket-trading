/**
 * Monitoring service — phase-aware periodic re-checks of forecast + market prices
 *
 * Phase Logic:
 *   T-2+ (buy):     Initial range selection. Buy 3 ranges.
 *   T-1  (monitor): Track changes. Only rebalance if forecast shifts ±7°F.
 *   T-0  (resolve): Discard 2 of 3 ranges, keep the most likely to hit.
 *
 * Weather source: Weather Company API (matches Polymarket resolution via WU)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import { config } from '../config.js';
import { fetchWeatherData } from './weather.js';
import { discoverMarket } from './polymarket.js';
import { selectRanges } from './rangeSelector.js';
import { executeRealBuyOrder } from './trading.js';
import { liquidityMonitor } from './liquidityStream.js';
import { nowISO, daysUntil, getPhase } from '../utils/dateUtils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const OUTPUT_DIR = path.resolve(__dirname, '../../output');

// Thresholds are read dynamically from config at each usage point
// to support hot-reload via the admin config page.

// ── Simulated Buy Order ─────────────────────────────────────────────────

/**
 * Place a simulated buy order using current snapshot prices
 * @param {import('../models/types.js').MonitoringSnapshot} snapshot
 * @returns {Object} buyOrder
 */
function placeBuyOrder(snapshot) {
    const positions = [];

    if (snapshot.target) {
        positions.push({
            label: 'target',
            question: snapshot.target.question,
            marketId: snapshot.target.marketId,
            buyPrice: snapshot.target.yesPrice,
            shares: 1,  // 1 share = $1 payout if YES
        });
    }
    if (snapshot.below) {
        positions.push({
            label: 'below',
            question: snapshot.below.question,
            marketId: snapshot.below.marketId,
            buyPrice: snapshot.below.yesPrice,
            shares: 1,
        });
    }
    if (snapshot.above) {
        positions.push({
            label: 'above',
            question: snapshot.above.question,
            marketId: snapshot.above.marketId,
            buyPrice: snapshot.above.yesPrice,
            shares: 1,
        });
    }

    const totalCost = positions.reduce((sum, p) => sum + p.buyPrice, 0);

    return {
        placedAt: nowISO(),
        positions,
        totalCost: parseFloat(totalCost.toFixed(4)),
        maxPayout: 1.0,  // Only 1 range pays out $1
        maxProfit: parseFloat((1.0 - totalCost).toFixed(4)),
    };
}

/**
 * Try real trading first, fall back to simulated
 * @param {Object} snapshot
 * @returns {Promise<Object>} buyOrder
 */
async function tryPlaceBuyOrder(snapshot) {
    try {
        const realOrder = await executeRealBuyOrder(snapshot);
        if (realOrder) return realOrder;
    } catch (err) {
        console.warn(`  ⚠️  Real trading failed, using simulated: ${err.message}`);
    }
    // Fall back to simulated
    const order = placeBuyOrder(snapshot);
    order.simulated = true;
    return order;
}

/**
 * Check if it's time to place a buy (7am EST on the day that is T-2 from target)
 * @param {import('../models/types.js').MonitoringSession} session
 * @param {import('../models/types.js').MonitoringSnapshot} snapshot
 * @returns {boolean|string} true for immediate buy, 'await-liquidity' for gated buy, false to skip
 */
function shouldPlaceBuy(session, snapshot) {
    // Already bought or already waiting?
    if (session.buyOrder) return false;
    if (session.awaitingLiquidity) return false;

    // On first snapshot, always place buy (backfill/simulation)
    if (session.snapshots.length === 0) return true;

    // Check if current time is at or past buyHourEST
    const nowET = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
    const hour = new Date(nowET).getHours();
    if (hour < config.monitor.buyHourEST) return false;

    // If WebSocket liquidity streaming is enabled, gate the buy
    if (config.liquidity.wsEnabled) {
        return 'await-liquidity';
    }

    // Otherwise, buy immediately (old behavior)
    return true;
}

/**
 * Compute P&L for all positions against current prices
 * @param {Object} buyOrder
 * @param {import('../models/types.js').MonitoringSnapshot} snapshot
 * @returns {Object} pnl
 */
export function computePnL(buyOrder, snapshot) {
    if (!buyOrder || !buyOrder.positions) return null;

    const currentRanges = {
        target: snapshot.target,
        below: snapshot.below,
        above: snapshot.above,
    };

    let totalBuyCost = 0;
    let totalCurrentValue = 0;
    const positions = [];

    for (const pos of buyOrder.positions) {
        const currentRange = currentRanges[pos.label];
        const currentPrice = currentRange?.yesPrice ?? pos.buyPrice;
        const pnl = parseFloat((currentPrice - pos.buyPrice).toFixed(4));
        const pnlPct = pos.buyPrice > 0
            ? parseFloat(((pnl / pos.buyPrice) * 100).toFixed(1))
            : 0;

        totalBuyCost += pos.buyPrice;
        totalCurrentValue += currentPrice;

        positions.push({
            label: pos.label,
            question: pos.question,
            buyPrice: pos.buyPrice,
            currentPrice,
            pnl,
            pnlPct,
        });
    }

    const totalPnL = parseFloat((totalCurrentValue - totalBuyCost).toFixed(4));
    const totalPnLPct = totalBuyCost > 0
        ? parseFloat(((totalPnL / totalBuyCost) * 100).toFixed(1))
        : 0;

    return {
        positions,
        totalBuyCost: parseFloat(totalBuyCost.toFixed(4)),
        totalCurrentValue: parseFloat(totalCurrentValue.toFixed(4)),
        totalPnL,
        totalPnLPct,
    };
}

// ── Session persistence ─────────────────────────────────────────────────

function getSessionPath(targetDate) {
    return path.join(OUTPUT_DIR, `monitor-${targetDate}.json`);
}

/**
 * @param {string} targetDate
 * @returns {import('../models/types.js').MonitoringSession|null}
 */
export function loadSession(targetDate) {
    const filePath = getSessionPath(targetDate);
    if (fs.existsSync(filePath)) {
        try {
            return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        } catch {
            return null;
        }
    }
    return null;
}

/** @param {import('../models/types.js').MonitoringSession} session */
function saveSession(session) {
    if (!fs.existsSync(OUTPUT_DIR)) {
        fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    }
    const filePath = getSessionPath(session.targetDate);
    fs.writeFileSync(filePath, JSON.stringify(session, null, 2), 'utf-8');
}

// ── Snapshot construction ───────────────────────────────────────────────

/**
 * @param {import('../models/types.js').TemperatureRange} range
 * @param {import('../models/types.js').SnapshotRange|null} previous
 * @returns {import('../models/types.js').SnapshotRange}
 */
function buildSnapshotRange(range, previous) {
    const priceChange = previous
        ? parseFloat((range.yesPrice - previous.yesPrice).toFixed(4))
        : 0;

    return {
        marketId: range.marketId,
        conditionId: range.conditionId,
        clobTokenIds: range.clobTokenIds,
        question: range.question,
        yesPrice: range.yesPrice,
        priceChange,
        impliedProbability: range.impliedProbability,
        volume: range.volume,
    };
}

/**
 * Take a single monitoring snapshot — fetches weather + market data
 * @param {string} targetDate
 * @param {import('../models/types.js').MonitoringSnapshot|null} previous
 * @returns {Promise<import('../models/types.js').MonitoringSnapshot>}
 */
export async function takeSnapshot(targetDate, previous) {
    // Fetch weather (forecast + current) and market data in parallel
    const [weatherData, event] = await Promise.all([
        fetchWeatherData(targetDate),
        discoverMarket(targetDate),
    ]);

    const { forecast, current } = weatherData;

    // Select ranges based on current forecast
    const selection = selectRanges(forecast.highTempF, event.ranges, targetDate);

    // Compute changes
    const forecastChange = previous
        ? parseFloat((forecast.highTempF - previous.forecastTempF).toFixed(1))
        : 0;

    const rangeShifted = previous
        ? selection.target.question !== previous.target.question
        : false;

    const shiftedFrom = rangeShifted ? previous.target.question : null;

    const phase = getPhase(targetDate);
    const days = daysUntil(targetDate);

    /** @type {import('../models/types.js').MonitoringSnapshot} */
    const snapshot = {
        timestamp: nowISO(),
        forecastTempF: forecast.highTempF,
        forecastSource: forecast.source,
        forecastChange,
        currentTempF: current.tempF,
        maxTodayF: current.maxSince7amF,
        currentConditions: current.conditions,
        phase,
        daysUntilTarget: days,
        target: buildSnapshotRange(selection.target, previous?.target ?? null),
        below: selection.below
            ? buildSnapshotRange(selection.below, previous?.below ?? null)
            : null,
        above: selection.above
            ? buildSnapshotRange(selection.above, previous?.above ?? null)
            : null,
        totalCost: selection.totalCost,
        rangeShifted,
        shiftedFrom,
        allRanges: event.ranges.map(r => ({
            marketId: r.marketId,
            question: r.question,
            yesPrice: r.yesPrice,
            impliedProbability: r.impliedProbability,
            volume: r.volume,
        })),
        eventActive: event.active,
        eventClosed: event.closed,
    };

    return snapshot;
}

// ── Alert detection ─────────────────────────────────────────────────────

/**
 * Detect alerts by comparing current snapshot to previous and initial state
 * @param {import('../models/types.js').MonitoringSnapshot} current
 * @param {import('../models/types.js').MonitoringSnapshot|null} previous
 * @param {import('../models/types.js').MonitoringSession} session
 * @returns {import('../models/types.js').MonitoringAlert[]}
 */
export function detectAlerts(current, previous, session) {
    /** @type {import('../models/types.js').MonitoringAlert[]} */
    const alerts = [];
    const now = nowISO();
    const initialForecast = session.initialForecastTempF;

    // 1. Market closed
    if (current.eventClosed) {
        alerts.push({
            timestamp: now,
            type: 'market_closed',
            message: 'Market has been closed/resolved.',
            data: {},
        });
    }

    // 2. Phase change
    if (previous && current.phase !== previous.phase) {
        const phaseLabels = { buy: '🛒 Buy', monitor: '👁️ Monitor', resolve: '🎯 Resolve' };
        alerts.push({
            timestamp: now,
            type: 'phase_change',
            message: `Phase changed: ${phaseLabels[previous.phase] || previous.phase} → ${phaseLabels[current.phase] || current.phase}`,
            data: { from: previous.phase, to: current.phase, daysUntil: current.daysUntilTarget },
        });
    }

    if (!previous) return alerts;

    // 3. Forecast shift from initial
    const totalShift = Math.abs(current.forecastTempF - initialForecast);
    if (totalShift >= config.monitor.forecastShiftThreshold) {
        const delta = parseFloat((current.forecastTempF - initialForecast).toFixed(1));
        const isDrastic = totalShift >= config.monitor.rebalanceThreshold;
        alerts.push({
            timestamp: now,
            type: 'forecast_shift',
            message: `Forecast shifted ${delta > 0 ? '+' : ''}${delta}°F from initial (${initialForecast}°F → ${current.forecastTempF}°F)${isDrastic ? ' ⚠️ DRASTIC — consider rebalancing!' : ''}`,
            data: {
                initialForecast,
                currentForecast: current.forecastTempF,
                delta,
                isDrastic,
            },
        });
    }

    // 4. Range shift
    if (current.rangeShifted) {
        alerts.push({
            timestamp: now,
            type: 'range_shift',
            message: `Target range shifted: "${current.shiftedFrom}" → "${current.target.question}"`,
            data: {
                from: current.shiftedFrom,
                to: current.target.question,
                newForecast: current.forecastTempF,
            },
        });
    }

    // 5. Price spike on any selected range
    const rangesToCheck = [
        { label: 'target', range: current.target },
        { label: 'below', range: current.below },
        { label: 'above', range: current.above },
    ];

    for (const { label, range } of rangesToCheck) {
        if (range && Math.abs(range.priceChange) >= config.monitor.priceSpikeThreshold) {
            const direction = range.priceChange > 0 ? '📈' : '📉';
            alerts.push({
                timestamp: now,
                type: 'price_spike',
                message: `${direction} ${label.toUpperCase()} "${range.question}" price ${range.priceChange > 0 ? '+' : ''}${(range.priceChange * 100).toFixed(1)}¢ (now ${(range.yesPrice * 100).toFixed(1)}¢)`,
                data: {
                    label,
                    question: range.question,
                    priceChange: range.priceChange,
                    currentPrice: range.yesPrice,
                },
            });
        }
    }

    return alerts;
}

// ── Resolve phase logic ─────────────────────────────────────────────────

/**
 * On target day, determine which range to keep and which to discard
 * @param {import('../models/types.js').MonitoringSnapshot} snapshot
 * @returns {{ keep: string, discard: string[], reason: string }}
 */
export function resolveRanges(snapshot) {
    const candidates = [];

    if (snapshot.target) candidates.push({ label: 'target', range: snapshot.target });
    if (snapshot.below) candidates.push({ label: 'below', range: snapshot.below });
    if (snapshot.above) candidates.push({ label: 'above', range: snapshot.above });

    // Sort by YES price descending (highest probability = most likely to hit)
    candidates.sort((a, b) => b.range.yesPrice - a.range.yesPrice);

    const keep = candidates[0];
    const discard = candidates.slice(1);

    return {
        keep: keep.range.question,
        keepLabel: keep.label,
        keepPrice: keep.range.yesPrice,
        discard: discard.map(d => d.range.question),
        discardLabels: discard.map(d => d.label),
        reason: `${keep.range.question} has highest YES price (${(keep.range.yesPrice * 100).toFixed(1)}¢) — most likely to hit`,
    };
}
// ── Liquidity-Gated Buy Flow ────────────────────────────────────────────

/**
 * Start monitoring liquidity via WebSocket and auto-buy when conditions are met.
 *
 * Instead of buying immediately at 7am, we start streaming the order book
 * and wait for all (or any, per config) tokens to reach liquid conditions
 * before executing. A deadline timer forces a buy or skips if liquidity
 * never materializes.
 *
 * @param {import('../models/types.js').MonitoringSession} session
 * @param {import('../models/types.js').MonitoringSnapshot} snapshot
 */
function startLiquidityGatedBuy(session, snapshot) {
    // Mark session as waiting
    session.awaitingLiquidity = true;
    session.liquidityWaitStart = nowISO();
    saveSession(session);

    console.log(`\n  ⏳ Liquidity gate activated — waiting for optimal buy window...`);
    console.log(`     Deadline: ${config.liquidity.buyDeadlineHour}:00 ET`);
    console.log(`     Require:  ${config.liquidity.requireAllLiquid ? 'ALL tokens liquid' : 'ANY token liquid'}`);

    // Build token list from snapshot
    const tokens = [];
    for (const pos of ['target', 'below', 'above']) {
        const range = snapshot[pos];
        if (range?.clobTokenIds?.[0]) {
            tokens.push({
                tokenId: range.clobTokenIds[0],
                label: pos,
                question: range.question || pos,
            });
        }
    }

    if (tokens.length === 0) {
        console.log(`  ⚠️  No tokens with clobTokenIds — falling back to immediate buy`);
        session.awaitingLiquidity = false;
        tryPlaceBuyOrder(snapshot).then(order => {
            session.buyOrder = order;
            saveSession(session);
        });
        return;
    }

    // Start (or re-use) the liquidity stream
    if (!liquidityMonitor.isRunning()) {
        liquidityMonitor.start(tokens);
    }

    // One-shot callback: fires when liquidity conditions are met
    let bought = false;
    liquidityMonitor.onLiquidityWindow(async (liqSnap) => {
        if (bought || session.buyOrder) return;

        // Check if conditions are met
        const requireAll = config.liquidity.requireAllLiquid;
        const conditionMet = requireAll ? liqSnap.allLiquid : (liqSnap.liquidCount > 0);

        if (!conditionMet) return;

        bought = true;
        session.awaitingLiquidity = false;

        const waitMs = Date.now() - new Date(session.liquidityWaitStart).getTime();
        const waitStr = waitMs < 60000
            ? `${(waitMs / 1000).toFixed(0)}s`
            : `${(waitMs / 60000).toFixed(1)}m`;

        console.log(`\n  🟢 LIQUIDITY WINDOW OPEN — ${liqSnap.liquidCount}/${liqSnap.totalCount} tokens liquid`);
        console.log(`     Waited: ${waitStr}`);

        // Log per-token liquidity at buy time
        for (const t of liqSnap.tokens) {
            const status = t.isLiquid ? '✅' : '⚠️';
            console.log(`     ${status} ${t.label}: bid=$${t.bestBid.toFixed(3)} ask=$${t.bestAsk.toFixed(3)} spread=${(t.spreadPct * 100).toFixed(1)}% depth=${t.askDepth.toFixed(1)} score=${(t.score * 100).toFixed(0)}%`);
        }

        // Update snapshot prices with live stream data (more current than last REST fetch)
        const liveSnapshot = { ...snapshot };
        for (const t of liqSnap.tokens) {
            const rangeKey = t.label;  // target, below, above
            if (liveSnapshot[rangeKey]) {
                liveSnapshot[rangeKey] = {
                    ...liveSnapshot[rangeKey],
                    yesPrice: t.bestAsk,  // Use live ask for buy price
                };
            }
        }

        // Execute the buy with live prices
        const order = await tryPlaceBuyOrder(liveSnapshot);
        order.liquidityWait = waitStr;
        order.liquiditySnapshot = {
            liquidCount: liqSnap.liquidCount,
            totalCount: liqSnap.totalCount,
            tokens: liqSnap.tokens.map(t => ({
                label: t.label, bid: t.bestBid, ask: t.bestAsk,
                spread: t.spreadPct, depth: t.askDepth, score: t.score,
            })),
        };

        session.buyOrder = order;
        session.pnl = computePnL(order, snapshot);
        saveSession(session);

        // Add alert
        session.alerts.push({
            timestamp: nowISO(),
            type: 'buy_executed',
            message: `Buy executed after ${waitStr} liquidity wait (${liqSnap.liquidCount}/${liqSnap.totalCount} tokens liquid)`,
            data: { waitMs, liquidCount: liqSnap.liquidCount, totalCount: liqSnap.totalCount },
        });
        saveSession(session);

        console.log(`  💰 Buy order placed via liquidity gate: $${order.totalCost.toFixed(3)} [waited ${waitStr}]`);
    });

    // Deadline timer: if we hit the deadline hour, force buy
    const checkDeadline = setInterval(() => {
        if (bought || session.buyOrder) {
            clearInterval(checkDeadline);
            return;
        }

        const nowET = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
        const hour = new Date(nowET).getHours();

        if (hour >= config.liquidity.buyDeadlineHour) {
            clearInterval(checkDeadline);
            if (bought || session.buyOrder) return;

            bought = true;
            session.awaitingLiquidity = false;

            const waitMs = Date.now() - new Date(session.liquidityWaitStart).getTime();
            const waitStr = `${(waitMs / 60000).toFixed(1)}m`;

            console.log(`\n  ⏰ DEADLINE REACHED (${config.liquidity.buyDeadlineHour}:00 ET) — forcing buy after ${waitStr}`);

            tryPlaceBuyOrder(snapshot).then(order => {
                order.liquidityWait = waitStr;
                order.forcedByDeadline = true;
                session.buyOrder = order;
                session.pnl = computePnL(order, snapshot);
                session.alerts.push({
                    timestamp: nowISO(),
                    type: 'buy_executed',
                    message: `Buy forced at deadline (${config.liquidity.buyDeadlineHour}:00 ET) after ${waitStr} — liquidity never optimal`,
                    data: { waitMs, forced: true },
                });
                saveSession(session);
                console.log(`  💰 Deadline buy placed: $${order.totalCost.toFixed(3)}`);
            });
        }
    }, 60_000);  // Check every minute
}

// ── Session management ──────────────────────────────────────────────────

/**
 * Create or resume a monitoring session
 * @param {string} targetDate
 * @param {number} intervalMinutes
 * @returns {Promise<import('../models/types.js').MonitoringSession>}
 */
export async function createOrResumeSession(targetDate, intervalMinutes) {
    const existing = loadSession(targetDate);

    if (existing && (existing.status === 'active' || existing.status === 'stopped')) {
        // Reactivate stopped sessions
        existing.status = 'active';
        // Update phase in case day changed
        existing.phase = getPhase(targetDate);

        // Backfill buyOrder if missing (session was created before buy feature)
        if (!existing.buyOrder && existing.snapshots.length > 0) {
            const firstSnapshot = existing.snapshots[0];
            existing.buyOrder = placeBuyOrder(firstSnapshot);
            existing.buyOrder.placedAt = existing.startedAt; // Use session start time
            console.log(`  💰 Backfilled buy order from first snapshot: $${existing.buyOrder.totalCost.toFixed(3)}`);

            // Compute current P&L against latest snapshot
            const latestSnap = existing.snapshots[existing.snapshots.length - 1];
            existing.pnl = computePnL(existing.buyOrder, latestSnap);
        }

        // If session was mid-liquidity-wait, reset so we can re-trigger
        if (existing.awaitingLiquidity && !existing.buyOrder) {
            existing.awaitingLiquidity = false;
            console.log(`  🔄 Resetting liquidity wait (will re-trigger at buy hour)`);
        }

        saveSession(existing);
        console.log(`  📋 Resuming existing session (${existing.snapshots.length} snapshots, phase: ${existing.phase})`);
        return existing;
    }

    // Take initial snapshot
    console.log('  📸 Taking initial snapshot...');
    const snapshot = await takeSnapshot(targetDate, null);

    const phase = getPhase(targetDate);

    // Place buy order (real or simulated depending on TRADING_MODE)
    const buyOrder = await tryPlaceBuyOrder(snapshot);
    console.log(`  💰 Buy order placed: $${buyOrder.totalCost.toFixed(3)} (max profit: $${buyOrder.maxProfit.toFixed(3)}) [${buyOrder.simulated !== false ? 'simulated' : buyOrder.mode || 'live'}]`);

    /** @type {import('../models/types.js').MonitoringSession} */
    const session = {
        id: crypto.randomUUID(),
        targetDate,
        startedAt: nowISO(),
        status: 'active',
        phase,
        intervalMinutes,
        initialForecastTempF: snapshot.forecastTempF,
        initialTargetRange: snapshot.target.question,
        forecastSource: snapshot.forecastSource,
        rebalanceThreshold: config.monitor.rebalanceThreshold,
        buyOrder,
        pnl: null,
        snapshots: [snapshot],
        alerts: [],
    };

    saveSession(session);

    // ── Start WebSocket liquidity stream for BUY phase ──────────────
    if (session.phase === 'buy' && config.liquidity.wsEnabled) {
        const tokens = [];
        for (const pos of ['target', 'below', 'above']) {
            const range = snapshot[pos];
            if (range?.clobTokenIds?.[0]) {
                tokens.push({
                    tokenId: range.clobTokenIds[0],
                    label: pos,
                    question: range.question || pos,
                });
            }
        }
        if (tokens.length > 0) {
            liquidityMonitor.start(tokens);
        }
    }

    return session;
}

/**
 * Run a single monitoring cycle — snapshot + alert detection + persist
 * @param {import('../models/types.js').MonitoringSession} session
 * @returns {Promise<{snapshot: import('../models/types.js').MonitoringSnapshot, alerts: import('../models/types.js').MonitoringAlert[], resolution: Object|null}>}
 */
export async function runMonitoringCycle(session) {
    const previousSnapshot = session.snapshots[session.snapshots.length - 1] || null;

    const snapshot = await takeSnapshot(session.targetDate, previousSnapshot);
    const alerts = detectAlerts(snapshot, previousSnapshot, session);

    // Update session phase
    session.phase = snapshot.phase;

    // Place buy (immediate or liquidity-gated)
    const buySignal = shouldPlaceBuy(session, snapshot);
    if (buySignal === true) {
        // Immediate buy (old path: no WS, first snapshot, etc.)
        session.buyOrder = await tryPlaceBuyOrder(snapshot);
    } else if (buySignal === 'await-liquidity' && !session.awaitingLiquidity) {
        // Start liquidity-gated buy flow
        startLiquidityGatedBuy(session, snapshot);
    }

    // Compute P&L against buy prices
    if (session.buyOrder) {
        session.pnl = computePnL(session.buyOrder, snapshot);
    }

    // Append to session
    session.snapshots.push(snapshot);
    session.alerts.push(...alerts);

    // Resolution logic on target day
    let resolution = null;
    if (snapshot.phase === 'resolve' && !snapshot.eventClosed) {
        resolution = resolveRanges(snapshot);
        session.resolution = resolution;
    }

    // Check if market closed
    if (snapshot.eventClosed) {
        session.status = 'completed';
    }

    // Persist
    saveSession(session);

    return { snapshot, alerts, resolution };
}

/**
 * @param {import('../models/types.js').MonitoringSession} session
 */
export function stopSession(session) {
    session.status = 'stopped';
    saveSession(session);
    liquidityMonitor.stop();
}

/**
 * Get the current liquidity snapshot (for the dashboard API).
 * @returns {Object|null}
 */
export function getLiquiditySnapshot() {
    if (!liquidityMonitor.isRunning()) return null;
    return liquidityMonitor.getSnapshot();
}
