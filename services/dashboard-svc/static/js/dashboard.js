/**
 * TempEdge Dashboard — Client-side JavaScript
 *
 * Reads server-injected config from window.__TEMPEDGE_CONFIG__
 */

const CFG = window.__TEMPEDGE_CONFIG__ || {};
const currentDate = CFG.defaultDate || new Date().toISOString().slice(0, 10);
const refreshTimer = null;
const lastRenderState = null;
const currentPlay = null;
const manualSellEnabled = CFG.manualSellEnabled || false;

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

function shortLabel(question) {
    if (!question) return '--';
    const rangeMatch = question.match(/(\d+)-(\d+)/);
    if (rangeMatch) return rangeMatch[1] + '-' + rangeMatch[2] + '\u00b0F';
    const upperMatch = question.match(/(\d+).*or higher/i);
    if (upperMatch) return upperMatch[1] + '\u00b0F+';
    const lowerMatch = question.match(/(\d+).*or (?:lower|below)/i);
    if (lowerMatch) return '\u2264' + lowerMatch[1] + '\u00b0F';
    return question.slice(0, 15);
}

// ── Utilities ─────────────────────────────
function escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatTime(iso) {
    try {
        return new Date(iso).toLocaleTimeString('en-US', {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: true,
            timeZone: 'America/New_York',
        });
    } catch {
        return iso;
    }
}

function timeAgo(iso) {
    if (!iso) return '';
    try {
        const ms = Date.now() - new Date(iso).getTime();
        if (ms < 0) return 'just now';
        const sec = Math.floor(ms / 1000);
        if (sec < 60) return sec + 's ago';
        const min = Math.floor(sec / 60);
        if (min < 60) return min + 'm ago';
        const hrs = Math.floor(min / 60);
        return hrs + 'h ago';
    } catch {
        return '';
    }
}

function updateStatus(status, text) {
    const badge = document.getElementById('statusBadge');
    const textEl = document.getElementById('statusText');
    badge.className = 'status-badge status-' + status;
    textEl.textContent = text;
}

function statCard(id, label, value, sub, change, unit) {
    let changeHtml = '';
    if (change !== 0) {
        const cls = change > 0 ? 'change-up' : 'change-down';
        const sign = change > 0 ? '+' : '';
        changeHtml = '<div class="stat-change ' + cls + '">' + sign + change + unit + '</div>';
    }
    return (
        '<div class="stat-card" id="' +
        id +
        '">' +
        '<div class="stat-label">' +
        label +
        '</div>' +
        '<div class="stat-value" id="' +
        id +
        '-value">' +
        value +
        '</div>' +
        '<div class="stat-sub" id="' +
        id +
        '-sub">' +
        sub +
        '</div>' +
        changeHtml +
        '</div>'
    );
}

function updateStatCard(id, value, sub) {
    const valEl = document.getElementById(id + '-value');
    const subEl = document.getElementById(id + '-sub');
    if (!valEl) return;
    if (valEl.textContent !== value) {
        valEl.textContent = value;
        valEl.classList.remove('value-updated');
        void valEl.offsetWidth;
        valEl.classList.add('value-updated');
    }
    if (subEl && subEl.textContent !== sub) {
        subEl.textContent = sub;
    }
}

// ── Portfolio Card ─────────────────────────
function renderPortfolioCard(play) {
    const phaseColors = { buy: '#10b981', monitor: '#f59e0b', resolve: '#ef4444' };
    const phaseIcons = { buy: '\ud83d\uded2', monitor: '\ud83d\udc41\ufe0f', resolve: '\ud83c\udfaf' };
    const phaseLabels = { buy: 'BUY', monitor: 'MONITOR', resolve: 'RESOLVE' };
    const color = phaseColors[play.phase] || '#6b7280';
    const icon = phaseIcons[play.phase] || '';
    const label = phaseLabels[play.phase] || play.phase;
    const latest = play.latest;
    const eventClosed = latest?.eventClosed === true;

    const forecastTemp = latest ? latest.forecastTempF + '\u00b0F' : '--';
    const currentTemp = latest?.currentTempF != null ? latest.currentTempF + '\u00b0F' : '--';
    const forecastTarget = latest && !eventClosed ? shortLabel(latest.target?.question) : '--';

    const buyOrder = eventClosed ? null : play.session?.buyOrder;
    const pnl = eventClosed ? null : play.session?.pnl;
    const hasFilled = buyOrder?.positions?.some(function (p) {
        return p.status !== 'failed' && p.status !== 'rejected';
    });

    const boughtTargetQ = hasFilled
        ? buyOrder?.positions?.find(function (p) {
              return p.label === 'target';
          })?.question
        : null;
    const boughtTarget = boughtTargetQ ? shortLabel(boughtTargetQ) : null;
    const targetShifted = buyOrder && boughtTarget && boughtTarget !== forecastTarget;
    const buyCost = buyOrder ? '$' + buyOrder.totalCost.toFixed(3) : '--';
    const sellValue = pnl ? '$' + pnl.totalCurrentValue.toFixed(3) : '--';
    const totalPnL = pnl ? pnl.totalPnL : 0;
    const totalPnLPct = pnl ? pnl.totalPnLPct : 0;
    const pnlColor = totalPnL >= 0 ? 'var(--accent-green)' : 'var(--accent-red)';
    const pnlSign = totalPnL >= 0 ? '+' : '';
    const pnlDisplay = pnl ? pnlSign + '$' + totalPnL.toFixed(4) + ' (' + pnlSign + totalPnLPct + '%)' : '--';
    const buyTime = buyOrder
        ? new Date(buyOrder.placedAt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZone: 'America/New_York' })
        : '';

    let buyTooltipHtml = buyCost;
    if (buyOrder && buyOrder.positions) {
        const lines = buyOrder.positions.map(function (pos) {
            const marker = pos.label === 'target' ? '\ud83c\udfaf' : '\ud83d\udcca';
            return marker + ' ' + shortLabel(pos.question) + ' @ ' + (pos.buyPrice * 100).toFixed(1) + String.fromCharCode(162);
        });
        lines.push('Total: ' + buyCost);
        const buyTitleAttr = lines.join(String.fromCharCode(10));
        buyTooltipHtml =
            '<span style="cursor:help;border-bottom:1px dashed rgba(255,255,255,0.3)" title="' +
            escapeHtml(buyTitleAttr) +
            '">' +
            buyCost +
            '</span>';
    }

    let sellTooltipHtml = sellValue;
    if (pnl && pnl.positions) {
        const lines = pnl.positions.map(function (pos) {
            const marker = pos.label === 'target' ? '\ud83c\udfaf' : '\ud83d\udcca';
            const sign = pos.pnl >= 0 ? '+' : '';
            return (
                marker +
                ' ' +
                shortLabel(pos.question) +
                ' bid@' +
                (pos.currentPrice * 100).toFixed(1) +
                String.fromCharCode(162) +
                ' (' +
                sign +
                (pos.pnl * 100).toFixed(1) +
                String.fromCharCode(162) +
                ')'
            );
        });
        lines.push('Total: ' + sellValue);
        const cvTitle = lines.join(String.fromCharCode(10));
        sellTooltipHtml =
            '<span style="cursor:help;border-bottom:1px dashed rgba(255,255,255,0.3)" title="' +
            escapeHtml(cvTitle) +
            '">' +
            sellValue +
            '</span>';
    }

    const snaps = play.session?.snapshotCount || 0;
    const alerts = play.session?.alertCount || 0;
    const selected = play.date === currentDate ? 'border-color:' + color + ';' : '';
    const dayLabel = play.daysUntil === 0 ? 'Today' : play.daysUntil === 1 ? 'Tomorrow' : 'T+' + play.daysUntil;
    const forecastAge = latest?.timestamp ? timeAgo(latest.timestamp) : '';

    let resolutionHtml = '';
    if (play.session?.resolution) {
        const r = play.session.resolution;
        resolutionHtml =
            '<div style="margin-top:8px;padding-top:8px;border-top:1px solid rgba(255,255,255,0.1);">' +
            '<div style="color:' +
            color +
            ';font-weight:700;">KEEP: ' +
            escapeHtml(shortLabel(r.keep)) +
            '</div>' +
            '<div style="color:var(--accent-red);font-size:12px;">DISCARD: ' +
            r.discard.map((d) => escapeHtml(shortLabel(d))).join(', ') +
            '</div>' +
            '</div>';
    }

    return (
        '<div class="card portfolio-card" style="cursor:pointer;' +
        selected +
        '" onclick="switchDate(\'' +
        play.date +
        '\')">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">' +
        '<div style="display:flex;align-items:center;gap:8px;">' +
        '<span style="font-size:18px;font-weight:700;color:var(--text-primary);">' +
        play.date +
        '</span>' +
        '<span style="background:' +
        color +
        ';color:#fff;font-size:11px;font-weight:700;padding:2px 10px;border-radius:99px;">' +
        icon +
        ' ' +
        label +
        '</span>' +
        '</div>' +
        '<span style="color:var(--text-secondary);font-size:12px;">' +
        dayLabel +
        '</span>' +
        '</div>' +
        '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;">' +
        '<div><div style="color:var(--text-secondary);font-size:11px;">Current</div><div style="font-size:18px;font-weight:700;">' +
        currentTemp +
        '</div></div>' +
        '<div><div style="color:var(--text-secondary);font-size:11px;">Forecast' +
        (forecastAge ? ' <span style="opacity:0.5;font-size:10px;">' + forecastAge + '</span>' : '') +
        '</div><div style="font-size:18px;font-weight:700;">' +
        forecastTemp +
        '</div></div>' +
        (targetShifted
            ? '<div><div style="color:var(--text-secondary);font-size:11px;">Bought Target</div><div style="font-size:15px;font-weight:700;color:var(--accent-amber);">' +
              boughtTarget +
              '</div>' +
              '<div style="font-size:11px;color:var(--text-secondary);margin-top:2px;">Forecast: <span style="color:' +
              color +
              ';font-weight:600;">' +
              forecastTarget +
              '</span> \u26a0\ufe0f</div></div>'
            : '<div><div style="color:var(--text-secondary);font-size:11px;">Target</div><div style="font-size:18px;font-weight:700;color:' +
              color +
              ';">' +
              forecastTarget +
              '</div></div>') +
        '</div>' +
        '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-top:8px;">' +
        '<div><div style="color:var(--text-secondary);font-size:11px;">Bought At' +
        (buyTime ? ' (' + buyTime + ')' : '') +
        '</div><div style="font-weight:600;">' +
        buyTooltipHtml +
        '</div></div>' +
        '<div><div style="color:var(--text-secondary);font-size:11px;">Sell Value</div><div style="font-weight:600;">' +
        sellTooltipHtml +
        '</div></div>' +
        '<div><div style="color:var(--text-secondary);font-size:11px;">P&amp;L</div><div style="font-weight:700;font-size:14px;color:' +
        pnlColor +
        ';">' +
        pnlDisplay +
        '</div></div>' +
        '</div>' +
        (play.hasData
            ? '<div style="margin-top:8px;color:var(--text-secondary);font-size:12px;">' +
              snaps +
              ' snapshots \u00b7 ' +
              alerts +
              ' alerts</div>'
            : '<div style="margin-top:8px;color:var(--text-muted);font-size:12px;">Awaiting market data</div>') +
        resolutionHtml +
        '</div>'
    );
}

// ── View Model Extraction ─────────────────
function extractViewModel(data) {
    const session = data.session;
    const observation = data.observation;
    const snapshots = session?.snapshots || [];
    const alerts = session?.alerts || [];
    const latest = snapshots[snapshots.length - 1] || null;
    const status = session?.status || (observation ? 'observation' : 'none');
    const phase = latest?.phase || session?.phase || '';

    let forecastTemp = '--',
        targetRange = null,
        belowRange = null,
        aboveRange = null;
    let totalCost = 0,
        allRanges = [];
    let currentTempF = null,
        currentConditions = '',
        maxTodayF = null;
    let forecastSource = 'unknown',
        daysUntilTarget = null;
    const eventClosed = latest?.eventClosed === true;

    if (latest) {
        forecastTemp = latest.forecastTempF;
        currentTempF = latest.currentTempF;
        currentConditions = latest.currentConditions || '';
        maxTodayF = latest.maxTodayF;
        forecastSource = latest.forecastSource || session?.forecastSource || 'unknown';
        daysUntilTarget = latest.daysUntilTarget;
        if (!eventClosed) {
            targetRange = latest.target;
            belowRange = latest.below;
            aboveRange = latest.above;
            totalCost = latest.totalCost;
            allRanges = latest.allRanges || [];
        }
    } else if (observation) {
        forecastTemp = observation.forecast.highTempF;
        targetRange = observation.selection.target;
        belowRange = observation.selection.below;
        aboveRange = observation.selection.above;
        totalCost = observation.selection.totalCost;
        forecastSource = observation.forecast.source || 'unknown';
        allRanges = observation.event.ranges.map((r) => ({
            marketId: r.marketId,
            question: r.question,
            yesPrice: r.yesPrice,
            impliedProbability: r.impliedProbability,
            volume: r.volume,
        }));
    }

    const profit = (1 - totalCost).toFixed(3);
    const roi = totalCost > 0 ? (((1 - totalCost) / totalCost) * 100).toFixed(1) : '0';
    const forecastChange = latest?.forecastChange || 0;
    const sourceLabel = forecastSource === 'weather-company' ? 'WU/KLGA' : forecastSource;

    const detailBuyOrder = eventClosed ? null : session?.buyOrder;
    const detailPnL = eventClosed ? null : session?.pnl;
    let costLabel = 'Total Cost';
    let costValue = totalCost > 0 ? '$' + totalCost?.toFixed(3) : '--';
    let costSub = totalCost > 0 ? 'Profit: $' + profit + ' \u00b7 ROI: ' + roi + '%' : '';
    if (detailBuyOrder) {
        costLabel = 'Buy / Sell';
        costValue = '$' + detailBuyOrder.totalCost.toFixed(3);
        if (detailPnL) {
            const pSign = detailPnL.totalPnL >= 0 ? '+' : '';
            costSub =
                'Sell: $' +
                detailPnL.totalCurrentValue.toFixed(3) +
                ' \u00b7 P&L: ' +
                pSign +
                '$' +
                detailPnL.totalPnL.toFixed(4) +
                ' (' +
                pSign +
                detailPnL.totalPnLPct +
                '%)';
        }
    }

    return {
        session,
        observation,
        snapshots,
        alerts,
        latest,
        status,
        phase,
        forecastTemp,
        targetRange,
        belowRange,
        aboveRange,
        totalCost,
        allRanges,
        currentTempF,
        currentConditions,
        maxTodayF,
        forecastSource,
        sourceLabel,
        daysUntilTarget,
        forecastChange,
        costLabel,
        costValue,
        costSub,
        snapshotCount: snapshots.length,
        alertCount: alerts.length,
        snapshotTimestamp: latest?.timestamp || null,
        awaitingLiquidity: session?.awaitingLiquidity || false,
        liquidityWaitStart: session?.liquidityWaitStart || null,
    };
}

// ── sub-renderers are defined in dashboard-renderers.js ──
// (renderAlertsFeed, renderRangesTable, renderChart, renderLiquidity,
//  renderPipeline, renderTradeLog, retryPosition, sellPosition, etc.)
