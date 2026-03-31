/**
 * TempEdge Monitor — Multi-Market, Multi-Date Phase-Aware Monitoring
 *
 * Monitors multiple markets (NYC, London, Wellington, etc.) across
 * T+0 through T+N concurrent plays. Each market × date pair gets
 * its own session with market-specific weather, discovery, and budget.
 *
 * Usage:
 *   node index.js                     # Auto-detect markets and dates
 *   node index.js --interval 5        # Check every 5 minutes
 */

import 'dotenv/config';
import {
    createOrResumeSession,
    runMonitoringCycle,
    stopSession,
    getConfig,
    getPhase,
    getPhaseInTz,
    getDateOffsetET,
    getDateOffsetInTz,
    refreshConfig,
    loadSession,
} from './orchestrator.js';
import { tryRedeemPositions } from './svcClients.js';
import { saveSession } from './persistence.js';
import { getEnabledMarkets, computeBudgetAllocations } from './budget.js';
import { services } from '../../shared/services.js';
import { createLogger } from '../../shared/logger.js';

const log = createLogger('monitor');

const DATA_SVC = services.dataSvc;

// ── CLI Argument Parsing ────────────────────────────────────────────────

const args = process.argv.slice(2);
let intervalMinutes = 15;

for (let i = 0; i < args.length; i++) {
    if (args[i] === '--interval' && args[i + 1]) {
        intervalMinutes = parseInt(args[i + 1]);
        i++;
    }
}

// ── Console Formatting ──────────────────────────────────────────────────

const PHASE_LABELS = {
    scout: '🔭 SCOUT',
    track: '📈 TRACK',
    buy: '🛒 BUY',
    monitor: '👁️  MONITOR',
    resolve: '🎯 RESOLVE',
};

const PHASE_COLORS = {
    scout: '\x1b[36m',
    track: '\x1b[35m',
    buy: '\x1b[32m',
    monitor: '\x1b[33m',
    resolve: '\x1b[31m',
};

const RESET = '\x1b[0m';

function formatTime(iso) {
    return new Date(iso).toLocaleTimeString('en-US', {
        timeZone: 'America/New_York',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
    });
}

function formatPrice(price) {
    return (price * 100).toFixed(1) + '¢';
}

function formatPriceChange(change) {
    if (change === 0) return '  --';
    const sign = change > 0 ? '+' : '';
    return `${sign}${(change * 100).toFixed(1)}¢`;
}

function shortLabel(question) {
    if (!question) return '--';
    const rangeMatch = question.match(/(\d+)-(\d+)/);
    if (rangeMatch) return `${rangeMatch[1]}-${rangeMatch[2]}°`;
    const upperMatch = question.match(/(\d+).*or higher/i);
    if (upperMatch) return `${upperMatch[1]}°+`;
    const lowerMatch = question.match(/(\d+).*or (?:lower|below)/i);
    if (lowerMatch) return `≤${lowerMatch[1]}°`;
    // Single-degree: "be 14°C on" or "be 78°F on" (London 2026 format)
    const singleMatch = question.match(/be (\d+)°[CF]\b/i);
    if (singleMatch) return `${singleMatch[1]}°`;
    return question.slice(0, 15);
}

function printSnapshotCompact(key, snapshot, session) {
    const phase = snapshot.phase || session.phase;
    const phaseLabel = PHASE_LABELS[phase] || phase;
    const phaseColor = PHASE_COLORS[phase] || '';
    const target = shortLabel(snapshot.target.question).padEnd(12);
    const price = formatPrice(snapshot.target.yesPrice).padEnd(8);
    const cost = '$' + snapshot.totalCost.toFixed(3);
    const unit = snapshot.unit || 'F';
    const currentTemp = snapshot.currentTempF !== null ? `${snapshot.currentTempF}°${unit}` : '--';
    const forecast = `${snapshot.forecastTempF}°${unit}`;
    const delta = snapshot.forecastChange !== 0 ? ` (${snapshot.forecastChange > 0 ? '+' : ''}${snapshot.forecastChange})` : '';
    console.log(
        `  │ ${key.padEnd(16)} │ ${phaseColor}${phaseLabel.padEnd(12)}${RESET} │ ${currentTemp.padEnd(6)} │ ${forecast.padEnd(6)}${delta.padEnd(6)} │ 🎯 ${target} ${price} │ ${cost} │`,
    );
}

function printDetailedSnapshot(key, snapshot, session) {
    const time = formatTime(snapshot.timestamp);
    const count = session.snapshots.length;
    const phase = snapshot.phase || session.phase;
    const phaseLabel = PHASE_LABELS[phase] || phase;
    const phaseColor = PHASE_COLORS[phase] || '';
    const unit = snapshot.unit || 'F';

    console.log(`\n  ┌─ ${key} ${phaseColor}${phaseLabel}${RESET} @ ${time} (#${count}) ${'─'.repeat(20)}┐`);
    console.log(
        `  │  Forecast: ${snapshot.forecastTempF}°${unit}  (Δ ${snapshot.forecastChange >= 0 ? '+' : ''}${snapshot.forecastChange})  [${snapshot.forecastSource || 'unknown'}]`,
    );
    if (snapshot.currentTempF != null) {
        const maxToday = snapshot.maxTodayF ? `  Hi: ${snapshot.maxTodayF}°${unit}` : '';
        console.log(`  │  Current:  ${snapshot.currentTempF}°${unit}  ${snapshot.currentConditions || ''}${maxToday}`);
    }
    console.log(
        `  │  🎯 Target: ${shortLabel(snapshot.target.question).padEnd(14)} YES: ${formatPrice(snapshot.target.yesPrice).padEnd(8)} (${formatPriceChange(snapshot.target.priceChange)})`,
    );
    if (snapshot.below)
        console.log(
            `  │  ⬇️  Below:  ${shortLabel(snapshot.below.question).padEnd(14)} YES: ${formatPrice(snapshot.below.yesPrice).padEnd(8)} (${formatPriceChange(snapshot.below.priceChange)})`,
        );
    if (snapshot.above)
        console.log(
            `  │  ⬆️  Above:  ${shortLabel(snapshot.above.question).padEnd(14)} YES: ${formatPrice(snapshot.above.yesPrice).padEnd(8)} (${formatPriceChange(snapshot.above.priceChange)})`,
        );
    console.log(`  │  Total cost: $${snapshot.totalCost.toFixed(3)}   Profit: $${(1 - snapshot.totalCost).toFixed(3)}`);
    if (snapshot.rangeShifted) console.log(`  │  🔄 RANGE SHIFTED from "${shortLabel(snapshot.shiftedFrom)}"`);
    console.log(`  └${'─'.repeat(58)}┘`);
}

function printAlerts(alerts) {
    if (alerts.length === 0) return;
    const icons = { forecast_shift: '⚠️', range_shift: '🔴', price_spike: '📊', market_closed: '✅', phase_change: '🔄' };
    for (const alert of alerts) console.log(`    ${icons[alert.type] || '❓'}  ${alert.message}`);
}

function printResolution(resolution) {
    if (!resolution) return;
    console.log(`    🎯 KEEP: ${shortLabel(resolution.keep)} (${(resolution.keepPrice * 100).toFixed(1)}¢)`);
    console.log(`    ❌ DISCARD: ${resolution.discard.map(shortLabel).join(', ')}`);
}

// ── Market Registry ─────────────────────────────────────────────────────
// Fetch full market metadata from data-svc to build weather/discovery context.

const _marketMetadata = new Map();

async function fetchMarketMetadata(marketId) {
    if (_marketMetadata.has(marketId)) return _marketMetadata.get(marketId);
    try {
        const res = await fetch(`${DATA_SVC}/api/markets/${marketId}`, { signal: AbortSignal.timeout(3000) });
        if (res.ok) {
            const meta = await res.json();
            _marketMetadata.set(marketId, meta);
            return meta;
        }
    } catch (err) {
        log.warn('market_metadata_fetch_failed', { marketId, error: err.message });
    }
    // Return NYC defaults for backwards compatibility
    return {
        id: marketId,
        name: marketId.toUpperCase(),
        unit: 'F',
        station_lat: 40.7769,
        station_lon: -73.874,
        station_name: 'KLGA',
        timezone: 'America/New_York',
    };
}

/**
 * Build the market context object for weather-svc calls.
 */
function buildMarketCtx(meta) {
    return {
        lat: meta.station_lat,
        lon: meta.station_lon,
        unit: meta.unit || 'F',
        tz: meta.timezone || 'America/New_York',
        station: meta.station_name || 'KLGA',
    };
}

// ── Multi-Market Session Key ────────────────────────────────────────────

function sessionKey(marketId, date) {
    return `${marketId}:${date}`;
}

// ── Multi-Market Portfolio Generation ───────────────────────────────────

function getPortfolioDates(marketId, meta) {
    const cfg = getConfig();
    const maxDays = cfg.phases.scoutDaysMax;
    const tz = meta?.timezone || 'America/New_York';
    const dates = [];
    for (let i = 0; i <= maxDays; i++) {
        const date = tz !== 'America/New_York' ? getDateOffsetInTz(i, tz) : getDateOffsetET(i);
        const phase = tz !== 'America/New_York' ? getPhaseInTz(date, tz) : getPhase(date);
        dates.push({ date, phase });
    }
    return dates;
}

async function initializeSessions(enabledMarkets) {
    const sessions = new Map();

    for (const market of enabledMarkets) {
        const marketId = market.id || market;
        const meta = await fetchMarketMetadata(marketId);
        const dates = getPortfolioDates(marketId, meta);
        const marketCtx = buildMarketCtx(meta);
        const marketOpts = { marketCtx, marketId };

        console.log(`\n  🏙️  Market: ${meta.name || marketId.toUpperCase()} (${meta.unit || 'F'}, ${meta.timezone || 'ET'})`);

        for (const { date, phase } of dates) {
            const key = sessionKey(marketId, date);
            try {
                log.info('session_init', { marketId, date, phase: PHASE_LABELS[phase] });
                console.log(`    📅 ${date} (${PHASE_LABELS[phase]})...`);
                const session = await createOrResumeSession(date, intervalMinutes, marketOpts);
                session.marketId = marketId;
                sessions.set(key, { session, marketOpts, meta });
            } catch (err) {
                log.warn('session_skip', { marketId, date, error: err.message });
                console.log(`    ⚠️  Skipping ${date}: ${err.message}`);
            }
        }
    }
    return sessions;
}

// ── Restart Signal Check (via data-svc) ─────────────────────────────────

async function checkRestartSignal() {
    try {
        const res = await fetch(`${DATA_SVC}/api/restart-signal`, { signal: AbortSignal.timeout(2000) });
        if (res.ok) {
            const data = await res.json();
            return data.requested === true;
        }
    } catch {
        /* intentional: restart signal check is best-effort */
    }
    return false;
}

async function clearRestartSignal() {
    try {
        await fetch(`${DATA_SVC}/api/restart-signal`, { method: 'DELETE', signal: AbortSignal.timeout(2000) });
    } catch {
        /* intentional: fire-and-forget */
    }
}

// ── Startup Redeem Sweep ────────────────────────────────────────────────

async function sweepUnredeemedSessions() {
    try {
        const res = await fetch(`${DATA_SVC}/api/session-files?format=full`, { signal: AbortSignal.timeout(5000) });
        if (!res.ok) return;
        const { sessions: files } = await res.json();
        if (!files || files.length === 0) return;

        const today = getDateOffsetET(0);
        let redeemed = 0;

        for (const { marketId, date } of files) {
            if (date >= today) continue;

            const session = await loadSession(date, marketId);
            if (!session) continue;

            if (session.redeemExecuted || !session.buyOrder?.positions?.length) continue;

            const unsold = session.buyOrder.positions.filter(p => !p.soldAt);
            if (unsold.length === 0) {
                log.info('redeem_sweep_skip_sold', { marketId, date, reason: 'all_positions_sold' });
                continue;
            }

            log.info('redeem_sweep_attempt', { marketId, date, positions: unsold.length });
            console.log(`  🔄 Redeem sweep: ${marketId}/${date} — ${unsold.length} unredeemed positions`);

            try {
                const result = await tryRedeemPositions(session);
                if (result && !result.error) {
                    session.redeemExecuted = true;
                    session.redeemResult = result;
                    session.status = 'completed';
                    await saveSession(session);
                    redeemed++;
                    log.info('redeem_sweep_success', { marketId, date, redeemed: result.redeemed, value: result.totalValue });
                    console.log(`  ✅ Redeemed ${marketId}/${date}: ${result.redeemed} positions, $${result.totalValue?.toFixed(2) || '?'}`);
                } else {
                    log.warn('redeem_sweep_failed', { marketId, date, error: result?.error || 'no result' });
                }
            } catch (err) {
                log.warn('redeem_sweep_error', { marketId, date, error: err.message });
            }
        }

        if (redeemed > 0) {
            console.log(`  💰 Sweep complete: ${redeemed} session(s) redeemed`);
        } else {
            log.info('redeem_sweep_none');
        }
    } catch (err) {
        log.warn('redeem_sweep_error', { error: err.message });
    }
}

// ── Main ────────────────────────────────────────────────────────────────

async function main() {
    await refreshConfig();
    const cfg = getConfig();
    intervalMinutes = cfg.monitor.intervalMinutes || intervalMinutes;

    // Sweep unredeemed past sessions before starting active monitoring
    console.log('\n  🔍 Checking for unredeemed past sessions...');
    await sweepUnredeemedSessions();

    const enabledMarkets = await getEnabledMarkets(cfg);
    const budget = await computeBudgetAllocations(cfg);

    console.log(`\n🌡️  TempEdge Monitor — Multi-Market Rolling Portfolio`);
    console.log('═══════════════════════════════════════════════════════════════');
    console.log(`  Markets:         ${enabledMarkets.map(m => m.id || m).join(', ')}`);
    console.log(`  Daily budget:    $${budget.totalBudget.toFixed(2)}`);
    for (const a of budget.allocations) {
        console.log(`    → ${a.marketId.padEnd(10)} $${a.budget.toFixed(2)} (priority #${a.priority})`);
    }
    console.log(`  Check interval:  ${intervalMinutes} minutes`);
    console.log(`  Rebalance at:    ±${cfg.monitor.rebalanceThreshold}°`);
    console.log('═══════════════════════════════════════════════════════════════');

    const sessions = await initializeSessions(enabledMarkets);

    if (sessions.size === 0) {
        log.error('no_markets_found', { reason: 'exiting' });
        console.error('\n  ❌ No markets found for any date. Exiting.');
        process.exit(1);
    }

    console.log('\n  📊 Portfolio Overview:');
    for (const [key, { session }] of sessions) {
        const latest = session.snapshots[session.snapshots.length - 1];
        if (latest) printSnapshotCompact(key, latest, session);
    }

    for (const [key, { session }] of sessions) {
        const latest = session.snapshots[session.snapshots.length - 1];
        if (latest) printDetailedSnapshot(key, latest, session);
    }

    const intervalMs = intervalMinutes * 60 * 1000;

    // Restart signal watcher
    const restartWatcher = setInterval(async () => {
        if (await checkRestartSignal()) {
            clearInterval(restartWatcher);
            clearInterval(timer);
            log.info('restart_signal_detected');
            console.log('\n  🔄 Restart signal detected');
            await clearRestartSignal();
            for (const [, { session }] of sessions) await stopSession(session);
            log.info('sessions_saved_shutdown');
            console.log('  💾 Sessions saved. Exiting...');
            process.exit(0);
        }
    }, 5000);

    const timer = setInterval(async () => {
        log.info('monitoring_cycle', { time: formatTime(new Date().toISOString()), markets: enabledMarkets.length });
        console.log(`\n${'═'.repeat(65)}`);
        console.log(`  ⏱️  Monitoring cycle @ ${formatTime(new Date().toISOString())} [${enabledMarkets.length} markets]`);

        // Refresh config each cycle for hot-reload
        await refreshConfig();
        const currentCfg = getConfig();

        // Re-check enabled markets (may have changed via admin)
        const currentMarkets = await getEnabledMarkets(currentCfg);

        // Retry failed initializations for all markets × dates
        for (const market of currentMarkets) {
            const marketId = market.id || market;
            const meta = await fetchMarketMetadata(marketId);
            const dates = getPortfolioDates(marketId, meta);
            const marketCtx = buildMarketCtx(meta);
            const marketOpts = { marketCtx, marketId };

            for (const { date, phase } of dates) {
                const key = sessionKey(marketId, date);
                if (!sessions.has(key)) {
                    try {
                        const session = await createOrResumeSession(date, intervalMinutes, marketOpts);
                        session.marketId = marketId;
                        sessions.set(key, { session, marketOpts, meta });
                        console.log(`  ✅ ${key} initialized (${phase})`);
                    } catch (err) {
                        log.warn('session_retry_failed', { marketId, date, error: err.message });
                    }
                }
            }
        }

        // Run monitoring cycles
        for (const [key, entry] of sessions) {
            const { session, marketOpts } = entry;
            if (session.status === 'completed') {
                console.log(`  │ ${key.padEnd(16)} │ ✅ COMPLETE   │`);
                continue;
            }
            try {
                const { snapshot, alerts, resolution } = await runMonitoringCycle(session, marketOpts);
                printSnapshotCompact(key, snapshot, session);
                if (alerts.length > 0 || resolution) {
                    printAlerts(alerts);
                    printResolution(resolution);
                }
            } catch (err) {
                console.log(`  │ ${key.padEnd(16)} │ ❌ ERROR      │ ${err.message.slice(0, 60)} │`);
                log.error('cycle_error', { key, error: err.message });
            }
        }

        const allComplete = [...sessions.values()].every((e) => e.session.status === 'completed');
        if (allComplete) {
            console.log('\n  ✅ All markets resolved. Done.');
            clearInterval(timer);
            process.exit(0);
        }

        console.log(`\n  ⏱️  Next check in ${intervalMinutes} minutes...`);
    }, intervalMs);

    console.log(`\n  ⏱️  Next check in ${intervalMinutes} minutes... (Ctrl+C to stop)`);

    // Graceful shutdown
    const shutdown = async () => {
        log.info('shutdown_initiated', { signal: 'manual' });
        console.log('\n\n  🛑 Shutting down monitor...');
        clearInterval(timer);
        clearInterval(restartWatcher);
        await Promise.all(
            [...sessions.values()]
                .filter((e) => e.session.status === 'active')
                .map((e) => stopSession(e.session)),
        );
        const totalSnapshots = [...sessions.values()].reduce((sum, e) => sum + e.session.snapshots.length, 0);
        log.info('shutdown_complete', { sessions: sessions.size, totalSnapshots });
        console.log(`  💾 ${sessions.size} sessions saved (${totalSnapshots} snapshots)`);
        process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

main().catch((err) => {
    log.error('fatal_error', { error: err.message, stack: err.stack });
    console.error('\n❌ Fatal error:', err.message);
    console.error(err.stack);
    process.exit(1);
});
