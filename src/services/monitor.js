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
import { executeSellOrder } from './trading.js';
import nodeHttp from 'http';
import { ethers } from 'ethers';
import { nowISO, daysUntil, getPhase, getTodayET } from '../utils/dateUtils.js';

// ── On-chain redemption constants ───────────────────────────────────────
const CTF_CONTRACT_ADDR = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
const NEG_RISK_ADAPTER_ADDR = '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296';
const USDC_E_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const CTF_REDEEM_ABI = [
    'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)',
    'function balanceOf(address owner, uint256 id) view returns (uint256)',
    'function payoutDenominator(bytes32 conditionId) view returns (uint256)',
    'function payoutNumerators(bytes32 conditionId, uint256 index) view returns (uint256)',
];
const NEG_RISK_ADAPTER_ABI = [
    'function redeemPositions(bytes32 conditionId, uint256[] indexSets)',
];
const GAS_OVERRIDES = {
    gasLimit: 300000,
    maxFeePerGas: ethers.utils.parseUnits('200', 'gwei'),
    maxPriorityFeePerGas: ethers.utils.parseUnits('30', 'gwei'),
};

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
            clobTokenId: snapshot.target.clobTokenIds?.[0] || null,
            buyPrice: snapshot.target.yesPrice,
            shares: 1,  // 1 share = $1 payout if YES
        });
    }
    if (snapshot.below) {
        positions.push({
            label: 'below',
            question: snapshot.below.question,
            marketId: snapshot.below.marketId,
            clobTokenId: snapshot.below.clobTokenIds?.[0] || null,
            buyPrice: snapshot.below.yesPrice,
            shares: 1,
        });
    }
    if (snapshot.above) {
        positions.push({
            label: 'above',
            question: snapshot.above.question,
            marketId: snapshot.above.marketId,
            clobTokenId: snapshot.above.clobTokenIds?.[0] || null,
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
async function tryPlaceBuyOrder(snapshot, liqTokens = []) {
    try {
        const realOrder = await executeRealBuyOrder(snapshot, liqTokens);
        if (!realOrder) return null;

        // If post-trade verification found no actual fills, treat as failed
        if (realOrder.allUnfilled) {
            console.warn('  ⚠️  Order was placed but no fills confirmed — treating as failed');
            return null;
        }

        return realOrder;
    } catch (err) {
        console.warn(`  ⚠️  Buy order failed: ${err.message}`);
    }
    // If real order failed or returned null, don't fake a buy
    return null;
}

// ── Auto-Redemption ─────────────────────────────────────────────────────

/**
 * Attempt to redeem resolved winning positions on-chain.
 * Called automatically when a market is detected as closed.
 *
 * @param {import('../models/types.js').MonitoringSession} session
 * @returns {Promise<{redeemed: number, totalValue: number, positions: Array}|null>}
 */
async function tryRedeemPositions(session) {
    const privateKey = process.env.POLYMARKET_PRIVATE_KEY;
    if (!privateKey) {
        console.log(`  ⚠️  POLYMARKET_PRIVATE_KEY not set — cannot redeem`);
        return null;
    }

    try {
        const rpc = process.env.POLYGON_RPC_URL || 'https://polygon.drpc.org';
        const provider = new ethers.providers.StaticJsonRpcProvider(rpc, 137);
        const wallet = new ethers.Wallet(privateKey, provider);
        const ctf = new ethers.Contract(CTF_CONTRACT_ADDR, CTF_REDEEM_ABI, wallet);

        // Initialize CLOB client for resolution checks (per official docs)
        const { ClobClient } = await import('@polymarket/clob-client');
        const clobClient = new ClobClient(
            'https://clob.polymarket.com', 137, wallet,
            { key: process.env.CLOB_API_KEY, secret: process.env.CLOB_SECRET, passphrase: process.env.CLOB_PASSPHRASE },
        );

        // Collect held positions with conditionIds
        const heldPositions = session.buyOrder.positions.filter(
            p => !p.soldAt && !p.redeemed && p.conditionId &&
                 p.status !== 'failed' && p.status !== 'rejected'
        );

        if (heldPositions.length === 0) {
            console.log(`  ℹ️  No held positions to redeem`);
            return null;
        }

        // Deduplicate by conditionId
        const conditionIds = [...new Set(heldPositions.map(p => p.conditionId))];
        let totalRedeemed = 0;
        let totalValue = 0;
        const results = [];

        for (const condId of conditionIds) {
            try {
                // Use CLOB client to check resolution (per official Polymarket docs)
                const market = await clobClient.getMarket(condId);
                if (!market.closed) {
                    console.log(`  ⏳ ${condId.substring(0, 12)}... not yet closed`);
                    continue;
                }

                const negRisk = market.neg_risk === true;
                const winningToken = market.tokens?.find(t => t.winner === true);

                const pos = heldPositions.find(p => p.conditionId === condId);
                const shares = pos?.shares || 1;

                if (!winningToken || winningToken.outcome?.toUpperCase() !== 'YES') {
                    console.log(`  ❌ ${pos?.label || 'position'}: Resolved NO — worthless`);
                    for (const p of heldPositions.filter(p => p.conditionId === condId)) {
                        p.redeemed = true;
                        p.redeemedAt = nowISO();
                        p.redeemedValue = 0;
                    }
                    continue;
                }

                // Verify on-chain balance before redeeming
                let hasBalance = false;
                if (pos?.clobTokenIds) {
                    for (const tid of (Array.isArray(pos.clobTokenIds) ? pos.clobTokenIds : [])) {
                        try {
                            const bal = await ctf.balanceOf(wallet.address, tid);
                            if (bal.gt(0)) { hasBalance = true; break; }
                        } catch { /* skip */ }
                    }
                } else {
                    hasBalance = true;
                }

                if (!hasBalance) {
                    console.log(`  ℹ️  ${pos?.label || 'position'}: WON but no on-chain balance (already sold?)`);
                    for (const p of heldPositions.filter(p => p.conditionId === condId)) {
                        p.redeemed = true;
                        p.redeemedAt = nowISO();
                        p.redeemedValue = 0;
                    }
                    continue;
                }

                const value = shares;
                console.log(`  🏆 ${pos?.label || 'position'}: WON! Redeeming ${shares} shares ($${value.toFixed(2)})...`);

                let tx;
                if (negRisk) {
                    const adapter = new ethers.Contract(NEG_RISK_ADAPTER_ADDR, NEG_RISK_ADAPTER_ABI, wallet);
                    console.log(`     📝 Calling NegRiskAdapter.redeemPositions...`);
                    tx = await adapter.redeemPositions(condId, [1, 2], GAS_OVERRIDES);
                } else {
                    console.log(`     📝 Calling CTF.redeemPositions...`);
                    tx = await ctf.redeemPositions(USDC_E_ADDRESS, ethers.constants.HashZero, condId, [1, 2], GAS_OVERRIDES);
                }

                console.log(`     TX: ${tx.hash}`);
                const receipt = await tx.wait();
                console.log(`     ✅ Redeemed! Gas: ${receipt.gasUsed.toString()}`);

                for (const p of heldPositions.filter(p => p.conditionId === condId)) {
                    p.redeemed = true;
                    p.redeemedAt = nowISO();
                    p.redeemedTx = tx.hash;
                    p.redeemedValue = p.shares || 1;
                }

                totalRedeemed++;
                totalValue += value;
                results.push({ conditionId: condId, label: pos?.label, shares, txHash: tx.hash });

            } catch (err) {
                console.log(`  ❌ Redeem failed for ${condId.substring(0, 12)}...: ${err.message}`);
            }
        }

        return totalRedeemed > 0
            ? { redeemed: totalRedeemed, totalValue, positions: results }
            : null;

    } catch (err) {
        console.log(`  ❌ Auto-redeem error: ${err.message}`);
        return null;
    }
}

// ── Forecast Trend Analysis ─────────────────────────────────────────────

/**
 * Analyze forecast history to determine trend direction.
 * Compares earliest observation to latest to detect warming/cooling.
 *
 * @param {Array<{date:string, daysOut:number, forecast:number}>} forecastHistory
 * @returns {{ direction: 'warming'|'cooling'|'neutral', magnitude: number, points: Array }}
 */
function analyzeTrend(forecastHistory) {
    if (!forecastHistory || forecastHistory.length < 2) {
        return { direction: 'neutral', magnitude: 0, points: forecastHistory || [] };
    }

    // Sort by daysOut descending (earliest observation first)
    const sorted = [...forecastHistory].sort((a, b) => b.daysOut - a.daysOut);
    const first = sorted[0].forecast;       // earliest (e.g. T+4)
    const last = sorted[sorted.length - 1].forecast; // latest (e.g. T+2)
    const totalDelta = last - first;

    const threshold = config.phases.trendThreshold;

    let direction = 'neutral';
    if (totalDelta >= threshold) direction = 'warming';
    if (totalDelta <= -threshold) direction = 'cooling';

    return {
        direction,
        magnitude: totalDelta,
        points: sorted,
    };
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

    // Never buy against a closed/stale event
    if (snapshot.eventClosed) {
        return false;
    }

    // Only buy during the buy phase (T+2)
    if (snapshot.phase && snapshot.phase !== 'buy') {
        return false;
    }

    // Check if current time is at or past buyHourEST (supports decimals: 9.5 = 9:30am)
    const nowET = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
    const nowDate = new Date(nowET);
    const currentHourDecimal = nowDate.getHours() + nowDate.getMinutes() / 60;
    if (currentHourDecimal < config.monitor.buyHourEST) return false;

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
export function computePnL(buyOrder, snapshot, liquidityBids) {
    if (!buyOrder || !buyOrder.positions) return null;

    const currentRanges = {
        target: snapshot.target,
        below: snapshot.below,
        above: snapshot.above,
    };

    const bids = liquidityBids || {};

    let totalBuyCost = 0;
    let totalCurrentValue = 0;
    const positions = [];

    for (const pos of buyOrder.positions) {
        const currentRange = currentRanges[pos.label];
        // Match by question text (stable across range shifts) for live CLOB bid
        const clobBid = bids[pos.question];
        const currentPrice = clobBid > 0
            ? clobBid
            : (currentRange?.yesPrice ?? pos.buyPrice);
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

    // Hot-patch: check for external patch file and merge into in-memory session
    const patchPath = path.join(OUTPUT_DIR, `patch-${session.targetDate}.json`);
    if (fs.existsSync(patchPath)) {
        try {
            const patch = JSON.parse(fs.readFileSync(patchPath, 'utf-8'));
            console.log(`  🔧 HOT-PATCH: applying patch for ${session.targetDate}`);
            Object.assign(session, patch);
            // Delete patch file after applying
            fs.unlinkSync(patchPath);
            console.log(`  ✅ Patch applied and removed`);
        } catch (err) {
            console.log(`  ⚠️  Failed to apply patch: ${err.message}`);
        }
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
        noPrice: range.noPrice || 0,
        bestBid: range.bestBid || 0,
        bestAsk: range.bestAsk || 0,
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
            clobTokenIds: r.clobTokenIds || [],
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
        const phaseLabels = { scout: '🔭 Scout', track: '📈 Track', buy: '🛒 Buy', monitor: '👁️ Monitor', resolve: '🎯 Resolve' };
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

// ── Liquidity Microservice Client ───────────────────────────────────────

const LIQUIDITY_SERVICE_URL = 'http://localhost:3001';

/**
 * Fetch liquidity data from the dedicated liquidity microservice.
 * @param {string} date - Target date (YYYY-MM-DD)
 * @returns {Promise<Object|null>}
 */
function fetchLiquidityFromService(date) {
    return new Promise((resolve) => {
        const url = `${LIQUIDITY_SERVICE_URL}/api/liquidity?date=${date}`;
        const req = nodeHttp.get(url, { timeout: 5000 }, (res) => {
            let body = '';
            res.on('data', chunk => { body += chunk; });
            res.on('end', () => {
                try {
                    resolve(JSON.parse(body));
                } catch {
                    resolve(null);
                }
            });
        });
        req.on('error', () => resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });
    });
}

/**
 * Start monitoring liquidity via the microservice and auto-buy when conditions are met.
 *
 * Instead of buying immediately at 7am, we poll the liquidity microservice
 * (which streams the order book via WebSocket) and wait for all (or any,
 * per config) tokens to reach liquid conditions before executing.
 * A deadline timer forces a buy if liquidity never materializes.
 *
 * @param {import('../models/types.js').MonitoringSession} session
 * @param {import('../models/types.js').MonitoringSnapshot} snapshot
 */
function startLiquidityGatedBuy(session, snapshot) {
    // Mark session as waiting
    session.awaitingLiquidity = true;
    session.liquidityWaitStart = nowISO();
    saveSession(session);

    const targetDate = session.targetDate;
    const pollIntervalMs = (config.liquidity.checkIntervalSecs || 30) * 1000;

    const deadlineHour = config.liquidity.buyDeadlineHour || 10.5;
    const deadlineH = Math.floor(deadlineHour);
    const deadlineM = Math.round((deadlineHour - deadlineH) * 60);

    console.log(`\n  ⏳ Liquidity gate activated for ${targetDate}`);
    console.log(`     Polling:   liquidity service every ${pollIntervalMs / 1000}s`);
    console.log(`     Deadline:  ${deadlineH}:${String(deadlineM).padStart(2, '0')} ET`);
    console.log(`     Require:   ${config.liquidity.requireAllLiquid ? 'ALL tokens liquid' : 'ANY token liquid'}`);

    let bought = false;

    // ── Polling loop ──────────────────────────────────────────────────
    const pollTimer = setInterval(async () => {
        if (bought || session.buyOrder) {
            clearInterval(pollTimer);
            return;
        }

        // Check deadline (supports fractional hours: 10.5 = 10:30)
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

            console.log(`\n  ⏰ DEADLINE REACHED (${deadlineH}:${String(deadlineM).padStart(2, '0')} ET) — forcing buy after ${waitStr}`);

            // Fetch latest WS liquidity data for accurate spread checks
            const deadlineLiq = await fetchLiquidityFromService(targetDate);
            const order = await tryPlaceBuyOrder(snapshot, deadlineLiq?.tokens || []);
            if (!order) {
                console.warn('  ⚠️  Deadline buy failed — will retry next cycle');
                return;
            }
            order.liquidityWait = waitStr;
            order.forcedByDeadline = true;
            session.buyOrder = order;
            session.pnl = computePnL(order, snapshot);
            session.alerts.push({
                timestamp: nowISO(),
                type: 'buy_executed',
                message: `Buy forced at deadline (${deadlineH}:${String(deadlineM).padStart(2, '0')} ET) after ${waitStr} — liquidity never optimal`,
                data: { waitMs, forced: true },
            });
            saveSession(session);
            console.log(`  💰 Deadline buy placed: $${order.totalCost.toFixed(3)}`);
            return;
        }

        // Poll the liquidity microservice
        const liqData = await fetchLiquidityFromService(targetDate);
        if (!liqData || !liqData.tokens || liqData.tokens.length === 0) return;

        // Check liquidity conditions
        const requireAll = config.liquidity.requireAllLiquid;
        const liquidCount = liqData.liquidCount || 0;
        const totalCount = liqData.tokenCount || liqData.tokens.length;
        const allLiquid = liqData.allLiquid || false;
        const conditionMet = requireAll ? allLiquid : (liquidCount > 0);

        if (!conditionMet) {
            // Log every few polls for visibility
            const elapsedMin = ((Date.now() - new Date(session.liquidityWaitStart).getTime()) / 60000).toFixed(0);
            if (parseInt(elapsedMin) % 5 === 0) {
                console.log(`  ⏳ [${targetDate}] Liquidity check: ${liquidCount}/${totalCount} liquid (${elapsedMin}m elapsed)`);
                for (const t of liqData.tokens) {
                    console.log(`     ${t.isLiquid ? '✅' : '❌'} ${t.label}: spread=${(t.spreadPct * 100).toFixed(1)}% depth=${t.askDepth} score=${(t.score * 100).toFixed(0)}%`);
                }
            }
            return;
        }

        // ── LIQUIDITY WINDOW OPEN — execute buy ──
        clearInterval(pollTimer);
        bought = true;
        session.awaitingLiquidity = false;

        const waitMs = Date.now() - new Date(session.liquidityWaitStart).getTime();
        const waitStr = waitMs < 60000
            ? `${(waitMs / 1000).toFixed(0)}s`
            : `${(waitMs / 60000).toFixed(1)}m`;

        console.log(`\n  🟢 LIQUIDITY WINDOW OPEN — ${liquidCount}/${totalCount} tokens liquid`);
        console.log(`     Waited: ${waitStr}`);

        // Log per-token liquidity at buy time
        for (const t of liqData.tokens) {
            const status = t.isLiquid ? '✅' : '⚠️';
            console.log(`     ${status} ${t.label}: bid=$${t.bestBid.toFixed(3)} ask=$${t.bestAsk.toFixed(3)} spread=${(t.spreadPct * 100).toFixed(1)}% depth=${t.askDepth} score=${(t.score * 100).toFixed(0)}%`);
        }

        // Update snapshot prices with live stream data
        const liveSnapshot = { ...snapshot };
        for (const t of liqData.tokens) {
            const rangeKey = t.label;  // target, below, above
            if (liveSnapshot[rangeKey]) {
                liveSnapshot[rangeKey] = {
                    ...liveSnapshot[rangeKey],
                    yesPrice: t.bestAsk,  // Use live ask for immediate fill
                };
            }
        }

        // Execute the buy with live prices + WS liquidity data
        const order = await tryPlaceBuyOrder(liveSnapshot, liqData.tokens || []);
        if (!order) {
            console.warn('  ⚠️  Liquidity-gated buy failed — will retry next cycle');
            session.awaitingLiquidity = false;
            return;
        }
        order.liquidityWait = waitStr;
        order.liquiditySnapshot = {
            liquidCount,
            totalCount,
            tokens: liqData.tokens.map(t => ({
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
            message: `Buy executed after ${waitStr} liquidity wait (${liquidCount}/${totalCount} tokens liquid)`,
            data: { waitMs, liquidCount, totalCount },
        });
        saveSession(session);

        console.log(`  💰 Buy order placed via liquidity gate: $${order.totalCost.toFixed(3)} [waited ${waitStr}]`);
    }, pollIntervalMs);
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

        // Clean up failed buy orders (totalCost=0, all positions failed) — legacy artifacts
        if (existing.buyOrder && existing.buyOrder.totalCost === 0) {
            const allFailed = existing.buyOrder.positions?.every(p => p.status === 'failed');
            if (allFailed) {
                console.log(`  🧹 Clearing failed buy order (totalCost=0, all positions failed)`);
                existing.buyOrder = null;
                existing.pnl = null;
            }
        }

        // If no buy order exists, note it — we don't backfill fake buys
        if (!existing.buyOrder) {
            console.log(`  ⏳ No buy order yet — will trigger via normal buy flow`);
        }

        // If session was mid-liquidity-wait, reset so we can re-trigger
        if (existing.awaitingLiquidity && !existing.buyOrder) {
            existing.awaitingLiquidity = false;
            console.log(`  🔄 Resetting liquidity wait (will re-trigger at buy hour)`);
        }

        // If resolve sell was attempted but all positions failed, allow retry
        if (existing.resolveSellExecuted && existing.sellOrders?.length > 0) {
            const lastSell = existing.sellOrders[existing.sellOrders.length - 1];
            const allSellsFailed = lastSell.positions?.every(p => p.status === 'failed');
            if (allSellsFailed) {
                console.log(`  🔄 Resetting failed resolve sell — will retry with resolved token IDs`);
                existing.resolveSellExecuted = false;
                existing.sellOrders.pop();
                // Clear sold status on positions
                for (const p of existing.buyOrder?.positions || []) {
                    if (p.soldStatus === 'failed') {
                        p.soldAt = undefined;
                        p.soldStatus = undefined;
                        p.soldOrderId = undefined;
                    }
                }
            }
        }

        saveSession(existing);
        console.log(`  📋 Resuming existing session (${existing.snapshots.length} snapshots, phase: ${existing.phase})`);
        return existing;
    }

    // Take initial snapshot
    console.log('  📸 Taking initial snapshot...');
    const snapshot = await takeSnapshot(targetDate, null);

    const phase = getPhase(targetDate);

    // Determine buy strategy:
    // - Never buy against closed events (market not yet created)
    // - If liquidity-gated and in buy phase, defer to the polling loop
    // - Otherwise, place an immediate simulated/real buy
    let buyOrder = null;

    if (snapshot.eventClosed) {
        console.log('  ⏳ Event is closed/not yet created — deferring buy until market is active');
    } else {
        const shouldGate = config.liquidity.wsEnabled && phase === 'buy';
        if (!shouldGate) {
            const initLiq = await fetchLiquidityFromService(targetDate);
            buyOrder = await tryPlaceBuyOrder(snapshot, initLiq?.tokens || []);
            if (buyOrder) {
                console.log('  ' + String.fromCodePoint(0x1F4B0) + ' Buy order placed: $' + buyOrder.totalCost.toFixed(3) + ' (max profit: $' + buyOrder.maxProfit.toFixed(3) + ') [' + (buyOrder.mode || 'live') + ']');
            } else {
                console.log('  ' + String.fromCodePoint(0x26A0) + ' Buy order attempted but failed — will retry on next cycle');
            }
        } else {
            console.log('  ' + String.fromCodePoint(0x23F3) + ' Buy deferred — liquidity gate will handle purchase during monitoring cycle');
        }
    }

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

    // Liquidity microservice auto-discovers sessions from output dir.
    // The buy will be handled by shouldPlaceBuy() -> startLiquidityGatedBuy()
    // during the first monitoring cycle, NOT here (avoids bypassing the gate).

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

    // ── Forecast History Recording (all phases) ──────────────────────
    // Record one observation per day for trend analysis
    if (!session.forecastHistory) session.forecastHistory = [];
    const todayET = getTodayET();
    const alreadyRecordedToday = session.forecastHistory.some(
        h => h.date === todayET
    );
    if (!alreadyRecordedToday && snapshot.forecastTempF != null) {
        session.forecastHistory.push({
            date: todayET,
            daysOut: snapshot.daysUntilTarget,
            forecast: snapshot.forecastTempF,
            source: snapshot.forecastSource,
            timestamp: nowISO(),
        });
    }

    // ── Trend Analysis ──────────────────────────────────────────────
    // Compute trend from accumulated forecast history
    session.trend = analyzeTrend(session.forecastHistory);

    // ── Scout/Track: observation only — skip buy/sell logic ──────────
    if (snapshot.phase === 'scout' || snapshot.phase === 'track') {
        // Append snapshot and save — no buy/sell actions
        session.snapshots.push(snapshot);
        session.alerts = [...(session.alerts || []), ...alerts];
        saveSession(session);
        return { snapshot, alerts };
    }

    // Place buy (immediate or liquidity-gated)
    const buySignal = shouldPlaceBuy(session, snapshot);
    if (buySignal === true) {
        // Immediate buy — fetch WS liquidity data for accurate spread checks
        const immLiq = await fetchLiquidityFromService(session.targetDate);
        session.buyOrder = await tryPlaceBuyOrder(snapshot, immLiq?.tokens || []);
    } else if (buySignal === 'await-liquidity' && !session.awaitingLiquidity) {
        // Start liquidity-gated buy flow
        startLiquidityGatedBuy(session, snapshot);
    }

    // ── Sell Strategy: phase-dependent ────────────────────────────────
    if (session.buyOrder && !snapshot.eventClosed) {

        // ── RESOLVE DAY (T+0): Sell hedge positions immediately ──────
        // On resolve day the forecast is mature — sell the 2 positions
        // that don't match the current target range to lock in value.
        if (snapshot.phase === 'resolve' && !session.resolveSellExecuted) {

            const currentTargetQ = snapshot.target?.question;
            if (currentTargetQ) {
                const positionsToSell = [];
                const positionsToKeep = [];

                for (const pos of session.buyOrder.positions) {
                    if (pos.status === 'failed' || pos.status === 'rejected') continue;
                    if (pos.soldAt) continue; // Already sold

                    // Resolve clobTokenId — fall back to snapshot data if not stored on position
                    let tokenId = pos.clobTokenId || pos.clobTokenIds?.[0] || pos.tokenId;
                    if (!tokenId) {
                        // Look up from snapshot by matching question text
                        for (const key of ['target', 'below', 'above']) {
                            const snapRange = snapshot[key];
                            if (snapRange && snapRange.question === pos.question && snapRange.clobTokenIds?.[0]) {
                                tokenId = snapRange.clobTokenIds[0];
                                pos.clobTokenIds = snapRange.clobTokenIds;
                                pos.tokenId = tokenId;
                                console.log(`     🔧 Resolved tokenId for ${pos.label} from snapshot`);
                                break;
                            }
                        }
                    }

                    if (pos.question === currentTargetQ) {
                        positionsToKeep.push(pos);
                    } else {
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
                    console.log(`\n  🎯 RESOLVE-DAY SELL: keeping target "${currentTargetQ.substring(55, 80)}"`);
                    console.log(`     Forecast: ${snapshot.forecastTempF}°F — selling ${positionsToSell.length} hedge position(s):`);
                    for (const p of positionsToSell) {
                        console.log(`     📉 ${p.label}: "${p.question.substring(55, 80)}" (${p.shares} shares)`);
                    }

                    const sellResult = await executeSellOrder(positionsToSell);
                    if (sellResult) {
                        if (!session.sellOrders) session.sellOrders = [];
                        session.sellOrders.push(sellResult);
                        session.resolveSellExecuted = true;

                        // Update bought positions with sell status
                        for (const sold of sellResult.positions) {
                            const original = session.buyOrder.positions.find(
                                p => p.question === sold.question
                            );
                            if (original) {
                                original.soldAt = sold.sellPrice;
                                original.soldOrderId = sold.orderId;
                                original.soldStatus = sold.status;
                            }
                        }

                        alerts.push({
                            timestamp: nowISO(),
                            type: 'resolve_sell',
                            message: `Resolve-day sell: sold ${positionsToSell.length} hedge position(s), keeping "${positionsToKeep[0]?.label || 'target'}"`,
                            data: {
                                forecast: snapshot.forecastTempF,
                                kept: positionsToKeep.map(p => p.question),
                                sold: positionsToSell.map(p => p.question),
                                proceeds: sellResult.totalProceeds,
                            },
                        });
                    }
                } else {
                    console.log(`  ✅ Resolve day: no hedge positions to sell`);
                    session.resolveSellExecuted = true;
                }
            }
        }

        // ── MONITOR/BUY (T+1, T+2): Rebalance on ±3°F forecast shift ──
        // During earlier phases, the forecast can still swing. Only sell
        // if it moves significantly from the initial buy forecast.
        if ((snapshot.phase === 'monitor' || snapshot.phase === 'buy') &&
            !session.rebalanceExecuted) {

            const totalShift = Math.abs(snapshot.forecastTempF - session.initialForecastTempF);
            const threshold = config.monitor.rebalanceThreshold;

            if (totalShift >= threshold) {
                console.log(`\n  🔄 REBALANCE TRIGGERED: forecast shifted ${totalShift.toFixed(1)}°F (threshold: ±${threshold}°F)`);
                console.log(`     Initial: ${session.initialForecastTempF}°F → Current: ${snapshot.forecastTempF}°F`);

                const currentTargetQ = snapshot.target?.question;
                const currentBelowQ = snapshot.below?.question;
                const currentAboveQ = snapshot.above?.question;
                const currentRangeQuestions = new Set(
                    [currentTargetQ, currentBelowQ, currentAboveQ].filter(Boolean)
                );

                const positionsToSell = [];
                for (const pos of session.buyOrder.positions) {
                    if (pos.status === 'failed' || pos.status === 'rejected') continue;
                    if (pos.soldAt) continue;

                    // Resolve tokenId from snapshot if missing
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
                    console.log(`  📉 ${positionsToSell.length} position(s) are now out-of-range:`);
                    for (const p of positionsToSell) {
                        console.log(`     • ${p.label}: "${p.question}"`);
                    }

                    const sellResult = await executeSellOrder(positionsToSell);
                    if (sellResult) {
                        if (!session.sellOrders) session.sellOrders = [];
                        session.sellOrders.push(sellResult);
                        session.rebalanceExecuted = true;

                        for (const sold of sellResult.positions) {
                            const original = session.buyOrder.positions.find(
                                p => p.question === sold.question
                            );
                            if (original) {
                                original.soldAt = sold.sellPrice;
                                original.soldOrderId = sold.orderId;
                                original.soldStatus = sold.status;
                            }
                        }

                        alerts.push({
                            timestamp: nowISO(),
                            type: 'rebalance_sell',
                            message: `Sold ${positionsToSell.length} out-of-range position(s) after ${totalShift.toFixed(1)}°F forecast shift`,
                            data: {
                                shift: totalShift,
                                sold: positionsToSell.map(p => p.question),
                                proceeds: sellResult.totalProceeds,
                            },
                        });
                    }
                } else {
                    console.log(`  ✅ All owned positions still in-range after shift`);
                }
            }
        }
    }

    // Compute P&L against buy prices using live CLOB bids
    if (session.buyOrder) {
        const liqData = await fetchLiquidityFromService(session.targetDate);
        const liquidityBids = {};
        if (liqData && liqData.tokens) {
            for (const t of liqData.tokens) {
                if (t.question && t.bestBid > 0) liquidityBids[t.question] = t.bestBid;
            }
        }
        session.pnl = computePnL(session.buyOrder, snapshot, liquidityBids);
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

    // Check if market closed → attempt auto-redemption
    if (snapshot.eventClosed && session.status !== 'completed') {
        session.status = 'completed';

        // Auto-redeem any held positions
        if (session.buyOrder && !session.redeemExecuted) {
            const redeemResult = await tryRedeemPositions(session);
            if (redeemResult) {
                session.redeemExecuted = true;
                session.redeemResult = redeemResult;
                alerts.push({
                    timestamp: nowISO(),
                    type: 'redeem',
                    message: `Auto-redeemed ${redeemResult.redeemed} position(s) for $${redeemResult.totalValue.toFixed(2)}`,
                    data: redeemResult,
                });
            }
        }
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
}

/**
 * Get the current liquidity snapshot from the microservice.
 * @param {string} date
 * @returns {Promise<Object|null>}
 */
export async function getLiquiditySnapshot(date) {
    return fetchLiquidityFromService(date);
}
