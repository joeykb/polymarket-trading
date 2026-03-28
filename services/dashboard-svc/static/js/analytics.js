/**
 * TempEdge — Historical Performance Analytics
 *
 * Fetches trade performance data from data-svc via dashboard-svc proxy,
 * renders KPI cards, cumulative P&L SVG chart, and expandable trade table
 * with inline forecast sparklines.
 */

(function () {
    'use strict';

    // ── State ─────────────────────────────────────────────────────────────
    let _data = null;       // { trades: [], summary: {} }
    let _period = null;      // Default: all trades

    // ── DOM refs ──────────────────────────────────────────────────────────
    const $ = (sel) => document.querySelector(sel);
    const $$ = (sel) => document.querySelectorAll(sel);

    // ── Init ──────────────────────────────────────────────────────────────
    document.addEventListener('DOMContentLoaded', () => {
        setupPeriodPills();
        setupDateRange();
        fetchAndRender();
    });

    // ── Period pill buttons ───────────────────────────────────────────────
    function setupPeriodPills() {
        $$('.period-pill').forEach(btn => {
            btn.addEventListener('click', () => {
                $$('.period-pill').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');

                const period = btn.dataset.period;
                if (period === 'all') {
                    _period = null;
                    $('#dateFrom').value = '';
                    $('#dateTo').value = '';
                } else {
                    _period = parseInt(period);
                    // Update date inputs to reflect
                    const to = new Date();
                    const from = new Date();
                    from.setDate(from.getDate() - _period);
                    $('#dateFrom').value = fmtDateISO(from);
                    $('#dateTo').value = fmtDateISO(to);
                }
                fetchAndRender();
            });
        });
    }

    function setupDateRange() {
        // Default: show all trades (no date filter)
        $('#dateFrom').value = '';
        $('#dateTo').value = '';
        // Activate the 'All' pill by default
        $$('.period-pill').forEach(b => b.classList.remove('active'));
        document.querySelector('.period-pill[data-period="all"]').classList.add('active');

        $('#applyFilter').addEventListener('click', () => {
            // Deactivate period pills
            $$('.period-pill').forEach(b => b.classList.remove('active'));
            _period = null;
            fetchAndRender();
        });
    }

    // ── Fetch ─────────────────────────────────────────────────────────────
    async function fetchAndRender() {
        const from = $('#dateFrom').value || '';
        const to = $('#dateTo').value || '';
        const qs = [from && `from=${from}`, to && `to=${to}`].filter(Boolean).join('&');
        const url = `/api/analytics/performance${qs ? '?' + qs : ''}`;

        try {
            const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
            _data = await res.json();
        } catch (err) {
            console.error('Analytics fetch error:', err);
            _data = { trades: [], summary: {} };
        }

        renderKPIs(_data.summary);
        renderCumulativeChart(_data.trades);
        renderTradeTable(_data.trades);
        $('#lastUpdated').innerHTML = `<span class="dot"></span>${new Date().toLocaleTimeString()}`;
    }

    // ── KPI Cards ─────────────────────────────────────────────────────────
    function renderKPIs(s) {
        if (!s || !s.totalTrades) {
            $('#kpiNetPnL').textContent = '—';
            $('#kpiWinRate').textContent = '—';
            $('#kpiTotalTrades').textContent = '0';
            $('#kpiAvgPnL').textContent = '—';
            return;
        }

        // Net P&L
        const pnl = s.netPnL || 0;
        const pnlEl = $('#kpiNetPnL');
        pnlEl.textContent = formatUSD(pnl);
        pnlEl.className = 'stat-value ' + (pnl > 0 ? 'positive' : pnl < 0 ? 'negative' : 'neutral');
        $('#kpiNetPnLSub').textContent = `$${s.totalCost.toFixed(2)} invested → $${s.totalProceeds.toFixed(2)} returned`;

        // Win Rate
        const wr = s.winRate != null ? (s.winRate * 100).toFixed(0) + '%' : '—';
        const wrEl = $('#kpiWinRate');
        wrEl.textContent = wr;
        wrEl.className = 'stat-value ' + (s.winRate > 0.5 ? 'positive' : s.winRate != null ? 'negative' : 'neutral');
        $('#kpiWinRateSub').textContent = `${s.wins}W / ${s.losses}L` + (s.settledTrades < s.totalTrades ? ` (${s.totalTrades - s.settledTrades} pending)` : '');

        // Total Trades
        $('#kpiTotalTrades').textContent = s.totalTrades;
        $('#kpiTotalTradesSub').textContent = `${s.settledTrades} settled`;

        // Avg P&L
        const avg = s.avgPnLPerTrade || 0;
        const avgEl = $('#kpiAvgPnL');
        avgEl.textContent = formatUSD(avg);
        avgEl.className = 'stat-value ' + (avg > 0 ? 'positive' : avg < 0 ? 'negative' : 'neutral');

        const bestStr = s.bestTrade ? `Best: ${formatUSD(s.bestTrade.pnl)} (${fmtDate(s.bestTrade.date)})` : '';
        const worstStr = s.worstTrade ? `Worst: ${formatUSD(s.worstTrade.pnl)} (${fmtDate(s.worstTrade.date)})` : '';
        $('#kpiAvgPnLSub').textContent = [bestStr, worstStr].filter(Boolean).join(' · ');
    }

    // ── Cumulative P&L Chart (SVG) ────────────────────────────────────────
    function renderCumulativeChart(trades) {
        const svg = $('#chartSvg');
        if (!trades || trades.length === 0) {
            svg.innerHTML = '<text x="50%" y="50%" text-anchor="middle" fill="#5a6a80" font-size="14" font-family="Inter">No trade data to chart</text>';
            return;
        }

        // Sort by date ascending
        const sorted = [...trades].sort((a, b) => a.targetDate.localeCompare(b.targetDate));

        // Build cumulative P&L series
        let cumulative = 0;
        const points = [];
        for (const t of sorted) {
            if (t.realizedPnL != null) {
                cumulative += t.realizedPnL;
            }
            points.push({
                date: t.targetDate,
                pnl: t.realizedPnL,
                cumPnL: parseFloat(cumulative.toFixed(4)),
                outcome: t.outcome,
            });
        }

        // Dimensions
        const rect = svg.parentElement.getBoundingClientRect();
        const W = rect.width || 800;
        const H = 240;
        const pad = { top: 20, right: 20, bottom: 35, left: 55 };
        const plotW = W - pad.left - pad.right;
        const plotH = H - pad.top - pad.bottom;

        svg.setAttribute('viewBox', `0 0 ${W} ${H}`);

        const values = points.map(p => p.cumPnL);
        const minVal = Math.min(0, ...values);
        const maxVal = Math.max(0, ...values);
        const range = maxVal - minVal || 1;
        const buffer = range * 0.1;

        const yMin = minVal - buffer;
        const yMax = maxVal + buffer;

        const x = (i) => pad.left + (i / (points.length - 1 || 1)) * plotW;
        const y = (v) => pad.top + (1 - (v - yMin) / (yMax - yMin)) * plotH;

        const zeroY = y(0);
        let html = '';

        // Grid lines (5 lines)
        const gridSteps = 5;
        for (let i = 0; i <= gridSteps; i++) {
            const val = yMin + (i / gridSteps) * (yMax - yMin);
            const gy = y(val);
            html += `<line x1="${pad.left}" y1="${gy}" x2="${W - pad.right}" y2="${gy}" class="chart-grid-line"/>`;
            html += `<text x="${pad.left - 8}" y="${gy + 3}" text-anchor="end" class="chart-value-label">${formatUSD(val)}</text>`;
        }

        // Zero line
        html += `<line x1="${pad.left}" y1="${zeroY}" x2="${W - pad.right}" y2="${zeroY}" class="chart-zero-line"/>`;

        // Build path
        if (points.length > 1) {
            const linePts = points.map((p, i) => `${x(i).toFixed(1)},${y(p.cumPnL).toFixed(1)}`);

            // Area fill — split positive/negative
            const areaTop = `M${x(0).toFixed(1)},${zeroY.toFixed(1)} L${linePts.join(' L')} L${x(points.length - 1).toFixed(1)},${zeroY.toFixed(1)} Z`;

            // Use clip paths for pos/neg coloring
            const lastCum = points[points.length - 1].cumPnL;
            const areaClass = lastCum >= 0 ? 'chart-area-positive' : 'chart-area-negative';
            html += `<path d="${areaTop}" class="${areaClass}"/>`;

            // Line
            const lineClass = lastCum >= 0 ? 'chart-line-positive' : 'chart-line-negative';
            html += `<polyline points="${linePts.join(' ')}" class="chart-line ${lineClass}"/>`;
        }

        // Dots + x-axis labels
        const labelInterval = Math.max(1, Math.floor(points.length / 10));
        points.forEach((p, i) => {
            const cx = x(i);
            const cy = y(p.cumPnL);
            const dotClass = p.outcome === 'profit' ? 'chart-dot-positive'
                           : p.outcome === 'loss' ? 'chart-dot-negative'
                           : 'chart-dot-pending';
            html += `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" class="chart-dot ${dotClass}" data-idx="${i}"/>`;

            // X labels (sampled)
            if (i % labelInterval === 0 || i === points.length - 1) {
                html += `<text x="${cx.toFixed(1)}" y="${H - 5}" text-anchor="middle" class="chart-label">${fmtDate(p.date)}</text>`;
            }
        });

        svg.innerHTML = html;

        // Chart range label
        const from = points[0].date;
        const to = points[points.length - 1].date;
        $('#chartRange').textContent = `${fmtDate(from)} → ${fmtDate(to)}`;
    }

    // ── Trade Table ───────────────────────────────────────────────────────
    function renderTradeTable(trades) {
        const tbody = $('#tradesBody');
        if (!trades || trades.length === 0) {
            tbody.innerHTML = '<tr><td colspan="10" class="empty-state">No trades found for this period</td></tr>';
            $('#tradeCount').textContent = '';
            return;
        }

        $('#tradeCount').textContent = `${trades.length} trade${trades.length !== 1 ? 's' : ''}`;

        const rows = trades.map(t => {
            // Extract range from first position or initialTargetRange
            const range = t.initialTargetRange || t.positions?.[0]?.question?.match(/(\d+-\d+)/)?.[0] || '—';

            // Average buy price across positions
            const avgBuyPrice = t.positions.length > 0
                ? t.positions.reduce((s, p) => s + (p.buyPrice || 0), 0) / t.positions.length
                : 0;

            // Forecast delta
            const fDelta = t.forecastAtBuy != null && t.finalForecast != null
                ? t.finalForecast - t.forecastAtBuy
                : null;
            const fDeltaClass = fDelta != null ? (fDelta > 0.5 ? 'up' : fDelta < -0.5 ? 'down' : 'flat') : '';
            const fDeltaStr = fDelta != null ? (fDelta > 0 ? `+${fDelta.toFixed(1)}` : fDelta.toFixed(1)) : '';

            // Sparkline SVG
            const sparkline = renderSparkline(t.forecastTrend);

            // P&L display
            const pnlClass = t.outcome === 'profit' ? 'positive' : t.outcome === 'loss' ? 'negative' : 'pending';
            const pnlStr = t.realizedPnL != null ? formatUSD(t.realizedPnL) : '—';
            const pnlPctStr = t.realizedPnLPct != null ? `${t.realizedPnLPct > 0 ? '+' : ''}${t.realizedPnLPct}%` : '';

            // Proceeds
            const proceeds = t.realizedPnL != null ? formatUSD(t.totalCost + t.realizedPnL) : '—';

            // Outcome badge
            const outcomeHtml = {
                profit: '<span class="outcome-badge outcome-profit">✓ WIN</span>',
                loss: '<span class="outcome-badge outcome-loss">✗ LOSS</span>',
                pending: '<span class="outcome-badge outcome-pending">⏳ OPEN</span>',
                breakeven: '<span class="outcome-badge outcome-breakeven">— EVEN</span>',
            }[t.outcome] || '';

            return `
                <tr>
                    <td class="trade-date mono">${fmtDate(t.targetDate)}</td>
                    <td><span class="range-badge">${escHtml(range)}</span></td>
                    <td class="mono">${avgBuyPrice ? '$' + avgBuyPrice.toFixed(2) : '—'}</td>
                    <td class="forecast-val">${t.forecastAtBuy != null ? t.forecastAtBuy.toFixed(1) + '°F' : '—'}</td>
                    <td class="forecast-val">
                        ${t.finalForecast != null ? t.finalForecast.toFixed(1) + '°F' : '—'}
                        ${fDeltaStr ? `<span class="forecast-delta ${fDeltaClass}">${fDeltaStr}</span>` : ''}
                    </td>
                    <td>${sparkline}</td>
                    <td class="mono">$${t.totalCost.toFixed(2)}</td>
                    <td class="mono">${proceeds}</td>
                    <td><span class="pnl-value ${pnlClass}">${pnlStr}</span><span class="pnl-pct ${pnlClass}">${pnlPctStr}</span></td>
                    <td>${outcomeHtml}</td>
                </tr>
            `;
        });

        tbody.innerHTML = rows.join('');
    }

    // ── Sparkline Renderer ────────────────────────────────────────────────
    function renderSparkline(trend) {
        if (!trend || trend.length < 2) {
            return '<span class="mono" style="color:var(--text-muted)">—</span>';
        }

        const W = 80;
        const H = 24;
        const pad = 2;

        const temps = trend.map(t => t.temp).filter(v => v != null);
        if (temps.length < 2) return '<span class="mono" style="color:var(--text-muted)">—</span>';

        const min = Math.min(...temps);
        const max = Math.max(...temps);
        const range = max - min || 1;

        const pts = temps.map((v, i) => {
            const x = pad + (i / (temps.length - 1)) * (W - 2 * pad);
            const y = pad + (1 - (v - min) / range) * (H - 2 * pad);
            return `${x.toFixed(1)},${y.toFixed(1)}`;
        });

        // Determine color from overall trend
        const first = temps[0];
        const last = temps[temps.length - 1];
        const color = Math.abs(last - first) < 0.5 ? 'var(--accent-cyan)'
                    : last > first ? 'var(--accent-red)'
                    : 'var(--accent-blue)';

        // Area
        const areaPts = `${pad},${H - pad} ${pts.join(' ')} ${W - pad},${H - pad}`;

        return `
            <span class="sparkline-container">
                <svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
                    <polygon points="${areaPts}" fill="${color}" class="sparkline-area"/>
                    <polyline points="${pts.join(' ')}" stroke="${color}" class="sparkline-line"/>
                </svg>
            </span>
        `;
    }

    // ── Helpers ────────────────────────────────────────────────────────────
    function formatUSD(v) {
        if (v == null) return '—';
        const sign = v >= 0 ? '+' : '';
        return `${sign}$${Math.abs(v).toFixed(2)}`;
    }

    function fmtDate(dateStr) {
        if (!dateStr) return '—';
        const parts = dateStr.split('-');
        return `${parts[1]}/${parts[2]}`;
    }

    function fmtDateISO(d) {
        // Use local date, NOT UTC — avoids off-by-one from timezone offset
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${y}-${m}-${day}`;
    }

    function escHtml(s) {
        const div = document.createElement('div');
        div.textContent = s;
        return div.innerHTML;
    }
})();
