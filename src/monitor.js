/**
 * TempEdge Monitor — Multi-date phase-aware monitoring
 *
 * Monitors 3 concurrent plays at different phases:
 *   T+0 (resolve):  Target is today — keep best range, discard 2
 *   T+1 (monitor):  Target is tomorrow — watch for shifts
 *   T+2 (buy):      Target is day after — initial selection
 *
 * Usage:
 *   node src/monitor.js                     # Auto-detect 3 dates
 *   node src/monitor.js --interval 5        # Check every 5 minutes
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createOrResumeSession, runMonitoringCycle, stopSession, loadSession } from './services/monitor.js';
import { getTodayET, getTomorrowET, getTargetDateET, daysUntil, getPhase } from './utils/dateUtils.js';
import { config } from './config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const OUTPUT_DIR = path.resolve(__dirname, '../output');

// ── CLI Argument Parsing ────────────────────────────────────────────────

const args = process.argv.slice(2);
let intervalMinutes = config.monitor.intervalMinutes;

for (let i = 0; i < args.length; i++) {
    if (args[i] === '--interval' && args[i + 1]) {
        intervalMinutes = parseInt(args[i + 1]);
        i++;
    }
}

// ── Console Formatting ──────────────────────────────────────────────────

const PHASE_LABELS = {
    buy: '🛒 BUY',
    monitor: '👁️  MONITOR',
    resolve: '🎯 RESOLVE',
};

const PHASE_COLORS = {
    buy: '\x1b[32m',      // green
    monitor: '\x1b[33m',  // yellow
    resolve: '\x1b[31m',  // red
};

const RESET = '\x1b[0m';

function formatTime(iso) {
    return new Date(iso).toLocaleTimeString('en-US', {
        timeZone: 'America/New_York',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
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

    console.log(`  │ ${date} │ ${phaseColor}${phaseLabel.padEnd(12)}${RESET} │ Now: ${currentTemp.padEnd(5)} │ Fcst: ${forecast.padEnd(5)}${delta.padEnd(6)} │ 🎯 ${target} ${price} │ Cost: ${cost} │`);
}

function printDetailedSnapshot(date, snapshot, session) {
    const time = formatTime(snapshot.timestamp);
    const count = session.snapshots.length;
    const phase = snapshot.phase || session.phase;
    const phaseLabel = PHASE_LABELS[phase] || phase;
    const phaseColor = PHASE_COLORS[phase] || '';

    console.log(`\n  ┌─ ${date} ${phaseColor}${phaseLabel}${RESET} @ ${time} (#${count}) ${'─'.repeat(Math.max(0, 30))}┐`);
    console.log(`  │  Forecast: ${snapshot.forecastTempF}°F  (Δ ${snapshot.forecastChange >= 0 ? '+' : ''}${snapshot.forecastChange}°F)  [${snapshot.forecastSource || 'unknown'}]`);

    if (snapshot.currentTempF !== null && snapshot.currentTempF !== undefined) {
        const maxToday = snapshot.maxTodayF ? `  Hi: ${snapshot.maxTodayF}°F` : '';
        console.log(`  │  Current:  ${snapshot.currentTempF}°F  ${snapshot.currentConditions || ''}${maxToday}`);
    }

    console.log(`  │  🎯 Target: ${shortLabel(snapshot.target.question).padEnd(14)} YES: ${formatPrice(snapshot.target.yesPrice).padEnd(8)} (${formatPriceChange(snapshot.target.priceChange)})`);

    if (snapshot.below) {
        console.log(`  │  ⬇️  Below:  ${shortLabel(snapshot.below.question).padEnd(14)} YES: ${formatPrice(snapshot.below.yesPrice).padEnd(8)} (${formatPriceChange(snapshot.below.priceChange)})`);
    }
    if (snapshot.above) {
        console.log(`  │  ⬆️  Above:  ${shortLabel(snapshot.above.question).padEnd(14)} YES: ${formatPrice(snapshot.above.yesPrice).padEnd(8)} (${formatPriceChange(snapshot.above.priceChange)})`);
    }

    console.log(`  │  Total cost: $${snapshot.totalCost.toFixed(3)}   Profit: $${(1 - snapshot.totalCost).toFixed(3)}`);

    if (snapshot.rangeShifted) {
        console.log(`  │  🔄 RANGE SHIFTED from "${shortLabel(snapshot.shiftedFrom)}"`);
    }

    console.log(`  └${'─'.repeat(58)}┘`);
}

function printAlerts(alerts) {
    if (alerts.length === 0) return;
    const icons = {
        forecast_shift: '⚠️', range_shift: '🔴', price_spike: '📊',
        market_closed: '✅', phase_change: '🔄',
    };
    for (const alert of alerts) {
        console.log(`    ${icons[alert.type] || '❓'}  ${alert.message}`);
    }
}

function printResolution(resolution) {
    if (!resolution) return;
    console.log(`    🎯 KEEP: ${shortLabel(resolution.keep)} (${(resolution.keepPrice * 100).toFixed(1)}¢)`);
    console.log(`    ❌ DISCARD: ${resolution.discard.map(shortLabel).join(', ')}`);
}

// ── Multi-Date Session Management ───────────────────────────────────────

/**
 * Get the 3 target dates for the rolling portfolio
 * @returns {{ date: string, phase: string }[]}
 */
function getPortfolioDates() {
    const today = getTodayET();
    const tomorrow = getTomorrowET();
    const dayAfter = getTargetDateET();

    return [
        { date: today, phase: 'resolve' },
        { date: tomorrow, phase: 'monitor' },
        { date: dayAfter, phase: 'buy' },
    ];
}

/**
 * Initialize sessions for all portfolio dates
 * If a market doesn't exist for a date, skip it
 */
async function initializeSessions(dates) {
    /** @type {Map<string, import('./services/monitor.js').MonitoringSession>} */
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

// ── Main ────────────────────────────────────────────────────────────────

async function main() {
    const dates = getPortfolioDates();

    console.log(`\n🌡️  TempEdge Monitor — Rolling Portfolio`);
    console.log('═══════════════════════════════════════════════════════════════');
    console.log(`  Dates:           ${dates.map(d => d.date).join(', ')}`);
    console.log(`  Check interval:  ${intervalMinutes} minutes`);
    console.log(`  Weather source:  Weather Company (WU) → matches Polymarket`);
    console.log(`  Rebalance at:    ±${config.monitor.rebalanceThreshold}°F forecast change → auto-sell`);
    console.log(`  Dashboard:       http://localhost:30301`);
    console.log('═══════════════════════════════════════════════════════════════');

    console.log('\n  📊 Portfolio Overview:');
    console.log('  ┌────────────┬──────────────┬───────────┬─────────────────┬────────────────────────────┬────────────┐');
    console.log('  │ Date       │ Phase        │ Current   │ Forecast        │ Target                     │ Cost       │');
    console.log('  ├────────────┼──────────────┼───────────┼─────────────────┼────────────────────────────┼────────────┤');

    // Initialize all sessions
    const sessions = await initializeSessions(dates);

    if (sessions.size === 0) {
        console.error('\n  ❌ No markets found for any date. Exiting.');
        process.exit(1);
    }

    // Print initial overview
    for (const [date, session] of sessions) {
        const latest = session.snapshots[session.snapshots.length - 1];
        if (latest) {
            printSnapshotCompact(date, latest, session);
        }
    }
    console.log('  └────────────┴──────────────┴───────────┴─────────────────┴────────────────────────────┴────────────┘');

    // Print detailed snapshots for each
    for (const [date, session] of sessions) {
        const latest = session.snapshots[session.snapshots.length - 1];
        if (latest) {
            printDetailedSnapshot(date, latest, session);
        }
    }

    // Set up monitoring loop
    const intervalMs = intervalMinutes * 60 * 1000;

    // Track which dates failed initialization so we can retry
    const failedDates = dates.filter(d => !sessions.has(d.date));
    if (failedDates.length > 0) {
        console.log(`\n  ⚠️  ${failedDates.length} date(s) failed initialization — will retry each cycle: ${failedDates.map(d => d.date).join(', ')}`);
    }
    // Fast-poll restart signal watcher (checks every 5s independently of monitor cycle)
    const restartSignalPath = path.join(OUTPUT_DIR, '.restart-requested');
    const restartWatcher = setInterval(async () => {
        if (fs.existsSync(restartSignalPath)) {
            clearInterval(restartWatcher);
            clearInterval(timer);
            console.log('\n  🔄 Restart signal detected from admin panel');
            try { fs.unlinkSync(restartSignalPath); } catch { /* ok */ }
            for (const [date, session] of sessions) {
                await stopSession(session, date, intervalMinutes);
            }
            console.log('  💾 Sessions saved. Exiting for restart...');
            process.exit(0);
        }
    }, 5000);

    const timer = setInterval(async () => {
        console.log(`\n${'═'.repeat(65)}`);
        console.log(`  ⏱️  Monitoring cycle @ ${formatTime(new Date().toISOString())}`);

        // Retry any dates that failed initialization (market may have been created since)
        const currentDates = getPortfolioDates();
        for (const { date, phase } of currentDates) {
            if (!sessions.has(date)) {
                try {
                    console.log(`  🔄 Retrying initialization for ${date}...`);
                    const session = await createOrResumeSession(date, intervalMinutes);
                    sessions.set(date, session);
                    console.log(`  ✅ Successfully initialized ${date} (${phase})`);
                } catch (err) {
                    console.log(`  ⚠️  ${date} still unavailable: ${err.message.slice(0, 80)}`);
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
                console.log(`  │ ${date} │ ❌ ERROR      │ ${err.message.slice(0, 50).padEnd(52)} │`);
            }
        }

        console.log('  └────────────┴──────────────┴───────────┴─────────────────┴────────────────────────────┴────────────┘');

        // Check if all sessions are complete
        const allComplete = [...sessions.values()].every(s => s.status === 'completed');
        if (allComplete) {
            console.log('\n  ✅ All markets resolved. Monitoring complete.');
            clearInterval(timer);
            process.exit(0);
        }

        console.log(`\n  ⏱️  Next check in ${intervalMinutes} minutes... (Ctrl+C to stop)`);
    }, intervalMs);

    console.log(`\n  ⏱️  Next check in ${intervalMinutes} minutes... (Ctrl+C to stop)`);

    // Graceful shutdown
    const shutdown = () => {
        console.log('\n\n  🛑 Shutting down monitor...');
        clearInterval(timer);
        for (const [date, session] of sessions) {
            if (session.status === 'active') {
                stopSession(session);
            }
        }
        const totalSnapshots = [...sessions.values()].reduce((sum, s) => sum + s.snapshots.length, 0);
        const totalAlerts = [...sessions.values()].reduce((sum, s) => sum + s.alerts.length, 0);
        console.log(`  💾 ${sessions.size} sessions saved (${totalSnapshots} snapshots, ${totalAlerts} alerts)`);
        process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

main().catch(err => {
    console.error('\n❌ Fatal error:', err.message);
    console.error(err.stack);
    process.exit(1);
});
