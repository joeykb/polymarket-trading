/**
 * TempEdge Dashboard — Renderers & Main Loop
 * Loaded after dashboard.js which provides: CFG, currentDate, shortLabel,
 * escapeHtml, formatTime, timeAgo, updateStatus, statCard, updateStatCard,
 * renderPortfolioCard, extractViewModel, fetchStatus, fetchPortfolio
 */

// ── Alerts Feed ───────────────────────────
function renderAlertsFeed(alertsArr) {
    if (!alertsArr || alertsArr.length === 0) {
        return '<div class="alert-empty">No alerts yet. Monitoring will detect forecast shifts, range changes, and price spikes.</div>';
    }
    const alertIcons = { forecast_shift: '\u26a0\ufe0f', range_shift: '\ud83d\udd34', price_spike: '\ud83d\udcca', market_closed: '\u2705', phase_change: '\ud83d\udd04', buy_executed: '\ud83d\udcb0' };

    // Dedup: group consecutive identical messages
    const groups = [];
    for (let i = alertsArr.length - 1; i >= 0; i--) {
        const a = alertsArr[i];
        const last = groups[groups.length - 1];
        if (last && last.message === a.message && last.type === a.type) {
            last.count++;
            last.lastTimestamp = last.lastTimestamp || last.timestamp;
            last.firstTimestamp = a.timestamp;
        } else {
            groups.push({ ...a, count: 1, firstTimestamp: a.timestamp, lastTimestamp: null });
        }
    }

    let h = '';
    const maxShow = 50;
    for (let i = 0; i < Math.min(groups.length, maxShow); i++) {
        const g = groups[i];
        const icon = alertIcons[g.type] || '\u2753';
        const timeStr = formatAlertTime(g.timestamp);
        const countBadge = g.count > 1
            ? '<span style="background:rgba(251,191,36,0.2);color:#fbbf24;font-size:10px;font-weight:700;padding:1px 6px;border-radius:99px;margin-left:6px;">\u00d7' + g.count + '</span>'
            : '';
        const rangeStr = g.count > 1 && g.firstTimestamp
            ? '<span style="color:var(--text-muted);font-size:10px;margin-left:4px;">(since ' + formatAlertTime(g.firstTimestamp) + ')</span>'
            : '';
        h += '<div class="alert-item"><span class="alert-icon">' + icon + '</span><div class="alert-content"><div class="alert-message">' + escapeHtml(g.message) + countBadge + '</div><div class="alert-time">' + timeStr + rangeStr + '</div></div></div>';
    }
    if (groups.length > maxShow) {
        h += '<div class="alert-item" style="justify-content:center;color:var(--text-muted);font-size:12px;">+ ' + (groups.length - maxShow) + ' more alerts</div>';
    }
    return h;
}

function formatAlertTime(iso) {
    try {
        const d = new Date(iso);
        const now = new Date();
        const sameDay = d.toDateString() === now.toDateString();
        if (sameDay) {
            return 'Today ' + d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'America/New_York' });
        }
        return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/New_York' }) + ' ' +
            d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'America/New_York' });
    } catch {
        return iso;
    }
}

// ── Ranges Table ──────────────────────────
function renderRangesTable(ranges, target, below, above) {
    if (!ranges || ranges.length === 0) return '<div class="alert-empty">No range data available</div>';
    const sorted = [...ranges].sort((a, b) => {
        const aLow = a.question.match(/\d+/);
        const bLow = b.question.match(/\d+/);
        return (aLow ? parseInt(aLow[0]) : -999) - (bLow ? parseInt(bLow[0]) : -999);
    });
    let html = '<table class="ranges-table"><thead><tr><th></th><th>Range</th><th>YES Price</th><th>Implied %</th><th>Volume</th><th>Probability</th></tr></thead><tbody>';
    for (const r of sorted) {
        let rowClass = '', marker = '';
        if (target && r.marketId === target.marketId) { rowClass = 'selected-target'; marker = '🎯'; }
        else if (below && r.marketId === below.marketId) { rowClass = 'selected-below'; marker = '⬇️'; }
        else if (above && r.marketId === above.marketId) { rowClass = 'selected-above'; marker = '⬆️'; }
        const pct = r.impliedProbability || (r.yesPrice * 100);
        const barColor = pct > 50 ? 'var(--accent-green)' : pct > 20 ? 'var(--accent-amber)' : 'var(--accent-blue)';
        html += '<tr class="' + rowClass + '"><td><span class="range-marker">' + marker + '</span></td>';
        html += '<td style="color:var(--text-primary);font-weight:500;">' + escapeHtml(shortLabel(r.question)) + '</td>';
        html += '<td>' + (r.yesPrice * 100).toFixed(1) + '¢</td><td>' + pct.toFixed(1) + '%</td>';
        html += '<td>$' + (r.volume || 0).toFixed(0) + '</td>';
        html += '<td style="min-width:120px;"><div class="price-bar"><div class="price-bar-fill" style="width:' + Math.min(pct, 100) + '%;background:' + barColor + ';"></div></div></td></tr>';
    }
    html += '</tbody></table>';
    return html;
}

// ── SVG Chart ─────────────────────────────
function renderChart(snapshots) {
    if (snapshots.length < 2) return '<div class="chart-empty">Need 2+ snapshots</div>';
    const width = 800, height = 250;
    const pad = { top: 20, right: 20, bottom: 40, left: 55 };
    const plotW = width - pad.left - pad.right, plotH = height - pad.top - pad.bottom;
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
        return data.map((v, i) => v === null ? '' : '<circle cx="' + xScale(i) + '" cy="' + yScale(v) + '" r="3.5" fill="' + color + '" stroke="var(--bg-card)" stroke-width="1.5" />').join('');
    }
    let yLabels = '', xLabels = '';
    for (let i = 0; i <= 5; i++) {
        const val = minP + (rangeP / 5) * i, y = yScale(val);
        yLabels += '<text x="' + (pad.left - 8) + '" y="' + (y + 4) + '" fill="var(--text-muted)" font-size="11" text-anchor="end" font-family="JetBrains Mono">' + val.toFixed(1) + '¢</text>';
        yLabels += '<line x1="' + pad.left + '" y1="' + y + '" x2="' + (width - pad.right) + '" y2="' + y + '" stroke="var(--border)" stroke-width="0.5" />';
    }
    const xLabelCount = Math.min(6, snapshots.length);
    for (let i = 0; i < xLabelCount; i++) {
        const idx = Math.round(i * (snapshots.length - 1) / (xLabelCount - 1));
        xLabels += '<text x="' + xScale(idx) + '" y="' + (height - 8) + '" fill="var(--text-muted)" font-size="10" text-anchor="middle" font-family="JetBrains Mono">' + formatTime(snapshots[idx].timestamp) + '</text>';
    }
    const lY = pad.top - 2;
    let legend = '<rect x="' + pad.left + '" y="' + (lY - 8) + '" width="10" height="10" rx="2" fill="var(--accent-blue)" /><text x="' + (pad.left + 14) + '" y="' + lY + '" fill="var(--text-secondary)" font-size="11">Target</text>';
    legend += '<rect x="' + (pad.left + 70) + '" y="' + (lY - 8) + '" width="10" height="10" rx="2" fill="var(--accent-orange)" /><text x="' + (pad.left + 84) + '" y="' + lY + '" fill="var(--text-secondary)" font-size="11">Below</text>';
    legend += '<rect x="' + (pad.left + 134) + '" y="' + (lY - 8) + '" width="10" height="10" rx="2" fill="var(--accent-green)" /><text x="' + (pad.left + 148) + '" y="' + lY + '" fill="var(--text-secondary)" font-size="11">Above</text>';
    return '<svg viewBox="0 0 ' + width + ' ' + height + '" class="chart-canvas" preserveAspectRatio="xMidYMid meet">' + yLabels + xLabels + legend +
        polyline(targetPrices, 'var(--accent-blue)') + polyline(belowPrices, 'var(--accent-orange)', '8 4') + polyline(abovePrices, 'var(--accent-green)', '3 3') +
        dots(targetPrices, 'var(--accent-blue)') + dots(belowPrices, 'var(--accent-orange)') + dots(abovePrices, 'var(--accent-green)') + '</svg>';
}

// ── Liquidity, Pipeline, TradeLog, Retry/Sell ─────────
let liquidityTimer = null, pipelineTimer = null, tradeLogTimer = null;

async function fetchLiquidity() {
    if (liquidityTimer) clearTimeout(liquidityTimer);
    try { const res = await fetch('/api/liquidity?date=' + encodeURIComponent(currentDate)); renderLiquidity(await res.json()); } catch {}
    liquidityTimer = setTimeout(fetchLiquidity, CFG.liquidityPollMs || 5000);
}

async function fetchPipeline() {
    if (pipelineTimer) clearTimeout(pipelineTimer);
    try { const res = await fetch('/api/pipeline'); renderPipeline(await res.json()); } catch {}
    pipelineTimer = setTimeout(fetchPipeline, 30000);
}

async function fetchTradeLog() {
    if (tradeLogTimer) clearTimeout(tradeLogTimer);
    try { const res = await fetch('/api/trades'); renderTradeLog(await res.json()); } catch {}
    tradeLogTimer = setTimeout(fetchTradeLog, 30000);
}

async function retryPosition(positionId, btnEl) {
    if (!positionId) return;
    if (!confirm('Retry this failed order? This will place a real trade.')) return;
    var origHtml = btnEl.innerHTML;
    btnEl.disabled = true; btnEl.innerHTML = '\u23f3 Placing...';
    btnEl.style.background = 'rgba(251,191,36,0.2)'; btnEl.style.color = '#fbbf24'; btnEl.style.borderColor = 'rgba(251,191,36,0.3)';
    try {
        var res = await fetch('/api/retry-position', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ positionId: positionId }) });
        var result = await res.json();
        if (result.success) {
            btnEl.innerHTML = '\u2705 ' + result.shares + ' shares filled';
            btnEl.style.background = 'rgba(16,185,129,0.2)'; btnEl.style.color = '#34d399'; btnEl.style.borderColor = 'rgba(16,185,129,0.3)';
            setTimeout(fetchTradeLog, 2000);
        } else {
            btnEl.innerHTML = '\u274c ' + (result.error || 'Failed').substring(0, 30);
            btnEl.style.background = 'rgba(239,68,68,0.15)'; btnEl.style.color = '#f87171'; btnEl.style.borderColor = 'rgba(239,68,68,0.3)';
            setTimeout(function() { btnEl.disabled = false; btnEl.innerHTML = origHtml; btnEl.style.background = 'rgba(59,130,246,0.2)'; btnEl.style.color = '#60a5fa'; btnEl.style.borderColor = 'rgba(59,130,246,0.3)'; }, 5000);
        }
    } catch (err) {
        btnEl.innerHTML = '\u274c Network error'; btnEl.style.background = 'rgba(239,68,68,0.15)'; btnEl.style.color = '#f87171';
        setTimeout(function() { btnEl.disabled = false; btnEl.innerHTML = origHtml; btnEl.style.background = 'rgba(59,130,246,0.2)'; btnEl.style.color = '#60a5fa'; }, 5000);
    }
}

async function sellPosition(posDataStr, btnEl) {
    var posData;
    if (typeof posDataStr === 'number') {
        posData = { positionId: posDataStr };
    } else if (typeof posDataStr === 'string') {
        try { posData = JSON.parse(posDataStr); } catch { posData = { positionId: parseInt(posDataStr) || posDataStr }; }
    } else if (typeof posDataStr === 'object' && posDataStr !== null) {
        posData = posDataStr;
    } else {
        posData = {};
    }
    if (!posData || (!posData.positionId && !posData.question)) return;

    var totalShares = posData.shares || 1;
    var rangeMatch = posData.question ? posData.question.match(/between[ ]+([0-9]+-[0-9]+)[^\x00]*?F/i) : null;
    var displayName = rangeMatch ? rangeMatch[1] + '°F' : (posData.label || 'position');

    var sharesToSell = prompt(
        'Sell ' + displayName + ' at market price.\n\n' +
        'You own ' + totalShares + ' share(s).\n' +
        'How many shares to sell? (Enter amount or "all")',
        String(totalShares)
    );
    if (sharesToSell === null) return; // Cancelled
    sharesToSell = sharesToSell.trim().toLowerCase();
    if (sharesToSell === 'all' || sharesToSell === '') sharesToSell = totalShares;
    else sharesToSell = parseFloat(sharesToSell);
    if (isNaN(sharesToSell) || sharesToSell <= 0) { alert('Invalid share count'); return; }
    if (sharesToSell > totalShares) { alert('Cannot sell more than ' + totalShares + ' shares'); return; }

    if (!confirm('Confirm: Sell ' + sharesToSell + ' share(s) of ' + displayName + ' at market price?\n\nThis cannot be undone.')) return;

    btnEl.disabled = true; btnEl.textContent = "Selling " + sharesToSell + "...";
    try {
        const payload = {
            positionId: posData.positionId || null,
            question: posData.question || null,
            label: posData.label || null,
            targetDate: posData.targetDate || currentDate,
            target_date: posData.targetDate || currentDate,
            shares: sharesToSell,
        };
        const res = await fetch("/api/sell-position", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
        const data = await res.json();
        if (data.success) {
            btnEl.textContent = "Sold " + sharesToSell + " @ $" + (data.sellPrice ? data.sellPrice.toFixed(2) : "?");
            btnEl.style.background = "rgba(16,185,129,0.2)"; btnEl.style.color = "#34d399"; btnEl.style.borderColor = "rgba(16,185,129,0.3)";
            // Refresh trade log and full dashboard
            setTimeout(function() { fetchTradeLog(); }, 1000);
            setTimeout(function() { refresh(); }, 2000);
        } else { alert("Sell failed: " + (data.error || "Unknown error")); btnEl.textContent = "SELL"; btnEl.disabled = false; }
    } catch (err) { alert("Sell error: " + err.message); btnEl.textContent = "SELL"; btnEl.disabled = false; }
}

// renderLiquidity, renderPipeline, renderTradeLog are large — loaded from dashboard-panels.js

// ── Event delegation for sell/retry buttons ─────────
document.addEventListener('click', function(e) {
    var btn = e.target.closest('.sell-btn');
    if (!btn) return;
    var raw = btn.getAttribute('data-sell');
    if (!raw) return;
    e.preventDefault();
    e.stopPropagation();
    sellPosition(raw, btn);
});
