/**
 * TempEdge Monitor — Multi-date phase-aware monitoring (Microservice Edition)
 *
 * Monitors 3+ concurrent plays at different phases:
 *   T+0 (resolve):  Target is today — keep best range, discard 2
 *   T+1 (monitor):  Target is tomorrow — watch for shifts
 *   T+2 (buy):      Target is day after — initial selection
 *
 * Usage:
 *   node index.js                     # Auto-detect dates
 *   node index.js --interval 5        # Check every 5 minutes
 */

import 'dotenv/config';
import {
    createOrResumeSession,
    runMonitoringCycle,
    stopSession,
    getConfig,
    getPhase,
    getDateOffsetET,
    refreshConfig,
} from './orchestrator.js';
import { services } from '../../shared/services.js';

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
    if (rangeMatch) return `${rangeMatch[1]}-${rangeMatch[2]}°F`;
    const upperMatch = question.match(/(\d+).*or higher/i);
    if (upperMatch) return `${upperMatch[1]}°F+`;
    const lowerMatch = question.match(/(\d+).*or (?:lower|below)/i);
    if (lowerMatch) return `≤${lowerMatch[1]}°F`;
    return question.slice(0, 15);
}

function printSnapshotCompact(date, snapshot, session) {
    const phase = snapshot.phase || session.phase;
    const phaseLabel = PHASE_LABELS[phase] || phase;
    const phaseColor = PHASE_COLORS[phase] || '';
    const target = shortLabel(snapshot.target.question).padEnd(14);
    const price = formatPrice(snapshot.target.yesPrice).padEnd(8);
    const cost = '$' + snapshot.totalCost.toFixed(3);
    const currentTemp = snapshot.currentTempF !== null ? `${snapshot.currentTempF}°F` : '--';
    const forecast = `${snapshot.forecastTempF}°F`;
    const delta = snapshot.forecastChange !== 0 ? ` (${snapshot.forecastChange > 0 ? '+' : ''}${snapshot.forecastChange})` : '';
    console.log(
        `  │ ${date} │ ${phaseColor}${phaseLabel.padEnd(12)}${RESET} │ Now: ${currentTemp.padEnd(5)} │ Fcst: ${forecast.padEnd(5)}${delta.padEnd(6)} │ 🎯 ${target} ${price} │ Cost: ${cost} │`,
    );
}

function printDetailedSnapshot(date, snapshot, session) {
    const time = formatTime(snapshot.timestamp);
    const count = session.snapshots.length;
    const phase = snapshot.phase || session.phase;
    const phaseLabel = PHASE_LABELS[phase] || phase;
    const phaseColor = PHASE_COLORS[phase] || '';

    console.log(`\n  ┌─ ${date} ${phaseColor}${phaseLabel}${RESET} @ ${time} (#${count}) ${'─'.repeat(30)}┐`);
    console.log(
        `  │  Forecast: ${snapshot.forecastTempF}°F  (Δ ${snapshot.forecastChange >= 0 ? '+' : ''}${snapshot.forecastChange}°F)  [${snapshot.forecastSource || 'unknown'}]`,
    );
    if (snapshot.currentTempF != null) {
        const maxToday = snapshot.maxTodayF ? `  Hi: ${snapshot.maxTodayF}°F` : '';
        console.log(`  │  Current:  ${snapshot.currentTempF}°F  ${snapshot.currentConditions || ''}${maxToday}`);
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

// ── Multi-Date Session Management ───────────────────────────────────────

function getPortfolioDates() {
    const cfg = getConfig();
    const maxDays = cfg.phases.scoutDaysMax;
    const dates = [];
    for (let i = 0; i <= maxDays; i++) {
        const date = getDateOffsetET(i);
        const phase = getPhase(date);
        dates.push({ date, phase });
    }
    return dates;
}

async function initializeSessions(dates) {
    const sessions = new Map();
    for (const { date, phase } of dates) {
        try {
            console.log(`\n  📅 Initializing ${date} (${PHASE_LABELS[phase]})...`);
            const session = await createOrResumeSession(date, intervalMinutes);
            sessions.set(date, session);
        } catch (err) {
            console.log(`  ⚠️  Skipping ${date}: ${err.message}`);
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

// ── Main ────────────────────────────────────────────────────────────────

async function main() {
    // Load config from data-svc
    await refreshConfig();
    const cfg = getConfig();
    intervalMinutes = cfg.monitor.intervalMinutes || intervalMinutes;

    const dates = getPortfolioDates();

    console.log(`\n🌡️  TempEdge Monitor — Rolling Portfolio (Microservice Edition)`);
    console.log('═══════════════════════════════════════════════════════════════');
    console.log(`  Dates:           ${dates.map((d) => d.date).join(', ')}`);
    console.log(`  Check interval:  ${intervalMinutes} minutes`);
    console.log(`  Weather:         weather-svc`);
    console.log(`  Markets:         market-svc`);
    console.log(`  Trading:         trading-svc`);
    console.log(`  Data:            data-svc`);
    console.log(`  Rebalance at:    ±${cfg.monitor.rebalanceThreshold}°F`);
    console.log('═══════════════════════════════════════════════════════════════');

    console.log('\n  📊 Portfolio Overview:');
    console.log('  ┌────────────┬──────────────┬───────────┬─────────────────┬────────────────────────────┬────────────┐');
    console.log('  │ Date       │ Phase        │ Current   │ Forecast        │ Target                     │ Cost       │');
    console.log('  ├────────────┼──────────────┼───────────┼─────────────────┼────────────────────────────┼────────────┤');

    const sessions = await initializeSessions(dates);

    if (sessions.size === 0) {
        console.error('\n  ❌ No markets found for any date. Exiting.');
        process.exit(1);
    }

    for (const [date, session] of sessions) {
        const latest = session.snapshots[session.snapshots.length - 1];
        if (latest) printSnapshotCompact(date, latest, session);
    }
    console.log('  └────────────┴──────────────┴───────────┴─────────────────┴────────────────────────────┴────────────┘');

    for (const [date, session] of sessions) {
        const latest = session.snapshots[session.snapshots.length - 1];
        if (latest) printDetailedSnapshot(date, latest, session);
    }

    const intervalMs = intervalMinutes * 60 * 1000;

    // Restart signal watcher
    const restartWatcher = setInterval(async () => {
        if (await checkRestartSignal()) {
            clearInterval(restartWatcher);
            clearInterval(timer);
            console.log('\n  🔄 Restart signal detected');
            await clearRestartSignal();
            for (const [, session] of sessions) await stopSession(session);
            console.log('  💾 Sessions saved. Exiting...');
            process.exit(0);
        }
    }, 5000);

    const timer = setInterval(async () => {
        console.log(`\n${'═'.repeat(65)}`);
        console.log(`  ⏱️  Monitoring cycle @ ${formatTime(new Date().toISOString())}`);

        // Refresh config each cycle for hot-reload
        await refreshConfig();

        // Retry failed initializations
        const currentDates = getPortfolioDates();
        for (const { date, phase } of currentDates) {
            if (!sessions.has(date)) {
                try {
                    console.log(`  🔄 Retrying ${date}...`);
                    const session = await createOrResumeSession(date, intervalMinutes);
                    sessions.set(date, session);
                    console.log(`  ✅ Initialized ${date} (${phase})`);
                } catch (err) {
                    console.log(`  ⚠️  ${date} unavailable: ${err.message.slice(0, 80)}`);
                }
            }
        }

        console.log('  ┌────────────┬──────────────┬───────────┬─────────────────┬────────────────────────────┬────────────┐');

        for (const [date, session] of sessions) {
            if (session.status === 'completed') {
                console.log(`  │ ${date} │ ✅ COMPLETE   │ Market resolved                                           │`);
                continue;
            }
            try {
                const { snapshot, alerts, resolution } = await runMonitoringCycle(session);
                printSnapshotCompact(date, snapshot, session);
                if (alerts.length > 0 || resolution) {
                    console.log('  ├────────────┴──────────────┴───────────┴─────────────────┴────────────────────────────┴────────────┤');
                    printAlerts(alerts);
                    printResolution(resolution);
                    console.log('  ├────────────┬──────────────┬───────────┬─────────────────┬────────────────────────────┬────────────┤');
                }
            } catch (err) {
                console.log(`  │ ${date} │ ❌ ERROR      │ ${err.message.slice(0, 80).padEnd(52)} │`);
            }
        }

        console.log('  └────────────┴──────────────┴───────────┴─────────────────┴────────────────────────────┴────────────┘');

        const allComplete = [...sessions.values()].every((s) => s.status === 'completed');
        if (allComplete) {
            console.log('\n  ✅ All markets resolved. Done.');
            clearInterval(timer);
            process.exit(0);
        }

        console.log(`\n  ⏱️  Next check in ${intervalMinutes} minutes...`);
    }, intervalMs);

    console.log(`\n  ⏱️  Next check in ${intervalMinutes} minutes... (Ctrl+C to stop)`);

    // Graceful shutdown
    const shutdown = () => {
        console.log('\n\n  🛑 Shutting down monitor...');
        clearInterval(timer);
        clearInterval(restartWatcher);
        for (const [, session] of sessions) {
            if (session.status === 'active') stopSession(session);
        }
        const totalSnapshots = [...sessions.values()].reduce((sum, s) => sum + s.snapshots.length, 0);
        console.log(`  💾 ${sessions.size} sessions saved (${totalSnapshots} snapshots)`);
        process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

main().catch((err) => {
    console.error('\n❌ Fatal error:', err.message);
    console.error(err.stack);
    process.exit(1);
});
