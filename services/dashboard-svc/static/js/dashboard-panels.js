/**
 * TempEdge Dashboard — Panel Renderers & Main Loop
 * Loaded after dashboard.js and dashboard-renderers.js
 */

function renderLiquidity(data) {
    const card = document.getElementById('liquidityCard');
    const body = document.getElementById('liquidityBody');
    const statusEl = document.getElementById('liquidityStatus');
    if (!card) return;
    if (!data || !data.tokens || data.tokens.length === 0) {
        if (data && data.status === 'disabled') card.style.display = 'none';
        return;
    }
    card.style.display = 'block';
    const statusColors = { connected: 'var(--accent-green)', connecting: 'var(--accent-amber)', disconnected: 'var(--accent-red)' };
    statusEl.innerHTML =
        '<span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:' +
        (statusColors[data.status] || 'var(--text-muted)') +
        ';margin-right:5px;"></span>' +
        data.status;

    let html = '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:0;">';
    const hasBuyOrder = currentPlay?.session?.buyOrder;
    const hasFilled = hasBuyOrder?.positions?.some(function (p) {
        return p.status !== 'failed' && p.status !== 'rejected';
    });
    const boughtTargetQ = hasFilled
        ? hasBuyOrder?.positions?.find(function (p) {
              return p.label === 'target';
          })?.question
        : null;
    const labelColors = { target: 'var(--accent-blue)', below: 'var(--accent-orange)', above: 'var(--accent-green)' };
    const labelIcons = { target: '🎯', below: '⬇️', above: '⬆️' };

    const ownedQuestions = new Set();
    if (hasBuyOrder && hasBuyOrder.positions)
        hasBuyOrder.positions.forEach(function (p) {
            if (p.question && p.status !== 'failed' && p.status !== 'rejected') ownedQuestions.add(p.question);
        });
    const strategyQuestions = new Set();
    const relevantTokens = [];
    for (var ti = 0; ti < data.tokens.length; ti++) {
        var t = data.tokens[ti];
        if (t.label === 'target' || t.label === 'below' || t.label === 'above') {
            relevantTokens.push(t);
            strategyQuestions.add(t.question);
        }
    }
    for (var ti = 0; ti < data.tokens.length; ti++) {
        var t = data.tokens[ti];
        if (!strategyQuestions.has(t.question) && ownedQuestions.has(t.question)) relevantTokens.push(t);
    }

    // Derive unit from current market
    var liqMktMeta = _portfolioData?.markets?.find(function(m) { return m.id === currentMarket; });
    var liqUnit = (currentMarket !== 'all' && liqMktMeta) ? liqMktMeta.unit : 'F';

    for (const token of relevantTokens) {
        let displayLabel, displayIcon, displayColor;
        if (hasFilled) {
            const isBoughtTarget = token.question === boughtTargetQ;
            displayLabel = shortLabel(token.question);
            displayIcon = isBoughtTarget ? '🎯' : '📊';
            displayColor = isBoughtTarget ? 'var(--accent-amber)' : 'var(--text-primary)';
        } else {
            const lbl = token.label;
            displayLabel =
                lbl.toUpperCase() + ' <span style="color:var(--text-secondary);font-weight:400;">' + shortLabel(token.question) + '</span>';
            displayIcon = labelIcons[lbl] || '📊';
            displayColor = labelColors[lbl] || 'var(--text-primary)';
        }
        const liquidBg = token.isLiquid ? 'rgba(16,185,129,0.08)' : 'rgba(239,68,68,0.05)';
        const liquidBorder = token.isLiquid ? 'var(--accent-green)' : 'var(--border)';
        const spreadColor = (token.spreadPct || 0) <= (data.thresholds?.maxSpreadPct || 0.2) ? 'var(--accent-green)' : 'var(--accent-red)';
        const depthColor = (token.askDepth || 0) >= (data.thresholds?.minAskDepth || 5) ? 'var(--accent-green)' : 'var(--accent-red)';
        const scorePct = Math.round((token.score || 0) * 100);
        const scoreColor = scorePct >= 60 ? 'var(--accent-green)' : scorePct >= 30 ? 'var(--accent-amber)' : 'var(--accent-red)';

        html +=
            '<div style="padding:16px 20px;border-bottom:1px solid var(--border);border-left:3px solid ' +
            liquidBorder +
            ';background:' +
            liquidBg +
            ';">';
        html +=
            '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;"><div style="font-weight:600;font-size:13px;color:' +
            displayColor +
            ';">' +
            displayIcon +
            ' ' +
            displayLabel +
            '</div>';
        html +=
            '<span style="font-size:10px;font-weight:700;padding:2px 8px;border-radius:4px;background:' +
            (token.isLiquid ? 'rgba(16,185,129,0.15)' : 'rgba(239,68,68,0.12)') +
            ';color:' +
            (token.isLiquid ? 'var(--accent-green)' : 'var(--accent-red)') +
            ';">' +
            (token.isLiquid ? '🟢 LIQUID' : '🔴 ILLIQUID') +
            '</span></div>';
        html += '<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:8px;">';
        html +=
            '<div style="text-align:center;"><div style="font-size:11px;color:var(--text-muted);margin-bottom:2px;">Bid</div><div style="font-family:JetBrains Mono,monospace;font-size:14px;font-weight:600;color:var(--accent-green);">' +
            (token.bestBid > 0 ? (token.bestBid * 100).toFixed(1) + '¢' : '--') +
            '</div></div>';
        html +=
            '<div style="text-align:center;"><div style="font-size:11px;color:var(--text-muted);margin-bottom:2px;">Ask</div><div style="font-family:JetBrains Mono,monospace;font-size:14px;font-weight:600;color:var(--accent-red);">' +
            (token.bestAsk > 0 ? (token.bestAsk * 100).toFixed(1) + '¢' : '--') +
            '</div></div>';
        html +=
            '<div style="text-align:center;"><div style="font-size:11px;color:var(--text-muted);margin-bottom:2px;">Spread</div><div style="font-family:JetBrains Mono,monospace;font-size:14px;font-weight:600;color:' +
            spreadColor +
            ';">' +
            ((token.spreadPct || 0) * 100).toFixed(1) +
            '%</div></div>';
        html +=
            '<div style="text-align:center;"><div style="font-size:11px;color:var(--text-muted);margin-bottom:2px;">Depth</div><div style="font-family:JetBrains Mono,monospace;font-size:14px;font-weight:600;color:' +
            depthColor +
            ';">' +
            (token.askDepth != null ? token.askDepth.toFixed(1) : '--') +
            '</div></div></div>';
        html +=
            '<div style="display:flex;align-items:center;gap:8px;"><div style="font-size:11px;color:var(--text-muted);width:40px;">Score</div><div style="flex:1;height:6px;background:rgba(42,53,80,0.5);border-radius:3px;overflow:hidden;"><div style="width:' +
            scorePct +
            '%;height:100%;background:' +
            scoreColor +
            ';border-radius:3px;transition:width 0.5s;"></div></div><div style="font-family:JetBrains Mono,monospace;font-size:12px;font-weight:600;color:' +
            scoreColor +
            ';width:35px;text-align:right;">' +
            scorePct +
            '%</div></div>';

        if (manualSellEnabled && hasFilled) {
            const ownedPos =
                hasBuyOrder && hasBuyOrder.positions
                    ? hasBuyOrder.positions.find(function (p) {
                          return p.question === token.question && !p.soldAt && p.status !== 'failed';
                      })
                    : null;
            if (ownedPos) {
                const sellData = escapeHtml(
                    JSON.stringify({
                        positionId: ownedPos.positionId,
                        question: ownedPos.question,
                        label: ownedPos.label,
                        targetDate: currentDate,
                        shares: ownedPos.shares,
                    }),
                );
                html +=
                    '<div style="margin-top:10px;padding-top:8px;border-top:1px solid rgba(255,255,255,0.06);display:flex;justify-content:space-between;align-items:center;">';
                html +=
                    '<span style="font-size:11px;color:var(--text-muted);">' +
                    (ownedPos.shares || '?') +
                    ' shares @ $' +
                    (ownedPos.buyPrice ? ownedPos.buyPrice.toFixed(2) : '?.??') +
                    '</span>';
                html +=
                    '<button class="sell-btn" data-sell="' +
                    sellData +
                    '" title="Sell this position at market bid price">SELL</button></div>';
            }
        }
        html += '</div>';
    }
    html += '</div>';
    body.innerHTML = html;
}

function renderPipeline(data) {
    const card = document.getElementById('pipelineCard'),
        body = document.getElementById('pipelineBody'),
        countEl = document.getElementById('pipelineCount');
    if (!card || !body) return;
    if (!data || !data.pipeline || data.pipeline.length === 0) {
        card.style.display = 'none';
        return;
    }
    card.style.display = 'block';
    if (countEl) countEl.textContent = data.pipeline.length + ' scouting';
    let html =
        '<table style="width:100%;border-collapse:collapse;font-size:13px;"><thead><tr style="border-bottom:1px solid var(--border);"><th style="padding:10px 14px;text-align:left;color:var(--text-secondary);font-weight:600;">Date</th><th style="padding:10px 8px;text-align:center;color:var(--text-secondary);font-weight:600;">Phase</th><th style="padding:10px 8px;text-align:left;color:var(--text-secondary);font-weight:600;">Current Forecast</th><th style="padding:10px 8px;text-align:left;color:var(--text-secondary);font-weight:600;">Forecast History</th><th style="padding:10px 14px;text-align:center;color:var(--text-secondary);font-weight:600;">Trend</th></tr></thead><tbody>';
    for (let i = 0; i < data.pipeline.length; i++) {
        const p = data.pipeline[i];
        const phaseBadge =
            p.phase === 'scout'
                ? '<span style="background:rgba(6,182,212,0.15);color:#22d3ee;padding:3px 10px;border-radius:6px;font-size:11px;font-weight:700;">\ud83d\udd2d Scout</span>'
                : '<span style="background:rgba(168,85,247,0.15);color:#c084fc;padding:3px 10px;border-radius:6px;font-size:11px;font-weight:700;">\ud83d\udcc8 Track</span>';
        const forecastStr = p.latestForecast ? p.latestForecast + '\u00b0F' : '--';
        const rangeStr = p.targetRange ? ' (' + p.targetRange + '\u00b0F)' : '';
        const historyParts = [];
        if (p.forecastHistory && p.forecastHistory.length > 0) {
            const sorted = p.forecastHistory.slice().sort(function (a, b) {
                return b.daysOut - a.daysOut;
            });
            for (let j = 0; j < sorted.length; j++) {
                const h = sorted[j];
                let label = 'T+' + h.daysOut + ': ' + h.forecast + '\u00b0F';
                if (j > 0) {
                    const delta = h.forecast - sorted[j - 1].forecast;
                    const sign = delta > 0 ? '+' : '';
                    const col = delta > 0 ? 'var(--accent-red)' : delta < 0 ? 'var(--accent-cyan)' : 'var(--text-muted)';
                    label += ' <span style="color:' + col + ';font-size:11px;">(' + sign + delta + ')</span>';
                }
                historyParts.push(label);
            }
        }
        const historyStr =
            historyParts.length > 0
                ? historyParts.join(' \u2192 ')
                : '<span style="color:var(--text-muted);">Awaiting first observation</span>';
        let trendBadge = '<span style="color:var(--text-muted);font-size:12px;">--</span>';
        if (p.trend && p.trend.direction !== 'neutral' && p.forecastHistory && p.forecastHistory.length >= 2) {
            const arrow = p.trend.direction === 'warming' ? '\u2197\ufe0f' : '\u2198\ufe0f';
            const tColor = p.trend.direction === 'warming' ? 'var(--accent-red)' : 'var(--accent-cyan)';
            const tSign = p.trend.magnitude > 0 ? '+' : '';
            trendBadge =
                '<span style="color:' +
                tColor +
                ';font-weight:700;font-size:13px;">' +
                arrow +
                ' ' +
                tSign +
                p.trend.magnitude +
                '\u00b0F</span>';
        } else if (p.forecastHistory && p.forecastHistory.length >= 2) {
            trendBadge = '<span style="color:var(--text-muted);font-size:12px;">\u2194\ufe0f Neutral</span>';
        }
        html +=
            '<tr style="border-bottom:1px solid var(--border);"><td style="padding:10px 14px;font-weight:600;white-space:nowrap;">' +
            p.date +
            '</td><td style="padding:10px 8px;text-align:center;">' +
            phaseBadge +
            '</td><td style="padding:10px 8px;font-family:JetBrains Mono,monospace;font-weight:600;">' +
            forecastStr +
            rangeStr +
            '</td><td style="padding:10px 8px;font-size:12px;line-height:1.6;">' +
            historyStr +
            '</td><td style="padding:10px 14px;text-align:center;">' +
            trendBadge +
            '</td></tr>';
    }
    html += '</tbody></table>';
    body.innerHTML = html;
}

function renderTradeLog(data) {
    const body = document.getElementById('tradeLogBody'),
        countEl = document.getElementById('tradeLogCount');
    if (!body) return;
    if (!data || !data.trades || data.trades.length === 0) {
        body.innerHTML = '<div style="padding:24px;text-align:center;color:var(--text-muted);font-size:13px;">No trades yet</div>';
        if (countEl) countEl.textContent = '0 trades';
        return;
    }
    const realCount = data.trades.filter(function (t) {
        return (
            t.mode === 'live' &&
            t.positions.some(function (p) {
                return p.status === 'placed';
            })
        );
    }).length;
    const simCount = data.trades.filter(function (t) {
        return t.mode === 'dry-run';
    }).length;
    const failCount = data.trades.filter(function (t) {
        return (
            t.mode === 'live' &&
            t.positions.every(function (p) {
                return p.status === 'failed';
            })
        );
    }).length;
    if (countEl) countEl.textContent = realCount + ' live, ' + simCount + ' sim, ' + failCount + ' failed';

    let html =
        '<table style="width:100%;border-collapse:collapse;font-size:13px;"><thead><tr style="border-bottom:1px solid var(--border);"><th style="padding:10px 14px;text-align:left;color:var(--text-secondary);font-weight:600;">Date</th><th style="padding:10px 8px;text-align:center;color:var(--text-secondary);font-weight:600;">Execution</th><th style="padding:10px 8px;text-align:left;color:var(--text-secondary);font-weight:600;">Time</th><th style="padding:10px 8px;text-align:left;color:var(--text-secondary);font-weight:600;">Positions</th><th style="padding:10px 8px;text-align:right;color:var(--text-secondary);font-weight:600;">Cost</th><th style="padding:10px 8px;text-align:right;color:var(--text-secondary);font-weight:600;">P&L</th><th style="padding:10px 14px;text-align:center;color:var(--text-secondary);font-weight:600;">Session</th></tr></thead><tbody>';

    for (const t of data.trades) {
        const time = t.placedAt
            ? new Date(t.placedAt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZone: 'America/New_York' })
            : '--';
        const allFailed = t.positions.every(function (p) {
            return p.status === 'failed';
        });
        const anyPlaced = t.positions.some(function (p) {
            return p.status === 'placed' || p.status === 'filled';
        });
        const anyPartial = t.positions.some(function (p) {
            return p.status === 'partial';
        });
        let execBadge = '';
        if (t.mode === 'dry-run')
            execBadge =
                '<span style="background:rgba(251,191,36,0.2);color:#fbbf24;padding:3px 10px;border-radius:6px;font-size:11px;font-weight:700;cursor:help;" title="Simulated trade — no real money spent">\ud83e\uddea DRY RUN</span>';
        else if (allFailed) {
            const firstErr = t.positions[0]?.error || 'unknown';
            execBadge =
                '<span style="background:rgba(239,68,68,0.15);color:#f87171;padding:3px 10px;border-radius:6px;font-size:11px;font-weight:700;cursor:help;" title="All orders failed: ' +
                escapeHtml(firstErr) +
                '">\u274c FAILED</span>';
        } else if (anyPlaced)
            execBadge =
                '<span style="background:rgba(16,185,129,0.15);color:#34d399;padding:3px 10px;border-radius:6px;font-size:11px;font-weight:700;cursor:help;" title="Live trade — real orders placed on-chain">\ud83d\udfe2 LIVE</span>';
        else if (anyPartial)
            execBadge =
                '<span style="background:rgba(251,191,36,0.2);color:#fbbf24;padding:3px 10px;border-radius:6px;font-size:11px;font-weight:700;cursor:help;" title="Some orders filled, some pending or failed">\ud83d\udfe1 PARTIAL</span>';
        else
            execBadge =
                '<span style="background:rgba(107,114,128,0.15);color:#9ca3af;padding:3px 10px;border-radius:6px;font-size:11px;font-weight:700;cursor:help;" title="Unknown execution status">\u2753 Unknown</span>';

        const posLabels = t.positions
            .map(function (p) {
                let icon,
                    tipText = '',
                    extraInfo = '',
                    sellBtn = '';
                if (
                    manualSellEnabled &&
                    (p.status === 'placed' || p.status === 'filled') &&
                    !p.soldAt &&
                    t.mode === 'live' &&
                    p.positionId &&
                    t.sessionStatus === 'active'
                ) {
                    const sd = escapeHtml(
                        JSON.stringify({
                            positionId: p.positionId,
                            question: p.question,
                            label: p.label,
                            targetDate: t.date,
                            shares: p.shares,
                        }),
                    );
                    sellBtn = '<button class="sell-btn" data-sell="' + sd + '" title="Sell at market">SELL</button> ';
                }
                if (p.soldAt && p.soldStatus === 'placed') {
                    icon = '<span title="SOLD — Position has been sold" style="cursor:help;">\ud83d\udcb5</span>';
                    const sp = p.sellPrice || 0;
                    const posShares = p.shares || 1;
                    const realizedPnl = sp > 0 ? (sp - p.buyPrice) * posShares : 0;
                    const pnlSign = realizedPnl >= 0 ? '+' : '';
                    const pnlColor = realizedPnl >= 0 ? 'var(--accent-green)' : 'var(--accent-red)';
                    extraInfo =
                        sp > 0
                            ? ' <span style="background:rgba(107,114,128,0.25);color:#9ca3af;padding:1px 6px;border-radius:4px;font-size:10px;font-weight:700;margin-left:4px;">SOLD @$' +
                              sp.toFixed(2) +
                              '</span> <span style="color:' +
                              pnlColor +
                              ';font-size:11px;font-weight:600;">' +
                              pnlSign +
                              '$' +
                              realizedPnl.toFixed(3) +
                              '</span>'
                            : ' <span style="background:rgba(251,191,36,0.25);color:#fbbf24;padding:1px 6px;border-radius:4px;font-size:10px;font-weight:700;margin-left:4px;">VERIFYING SELL...</span>';
                } else if (p.status === 'pending_verification') {
                    icon = '<span title="PENDING — Sell placed, verifying on-chain fill price" style="cursor:help;">\u23f3</span>';
                    extraInfo =
                        ' <span style="background:rgba(251,191,36,0.25);color:#fbbf24;padding:1px 6px;border-radius:4px;font-size:10px;font-weight:700;margin-left:4px;">VERIFYING...</span>';
                } else if ((p.status === 'placed' || p.status === 'filled') && t.mode !== 'dry-run')
                    icon = '<span title="FILLED — Live order placed on-chain" style="cursor:help;">\ud83d\udfe2</span>';
                else if (t.mode === 'dry-run')
                    icon = '<span title="SIMULATED — Dry-run mode (no real trade)" style="cursor:help;">\ud83e\uddea</span>';
                else {
                    icon = '<span title="FAILED — ' + escapeHtml(p.error || 'Order rejected') + '" style="cursor:help;">\u274c</span>';
                    tipText = p.error || '';
                }
                const rangeMatch = p.question ? p.question.match(/between[ ]+([0-9]+-[0-9]+)[^a-zA-Z0-9]*F/i) : null;
                const edgeMatch =
                    !rangeMatch && p.question ? p.question.match(/be[ ]+([0-9]+)[^a-zA-Z0-9]*F[ ]+(or[ ]+)(below|higher|above)/i) : null;
                const displayLabel = rangeMatch
                    ? rangeMatch[1] + '\u00b0F'
                    : edgeMatch
                      ? edgeMatch[1] + '\u00b0F ' + edgeMatch[3]
                      : p.label;
                const roleTips = {
                    target: 'Primary position — matches the forecast range',
                    below: 'Hedge — one range below the forecast',
                    above: 'Hedge — one range above the forecast',
                    chain: 'Chain-backfilled — imported from on-chain data',
                };
                const roleTag =
                    p.label && p.label !== displayLabel
                        ? ' <span style="color:var(--text-muted);font-size:10px;opacity:0.7;cursor:help;" title="' +
                          escapeHtml(roleTips[p.label] || p.label) +
                          '">(' +
                          p.label +
                          ')</span>'
                        : '';
                const priceStr = p.buyPrice ? '$' + p.buyPrice.toFixed(2) : '--';
                const shares = p.shares ? ' \u00d7' + p.shares : '';
                let label = sellBtn + icon + ' ' + displayLabel + roleTag + ' @' + priceStr + shares + extraInfo;
                if (tipText)
                    label +=
                        ' <span style="color:var(--text-muted);font-size:11px;" title="' +
                        escapeHtml(tipText) +
                        '">(' +
                        escapeHtml(tipText.substring(0, 25)) +
                        ')</span>';
                if (p.status === 'failed' && t.mode === 'live' && p.positionId && t.sessionStatus === 'active')
                    label +=
                        ' <button onclick="retryPosition(' +
                        p.positionId +
                        ', this)" class="retry-btn" title="Retry this failed order">\ud83d\udd04 Retry</button>';
                return label;
            })
            .join('<br>');

        const pnlVal = t.pnl ? t.pnl.totalPnL : null;
        const pnlPct = t.pnl ? t.pnl.totalPnLPct : null;
        const hasCost = t.totalCost > 0;
        const pnlColor = !hasCost ? 'var(--text-muted)' : pnlVal >= 0 ? 'var(--accent-green)' : 'var(--accent-red)';
        const pnlStr =
            hasCost && pnlVal !== null
                ? (pnlVal >= 0 ? '+' : '') + '$' + pnlVal.toFixed(3) + ' (' + (pnlPct >= 0 ? '+' : '') + pnlPct.toFixed(1) + '%)'
                : allFailed
                  ? 'N/A'
                  : '--';
        const statusMap = {
            active: {
                bg: 'rgba(59,130,246,0.15)',
                color: '#60a5fa',
                text: '\ud83d\udfe2 Active',
                tip: 'Session is actively monitoring this market',
            },
            completed: { bg: 'rgba(16,185,129,0.15)', color: '#34d399', text: '\u2705 Done', tip: 'Market resolved — session completed' },
            stopped: { bg: 'rgba(107,114,128,0.15)', color: '#9ca3af', text: '\u23f9 Stopped', tip: 'Session was manually stopped' },
        };
        const st = statusMap[t.sessionStatus] || statusMap.active;
        const costStr = hasCost ? '$' + t.totalCost.toFixed(3) : allFailed ? '$0 (rejected)' : '$0';

        // Market badge for trade log rows
        var tradeFlag = MARKET_FLAGS[t.marketId] || '\ud83c\udf10';
        var tradeMktName = MARKET_SHORT_NAMES[t.marketId] || (t.marketId || '').toUpperCase();

        html +=
            '<tr style="border-bottom:1px solid var(--border);transition:background 0.15s;' +
            (allFailed ? 'opacity:0.6;' : '') +
            '" class="trade-row">';
        html += '<td style="padding:10px 14px;font-weight:600;white-space:nowrap;">' + t.date + ' <span style="font-size:11px;opacity:0.7;" title="' + tradeMktName + '">' + tradeFlag + '</span></td>';
        html += '<td style="padding:10px 8px;text-align:center;">' + execBadge + '</td>';
        html +=
            '<td style="padding:10px 8px;color:var(--text-secondary);white-space:nowrap;font-family:JetBrains Mono,monospace;font-size:12px;">' +
            time +
            ' ET</td>';
        html += '<td style="padding:10px 8px;line-height:1.6;">' + posLabels + '</td>';
        html +=
            '<td style="padding:10px 8px;text-align:right;font-family:JetBrains Mono,monospace;font-weight:600;' +
            (allFailed ? 'color:var(--text-muted);' : '') +
            '">' +
            costStr +
            '</td>';
        html +=
            '<td style="padding:10px 8px;text-align:right;font-family:JetBrains Mono,monospace;font-weight:600;color:' +
            pnlColor +
            ';">' +
            pnlStr +
            '</td>';
        html +=
            '<td style="padding:10px 14px;text-align:center;"><span style="background:' +
            st.bg +
            ';color:' +
            st.color +
            ';padding:3px 10px;border-radius:6px;font-size:11px;font-weight:600;cursor:help;" title="' +
            escapeHtml(st.tip || '') +
            '">' +
            st.text +
            '</span></td></tr>';
    }
    html += '</tbody></table>';
    body.innerHTML = html;
}

// ── Config Panel (read-only, collapsible) ──
async function loadConfigPanel() {
    try {
        const res = await fetch('/api/config');
        const data = await res.json();
        if (data && data.config) renderConfigPanel(data.config);
    } catch {}
}

function renderConfigPanel(cfg) {
    const sectionLabels = {
        trading: { icon: '💰', label: 'Trading & Risk' },
        monitor: { icon: '👁️', label: 'Monitoring' },
        weather: { icon: '🌤️', label: 'Weather Service' },
        polymarket: { icon: '📈', label: 'Polymarket API' },
        dashboard: { icon: '📊', label: 'Dashboard' },
        phases: { icon: '🔄', label: 'Phase Logic' },
    };
    let html =
        '<div class="card" style="margin-top:24px;"><div class="card-header" style="cursor:pointer;" onclick="toggleConfigPanel()"><span class="card-title">⚙️ Runtime Configuration</span><span id="configToggle" style="color:var(--text-muted);font-size:12px;">▶ Show</span></div><div class="card-body" id="configBody" style="display:none;padding:0;">';
    for (const [section, fields] of Object.entries(cfg)) {
        const meta = sectionLabels[section] || { icon: '📋', label: section };
        html +=
            '<div style="padding:16px 20px;border-bottom:1px solid var(--border);"><div style="font-weight:600;font-size:13px;margin-bottom:12px;color:var(--text-primary);">' +
            meta.icon +
            ' ' +
            meta.label +
            '</div><div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:10px;">';
        for (const [key, info] of Object.entries(fields)) {
            const isOverridden = info.source === 'env';
            const badgeColor = isOverridden ? 'var(--accent-cyan)' : 'var(--text-muted)';
            const badgeBg = isOverridden ? 'rgba(6,182,212,0.12)' : 'rgba(90,106,128,0.1)';
            const badgeText = isOverridden ? 'ENV' : 'DEFAULT';
            const displayVal =
                typeof info.value === 'string' && info.value.length > 40 ? info.value.slice(0, 37) + '...' : String(info.value);
            html +=
                '<div style="background:var(--bg-primary);border:1px solid var(--border);border-radius:var(--radius-sm);padding:10px 12px;"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;"><span style="font-family:JetBrains Mono,monospace;font-size:11px;color:var(--text-secondary);">' +
                escapeHtml(info.envKey) +
                '</span><span style="font-size:10px;font-weight:700;padding:1px 6px;border-radius:4px;background:' +
                badgeBg +
                ';color:' +
                badgeColor +
                ';">' +
                badgeText +
                '</span></div><div style="font-family:JetBrains Mono,monospace;font-size:13px;font-weight:600;color:var(--text-primary);word-break:break-all;">' +
                escapeHtml(displayVal) +
                '</div>';
            if (isOverridden && String(info.default) !== String(info.value) && info.default !== '(hidden)')
                html +=
                    '<div style="font-size:11px;color:var(--text-muted);margin-top:2px;">default: ' +
                    escapeHtml(String(info.default)) +
                    '</div>';
            html += '</div>';
        }
        html += '</div></div>';
    }
    html += '</div></div>';
    document.getElementById('configPanel').innerHTML = html;
}

function toggleConfigPanel() {
    const body = document.getElementById('configBody'),
        toggle = document.getElementById('configToggle');
    if (body.style.display === 'none') {
        body.style.display = 'block';
        toggle.textContent = '▼ Hide';
    } else {
        body.style.display = 'none';
        toggle.textContent = '▶ Show';
    }
}

// ── Incremental + Full Render ─────────────
async function incrementalUpdate(data) {
    if (!lastRenderState || lastRenderState.date !== currentDate) return false;
    if (lastRenderState.market !== currentMarket) return false;
    if (currentMarket === 'all') return false; // always full-render overview
    if (!data || (!data.session && !data.observation)) return false;
    if (!document.getElementById('statsRow')) return false;
    const vm = extractViewModel(data);

    var mktFlag = MARKET_FLAGS[currentMarket] || '\ud83c\udf10';
    var mktName = MARKET_SHORT_NAMES[currentMarket] || currentMarket.toUpperCase();
    var portfolio = _portfolioData;
    var mktMeta = portfolio?.markets?.find(function(m) { return m.id === currentMarket; }) || { unit: 'F' };
    var unitSym = getUnitSymbol(mktMeta.unit);

    const phaseLabels = { buy: '\ud83d\uded2 BUY', monitor: '\ud83d\udc41\ufe0f MONITOR', resolve: '\ud83c\udfaf RESOLVE' };
    let phaseStr = phaseLabels[vm.phase] ? ' \u00b7 ' + phaseLabels[vm.phase] : '';
    if (vm.awaitingLiquidity) phaseStr = ' \u00b7 \u23f3 AWAITING LIQUIDITY';
    updateStatus(vm.status, mktFlag + ' ' + mktName + ' \u00b7 ' + vm.status.charAt(0).toUpperCase() + vm.status.slice(1) + phaseStr);
    updateStatCard(
        'stat-current',
        vm.currentTempF !== null ? vm.currentTempF + unitSym : '--',
        vm.currentConditions + (vm.maxTodayF ? ' \u00b7 Hi: ' + vm.maxTodayF + unitSym : ''),
    );
    updateStatCard(
        'stat-forecast',
        vm.forecastTemp + unitSym,
        vm.sourceLabel +
            (vm.daysUntilTarget !== null ? ' \u00b7 T-' + vm.daysUntilTarget : '') +
            (vm.snapshotTimestamp ? ' \u00b7 ' + timeAgo(vm.snapshotTimestamp) : ''),
    );
    updateStatCard(
        'stat-target',
        shortLabel(vm.targetRange?.question || '--'),
        vm.session?.initialTargetRange ? 'Initial: ' + shortLabel(vm.session.initialTargetRange) : '',
    );
    updateStatCard('stat-cost', vm.costValue, vm.costSub);
    portfolio = await fetchPortfolio();
    const portfolioEl = document.getElementById('portfolioSection');
    if (portfolioEl && portfolio && portfolio.plays) {
        var marketPlays = portfolio.plays.filter(function(p) { return p.marketId === currentMarket; });
        portfolioEl.innerHTML =
            '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:16px;">' +
            marketPlays.map((p) => renderPortfolioCard(p)).join('') +
            '</div>';
        currentPlay = marketPlays.find((p) => p.date === currentDate) || null;
        if (currentPlay && currentPlay.session) manualSellEnabled = !!currentPlay.session.manualSellEnabled;
    }
    if (vm.snapshotCount !== lastRenderState.snapshotCount) {
        const chartEl = document.getElementById('chartContainer');
        const snapLabel = document.getElementById('snapshotCountLabel');
        if (chartEl && vm.snapshots.length >= 2) chartEl.innerHTML = renderChart(vm.snapshots);
        if (snapLabel) snapLabel.textContent = vm.snapshotCount + ' snapshots';
        lastRenderState.snapshotCount = vm.snapshotCount;
    }
    if (vm.alertCount !== lastRenderState.alertCount) {
        const alertsEl = document.getElementById('alertsBody');
        const alertLabel = document.getElementById('alertCountLabel');
        if (alertsEl) alertsEl.innerHTML = renderAlertsFeed(vm.alerts);
        if (alertLabel) alertLabel.textContent = vm.alertCount + ' total';
        lastRenderState.alertCount = vm.alertCount;
    }
    if (vm.snapshotCount !== lastRenderState.lastRangesSnapshotCount) {
        const rangesEl = document.getElementById('rangesTableBody');
        if (rangesEl) rangesEl.innerHTML = renderRangesTable(vm.allRanges, vm.targetRange, vm.belowRange, vm.aboveRange);
        lastRenderState.lastRangesSnapshotCount = vm.snapshotCount;
    }
    return true;
}

// ── Market Overview Rendering ─────────────
function renderMarketOverviewInner(portfolioData) {
    if (!portfolioData || !portfolioData.plays) return '';
    var markets = portfolioData.markets || [];
    var spend = portfolioData.spend || {};

    // Group plays by market
    var byMarket = {};
    for (var i = 0; i < portfolioData.plays.length; i++) {
        var p = portfolioData.plays[i];
        var mid = p.marketId || 'nyc';
        if (!byMarket[mid]) byMarket[mid] = { plays: [], meta: null };
        byMarket[mid].plays.push(p);
        if (!byMarket[mid].meta) {
            byMarket[mid].meta = markets.find(function(m) { return m.id === mid; }) ||
                { id: mid, name: mid.toUpperCase(), unit: 'F', timezone: 'America/New_York' };
        }
    }

    var html = '<div class="market-overview-grid">';
    var marketIds = Object.keys(byMarket);
    for (var mi = 0; mi < marketIds.length; mi++) {
        var mId = marketIds[mi];
        var mData = byMarket[mId];
        var meta = mData.meta;
        var plays = mData.plays;
        var color = getMarketColor(mId, markets);
        var flag = MARKET_FLAGS[mId] || '\ud83c\udf10';
        var unitSym = getUnitSymbol(meta.unit);

        // Find best data from plays
        var latestPlay = plays.find(function(p) { return p.latest; }) || plays[0];
        var forecastVal = latestPlay?.latest?.forecastTempF || '--';
        var currentVal = latestPlay?.latest?.currentTempF || '--';
        var targetQ = latestPlay?.latest?.target?.question;
        var targetLabel = targetQ ? shortLabel(targetQ) : '--';
        var totalSpend = spend[mId] || 0;
        var dailyBudget = 3; // TODO: get from config
        var spendPct = dailyBudget > 0 ? Math.min(100, (totalSpend / dailyBudget) * 100) : 0;
        var spendColor = spendPct > 80 ? 'var(--accent-red)' : spendPct > 50 ? 'var(--accent-amber)' : color;

        // Active session count
        var activeSessions = plays.filter(function(p) { return p.session && p.session.status === 'active'; }).length;

        html += '<div class="market-overview-card" style="--card-accent:' + color + ';" onclick="switchMarket(\'' + mId + '\')">';
        html += '<div class="market-card-header">';
        html += '<div class="market-card-title"><span class="market-card-flag">' + flag + '</span>';
        html += '<span class="market-card-name">' + (MARKET_SHORT_NAMES[mId] || mId.toUpperCase()) + '</span></div>';
        html += '<span class="market-card-unit" style="background:' + color + '22;color:' + color + ';">' + unitSym + '</span>';
        html += '</div>';

        // Stats row
        html += '<div class="market-card-stats">';
        html += '<div class="market-stat-item"><div class="market-stat-label">Current</div>';
        html += '<div class="market-stat-value">' + (currentVal !== '--' ? currentVal + unitSym : '--') + '</div></div>';
        html += '<div class="market-stat-item"><div class="market-stat-label">Forecast</div>';
        html += '<div class="market-stat-value" style="color:' + color + ';">' + (forecastVal !== '--' ? forecastVal + unitSym : '--') + '</div></div>';
        html += '<div class="market-stat-item"><div class="market-stat-label">Target</div>';
        html += '<div class="market-stat-value">' + targetLabel + '</div></div>';
        html += '</div>';

        // Phase pills
        var phaseConfig = [
            { phase: 'resolve', icon: '\ud83c\udfaf', label: 'RESOLVE', bg: 'rgba(239,68,68,0.12)', color: '#f87171' },
            { phase: 'monitor', icon: '\ud83d\udc41\ufe0f', label: 'MONITOR', bg: 'rgba(251,191,36,0.12)', color: '#fbbf24' },
            { phase: 'buy', icon: '\ud83d\uded2', label: 'BUY', bg: 'rgba(16,185,129,0.12)', color: '#34d399' },
        ];
        html += '<div class="market-phases">';
        for (var pi = 0; pi < phaseConfig.length; pi++) {
            var pc = phaseConfig[pi];
            var matchingPlay = plays.find(function(p) { return p.phase === pc.phase; });
            var hasData = matchingPlay && matchingPlay.hasData;
            var hasBuy = matchingPlay?.session?.buyOrder;
            var pillBg = hasData ? pc.bg : 'rgba(42,53,80,0.3)';
            var pillColor = hasData ? pc.color : 'var(--text-muted)';
            var pillExtra = hasBuy ? ' active-pill' : '';
            html += '<div class="phase-pill' + pillExtra + '" style="background:' + pillBg + ';color:' + pillColor + ';">';
            html += pc.icon + ' ' + pc.label;
            if (matchingPlay) html += ' <span style="opacity:0.6;font-size:9px;">' + matchingPlay.date.slice(5) + '</span>';
            html += '</div>';
        }
        html += '</div>';

        // Spend bar
        html += '<div class="market-spend">';
        html += '<div class="spend-label"><span>Daily Spend</span><span style="font-family:JetBrains Mono,monospace;font-weight:600;">$' + totalSpend.toFixed(2) + ' / $' + dailyBudget.toFixed(2) + '</span></div>';
        html += '<div class="spend-bar-bg"><div class="spend-bar-fill" style="width:' + spendPct + '%;background:' + spendColor + ';"></div></div>';
        html += '</div>';

        html += '</div>'; // end card
    }
    html += '</div>';
    return html;
}
function renderMarketOverview(portfolioData) {
    return '<div id="marketOverviewSection">' + renderMarketOverviewInner(portfolioData) + '</div>';
}

function renderBudgetBarInner(portfolioData) {
    if (!portfolioData) return '';
    var spend = portfolioData.spend || {};
    var markets = portfolioData.markets || [];
    // Compute total budget from per-market daily_budget (default $3 each)
    var totalBudget = 0;
    var totalSpent = 0;
    var segments = [];
    for (var i = 0; i < markets.length; i++) {
        var m = markets[i];
        var mBudget = parseFloat(m.daily_budget || 3);
        totalBudget += mBudget;
        var s = spend[m.id] || 0;
        totalSpent += s;
        segments.push({ id: m.id, spent: s, budget: mBudget, color: getMarketColor(m.id, markets) });
    }
    var pct = totalBudget > 0 ? Math.min(100, (totalSpent / totalBudget) * 100) : 0;
    var pctColor = pct > 80 ? 'var(--accent-red)' : pct > 50 ? 'var(--accent-amber)' : 'var(--accent-green)';

    var html = '<div class="budget-card">';
    html += '<div class="budget-header"><span class="budget-title">\ud83d\udcb0 Daily Budget</span>';
    html += '<span class="budget-amount" style="color:' + pctColor + ';">$' + totalSpent.toFixed(2) + ' / $' + totalBudget.toFixed(2) + '</span></div>';
    html += '<div class="budget-bar">';
    for (var si = 0; si < segments.length; si++) {
        var seg = segments[si];
        var segPct = totalBudget > 0 ? (seg.spent / totalBudget) * 100 : 0;
        if (segPct > 0) {
            html += '<div class="budget-segment" style="width:' + segPct + '%;background:' + seg.color + ';"></div>';
        }
    }
    html += '</div>';
    html += '<div class="budget-legend">';
    for (var li = 0; li < segments.length; li++) {
        var leg = segments[li];
        var flagIcon = MARKET_FLAGS[leg.id] || '';
        html += '<div class="budget-legend-item"><span class="budget-legend-dot" style="background:' + leg.color + ';"></span>';
        html += flagIcon + ' ' + (MARKET_SHORT_NAMES[leg.id] || leg.id) + ' $' + leg.spent.toFixed(2) + '/' + leg.budget.toFixed(0) + '</div>';
    }
    html += '</div></div>';
    return html;
}
function renderBudgetBar(portfolioData) {
    return '<div id="budgetBarSection">' + renderBudgetBarInner(portfolioData) + '</div>';
}

function updateMarketTabs(markets) {
    var tabsEl = document.getElementById('marketTabs');
    if (!tabsEl) return;
    var html = '<option value="all"' + (currentMarket === 'all' ? ' selected' : '') + '>\ud83c\udf10  All Markets</option>';
    if (markets && markets.length > 0) {
        for (var i = 0; i < markets.length; i++) {
            var m = markets[i];
            var flag = MARKET_FLAGS[m.id] || '';
            var name = MARKET_SHORT_NAMES[m.id] || m.id.toUpperCase();
            var isActive = currentMarket === m.id;
            html += '<option value="' + m.id + '"' + (isActive ? ' selected' : '') + '>' + flag + '  ' + name + '</option>';
        }
    }
    tabsEl.innerHTML = html;
}

// ── Main Render ───────────────────────────
async function render(data) {
    if (!data && currentMarket !== 'all') {
        document.getElementById('app').innerHTML =
            '<div class="no-data"><h2>Connection Error</h2><p>Could not connect to the dashboard server.</p></div>';
        lastRenderState = null;
        return;
    }

    const portfolio = await fetchPortfolio();

    // Update market tabs
    if (portfolio && portfolio.markets) {
        updateMarketTabs(portfolio.markets);
    }

    // ── GLOBAL OVERVIEW MODE ──
    if (currentMarket === 'all') {
        document.getElementById('dateSelect').style.display = 'none';
        updateStatus('active', 'MULTI-MARKET \u00b7 ' + (portfolio?.markets?.length || 1) + ' markets');

        // Check if we can do an incremental update (trade log already rendered)
        var existingTradeLog = document.getElementById('tradeLogCard');
        if (existingTradeLog && lastRenderState && lastRenderState.market === 'all') {
            // Incremental: only update market cards and budget bar, preserve trade log
            var overviewEl = document.getElementById('marketOverviewSection');
            if (overviewEl) overviewEl.innerHTML = renderMarketOverviewInner(portfolio);
            var budgetEl = document.getElementById('budgetBarSection');
            if (budgetEl) budgetEl.innerHTML = renderBudgetBarInner(portfolio);
            return;
        }

        // Full render (first time only)
        var overviewHtml = renderMarketOverview(portfolio);
        overviewHtml += renderBudgetBar(portfolio);

        // Trade log
        overviewHtml += '<div class="card" id="tradeLogCard"><div class="card-header"><span class="card-title">\ud83d\udccb Trade Log</span>';
        overviewHtml += '<span id="tradeLogCount" style="font-size:12px;color:var(--text-muted);">loading...</span></div>';
        overviewHtml += '<div class="card-body" id="tradeLogBody" style="padding:0;max-height:400px;overflow-y:auto;">';
        overviewHtml += '<div style="padding:24px;text-align:center;color:var(--text-muted);font-size:13px;">Loading trade history...</div></div></div>';
        overviewHtml += '<div id="configPanel"></div>';

        document.getElementById('app').innerHTML = overviewHtml;
        lastRenderState = { date: currentDate, market: 'all', snapshotCount: 0, alertCount: 0, lastRangesSnapshotCount: 0 };
        loadConfigPanel();
        fetchTradeLog();
        return;
    }

    // ── SINGLE MARKET DETAIL MODE ──
    document.getElementById('dateSelect').style.display = '';

    if (await incrementalUpdate(data)) return;

    const select = document.getElementById('dateSelect');
    const dates = data?.availableDates || [];
    if (dates.length > 0)
        select.innerHTML = dates
            .map((d) => '<option value="' + d + '"' + (d === currentDate ? ' selected' : '') + '>' + d + '</option>')
            .join('');
    const vm = data ? extractViewModel(data) : null;

    // Market header with back button
    var mktMeta = portfolio?.markets?.find(function(m) { return m.id === currentMarket; }) || { id: currentMarket, name: currentMarket.toUpperCase(), unit: 'F' };
    var mktFlag = MARKET_FLAGS[currentMarket] || '\ud83c\udf10';
    var mktName = MARKET_SHORT_NAMES[currentMarket] || currentMarket.toUpperCase();
    var mktColor = getMarketColor(currentMarket, portfolio?.markets);

    var detailHtml = '';

    // Portfolio cards for this market
    if (portfolio && portfolio.plays) {
        var marketPlays = portfolio.plays.filter(function(p) { return p.marketId === currentMarket; });
        if (marketPlays.length > 0) {
            detailHtml += '<div class="card" style="margin-bottom:24px;"><div class="card-header">';
            detailHtml += '<span class="card-title">' + mktFlag + ' ' + mktName + ' Portfolio</span>';
            detailHtml += '<span style="color:var(--text-secondary);font-size:13px;">click a play to view details</span></div>';
            detailHtml += '<div class="card-body" id="portfolioSection"><div style="display:grid;grid-template-columns:repeat(3,1fr);gap:16px;">';
            detailHtml += marketPlays.map(function(p) { return renderPortfolioCard(p); }).join('');
            detailHtml += '</div></div></div>';
            currentPlay = marketPlays.find(function(p) { return p.date === currentDate; }) || null;
            if (currentPlay && currentPlay.session) manualSellEnabled = !!currentPlay.session.manualSellEnabled;
        }
    }

    if (!vm || (!vm.session && !vm.observation)) {
        updateStatus('none', mktFlag + ' ' + mktName + ' \u00b7 No Data');
        detailHtml += '<div class="stats-row" id="statsRow">' +
            statCard('stat-current', 'Current Temp', '--', '', 0, '') +
            statCard('stat-forecast', 'Forecast High', '--', '', 0, '') +
            statCard('stat-target', 'Target Range', '--', '', 0, '') +
            statCard('stat-cost', 'Buy / Sell', '--', '', 0, '') +
            '</div>';
        detailHtml += '<div class="no-data"><h2>No data for ' + mktName + ' on ' + currentDate + '</h2>';
        detailHtml += '<p>Monitor has not yet collected data for this market/date combination.</p></div>';
        detailHtml += '<div class="card" id="tradeLogCard"><div class="card-header"><span class="card-title">\ud83d\udccb Trade Log</span><span id="tradeLogCount" style="font-size:12px;color:var(--text-muted);">loading...</span></div><div class="card-body" id="tradeLogBody" style="padding:0;max-height:400px;overflow-y:auto;">Loading...</div></div>';
        detailHtml += '<div id="configPanel"></div>';
        document.getElementById('app').innerHTML = detailHtml;
        lastRenderState = { date: currentDate, market: currentMarket, snapshotCount: 0, alertCount: 0, lastRangesSnapshotCount: 0 };
        loadConfigPanel();
        fetchTradeLog();
        return;
    }

    var unitSym = getUnitSymbol(mktMeta.unit);
    const phaseLabels = { buy: '\ud83d\uded2 BUY', monitor: '\ud83d\udc41\ufe0f MONITOR', resolve: '\ud83c\udfaf RESOLVE' };
    let phaseStr = phaseLabels[vm.phase] ? ' \u00b7 ' + phaseLabels[vm.phase] : '';
    if (vm.awaitingLiquidity) phaseStr = ' \u00b7 \u23f3 AWAITING LIQUIDITY';
    updateStatus(vm.status, mktFlag + ' ' + mktName + ' \u00b7 ' + vm.status.charAt(0).toUpperCase() + vm.status.slice(1) + phaseStr);

    const {
        snapshots, alerts, latest, targetRange, belowRange, aboveRange, allRanges,
        currentTempF, currentConditions, maxTodayF, forecastTemp, sourceLabel,
        daysUntilTarget, forecastChange, snapshotCount, alertCount, costLabel, costValue, costSub, session,
    } = vm;

    detailHtml += '<div class="stats-row" id="statsRow">' +
        statCard('stat-current', 'Current Temp', currentTempF !== null ? currentTempF + unitSym : '--', currentConditions + (maxTodayF ? ' \u00b7 Hi: ' + maxTodayF + unitSym : ''), 0, '') +
        statCard('stat-forecast', 'Forecast High', forecastTemp + unitSym, sourceLabel + (daysUntilTarget !== null ? ' \u00b7 T-' + daysUntilTarget : ''), forecastChange, unitSym) +
        (function() {
            // Validate initialTargetRange matches market unit (suppress contaminated data)
            var initRange = session?.initialTargetRange || '';
            var showInitial = initRange && (mktMeta.unit === 'F' ? !initRange.includes('°C') : !initRange.includes('°F'));
            var initSub = showInitial ? 'Initial: ' + shortLabel(initRange) : '';
            return statCard('stat-target', 'Target Range', shortLabel(targetRange?.question || '--'), initSub, 0, '');
        })() +
        statCard('stat-cost', costLabel, costValue, costSub, 0, '') +
        '</div>';

    if (session?.resolution) {
        const r = session.resolution;
        detailHtml += '<div class="card" style="border-color:var(--accent-green);margin-bottom:24px;"><div class="card-header" style="background:rgba(16,185,129,0.1);"><span class="card-title">\ud83c\udfaf Resolve Day \u2014 Range Decision</span></div><div class="card-body"><div style="font-size:18px;font-weight:700;color:var(--accent-green);margin-bottom:8px;">KEEP: ' + escapeHtml(shortLabel(r.keep)) + ' (' + (r.keepPrice * 100).toFixed(1) + '\u00a2)</div><div style="color:var(--accent-red);margin-bottom:8px;">DISCARD: ' + r.discard.map(function(d) { return escapeHtml(shortLabel(d)); }).join(', ') + '</div><div style="color:var(--text-secondary);font-size:13px;">' + escapeHtml(r.reason) + '</div></div></div>';
    }

    detailHtml += '<div class="grid-2col"><div class="card"><div class="card-header"><span class="card-title">\ud83d\udcc8 Price History</span><span id="snapshotCountLabel" style="font-size:12px;color:var(--text-muted);">' + snapshotCount + ' snapshots</span></div><div class="card-body"><div class="chart-container" id="chartContainer">' + (snapshots.length >= 2 ? renderChart(snapshots) : '<div class="chart-empty">Waiting for more snapshots to plot chart...</div>') + '</div></div></div>';
    detailHtml += '<div class="card"><div class="card-header"><span class="card-title">\ud83d\udd14 Alerts</span><span id="alertCountLabel" style="font-size:12px;color:var(--text-muted);">' + alertCount + ' total</span></div><div class="card-body" style="padding:0;max-height:280px;overflow-y:auto;" id="alertsBody">' + renderAlertsFeed(alerts) + '</div></div></div>';
    detailHtml += '<div class="card" id="liquidityCard" style="display:none;"><div class="card-header"><span class="card-title">\ud83d\udce1 Live Liquidity</span><span id="liquidityStatus" style="font-size:11px;color:var(--text-muted);font-family:JetBrains Mono,monospace;">connecting...</span></div><div class="card-body" id="liquidityBody" style="padding:0;"><div style="padding:24px;text-align:center;color:var(--text-muted);font-size:13px;">Connecting...</div></div></div>';
    detailHtml += '<div class="card" id="pipelineCard" style="display:none;"><div class="card-header"><span class="card-title">\ud83d\udd2d Forecast Pipeline</span><span id="pipelineCount" style="font-size:12px;color:var(--text-muted);">loading...</span></div><div class="card-body" id="pipelineBody" style="padding:0;">Loading...</div></div>';
    detailHtml += '<div class="card" id="tradeLogCard"><div class="card-header"><span class="card-title">\ud83d\udccb Trade Log</span><span id="tradeLogCount" style="font-size:12px;color:var(--text-muted);">loading...</span></div><div class="card-body" id="tradeLogBody" style="padding:0;max-height:400px;overflow-y:auto;">Loading...</div></div>';
    detailHtml += '<div class="card"><div class="card-header"><span class="card-title">\ud83d\udcca All Temperature Ranges</span></div><div class="card-body" style="padding:0;overflow-x:auto;" id="rangesTableBody">' + renderRangesTable(allRanges, targetRange, belowRange, aboveRange) + '</div></div>';
    detailHtml += '<div id="configPanel"></div>';

    document.getElementById('app').innerHTML = detailHtml;
    lastRenderState = { date: currentDate, market: currentMarket, snapshotCount, alertCount, lastRangesSnapshotCount: snapshotCount };
    loadConfigPanel();
    fetchLiquidity();
    fetchPipeline();
    fetchTradeLog();
}

// ── Market Switching ──────────────────────
function switchMarket(marketId) {
    currentMarket = marketId;
    lastRenderState = null;
    if (marketId !== 'all') {
        // Set a sensible default date for this market
        if (_portfolioData && _portfolioData.plays) {
            var mp = _portfolioData.plays.filter(function(p) { return p.marketId === marketId; });
            var buyPlay = mp.find(function(p) { return p.phase === 'buy'; });
            if (buyPlay) currentDate = buyPlay.date;
            else if (mp.length > 0) currentDate = mp[mp.length - 1].date;
        }
    }
    refresh();
}

// ── Auto-refresh loop ─────────────────────
async function refresh() {
    if (currentMarket === 'all') {
        await render(null);
    } else {
        const data = await fetchStatus(currentDate, currentMarket);
        await render(data);
    }
}

function switchDate(date) {
    currentDate = date;
    lastRenderState = null;
    refresh();
}

refresh();
refreshTimer = setInterval(refresh, CFG.refreshInterval || 15000);
