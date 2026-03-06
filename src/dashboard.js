/**
 * TempEdge Dashboard — Local web dashboard for monitoring temperature markets
 *
 * Usage:
 *   node src/dashboard.js                     # Default port 3000
 *   node src/dashboard.js --port 8080         # Custom port
 *   node src/dashboard.js --date 2026-03-08   # Specific date
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getTodayET, getTomorrowET, getTargetDateET, daysUntil, getPhase } from './utils/dateUtils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const OUTPUT_DIR = path.resolve(__dirname, '../output');

// ── CLI Arguments ───────────────────────────────────────────────────────

const args = process.argv.slice(2);
let port = 3000;
let targetDate = null;

for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' && args[i + 1]) {
        port = parseInt(args[i + 1]);
        i++;
    } else if (args[i] === '--date' && args[i + 1]) {
        targetDate = args[i + 1];
        i++;
    } else if (/^\d{4}-\d{2}-\d{2}$/.test(args[i])) {
        targetDate = args[i];
    }
}

if (!targetDate) {
    targetDate = getTargetDateET();
}

// ── Data Loading ────────────────────────────────────────────────────────

function loadSessionData(date) {
    const sessionPath = path.join(OUTPUT_DIR, `monitor-${date}.json`);
    if (fs.existsSync(sessionPath)) {
        try {
            return JSON.parse(fs.readFileSync(sessionPath, 'utf-8'));
        } catch {
            return null;
        }
    }
    return null;
}

function loadObservationData(date) {
    const obsPath = path.join(OUTPUT_DIR, `${date}.json`);
    if (fs.existsSync(obsPath)) {
        try {
            return JSON.parse(fs.readFileSync(obsPath, 'utf-8'));
        } catch {
            return null;
        }
    }
    return null;
}

function listAvailableDates() {
    if (!fs.existsSync(OUTPUT_DIR)) return [];
    return fs.readdirSync(OUTPUT_DIR)
        .filter(f => f.startsWith('monitor-') && f.endsWith('.json'))
        .map(f => f.replace('monitor-', '').replace('.json', ''))
        .sort()
        .reverse();
}

// ── HTTP Server ─────────────────────────────────────────────────────────

/**
 * Compute P&L from buyOrder vs latest snapshot — runs on every API call
 */
function computeLivePnL(buyOrder, latestSnapshot) {
    if (!buyOrder || !buyOrder.positions || !latestSnapshot) return null;

    const currentRanges = {
        target: latestSnapshot.target,
        below: latestSnapshot.below,
        above: latestSnapshot.above,
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

const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);

    // API Routes
    if (url.pathname === '/api/status') {
        const date = url.searchParams.get('date') || targetDate;
        const session = loadSessionData(date);
        const observation = loadObservationData(date);
        const latestSnap = session?.snapshots?.[session.snapshots.length - 1] || null;
        const livePnL = computeLivePnL(session?.buyOrder, latestSnap);

        // Attach live P&L to session for the response
        const sessionWithPnL = session ? {
            ...session,
            pnl: livePnL,
        } : null;

        res.writeHead(200, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
        });
        res.end(JSON.stringify({
            targetDate: date,
            session: sessionWithPnL,
            observation,
            availableDates: listAvailableDates(),
            serverTime: new Date().toISOString(),
        }));
        return;
    }

    if (url.pathname === '/api/snapshots') {
        const date = url.searchParams.get('date') || targetDate;
        const session = loadSessionData(date);
        res.writeHead(200, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
        });
        res.end(JSON.stringify(session?.snapshots || []));
        return;
    }

    // Portfolio endpoint — returns all active sessions across the 3 rolling dates
    if (url.pathname === '/api/portfolio') {
        const today = getTodayET();
        const tomorrow = getTomorrowET();
        const dayAfter = getTargetDateET();
        const portfolioDates = [today, tomorrow, dayAfter];

        const plays = portfolioDates.map(date => {
            const session = loadSessionData(date);
            const phase = getPhase(date);
            const days = daysUntil(date);
            const latest = session?.snapshots?.[session.snapshots.length - 1] || null;
            return {
                date,
                phase,
                daysUntil: days,
                session: session ? {
                    id: session.id,
                    status: session.status,
                    phase: session.phase,
                    initialForecastTempF: session.initialForecastTempF,
                    initialTargetRange: session.initialTargetRange,
                    forecastSource: session.forecastSource,
                    rebalanceThreshold: session.rebalanceThreshold,
                    snapshotCount: session.snapshots?.length || 0,
                    alertCount: session.alerts?.length || 0,
                    resolution: session.resolution || null,
                    buyOrder: session.buyOrder || null,
                    pnl: computeLivePnL(session.buyOrder, latest),
                } : null,
                latest,
                hasData: !!session || !!loadObservationData(date),
            };
        });

        res.writeHead(200, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
        });
        res.end(JSON.stringify({
            plays,
            availableDates: listAvailableDates(),
            serverTime: new Date().toISOString(),
        }));
        return;
    }

    if (url.pathname === '/api/dates') {
        res.writeHead(200, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
        });
        res.end(JSON.stringify(listAvailableDates()));
        return;
    }

    // Dashboard HTML
    if (url.pathname === '/' || url.pathname === '/index.html') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(getDashboardHTML(targetDate));
        return;
    }

    // 404
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
});

server.listen(port, () => {
    console.log(`\n🌡️  TempEdge Dashboard`);
    console.log(`═══════════════════════════════════════`);
    console.log(`  URL:    http://localhost:${port}`);
    console.log(`  Date:   ${targetDate}`);
    console.log(`  Data:   ${OUTPUT_DIR}`);
    console.log(`═══════════════════════════════════════\n`);
});

// ── Dashboard HTML ──────────────────────────────────────────────────────

function getDashboardHTML(defaultDate) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>TempEdge Dashboard</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
    <style>
        :root {
            --bg-primary: #0a0e17;
            --bg-secondary: #111827;
            --bg-card: #1a2235;
            --bg-card-hover: #1f2a40;
            --border: #2a3550;
            --text-primary: #f0f4f8;
            --text-secondary: #8b99b0;
            --text-muted: #5a6a80;
            --accent-blue: #3b82f6;
            --accent-orange: #f59e0b;
            --accent-cyan: #06b6d4;
            --accent-green: #10b981;
            --accent-amber: #f59e0b;
            --accent-red: #ef4444;
            --accent-purple: #8b5cf6;
            --gradient-blue: linear-gradient(135deg, #3b82f6, #06b6d4);
            --gradient-green: linear-gradient(135deg, #10b981, #06d6a0);
            --gradient-warm: linear-gradient(135deg, #f59e0b, #ef4444);
            --shadow-sm: 0 1px 3px rgba(0,0,0,0.3);
            --shadow-md: 0 4px 12px rgba(0,0,0,0.4);
            --shadow-lg: 0 8px 30px rgba(0,0,0,0.5);
            --radius: 12px;
            --radius-sm: 8px;
        }

        * { margin: 0; padding: 0; box-sizing: border-box; }

        body {
            font-family: 'Inter', -apple-system, sans-serif;
            background: var(--bg-primary);
            color: var(--text-primary);
            min-height: 100vh;
            overflow-x: hidden;
        }

        /* ── Header ─────────────────────────────── */
        .header {
            background: var(--bg-secondary);
            border-bottom: 1px solid var(--border);
            padding: 16px 32px;
            display: flex;
            align-items: center;
            justify-content: space-between;
            position: sticky;
            top: 0;
            z-index: 100;
            backdrop-filter: blur(12px);
        }

        .header-left {
            display: flex;
            align-items: center;
            gap: 16px;
        }

        .logo {
            font-size: 24px;
            font-weight: 700;
            background: var(--gradient-blue);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            background-clip: text;
        }

        .status-badge {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            padding: 4px 12px;
            border-radius: 20px;
            font-size: 12px;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }

        .status-active {
            background: rgba(16, 185, 129, 0.15);
            color: var(--accent-green);
            border: 1px solid rgba(16, 185, 129, 0.3);
        }

        .status-completed {
            background: rgba(59, 130, 246, 0.15);
            color: var(--accent-blue);
            border: 1px solid rgba(59, 130, 246, 0.3);
        }

        .status-stopped {
            background: rgba(245, 158, 11, 0.15);
            color: var(--accent-amber);
            border: 1px solid rgba(245, 158, 11, 0.3);
        }

        .status-none {
            background: rgba(90, 106, 128, 0.15);
            color: var(--text-muted);
            border: 1px solid rgba(90, 106, 128, 0.3);
        }

        .status-dot {
            width: 8px;
            height: 8px;
            border-radius: 50%;
            background: currentColor;
        }

        .status-active .status-dot {
            animation: pulse 2s infinite;
        }

        @keyframes pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.4; }
        }

        .header-right {
            display: flex;
            align-items: center;
            gap: 12px;
            font-size: 13px;
            color: var(--text-secondary);
        }

        .header-right select {
            background: var(--bg-card);
            color: var(--text-primary);
            border: 1px solid var(--border);
            border-radius: var(--radius-sm);
            padding: 6px 10px;
            font-family: 'JetBrains Mono', monospace;
            font-size: 13px;
            cursor: pointer;
        }

        /* ── Main Layout ────────────────────────── */
        .container {
            max-width: 1400px;
            margin: 0 auto;
            padding: 24px 32px;
        }

        /* ── Stat Cards Row ──────────────────────── */
        .stats-row {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
            gap: 16px;
            margin-bottom: 24px;
        }

        .stat-card {
            background: var(--bg-card);
            border: 1px solid var(--border);
            border-radius: var(--radius);
            padding: 20px;
            transition: all 0.2s ease;
        }

        .stat-card:hover {
            background: var(--bg-card-hover);
            border-color: var(--accent-blue);
            box-shadow: var(--shadow-md);
        }

        .stat-label {
            font-size: 12px;
            color: var(--text-muted);
            text-transform: uppercase;
            letter-spacing: 1px;
            margin-bottom: 8px;
        }

        .stat-value {
            font-size: 28px;
            font-weight: 700;
            font-family: 'JetBrains Mono', monospace;
        }

        .stat-sub {
            font-size: 12px;
            color: var(--text-secondary);
            margin-top: 4px;
        }

        .stat-change {
            display: inline-flex;
            align-items: center;
            gap: 4px;
            font-size: 13px;
            font-weight: 600;
            padding: 2px 8px;
            border-radius: 6px;
            margin-top: 6px;
        }

        .change-up {
            color: var(--accent-green);
            background: rgba(16, 185, 129, 0.1);
        }

        .change-down {
            color: var(--accent-red);
            background: rgba(239, 68, 68, 0.1);
        }

        .change-neutral {
            color: var(--text-muted);
            background: rgba(90, 106, 128, 0.1);
        }

        /* ── Grid Layout ─────────────────────────── */
        .grid-2col {
            display: grid;
            grid-template-columns: 2fr 1fr;
            gap: 24px;
            margin-bottom: 24px;
        }

        @media (max-width: 1024px) {
            .grid-2col { grid-template-columns: 1fr; }
        }

        /* ── Card ─────────────────────────────────── */
        .card {
            background: var(--bg-card);
            border: 1px solid var(--border);
            border-radius: var(--radius);
            overflow: visible;
        }

        .portfolio-card {
            padding: 16px;
        }

        .card-header {
            padding: 16px 20px;
            border-bottom: 1px solid var(--border);
            display: flex;
            align-items: center;
            justify-content: space-between;
        }

        .card-title {
            font-size: 14px;
            font-weight: 600;
            color: var(--text-primary);
        }

        .card-body {
            padding: 20px;
        }

        /* ── Chart ────────────────────────────────── */
        .chart-container {
            width: 100%;
            height: 280px;
            position: relative;
        }

        .chart-canvas {
            width: 100%;
            height: 100%;
        }

        .chart-empty {
            display: flex;
            align-items: center;
            justify-content: center;
            height: 100%;
            color: var(--text-muted);
            font-size: 14px;
        }

        /* ── Price Tooltip ────────────────────────── */
        .price-tip {
            position: relative;
            cursor: help;
            border-bottom: 1px dashed rgba(255,255,255,0.3);
            display: inline-block;
        }
        .price-tip .tip-content {
            display: none;
            position: absolute;
            bottom: calc(100% + 8px);
            left: 50%;
            transform: translateX(-50%);
            background: var(--surface);
            border: 1px solid var(--border);
            border-radius: 8px;
            padding: 10px 14px;
            white-space: nowrap;
            z-index: 100;
            box-shadow: 0 8px 24px rgba(0,0,0,0.4);
            font-size: 12px;
            line-height: 1.6;
            pointer-events: none;
        }
        .price-tip .tip-content::after {
            content: '';
            position: absolute;
            top: 100%;
            left: 50%;
            transform: translateX(-50%);
            border: 6px solid transparent;
            border-top-color: var(--border);
        }
        .price-tip:hover .tip-content {
            display: block;
        }
        .tip-row {
            display: flex;
            justify-content: space-between;
            gap: 16px;
        }
        .tip-label {
            color: var(--text-secondary);
        }
        .tip-price {
            font-weight: 600;
            color: var(--text-primary);
        }
        .tip-total {
            border-top: 1px solid var(--border);
            margin-top: 4px;
            padding-top: 4px;
            font-weight: 700;
        }

        /* ── Ranges Table ─────────────────────────── */
        .ranges-table {
            width: 100%;
            border-collapse: collapse;
        }

        .ranges-table th {
            font-size: 11px;
            text-transform: uppercase;
            letter-spacing: 0.8px;
            color: var(--text-muted);
            font-weight: 500;
            text-align: left;
            padding: 10px 12px;
            border-bottom: 1px solid var(--border);
        }

        .ranges-table td {
            padding: 10px 12px;
            font-size: 13px;
            font-family: 'JetBrains Mono', monospace;
            border-bottom: 1px solid rgba(42, 53, 80, 0.5);
        }

        .ranges-table tr:hover td {
            background: rgba(59, 130, 246, 0.05);
        }

        .ranges-table tr.selected-target td {
            background: rgba(59, 130, 246, 0.1);
            border-left: 3px solid var(--accent-blue);
        }

        .ranges-table tr.selected-below td {
            background: rgba(245, 158, 11, 0.08);
            border-left: 3px solid var(--accent-orange);
        }

        .ranges-table tr.selected-above td {
            background: rgba(16, 185, 129, 0.08);
            border-left: 3px solid var(--accent-green);
        }

        .range-marker {
            font-size: 16px;
            width: 24px;
            display: inline-block;
            text-align: center;
        }

        .price-bar {
            height: 6px;
            border-radius: 3px;
            background: var(--border);
            overflow: hidden;
            margin-top: 4px;
        }

        .price-bar-fill {
            height: 100%;
            border-radius: 3px;
            transition: width 0.5s ease;
        }

        /* ── Alert Feed ───────────────────────────── */
        .alert-item {
            display: flex;
            gap: 12px;
            padding: 12px 16px;
            border-bottom: 1px solid rgba(42, 53, 80, 0.5);
            font-size: 13px;
            transition: background 0.2s;
        }

        .alert-item:last-child { border-bottom: none; }
        .alert-item:hover { background: var(--bg-card-hover); }

        .alert-icon {
            font-size: 18px;
            flex-shrink: 0;
            margin-top: 1px;
        }

        .alert-content {
            flex: 1;
        }

        .alert-message {
            color: var(--text-primary);
            line-height: 1.5;
        }

        .alert-time {
            color: var(--text-muted);
            font-size: 11px;
            font-family: 'JetBrains Mono', monospace;
            margin-top: 4px;
        }

        .alert-empty {
            padding: 24px;
            text-align: center;
            color: var(--text-muted);
            font-size: 13px;
        }

        /* ── Loading / No Data ────────────────────── */
        .no-data {
            text-align: center;
            padding: 60px 20px;
            color: var(--text-muted);
        }

        .no-data h2 {
            font-size: 20px;
            font-weight: 600;
            color: var(--text-secondary);
            margin-bottom: 8px;
        }

        .no-data p {
            font-size: 14px;
            max-width: 460px;
            margin: 0 auto;
            line-height: 1.6;
        }

        .no-data code {
            background: var(--bg-card);
            padding: 2px 8px;
            border-radius: 4px;
            font-family: 'JetBrains Mono', monospace;
            font-size: 13px;
            color: var(--accent-cyan);
        }

        /* ── Refresh indicator ────────────────────── */
        .refresh-indicator {
            font-size: 11px;
            color: var(--text-muted);
            font-family: 'JetBrains Mono', monospace;
        }

        .refresh-indicator .dot {
            display: inline-block;
            width: 6px;
            height: 6px;
            border-radius: 50%;
            background: var(--accent-green);
            margin-right: 6px;
            animation: pulse 2s infinite;
        }
    </style>
</head>
<body>
    <header class="header">
        <div class="header-left">
            <span class="logo">🌡️ TempEdge</span>
            <span id="statusBadge" class="status-badge status-none">
                <span class="status-dot"></span>
                <span id="statusText">Loading...</span>
            </span>
        </div>
        <div class="header-right">
            <span class="refresh-indicator"><span class="dot"></span>Auto-refresh</span>
            <select id="dateSelect" onchange="switchDate(this.value)">
                <option value="${defaultDate}">${defaultDate}</option>
            </select>
        </div>
    </header>

    <main class="container" id="app">
        <div class="no-data" id="loadingState">
            <h2>Loading...</h2>
            <p>Connecting to TempEdge monitor data</p>
        </div>
    </main>

    <script>
        let currentDate = '${defaultDate}';
        let refreshTimer = null;

        // ── Data Fetching ─────────────────────────
        async function fetchStatus(date) {
            try {
                const res = await fetch('/api/status?date=' + (date || currentDate));
                return await res.json();
            } catch {
                return null;
            }
        }

        async function fetchPortfolio() {
            try {
                const res = await fetch('/api/portfolio');
                return await res.json();
            } catch {
                return null;
            }
        }

        function switchDate(date) {
            currentDate = date;
            refresh();
        }

        function shortLabel(question) {
            if (!question) return '--';
            const rangeMatch = question.match(/(\\d+)-(\\d+)/);
            if (rangeMatch) return rangeMatch[1] + '-' + rangeMatch[2] + '\\u00b0F';
            const upperMatch = question.match(/(\\d+).*or higher/i);
            if (upperMatch) return upperMatch[1] + '\\u00b0F+';
            const lowerMatch = question.match(/(\\d+).*or (?:lower|below)/i);
            if (lowerMatch) return '\\u2264' + lowerMatch[1] + '\\u00b0F';
            return question.slice(0, 15);
        }

        function renderPortfolioCard(play) {
            const phaseColors = { buy: '#10b981', monitor: '#f59e0b', resolve: '#ef4444' };
            const phaseIcons = { buy: '\\ud83d\\uded2', monitor: '\\ud83d\\udc41\\ufe0f', resolve: '\\ud83c\\udfaf' };
            const phaseLabels = { buy: 'BUY', monitor: 'MONITOR', resolve: 'RESOLVE' };
            const color = phaseColors[play.phase] || '#6b7280';
            const icon = phaseIcons[play.phase] || '';
            const label = phaseLabels[play.phase] || play.phase;
            const latest = play.latest;

            const forecastTemp = latest ? latest.forecastTempF + '\\u00b0F' : '--';
            const currentTemp = latest?.currentTempF != null ? latest.currentTempF + '\\u00b0F' : '--';
            const target = latest ? shortLabel(latest.target?.question) : '--';

            // Buy order & P&L data
            const buyOrder = play.session?.buyOrder;
            const pnl = play.session?.pnl;
            const buyCost = buyOrder ? '$' + buyOrder.totalCost.toFixed(3) : '--';
            const currentValue = pnl ? '$' + pnl.totalCurrentValue.toFixed(3) : (latest ? '$' + latest.totalCost?.toFixed(3) : '--');
            const totalPnL = pnl ? pnl.totalPnL : 0;
            const totalPnLPct = pnl ? pnl.totalPnLPct : 0;
            const pnlColor = totalPnL >= 0 ? 'var(--accent-green)' : 'var(--accent-red)';
            const pnlSign = totalPnL >= 0 ? '+' : '';
            const pnlDisplay = pnl ? pnlSign + '$' + totalPnL.toFixed(4) + ' (' + pnlSign + totalPnLPct + '%)' : '--';
            const buyTime = buyOrder ? new Date(buyOrder.placedAt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZone: 'America/New_York' }) : '';

            // Build tooltip text for Bought At (per-range buy prices)
            let buyTitleAttr = '';
            let buyTooltipHtml = buyCost;
            if (buyOrder && buyOrder.positions) {
                const lines = buyOrder.positions.map(function(pos) {
                    var lbl = pos.label === 'target' ? 'Target' : pos.label === 'below' ? 'Below' : 'Above';
                    return lbl + ': ' + shortLabel(pos.question) + ' @ ' + (pos.buyPrice * 100).toFixed(1) + String.fromCharCode(162);
                });
                lines.push('Total: ' + buyCost);
                buyTitleAttr = lines.join(String.fromCharCode(10));
                buyTooltipHtml = '<span style="cursor:help;border-bottom:1px dashed rgba(255,255,255,0.3)" title="' + escapeHtml(buyTitleAttr) + '">' + buyCost + '</span>';
            }

            // Build tooltip text for Current Value (per-range current + P&L)
            let currentTooltipHtml = currentValue;
            if (pnl && pnl.positions) {
                const lines = pnl.positions.map(function(pos) {
                    var lbl = pos.label === 'target' ? 'Target' : pos.label === 'below' ? 'Below' : 'Above';
                    var sign = pos.pnl >= 0 ? '+' : '';
                    return lbl + ': ' + shortLabel(pos.question) + ' @ ' + (pos.currentPrice * 100).toFixed(1) + String.fromCharCode(162) + ' (' + sign + (pos.pnl * 100).toFixed(1) + String.fromCharCode(162) + ')';
                });
                lines.push('Total: ' + currentValue);
                var cvTitle = lines.join(String.fromCharCode(10));
                currentTooltipHtml = '<span style="cursor:help;border-bottom:1px dashed rgba(255,255,255,0.3)" title="' + escapeHtml(cvTitle) + '">' + currentValue + '</span>';
            }

            const snaps = play.session?.snapshotCount || 0;
            const alerts = play.session?.alertCount || 0;
            const selected = play.date === currentDate ? 'border-color:' + color + ';' : '';
            const dayLabel = play.daysUntil === 0 ? 'Today' : play.daysUntil === 1 ? 'Tomorrow' : 'T+' + play.daysUntil;

            let resolutionHtml = '';
            if (play.session?.resolution) {
                const r = play.session.resolution;
                resolutionHtml = '<div style=\"margin-top:8px;padding-top:8px;border-top:1px solid rgba(255,255,255,0.1);\">' +
                    '<div style=\"color:' + color + ';font-weight:700;\">KEEP: ' + escapeHtml(shortLabel(r.keep)) + '</div>' +
                    '<div style=\"color:var(--accent-red);font-size:12px;\">DISCARD: ' + r.discard.map(d => escapeHtml(shortLabel(d))).join(', ') + '</div>' +
                    '</div>';
            }

            return '<div class=\"card portfolio-card\" style=\"cursor:pointer;' + selected + '\" onclick=\"switchDate(\\'' + play.date + '\\')\">' +
                '<div style=\"display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;\">' +
                '<div style=\"display:flex;align-items:center;gap:8px;\">' +
                '<span style=\"font-size:18px;font-weight:700;color:var(--text-primary);\">' + play.date + '</span>' +
                '<span style=\"background:' + color + ';color:#fff;font-size:11px;font-weight:700;padding:2px 10px;border-radius:99px;\">' + icon + ' ' + label + '</span>' +
                '</div>' +
                '<span style=\"color:var(--text-secondary);font-size:12px;\">' + dayLabel + '</span>' +
                '</div>' +
                (!play.hasData ? '<div style=\"color:var(--text-secondary);font-size:13px;\">No market data yet</div>' :
                '<div style=\"display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;\">' +
                '<div><div style=\"color:var(--text-secondary);font-size:11px;\">Current</div><div style=\"font-size:18px;font-weight:700;\">' + currentTemp + '</div></div>' +
                '<div><div style=\"color:var(--text-secondary);font-size:11px;\">Forecast</div><div style=\"font-size:18px;font-weight:700;\">' + forecastTemp + '</div></div>' +
                '<div><div style=\"color:var(--text-secondary);font-size:11px;\">Target</div><div style=\"font-size:18px;font-weight:700;color:' + color + ';\">' + target + '</div></div>' +
                '</div>' +
                '<div style=\"display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-top:8px;\">' +
                '<div><div style=\"color:var(--text-secondary);font-size:11px;\">Bought At' + (buyTime ? ' (' + buyTime + ')' : '') + '</div><div style=\"font-weight:600;\">' + buyTooltipHtml + '</div></div>' +
                '<div><div style=\"color:var(--text-secondary);font-size:11px;\">Current Value</div><div style=\"font-weight:600;\">' + currentTooltipHtml + '</div></div>' +
                '<div><div style=\"color:var(--text-secondary);font-size:11px;\">P&amp;L</div><div style=\"font-weight:700;font-size:14px;color:' + pnlColor + ';\">' + pnlDisplay + '</div></div>' +
                '</div>' +
                '<div style=\"margin-top:8px;color:var(--text-secondary);font-size:12px;\">' + snaps + ' snapshots \\u00b7 ' + alerts + ' alerts</div>' +
                resolutionHtml) +
                '</div>';
        }

        // ── Rendering ─────────────────────────────
        async function render(data) {
            if (!data) {
                document.getElementById('app').innerHTML = '<div class=\"no-data\"><h2>Connection Error</h2><p>Could not connect to the dashboard server.</p></div>';
                return;
            }

            // Fetch portfolio data in parallel
            const portfolio = await fetchPortfolio();

            // Update date selector
            const select = document.getElementById('dateSelect');
            const dates = data.availableDates || [];
            if (!dates.includes(currentDate) && data.observation) {
                dates.unshift(currentDate);
            }
            if (dates.length > 0) {
                select.innerHTML = dates.map(d =>
                    '<option value=\"' + d + '\"' + (d === currentDate ? ' selected' : '') + '>' + d + '</option>'
                ).join('');
            }

            const session = data.session;
            const observation = data.observation;

            // Build portfolio HTML
            let portfolioHtml = '';
            if (portfolio && portfolio.plays) {
                portfolioHtml = '<div class=\"card\" style=\"margin-bottom:24px;\">' +
                    '<div class=\"card-header\"><span class=\"card-title\">\\ud83d\\udcca Rolling Portfolio</span><span style=\"color:var(--text-secondary);font-size:13px;\">click a play to view details</span></div>' +
                    '<div class=\"card-body\">' +
                    '<div style=\"display:grid;grid-template-columns:repeat(3,1fr);gap:16px;\">' +
                    portfolio.plays.map(p => renderPortfolioCard(p)).join('') +
                    '</div></div></div>';
            }

            if (!session && !observation) {
                updateStatus('none', 'No Data');
                document.getElementById('app').innerHTML = portfolioHtml +
                    '<div class=\"no-data\">' +
                    '<h2>No monitoring data for ' + currentDate + '</h2>' +
                    '<p>Start the monitor with:<br><code>node src/monitor.js</code></p>' +
                    '</div>';
                return;
            }

            // Determine source data
            const snapshots = session?.snapshots || [];
            const alerts = session?.alerts || [];
            const latest = snapshots[snapshots.length - 1] || null;
            const status = session?.status || (observation ? 'observation' : 'none');
            const phase = latest?.phase || session?.phase || '';
            const phaseLabels = { buy: '🛒 BUY', monitor: '👁️ MONITOR', resolve: '🎯 RESOLVE' };

            // Update status badge with phase
            const phaseStr = phaseLabels[phase] ? ' · ' + phaseLabels[phase] : '';
            updateStatus(status, (status.charAt(0).toUpperCase() + status.slice(1)) + phaseStr);

            // Get forecast and selection data
            let forecastTemp, targetRange, belowRange, aboveRange, totalCost, allRanges;
            let currentTempF = null, currentConditions = '', maxTodayF = null;
            let forecastSource = 'unknown', daysUntilTarget = null;

            if (latest) {
                forecastTemp = latest.forecastTempF;
                targetRange = latest.target;
                belowRange = latest.below;
                aboveRange = latest.above;
                totalCost = latest.totalCost;
                allRanges = latest.allRanges || [];
                currentTempF = latest.currentTempF;
                currentConditions = latest.currentConditions || '';
                maxTodayF = latest.maxTodayF;
                forecastSource = latest.forecastSource || session?.forecastSource || 'unknown';
                daysUntilTarget = latest.daysUntilTarget;
            } else if (observation) {
                forecastTemp = observation.forecast.highTempF;
                targetRange = observation.selection.target;
                belowRange = observation.selection.below;
                aboveRange = observation.selection.above;
                totalCost = observation.selection.totalCost;
                forecastSource = observation.forecast.source || 'unknown';
                allRanges = observation.event.ranges.map(r => ({
                    marketId: r.marketId,
                    question: r.question,
                    yesPrice: r.yesPrice,
                    impliedProbability: r.impliedProbability,
                    volume: r.volume,
                }));
            }

            const profit = (1 - totalCost).toFixed(3);
            const roi = totalCost > 0 ? ((1 - totalCost) / totalCost * 100).toFixed(1) : '0';
            const forecastChange = latest?.forecastChange || 0;
            const snapshotCount = snapshots.length;
            const alertCount = alerts.length;
            const sourceLabel = forecastSource === 'weather-company' ? 'WU/KLGA' : forecastSource;

            // Buy/P&L info for detail view
            const detailBuyOrder = data.session?.buyOrder;
            const detailPnL = data.session?.pnl;
            let costLabel = 'Total Cost';
            let costValue = '$' + totalCost?.toFixed(3);
            let costSub = 'Profit: $' + profit + ' \u00b7 ROI: ' + roi + '%';
            if (detailBuyOrder) {
                costLabel = 'Buy / P&L';
                costValue = '$' + detailBuyOrder.totalCost.toFixed(3);
                if (detailPnL) {
                    const pSign = detailPnL.totalPnL >= 0 ? '+' : '';
                    costSub = 'P&L: ' + pSign + '$' + detailPnL.totalPnL.toFixed(4) + ' (' + pSign + detailPnL.totalPnLPct + '%)';
                }
            }

            // Build HTML
            let html = '';

            // Stats Row
            html += '<div class="stats-row">';
            html += statCard('Current Temp', currentTempF !== null ? currentTempF + '\u00b0F' : '--', currentConditions + (maxTodayF ? ' \u00b7 Hi: ' + maxTodayF + '\u00b0F' : ''), 0, '');
            html += statCard('Forecast High', forecastTemp + '\u00b0F', sourceLabel + (daysUntilTarget !== null ? ' \u00b7 T-' + daysUntilTarget : ''), forecastChange, '\u00b0F');
            html += statCard('Target Range', shortLabel(targetRange?.question || '--'), session?.initialTargetRange ? 'Initial: ' + shortLabel(session.initialTargetRange) : '', 0, '');
            html += statCard(costLabel, costValue, costSub, 0, '');
            html += '</div>';

            // Resolve-day decision card
            if (session?.resolution) {
                const r = session.resolution;
                html += '<div class="card" style="border-color:var(--accent-green);margin-bottom:24px;">';
                html += '<div class="card-header" style="background:rgba(16,185,129,0.1);"><span class="card-title">🎯 Resolve Day — Range Decision</span></div>';
                html += '<div class="card-body">';
                html += '<div style="font-size:18px;font-weight:700;color:var(--accent-green);margin-bottom:8px;">KEEP: ' + escapeHtml(shortLabel(r.keep)) + ' (' + (r.keepPrice * 100).toFixed(1) + '¢)</div>';
                html += '<div style="color:var(--accent-red);margin-bottom:8px;">DISCARD: ' + r.discard.map(d => escapeHtml(shortLabel(d))).join(', ') + '</div>';
                html += '<div style="color:var(--text-secondary);font-size:13px;">' + escapeHtml(r.reason) + '</div>';
                html += '</div></div>';
            }

            // Chart + Alerts Layout
            html += '<div class="grid-2col">';

            // Price History Chart
            html += '<div class="card">';
            html += '<div class="card-header"><span class="card-title">📈 Price History</span><span style="font-size:12px;color:var(--text-muted);">' + snapshotCount + ' snapshots</span></div>';
            html += '<div class="card-body"><div class="chart-container">';
            if (snapshots.length >= 2) {
                html += renderChart(snapshots);
            } else {
                html += '<div class="chart-empty">Waiting for more snapshots to plot chart...</div>';
            }
            html += '</div></div></div>';

            // Alerts Feed
            html += '<div class="card">';
            html += '<div class="card-header"><span class="card-title">🔔 Alerts</span><span style="font-size:12px;color:var(--text-muted);">' + alertCount + ' total</span></div>';
            html += '<div class="card-body" style="padding:0;max-height:280px;overflow-y:auto;">';
            if (alerts.length > 0) {
                const alertIcons = { forecast_shift: '⚠️', range_shift: '🔴', price_spike: '📊', market_closed: '✅' };
                for (let i = alerts.length - 1; i >= 0; i--) {
                    const a = alerts[i];
                    html += '<div class="alert-item">';
                    html += '<span class="alert-icon">' + (alertIcons[a.type] || '❓') + '</span>';
                    html += '<div class="alert-content">';
                    html += '<div class="alert-message">' + escapeHtml(a.message) + '</div>';
                    html += '<div class="alert-time">' + formatTime(a.timestamp) + '</div>';
                    html += '</div></div>';
                }
            } else {
                html += '<div class="alert-empty">No alerts yet. Monitoring will detect forecast shifts, range changes, and price spikes.</div>';
            }
            html += '</div></div>';

            html += '</div>'; // end grid-2col

            // All Ranges Table
            html += '<div class="card">';
            html += '<div class="card-header"><span class="card-title">📊 All Temperature Ranges</span></div>';
            html += '<div class="card-body" style="padding:0;overflow-x:auto;">';
            html += renderRangesTable(allRanges, targetRange, belowRange, aboveRange);
            html += '</div></div>';

            document.getElementById('app').innerHTML = portfolioHtml + html;
        }

        function statCard(label, value, sub, change, unit) {
            let changeHtml = '';
            if (change !== 0) {
                const cls = change > 0 ? 'change-up' : 'change-down';
                const sign = change > 0 ? '+' : '';
                changeHtml = '<div class="stat-change ' + cls + '">' + sign + change + unit + '</div>';
            }
            return '<div class="stat-card">' +
                '<div class="stat-label">' + label + '</div>' +
                '<div class="stat-value">' + value + '</div>' +
                '<div class="stat-sub">' + sub + '</div>' +
                changeHtml +
                '</div>';
        }

        function updateStatus(status, text) {
            const badge = document.getElementById('statusBadge');
            const textEl = document.getElementById('statusText');
            badge.className = 'status-badge status-' + status;
            textEl.textContent = text;
        }

        function renderRangesTable(ranges, target, below, above) {
            if (!ranges || ranges.length === 0) return '<div class="alert-empty">No range data available</div>';

            const sorted = [...ranges].sort((a, b) => {
                const aLow = a.question.match(/\\d+/);
                const bLow = b.question.match(/\\d+/);
                return (aLow ? parseInt(aLow[0]) : -999) - (bLow ? parseInt(bLow[0]) : -999);
            });

            let html = '<table class="ranges-table">';
            html += '<thead><tr><th></th><th>Range</th><th>YES Price</th><th>Implied %</th><th>Volume</th><th>Probability</th></tr></thead>';
            html += '<tbody>';

            for (const r of sorted) {
                let rowClass = '';
                let marker = '';
                if (target && r.marketId === target.marketId) { rowClass = 'selected-target'; marker = '🎯'; }
                else if (below && r.marketId === below.marketId) { rowClass = 'selected-below'; marker = '⬇️'; }
                else if (above && r.marketId === above.marketId) { rowClass = 'selected-above'; marker = '⬆️'; }

                const pct = r.impliedProbability || (r.yesPrice * 100);
                const barColor = pct > 50 ? 'var(--accent-green)' : pct > 20 ? 'var(--accent-amber)' : 'var(--accent-blue)';

                html += '<tr class="' + rowClass + '">';
                html += '<td><span class="range-marker">' + marker + '</span></td>';
                html += '<td style="color:var(--text-primary);font-weight:500;">' + escapeHtml(shortLabel(r.question)) + '</td>';
                html += '<td>' + (r.yesPrice * 100).toFixed(1) + '¢</td>';
                html += '<td>' + pct.toFixed(1) + '%</td>';
                html += '<td>$' + (r.volume || 0).toFixed(0) + '</td>';
                html += '<td style="min-width:120px;"><div class="price-bar"><div class="price-bar-fill" style="width:' + Math.min(pct, 100) + '%;background:' + barColor + ';"></div></div></td>';
                html += '</tr>';
            }

            html += '</tbody></table>';
            return html;
        }

        function renderChart(snapshots) {
            if (snapshots.length < 2) return '<div class="chart-empty">Need 2+ snapshots</div>';

            const width = 800;
            const height = 250;
            const pad = { top: 20, right: 20, bottom: 40, left: 55 };
            const plotW = width - pad.left - pad.right;
            const plotH = height - pad.top - pad.bottom;

            // Collect all prices
            const targetPrices = snapshots.map(s => s.target.yesPrice * 100);
            const belowPrices = snapshots.map(s => s.below ? s.below.yesPrice * 100 : null);
            const abovePrices = snapshots.map(s => s.above ? s.above.yesPrice * 100 : null);

            const allPrices = [...targetPrices, ...belowPrices.filter(p => p !== null), ...abovePrices.filter(p => p !== null)];
            const minP = Math.max(0, Math.min(...allPrices) - 2);
            const maxP = Math.min(100, Math.max(...allPrices) + 2);
            const rangeP = maxP - minP || 1;

            const xScale = (i) => pad.left + (i / (snapshots.length - 1)) * plotW;
            const yScale = (v) => pad.top + plotH - ((v - minP) / rangeP) * plotH;

            function polyline(data, color, dash) {
                const points = data.map((v, i) => v !== null ? xScale(i) + ',' + yScale(v) : null).filter(p => p !== null);
                if (points.length < 2) return '';
                var dashAttr = dash ? ' stroke-dasharray="' + dash + '"' : '';
                return '<polyline points="' + points.join(' ') + '" fill="none" stroke="' + color + '" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"' + dashAttr + ' />';
            }

            function dots(data, color) {
                return data.map((v, i) => {
                    if (v === null) return '';
                    return '<circle cx="' + xScale(i) + '" cy="' + yScale(v) + '" r="3.5" fill="' + color + '" stroke="var(--bg-card)" stroke-width="1.5" />';
                }).join('');
            }

            // Y-axis labels
            let yLabels = '';
            const ySteps = 5;
            for (let i = 0; i <= ySteps; i++) {
                const val = minP + (rangeP / ySteps) * i;
                const y = yScale(val);
                yLabels += '<text x="' + (pad.left - 8) + '" y="' + (y + 4) + '" fill="var(--text-muted)" font-size="11" text-anchor="end" font-family="JetBrains Mono">' + val.toFixed(1) + '¢</text>';
                yLabels += '<line x1="' + pad.left + '" y1="' + y + '" x2="' + (width - pad.right) + '" y2="' + y + '" stroke="var(--border)" stroke-width="0.5" />';
            }

            // X-axis labels (show first, last, and a few in between)
            let xLabels = '';
            const xLabelCount = Math.min(6, snapshots.length);
            for (let i = 0; i < xLabelCount; i++) {
                const idx = Math.round(i * (snapshots.length - 1) / (xLabelCount - 1));
                const x = xScale(idx);
                const time = formatTime(snapshots[idx].timestamp);
                xLabels += '<text x="' + x + '" y="' + (height - 8) + '" fill="var(--text-muted)" font-size="10" text-anchor="middle" font-family="JetBrains Mono">' + time + '</text>';
            }

            // Legend
            const legendY = pad.top - 2;
            let legend = '';
            legend += '<rect x="' + pad.left + '" y="' + (legendY - 8) + '" width="10" height="10" rx="2" fill="var(--accent-blue)" />';
            legend += '<text x="' + (pad.left + 14) + '" y="' + legendY + '" fill="var(--text-secondary)" font-size="11">Target</text>';
            legend += '<rect x="' + (pad.left + 70) + '" y="' + (legendY - 8) + '" width="10" height="10" rx="2" fill="var(--accent-orange)" />';
            legend += '<text x="' + (pad.left + 84) + '" y="' + legendY + '" fill="var(--text-secondary)" font-size="11">Below</text>';
            legend += '<rect x="' + (pad.left + 134) + '" y="' + (legendY - 8) + '" width="10" height="10" rx="2" fill="var(--accent-green)" />';
            legend += '<text x="' + (pad.left + 148) + '" y="' + legendY + '" fill="var(--text-secondary)" font-size="11">Above</text>';

            return '<svg viewBox="0 0 ' + width + ' ' + height + '" class="chart-canvas" preserveAspectRatio="xMidYMid meet">' +
                yLabels + xLabels + legend +
                polyline(targetPrices, 'var(--accent-blue)') +
                polyline(belowPrices, 'var(--accent-orange)', '8 4') +
                polyline(abovePrices, 'var(--accent-green)', '3 3') +
                dots(targetPrices, 'var(--accent-blue)') +
                dots(belowPrices, 'var(--accent-orange)') +
                dots(abovePrices, 'var(--accent-green)') +
                '</svg>';
        }

        // ── Utilities ─────────────────────────────
        function escapeHtml(str) {
            return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        }

        function formatTime(iso) {
            try {
                return new Date(iso).toLocaleTimeString('en-US', {
                    hour: '2-digit', minute: '2-digit', second: '2-digit',
                    hour12: true, timeZone: 'America/New_York'
                });
            } catch {
                return iso;
            }
        }

        // ── Auto-refresh loop ─────────────────────
        async function refresh() {
            const data = await fetchStatus(currentDate);
            await render(data);
        }

        // Initial load
        refresh();

        // Refresh every 15 seconds
        refreshTimer = setInterval(refresh, 15000);
    </script>
</body>
</html>`;
}
