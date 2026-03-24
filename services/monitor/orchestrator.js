/**
 * TempEdge Monitor — Orchestrator (Microservice Edition)
 *
 * This is the core monitoring logic from the original services/monitor.js,
 * fully refactored to call microservice APIs instead of importing local modules.
 *
 * Dependencies (all via HTTP):
 *   weather-svc  → forecast + current conditions
 *   market-svc   → market discovery + range selection
 *   trading-svc  → buy, sell, redeem
 *   data-svc     → session files, DB writes, config, spend tracking
 *   liquidity    → WebSocket order book streaming (port 3001 on monolith until extracted)
 */

import 'dotenv/config';
import { services } from '../../shared/services.js';
import { createClient } from '../../shared/httpClient.js';
import { nowISO, getTodayET, getDateOffsetET, daysUntil, getPhase } from '../../shared/dates.js';

// ── Service URLs (from shared config) ───────────────────────────────────

const WEATHER_SVC = services.weatherSvc;
const MARKET_SVC = services.marketSvc;
const TRADING_SVC = services.tradingSvc;
const DATA_SVC = services.dataSvc;
const LIQUIDITY_SVC = services.liquiditySvc;

// ── Config defaults (overridden by data-svc /api/config) ───────────────

const _config = {
    monitor: {
        intervalMinutes: 15,
        rebalanceThreshold: 3,
        forecastShiftThreshold: 2,
        priceSpikeThreshold: 0.05,
        buyHourEST: 9.5,
    },
    liquidity: {
        wsEnabled: true,
        checkIntervalSecs: 30,
        buyDeadlineHour: 10.5,
        requireAllLiquid: false,
    },
    phases: {
        scoutDaysMax: 4,
        trendThreshold: 2,
    },
};

async function refreshConfig() {
    try {
        const res = await fetch(`${DATA_SVC}/api/config`);
        if (res.ok) {
            const remote = await res.json();
            if (remote.monitor) Object.assign(_config.monitor, remote.monitor);
            if (remote.liquidity) Object.assign(_config.liquidity, remote.liquidity);
            if (remote.phases) Object.assign(_config.phases, remote.phases);
        }
    } catch {
        /* intentional: config fetch may fail at startup, use defaults */
    }
}

function getConfigVal() {
    return _config;
}

// ── Service Clients (shared HTTP client) ────────────────────────────────

const weatherClient = createClient(WEATHER_SVC);
const marketClient = createClient(MARKET_SVC);
const tradingClient = createClient(TRADING_SVC);
const dataClient = createClient(DATA_SVC);
const liquidityClient = createClient(LIQUIDITY_SVC);

// Convenience wrappers matching the original call signatures: svcGet(BASE, path) → data
async function svcGet(base, path) {
    const client = clientForBase(base);
    return client.get(path, { timeoutMs: 30000 });
}
async function svcPost(base, path, body) {
    const client = clientForBase(base);
    return client.post(path, body, { timeoutMs: 60000 });
}
async function svcPut(base, path, body) {
    const client = clientForBase(base);
    return client.put(path, body, { timeoutMs: 15000 });
}

function clientForBase(base) {
    if (base === WEATHER_SVC) return weatherClient;
    if (base === MARKET_SVC) return marketClient;
    if (base === TRADING_SVC) return tradingClient;
    if (base === DATA_SVC) return dataClient;
    if (base === LIQUIDITY_SVC) return liquidityClient;
    return createClient(base);
}

// ── Service Clients ─────────────────────────────────────────────────────

async function fetchWeatherData(targetDate) {
    const [forecast, current] = await Promise.all([
        svcGet(WEATHER_SVC, `/api/forecast?date=${targetDate}`),
        svcGet(WEATHER_SVC, `/api/current`).catch(() => ({ tempF: null, maxSince7amF: null, conditions: null })),
    ]);
    return { forecast, current };
}

async function discoverMarket(targetDate) {
    return svcGet(MARKET_SVC, `/api/market?date=${targetDate}`);
}

async function selectRanges(forecastTempF, ranges, targetDate) {
    return svcGet(MARKET_SVC, `/api/ranges?date=${targetDate}&forecastF=${forecastTempF}`);
}

async function tryPlaceBuyOrder(snapshot, liqTokens = [], context = {}) {
    try {
        const result = await svcPost(TRADING_SVC, '/api/buy', { snapshot, liqTokens, context });
        if (!result || result.error) {
            console.warn(`  ⚠️  Buy order failed: ${result?.error || 'unknown'}`);
            return null;
        }
        if (result.allUnfilled) {
            console.warn('  ⚠️  Order placed but no fills confirmed — treating as failed');
            return null;
        }
        return result;
    } catch (err) {
        console.warn(`  ⚠️  Buy order failed: ${err.message}`);
        return null;
    }
}

async function executeSellOrder(positions, context = {}) {
    try {
        const result = await svcPost(TRADING_SVC, '/api/sell', { positions, context });
        if (!result || result.error) return null;
        return result;
    } catch (err) {
        console.warn(`  ⚠️  Sell order failed: ${err.message}`);
        return null;
    }
}

async function tryRedeemPositions(session) {
    try {
        const result = await svcPost(TRADING_SVC, '/api/redeem', { session });
        if (!result || result.error) return null;
        return result;
    } catch (err) {
        console.warn(`  ⚠️  Redeem failed: ${err.message}`);
        return null;
    }
}

async function fetchLiquidityFromService(date) {
    try {
        return await svcGet(LIQUIDITY_SVC, `/api/liquidity?date=${date}`);
    } catch {
        return null; /* intentional: liquidity-svc may not be ready */
    }
}

// ── Session Persistence (via data-svc) ──────────────────────────────────

async function loadSession(targetDate) {
    try {
        const data = await svcGet(DATA_SVC, `/api/session-files/${targetDate}`);
        return data;
    } catch {
        return null; /* intentional: session may not exist yet */
    }
}

async function saveSession(session) {
    try {
        await svcPut(DATA_SVC, `/api/session-files/${session.targetDate}`, session);
    } catch (err) {
        console.warn(`  ⚠️  Session save failed: ${err.message}`);
    }
}

async function dbUpsertSession(data) {
    try {
        const result = await svcPost(DATA_SVC, '/api/db/sessions', data);
        return result; // { upserted: true, existingId: ... }
    } catch (err) {
        console.warn(`  ⚠️  DB session upsert failed: ${err.message}`);
        return null;
    }
}

async function dbInsertSnapshot(data) {
    try {
        await svcPost(DATA_SVC, '/api/snapshots', data);
    } catch (err) {
        console.warn(`  ⚠️  DB snapshot insert failed: ${err.message}`);
    }
}

async function dbInsertAlert(data) {
    try {
        await svcPost(DATA_SVC, '/api/alerts', data);
    } catch (err) {
        console.warn(`  ⚠️  DB alert insert failed: ${err.message}`);
    }
}

async function dbInsertAlertsBatch(alerts) {
    if (!alerts || alerts.length === 0) return;
    try {
        await svcPost(DATA_SVC, '/api/alerts/batch', { alerts });
    } catch (err) {
        // Fallback to sequential inserts if batch endpoint is unavailable
        console.warn(`  ⚠️  Batch alert insert failed (${err.message}), falling back to sequential`);
        for (const a of alerts) await dbInsertAlert(a);
    }
}

// ── Snapshot Construction ───────────────────────────────────────────────

function buildSnapshotRange(range, previous) {
    const priceChange = previous ? parseFloat((range.yesPrice - previous.yesPrice).toFixed(4)) : 0;

    return {
        marketId: range.marketId,
        conditionId: range.conditionId,
        clobTokenIds: range.clobTokenIds,
        question: range.question,
        yesPrice: range.yesPrice,
        noPrice: range.noPrice || 0,
        bestBid: range.bestBid || 0,
        bestAsk: range.bestAsk || 0,
        priceChange,
        impliedProbability: range.impliedProbability,
        volume: range.volume,
    };
}

async function takeSnapshot(targetDate, previous) {
    const [weatherData, event] = await Promise.all([fetchWeatherData(targetDate), discoverMarket(targetDate)]);

    const { forecast, current } = weatherData;
    const selection = await selectRanges(forecast.highTempF, event.ranges, targetDate);

    const forecastChange = previous ? parseFloat((forecast.highTempF - previous.forecastTempF).toFixed(1)) : 0;
    const rangeShifted = previous ? selection.target.question !== previous.target.question : false;
    const shiftedFrom = rangeShifted ? previous.target.question : null;

    const phase = getPhase(targetDate);
    const days = daysUntil(targetDate);

    return {
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
        below: selection.below ? buildSnapshotRange(selection.below, previous?.below ?? null) : null,
        above: selection.above ? buildSnapshotRange(selection.above, previous?.above ?? null) : null,
        totalCost: selection.totalCost,
        rangeShifted,
        shiftedFrom,
        allRanges: event.ranges.map((r) => ({
            marketId: r.marketId,
            question: r.question,
            clobTokenIds: r.clobTokenIds || [],
            yesPrice: r.yesPrice,
            impliedProbability: r.impliedProbability,
            volume: r.volume,
        })),
        eventActive: event.active,
        eventClosed: event.closed,
    };
}

// ── Alert Detection ─────────────────────────────────────────────────────

function detectAlerts(current, previous, session) {
    const alerts = [];
    const now = nowISO();
    const initialForecast = session.initialForecastTempF;
    const cfg = _config.monitor;

    if (current.eventClosed) {
        alerts.push({ timestamp: now, type: 'market_closed', message: 'Market has been closed/resolved.', data: {} });
    }

    if (previous && current.phase !== previous.phase) {
        alerts.push({
            timestamp: now,
            type: 'phase_change',
            message: `Phase changed: ${previous.phase} → ${current.phase}`,
            data: { from: previous.phase, to: current.phase, daysUntil: current.daysUntilTarget },
        });
    }

    if (!previous) return alerts;

    const totalShift = Math.abs(current.forecastTempF - initialForecast);
    if (totalShift >= cfg.forecastShiftThreshold) {
        const delta = parseFloat((current.forecastTempF - initialForecast).toFixed(1));
        const isDrastic = totalShift >= cfg.rebalanceThreshold;
        alerts.push({
            timestamp: now,
            type: 'forecast_shift',
            message: `Forecast shifted ${delta > 0 ? '+' : ''}${delta}°F from initial (${initialForecast}°F → ${current.forecastTempF}°F)${isDrastic ? ' ⚠️ DRASTIC' : ''}`,
            data: { initialForecast, currentForecast: current.forecastTempF, delta, isDrastic },
        });
    }

    if (current.rangeShifted) {
        alerts.push({
            timestamp: now,
            type: 'range_shift',
            message: `Target range shifted: "${current.shiftedFrom}" → "${current.target.question}"`,
            data: { from: current.shiftedFrom, to: current.target.question, newForecast: current.forecastTempF },
        });
    }

    for (const { label, range } of [
        { label: 'target', range: current.target },
        { label: 'below', range: current.below },
        { label: 'above', range: current.above },
    ]) {
        if (range && Math.abs(range.priceChange) >= cfg.priceSpikeThreshold) {
            alerts.push({
                timestamp: now,
                type: 'price_spike',
                message: `${range.priceChange > 0 ? '📈' : '📉'} ${label.toUpperCase()} price ${(range.priceChange * 100).toFixed(1)}¢`,
                data: { label, question: range.question, priceChange: range.priceChange, currentPrice: range.yesPrice },
            });
        }
    }

    return alerts;
}

// ── Resolve Logic ───────────────────────────────────────────────────────

function resolveRanges(snapshot) {
    const candidates = [];
    if (snapshot.target) candidates.push({ label: 'target', range: snapshot.target });
    if (snapshot.below) candidates.push({ label: 'below', range: snapshot.below });
    if (snapshot.above) candidates.push({ label: 'above', range: snapshot.above });

    candidates.sort((a, b) => b.range.yesPrice - a.range.yesPrice);
    const keep = candidates[0];
    const discard = candidates.slice(1);

    return {
        keep: keep.range.question,
        keepLabel: keep.label,
        keepPrice: keep.range.yesPrice,
        discard: discard.map((d) => d.range.question),
        discardLabels: discard.map((d) => d.label),
        reason: `${keep.range.question} has highest YES price (${(keep.range.yesPrice * 100).toFixed(1)}¢)`,
    };
}

// ── Trend Analysis ──────────────────────────────────────────────────────

function analyzeTrend(forecastHistory) {
    if (!forecastHistory || forecastHistory.length < 2) {
        return { direction: 'neutral', magnitude: 0, volatility: 0, momentum: 0, convergence: 'unknown', points: forecastHistory || [] };
    }
    const sorted = [...forecastHistory].sort((a, b) => b.daysOut - a.daysOut);
    const totalDelta = sorted[sorted.length - 1].forecast - sorted[0].forecast;
    const threshold = _config.phases.trendThreshold;
    let direction = 'neutral';
    if (totalDelta >= threshold) direction = 'warming';
    if (totalDelta <= -threshold) direction = 'cooling';

    // Volatility: standard deviation of forecast deltas
    const deltas = [];
    for (let i = 1; i < sorted.length; i++) {
        deltas.push(sorted[i].forecast - sorted[i - 1].forecast);
    }
    const meanDelta = deltas.reduce((a, b) => a + b, 0) / deltas.length;
    const variance = deltas.reduce((sum, d) => sum + Math.pow(d - meanDelta, 2), 0) / deltas.length;
    const volatility = parseFloat(Math.sqrt(variance).toFixed(2));

    // Momentum: weighted average of recent deltas (last 3 weighted 3x more)
    let weightedSum = 0;
    let weightTotal = 0;
    for (let i = 0; i < deltas.length; i++) {
        const recency = i >= deltas.length - 3 ? 3 : 1;
        weightedSum += deltas[i] * recency;
        weightTotal += recency;
    }
    const momentum = parseFloat((weightTotal > 0 ? weightedSum / weightTotal : 0).toFixed(2));

    // Convergence: is the forecast stabilizing? (are recent deltas smaller?)
    let convergence = 'unknown';
    if (deltas.length >= 4) {
        const firstHalf = deltas.slice(0, Math.floor(deltas.length / 2)).map(Math.abs);
        const secondHalf = deltas.slice(Math.floor(deltas.length / 2)).map(Math.abs);
        const avgFirst = firstHalf.reduce((a, b) => a + b, 0) / firstHalf.length;
        const avgSecond = secondHalf.reduce((a, b) => a + b, 0) / secondHalf.length;
        convergence = avgSecond < avgFirst * 0.7 ? 'converging' : avgSecond > avgFirst * 1.3 ? 'diverging' : 'stable';
    }

    return { direction, magnitude: totalDelta, volatility, momentum, convergence, points: sorted };
}

// ── Buy Decision ────────────────────────────────────────────────────────

function shouldPlaceBuy(session, snapshot) {
    if (session.buyOrder) return false;
    if (session.awaitingLiquidity) return false;
    if (snapshot.eventClosed) return false;
    if (snapshot.phase && snapshot.phase !== 'buy') return false;

    const nowET = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
    const nowDate = new Date(nowET);
    const currentHourDecimal = nowDate.getHours() + nowDate.getMinutes() / 60;
    if (currentHourDecimal < _config.monitor.buyHourEST) return false;

    if (_config.liquidity.wsEnabled) return 'await-liquidity';
    return true;
}

// ── P&L Computation (uses shared module) ────────────────────────────────

import { computePnL as _computePnLCore } from '../../shared/pnl.js';

function computePnL(buyOrder, snapshot, liquidityBids) {
    return _computePnLCore(buyOrder, snapshot, liquidityBids);
}

// ── Liquidity-Gated Buy Flow ────────────────────────────────────────────

function attachSessionContext(order, session) {
    if (!order) return;
    order._sessionId = session.id;
    order._targetDate = session.targetDate;
    order._marketId = 'nyc';
}

function startLiquidityGatedBuy(session, snapshot) {
    session.awaitingLiquidity = true;
    session.liquidityWaitStart = nowISO();
    saveSession(session);

    const targetDate = session.targetDate;
    const pollIntervalMs = (_config.liquidity.checkIntervalSecs || 30) * 1000;
    const deadlineHour = _config.liquidity.buyDeadlineHour || 10.5;
    const deadlineH = Math.floor(deadlineHour);
    const deadlineM = Math.round((deadlineHour - deadlineH) * 60);

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
                console.log(`\n  ⏰ DEADLINE — forcing buy after ${waitStr}`);

                const deadlineLiq = await fetchLiquidityFromService(targetDate);
                // Take fresh snapshot so buy uses latest forecast
                let freshSnapshot;
                try {
                    freshSnapshot = await takeSnapshot(targetDate, null);
                } catch {
                    freshSnapshot = snapshot; /* intentional: use last known snapshot */
                }
                const order = await tryPlaceBuyOrder(freshSnapshot, deadlineLiq?.tokens || [], {
                    sessionId: session.id,
                    targetDate: session.targetDate,
                    marketId: 'nyc',
                });
                if (!order) {
                    console.warn('  ⚠️  Deadline buy failed');
                    return;
                }
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
                console.log(`  💰 Deadline buy: $${order.totalCost.toFixed(3)}`);
                return;
            }

            const liqData = await fetchLiquidityFromService(targetDate);
            if (!liqData || !liqData.tokens || liqData.tokens.length === 0) return;

            const requireAll = _config.liquidity.requireAllLiquid;
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
            console.log(`\n  ✅ LIQUIDITY MET — buying (${liquidCount}/${totalCount} liquid, waited ${waitStr})`);

            // Take fresh snapshot so buy uses latest forecast
            let freshSnapshot;
            try {
                freshSnapshot = await takeSnapshot(targetDate, null);
            } catch {
                freshSnapshot = snapshot; /* intentional: use last known snapshot */
            }
            const order = await tryPlaceBuyOrder(freshSnapshot, liqData.tokens, {
                sessionId: session.id,
                targetDate: session.targetDate,
                marketId: 'nyc',
            });
            if (!order) {
                console.warn('  ⚠️  Liquidity-gated buy failed');
                return;
            }
            attachSessionContext(order, session);
            order.liquidityWait = waitStr;
            session.buyOrder = order;
            session.pnl = computePnL(order, snapshot);
            session.alerts.push({
                timestamp: nowISO(),
                type: 'buy_executed',
                message: `Buy after ${waitStr} liquidity wait`,
                data: { waitMs, liquidCount, totalCount },
            });
            await saveSession(session);
            console.log(`  💰 Buy order placed: $${order.totalCost.toFixed(3)} [waited ${waitStr}]`);
        } finally {
            // Release lock
            _buyInProgress = false;
        }
    }, pollIntervalMs);
}

// ── Session Management (Exported) ───────────────────────────────────────

export async function createOrResumeSession(targetDate, intervalMinutes) {
    const existing = await loadSession(targetDate);

    if (existing && existing.status === 'completed') {
        console.log(`  ✅ Session ${targetDate} already completed — skipping`);
        return existing;
    }

    if (existing && (existing.status === 'active' || existing.status === 'stopped')) {
        existing.status = 'active';
        existing.phase = getPhase(targetDate);

        // Clean up failed buy orders
        if (existing.buyOrder && existing.buyOrder.totalCost === 0) {
            const allFailed = existing.buyOrder.positions?.every((p) => p.status === 'failed');
            if (allFailed) {
                console.log(`  🧹 Clearing failed buy order`);
                existing.buyOrder = null;
                existing.pnl = null;
            }
        }
        if (!existing.buyOrder) {
            // Try to hydrate buyOrder from chain-backfilled DB data
            try {
                const dbPositions = await svcGet(DATA_SVC, `/api/positions/active?date=${targetDate}`);
                if (dbPositions && dbPositions.length > 0) {
                    const positions = dbPositions.map((p) => ({
                        question: p.question,
                        label: p.label || 'chain',
                        buyPrice: p.price,
                        shares: p.shares,
                        tokenId: p.token_id,
                        conditionId: p.condition_id,
                        clobTokenIds: p.clob_token_ids ? JSON.parse(p.clob_token_ids) : undefined,
                        positionId: p.id,
                        status: p.status || 'filled',
                        soldAt: p.sold_at || null,
                    }));
                    const totalCost = positions.reduce((sum, p) => sum + (p.buyPrice || 0) * (p.shares || 0), 0);
                    existing.buyOrder = {
                        positions,
                        totalCost: parseFloat(totalCost.toFixed(4)),
                        mode: 'live',
                        source: 'chain-backfill',
                        placedAt: dbPositions[0].created_at,
                    };
                    console.log(`  🔗 Hydrated buyOrder from chain data: ${positions.length} positions, $${totalCost.toFixed(3)}`);
                } else {
                    console.log(`  ⏳ No buy order yet — will trigger via normal buy flow`);
                }
            } catch (err) {
                console.warn(`  ⚠️  Chain-backfill hydration failed: ${err.message}`);
                console.log(`  ⏳ No buy order yet — will trigger via normal buy flow`);
            }
        }
        if (existing.awaitingLiquidity && !existing.buyOrder) {
            existing.awaitingLiquidity = false;
            console.log(`  🔄 Resetting liquidity wait`);
        }

        // Reset failed resolve sell
        if (existing.resolveSellExecuted && existing.sellOrders?.length > 0) {
            const lastSell = existing.sellOrders[existing.sellOrders.length - 1];
            const allSellsFailed = lastSell.positions?.every((p) => p.status === 'failed');
            if (allSellsFailed) {
                console.log(`  🔄 Resetting failed resolve sell`);
                existing.resolveSellExecuted = false;
                existing.sellOrders.pop();
                for (const p of existing.buyOrder?.positions || []) {
                    if (p.soldStatus === 'failed') {
                        p.soldAt = undefined;
                        p.soldStatus = undefined;
                        p.soldOrderId = undefined;
                    }
                }
            }
        }

        await saveSession(existing);
        // Reconcile session ID with DB — the DB may hold a different ID, or no session at all
        try {
            const dbSession = await svcGet(DATA_SVC, `/api/db/sessions/nyc/${targetDate}`);
            if (dbSession && dbSession.id && dbSession.id !== existing.id) {
                existing.id = dbSession.id;
            }
        } catch {
            // Session not in DB — upsert it so snapshots/alerts have a valid FK target
            const upsertResult = await dbUpsertSession({
                id: existing.id,
                marketId: 'nyc',
                targetDate,
                status: existing.status,
                phase: existing.phase,
                initialForecastTemp: existing.initialForecastTempF,
                initialTargetRange: existing.initialTargetRange,
                forecastSource: existing.forecastSource,
                intervalMinutes: parseInt(existing.intervalMinutes) || 5,
                rebalanceThreshold: parseFloat(existing.rebalanceThreshold) || 3.0,
            });
            if (upsertResult?.existingId && upsertResult.existingId !== existing.id) {
                existing.id = upsertResult.existingId;
            }
        }
        console.log(`  📋 Resuming session (${existing.snapshots.length} snapshots, phase: ${existing.phase})`);
        return existing;
    }

    // New session
    console.log('  📸 Taking initial snapshot...');
    const snapshot = await takeSnapshot(targetDate, null);
    const phase = getPhase(targetDate);

    let buyOrder = null;
    if (snapshot.eventClosed) {
        console.log('  ⏳ Event is closed/not yet created — deferring buy');
    } else {
        const shouldGate = _config.liquidity.wsEnabled && phase === 'buy';
        if (!shouldGate) {
            const initLiq = await fetchLiquidityFromService(targetDate);
            buyOrder = await tryPlaceBuyOrder(snapshot, initLiq?.tokens || [], { targetDate, marketId: 'nyc' });
            if (buyOrder) {
                console.log(`  💰 Buy order placed: $${buyOrder.totalCost.toFixed(3)} [${buyOrder.mode || 'live'}]`);
            } else {
                console.log('  ⚠️ Buy attempted but failed — will retry next cycle');
            }
        } else {
            console.log('  ⏳ Buy deferred — liquidity gate will handle');
        }
    }

    const sessionId = crypto.randomUUID();
    if (buyOrder) {
        buyOrder._sessionId = sessionId;
        buyOrder._targetDate = targetDate;
        buyOrder._marketId = 'nyc';
    }

    const session = {
        id: sessionId,
        targetDate,
        startedAt: nowISO(),
        status: 'active',
        phase,
        intervalMinutes,
        initialForecastTempF: snapshot.forecastTempF,
        initialTargetRange: snapshot.target.question,
        forecastSource: snapshot.forecastSource,
        rebalanceThreshold: _config.monitor.rebalanceThreshold,
        buyOrder,
        pnl: null,
        snapshots: [snapshot],
        alerts: [],
    };

    await saveSession(session);

    // DB persist — upsert returns existingId if session already existed
    const upsertResult = await dbUpsertSession({
        id: session.id,
        marketId: 'nyc',
        targetDate,
        status: session.status,
        phase,
        initialForecastTemp: snapshot.forecastTempF,
        initialTargetRange: snapshot.target?.question,
        forecastSource: snapshot.forecastSource,
        intervalMinutes,
        rebalanceThreshold: _config.monitor.rebalanceThreshold,
    });
    // If DB already had a session for this date, adopt its ID for FK integrity
    if (upsertResult?.existingId && upsertResult.existingId !== session.id) {
        session.id = upsertResult.existingId;
    }
    await dbInsertSnapshot({ sessionId: session.id, ...snapshot });

    return session;
}

// ── Monitoring Cycle (Exported) ─────────────────────────────────────────

export async function runMonitoringCycle(session) {
    const previousSnapshot = session.snapshots[session.snapshots.length - 1] || null;
    const snapshot = await takeSnapshot(session.targetDate, previousSnapshot);
    const alerts = detectAlerts(snapshot, previousSnapshot, session);

    session.phase = snapshot.phase;

    // Record forecast history for trend analysis
    if (!session.forecastHistory) session.forecastHistory = [];
    const todayET = getTodayET();
    const alreadyRecordedToday = session.forecastHistory.some((h) => h.date === todayET);
    if (!alreadyRecordedToday && snapshot.forecastTempF != null) {
        session.forecastHistory.push({
            date: todayET,
            daysOut: snapshot.daysUntilTarget,
            forecast: snapshot.forecastTempF,
            source: snapshot.forecastSource,
            timestamp: nowISO(),
        });
    }
    session.trend = analyzeTrend(session.forecastHistory);

    // Scout/Track: observation only
    if (snapshot.phase === 'scout' || snapshot.phase === 'track') {
        session.snapshots.push(snapshot);
        session.alerts = [...(session.alerts || []), ...alerts];
        await saveSession(session);
        await dbInsertSnapshot({ sessionId: session.id, ...snapshot });
        await dbInsertAlertsBatch(alerts.map((a) => ({ sessionId: session.id, ...a })));
        return { snapshot, alerts };
    }

    // Buy logic
    const buySignal = shouldPlaceBuy(session, snapshot);
    if (buySignal === true) {
        const immLiq = await fetchLiquidityFromService(session.targetDate);
        session.buyOrder = await tryPlaceBuyOrder(snapshot, immLiq?.tokens || [], {
            sessionId: session.id,
            targetDate: session.targetDate,
            marketId: 'nyc',
        });
        attachSessionContext(session.buyOrder, session);
    } else if (buySignal === 'await-liquidity' && !session.awaitingLiquidity) {
        startLiquidityGatedBuy(session, snapshot);
    }

    // ── Sell Strategy ───────────────────────────────────────────────────

    if (session.buyOrder && !snapshot.eventClosed) {
        // RESOLVE DAY: sell hedge positions (after 9:30am EST)
        const resolveSellHour = _config.monitor.buyHourEST || 9.5; // Default 9:30am EST
        const nowET = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
        const nowDate = new Date(nowET);
        const currentHour = nowDate.getHours() + nowDate.getMinutes() / 60;
        if (snapshot.phase === 'resolve' && !session.resolveSellExecuted && currentHour >= resolveSellHour) {
            const currentTargetQ = snapshot.target?.question;
            if (currentTargetQ) {
                const positionsToSell = [];
                for (const pos of session.buyOrder.positions) {
                    if (pos.status === 'failed' || pos.status === 'rejected') continue;
                    if (pos.soldAt) continue;

                    let tokenId = pos.clobTokenId || pos.clobTokenIds?.[0] || pos.tokenId;
                    if (!tokenId) {
                        for (const key of ['target', 'below', 'above']) {
                            const snapRange = snapshot[key];
                            if (snapRange && snapRange.question === pos.question && snapRange.clobTokenIds?.[0]) {
                                tokenId = snapRange.clobTokenIds[0];
                                pos.clobTokenIds = snapRange.clobTokenIds;
                                pos.tokenId = tokenId;
                                break;
                            }
                        }
                    }

                    if (pos.question !== currentTargetQ) {
                        positionsToSell.push({
                            label: pos.label,
                            question: pos.question,
                            clobTokenId: tokenId,
                            conditionId: pos.conditionId,
                            shares: pos.shares || 1,
                        });
                    }
                }

                if (positionsToSell.length > 0) {
                    console.log(`\n  🎯 RESOLVE-DAY SELL: selling ${positionsToSell.length} hedge position(s)`);
                    const sellCtx = { sessionId: session.id, targetDate: session.targetDate, marketId: 'nyc' };
                    const sellResult = await executeSellOrder(positionsToSell, sellCtx);
                    if (sellResult) {
                        if (!session.sellOrders) session.sellOrders = [];
                        session.sellOrders.push(sellResult);
                        session.resolveSellExecuted = true;
                        for (const sold of sellResult.positions) {
                            const original = session.buyOrder.positions.find((p) => p.question === sold.question);
                            if (original) {
                                original.soldAt = nowISO();
                                original.sellPrice = sold.sellPrice;
                                original.soldOrderId = sold.orderId;
                                original.soldStatus = sold.status;
                            }
                        }
                        alerts.push({
                            timestamp: nowISO(),
                            type: 'resolve_sell',
                            message: `Resolve-day sell: sold ${positionsToSell.length} hedge position(s)`,
                            data: { forecast: snapshot.forecastTempF, sold: positionsToSell.map((p) => p.question) },
                        });
                    }
                } else {
                    session.resolveSellExecuted = true;
                }
            }
        }

        // MONITOR/BUY: rebalance on forecast shift
        // Multi-rebalance: measures shift from last rebalance point (not just initial forecast)
        if ((snapshot.phase === 'monitor' || snapshot.phase === 'buy') && session.buyOrder) {
            const rebalanceRef = session.lastRebalanceForecastF ?? session.initialForecastTempF;
            const totalShift = Math.abs(snapshot.forecastTempF - rebalanceRef);
            if (totalShift >= _config.monitor.rebalanceThreshold) {
                console.log(`\n  🔄 REBALANCE: forecast shifted ${totalShift.toFixed(1)}°F from reference ${rebalanceRef.toFixed(1)}°F`);

                const currentRangeQuestions = new Set(
                    [snapshot.target?.question, snapshot.below?.question, snapshot.above?.question].filter(Boolean),
                );
                const positionsToSell = [];
                for (const pos of session.buyOrder.positions) {
                    if (pos.status === 'failed' || pos.status === 'rejected' || pos.soldAt) continue;
                    let tokenId = pos.clobTokenId || pos.clobTokenIds?.[0] || pos.tokenId;
                    if (!tokenId) {
                        for (const key of ['target', 'below', 'above']) {
                            const snapRange = snapshot[key];
                            if (snapRange && snapRange.question === pos.question && snapRange.clobTokenIds?.[0]) {
                                tokenId = snapRange.clobTokenIds[0];
                                pos.clobTokenIds = snapRange.clobTokenIds;
                                break;
                            }
                        }
                    }
                    if (!currentRangeQuestions.has(pos.question)) {
                        positionsToSell.push({
                            label: pos.label,
                            question: pos.question,
                            clobTokenId: tokenId,
                            conditionId: pos.conditionId,
                            shares: pos.shares || 1,
                        });
                    }
                }

                if (positionsToSell.length > 0) {
                    const sellCtx = { sessionId: session.id, targetDate: session.targetDate, marketId: 'nyc' };
                    const sellResult = await executeSellOrder(positionsToSell, sellCtx);
                    if (sellResult) {
                        if (!session.sellOrders) session.sellOrders = [];
                        session.sellOrders.push(sellResult);
                        session.lastRebalanceForecastF = snapshot.forecastTempF;
                        for (const sold of sellResult.positions) {
                            const original = session.buyOrder.positions.find((p) => p.question === sold.question);
                            if (original) {
                                original.soldAt = nowISO();
                                original.sellPrice = sold.sellPrice;
                                original.soldOrderId = sold.orderId;
                                original.soldStatus = sold.status;
                            }
                        }
                        alerts.push({
                            timestamp: nowISO(),
                            type: 'rebalance_sell',
                            message: `Sold ${positionsToSell.length} out-of-range positions (shift: ${totalShift.toFixed(1)}°F from ${rebalanceRef.toFixed(1)}°F)`,
                            data: { shift: totalShift, rebalanceRef, proceeds: sellResult.totalProceeds },
                        });
                    }
                }
            }
        }
    }

    // P&L update
    if (session.buyOrder) {
        const liqData = await fetchLiquidityFromService(session.targetDate);
        const liquidityBids = {};
        if (liqData?.tokens) {
            for (const t of liqData.tokens) {
                if (t.question && t.bestBid > 0) liquidityBids[t.question] = t.bestBid;
            }
        }
        session.pnl = computePnL(session.buyOrder, snapshot, liquidityBids);
    }

    session.snapshots.push(snapshot);
    session.alerts.push(...alerts);

    let resolution = null;
    if (snapshot.phase === 'resolve' && !snapshot.eventClosed) {
        resolution = resolveRanges(snapshot);
        session.resolution = resolution;
    }

    // Auto-redeem
    if (snapshot.eventClosed && session.status !== 'completed') {
        session.status = 'completed';
        if (session.buyOrder && !session.redeemExecuted) {
            const redeemResult = await tryRedeemPositions(session);
            if (redeemResult) {
                session.redeemExecuted = true;
                session.redeemResult = redeemResult;
                alerts.push({
                    timestamp: nowISO(),
                    type: 'redeem',
                    message: `Redeemed ${redeemResult.redeemed} positions for $${redeemResult.totalValue.toFixed(2)}`,
                    data: redeemResult,
                });
            }
        }
    }

    await saveSession(session);

    // DB writes — upsert first to resolve correct session ID for FK integrity
    const upsertResult = await dbUpsertSession({
        id: session.id,
        marketId: 'nyc',
        targetDate: session.targetDate,
        status: session.status,
        phase: session.phase,
        initialForecastTemp: session.initialForecastTempF,
        initialTargetRange: session.initialTargetRange,
        forecastSource: session.forecastSource,
        intervalMinutes: parseInt(session.intervalMinutes) || 5,
        rebalanceThreshold: session.rebalanceThreshold,
    });
    if (upsertResult?.existingId && upsertResult.existingId !== session.id) {
        session.id = upsertResult.existingId;
    }
    await dbInsertSnapshot({ sessionId: session.id, ...snapshot });
    await dbInsertAlertsBatch(alerts.map((a) => ({ sessionId: session.id, ...a })));

    return { snapshot, alerts, resolution };
}

export async function stopSession(session) {
    session.status = 'stopped';
    await saveSession(session);
}

export { getConfigVal as getConfig, getPhase, getDateOffsetET, daysUntil, refreshConfig, loadSession };
