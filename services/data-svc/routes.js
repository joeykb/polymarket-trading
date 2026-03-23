/**
 * Data Service — HTTP Route Handlers
 *
 * All API route handling extracted from the monolithic index.js.
 * Each route group is clearly delineated.
 *
 * Extracted from the monolithic data-svc/index.js.
 */

import fs from 'fs';
import path from 'path';
import { healthResponse } from '../../shared/health.js';
import { jsonResponse as json, errorResponse as error, readJsonBody as readBody, parseUrl } from '../../shared/httpServer.js';
import { buildAdminConfig, buildFlatConfig } from '../../shared/configSchema.js';
import { getDb } from './db.js';
import {
    sessionSchema,
    sessionUpdateSchema,
    tradeSchema,
    tradeUpdateSchema,
    positionsInsertSchema,
    positionSoldSchema,
    positionRedeemedSchema,
    snapshotSchema,
    alertSchema,
    spendSchema,
    validate,
} from './schemas.js';
import * as queries from './queries.js';
import {
    OUTPUT_DIR,
    matchRoute,
    loadSessionFile,
    saveSessionFile,
    listSessionFiles,
    getSpendData,
    recordSpend,
    loadConfigOverrides,
    saveConfigOverrides,
} from './storage.js';

/**
 * Main request handler — dispatches to route-specific logic.
 */
export async function handleRequest(req, res) {
    const { pathname, params: query } = parseUrl(req.url);
    const method = req.method;

    try {
        // ── Health ───────────────────────────────────────
        if (pathname === '/health' && method === 'GET') {
            const dbPath = process.env.DB_PATH || path.join(OUTPUT_DIR, 'tempedge.db');
            const dbSize = fs.existsSync(dbPath) ? fs.statSync(dbPath).size : 0;
            return json(res, healthResponse('data-svc', { dbSizeBytes: dbSize, sessionFiles: listSessionFiles().length }));
        }

        // ── Session Files ───────────────────────────────
        if (pathname === '/api/session-files' && method === 'GET') {
            return json(res, { dates: listSessionFiles() });
        }

        // ── Trade Summary (lightweight — no snapshots) ──
        if (pathname === '/api/trade-summary' && method === 'GET') {
            return handleTradeSummary(res, query);
        }

        {
            const m = matchRoute('/api/session-files/:date', pathname);
            if (m.match && method === 'GET') {
                return handleGetSessionFile(res, m.params.date, query);
            }
            if (m.match && method === 'PUT') {
                const body = await readBody(req);
                saveSessionFile(m.params.date, body);
                return json(res, { saved: true });
            }
        }

        // ── DB Sessions ─────────────────────────────────
        if (pathname === '/api/sessions' && method === 'GET') {
            const limit = parseInt(query.limit || '30');
            return json(res, queries.getAllSessions(limit));
        }

        if (pathname === '/api/sessions/active' && method === 'GET') {
            const all = queries.getAllSessions(100);
            const active = all.filter((s) => s.status === 'active');
            return json(res, active);
        }

        {
            const m = matchRoute('/api/sessions/:id', pathname);
            if (m.match && method === 'GET') {
                const session = queries.getSession('nyc', m.params.id);
                if (!session) return error(res, 'Session not found', 404);
                return json(res, session);
            }
            if (m.match && method === 'PUT') {
                const body = await readBody(req);
                const { data, error: validationError } = validate(sessionSchema, body);
                if (validationError) return error(res, validationError, 400);
                queries.upsertSession(data);
                return json(res, { upserted: true });
            }
            if (m.match && method === 'PATCH') {
                const body = await readBody(req);
                const { data, error: validationError } = validate(sessionUpdateSchema, body);
                if (validationError) return error(res, validationError, 400);
                queries.updateSession(m.params.id, data);
                return json(res, { updated: true });
            }
        }

        // ── Trades ──────────────────────────────────────
        if (pathname === '/api/trades' && method === 'POST') {
            const body = await readBody(req);
            const { data, error: validationError } = validate(tradeSchema, body);
            if (validationError) return error(res, validationError, 400);
            const result = queries.insertTrade(data);
            return json(res, result, 201);
        }

        if (pathname === '/api/trades' && method === 'GET') {
            if (query.date) {
                return json(res, queries.getTradesForDate(query.date));
            }
            return json(res, queries.getAllTrades(parseInt(query.limit || '50')));
        }

        if (pathname === '/api/trades/log' && method === 'GET') {
            return json(res, queries.getTradeLog(parseInt(query.limit || '30')));
        }

        if (pathname === '/api/trades/pnl' && method === 'GET') {
            return json(res, queries.getPnLSummary());
        }

        {
            const m = matchRoute('/api/trades/:id', pathname);
            if (m.match && method === 'PATCH') {
                const body = await readBody(req);
                const { data, error: validationError } = validate(tradeUpdateSchema, body);
                if (validationError) return error(res, validationError, 400);
                queries.updateTrade(parseInt(m.params.id), data);
                return json(res, { updated: true });
            }
        }

        // ── Positions ───────────────────────────────────
        if (pathname === '/api/positions' && method === 'POST') {
            const body = await readBody(req);
            const { data, error: validationError } = validate(positionsInsertSchema, body);
            if (validationError) return error(res, validationError, 400);
            queries.insertPositions(data.tradeId, data.positions);
            return json(res, { inserted: data.positions.length }, 201);
        }

        if (pathname === '/api/positions/active' && method === 'GET') {
            if (!query.date) return error(res, 'date parameter required');
            return json(res, queries.getActivePositions(query.date));
        }

        {
            const m = matchRoute('/api/positions/:id', pathname);
            if (m.match && method === 'GET') {
                const db = getDb();
                const pos = db
                    .prepare(
                        `SELECT p.*, t.target_date, t.session_id, t.market_id, t.id as trade_id FROM positions p JOIN trades t ON p.trade_id = t.id WHERE p.id = ?`,
                    )
                    .get(parseInt(m.params.id));
                if (!pos) return error(res, 'Position not found', 404);
                return json(res, pos);
            }
            if (m.match && method === 'PATCH') {
                const body = await readBody(req);
                queries.updatePosition(parseInt(m.params.id), body);
                return json(res, { updated: true });
            }
        }

        // ── Analytics (for dashboard) ───────────────────
        if (pathname === '/api/analytics' && method === 'GET') {
            return handleAnalytics(res);
        }

        {
            const m = matchRoute('/api/positions/:id/sold', pathname);
            if (m.match && method === 'PATCH') {
                const body = await readBody(req);
                const { data, error: validationError } = validate(positionSoldSchema, body);
                if (validationError) return error(res, validationError, 400);
                queries.markPositionSold(parseInt(m.params.id), data);
                return json(res, { sold: true });
            }
        }

        {
            const m = matchRoute('/api/positions/:id/redeemed', pathname);
            if (m.match && method === 'PATCH') {
                const body = await readBody(req);
                const { data, error: validationError } = validate(positionRedeemedSchema, body);
                if (validationError) return error(res, validationError, 400);
                queries.markPositionRedeemed(parseInt(m.params.id), data);
                return json(res, { redeemed: true });
            }
        }

        // ── Snapshots ───────────────────────────────────
        if (pathname === '/api/snapshots' && method === 'POST') {
            let body = await readBody(req);
            const { data: validatedBody, error: validationError } = validate(snapshotSchema, body);
            if (validationError) return error(res, validationError, 400);
            body = validatedBody;
            try {
                queries.insertSnapshot(body);
            } catch (err) {
                if (err.message.includes('FOREIGN KEY') && body.sessionId) {
                    const existing = queries.getSession('nyc', body.targetDate || '');
                    if (existing) {
                        body.sessionId = existing.id;
                        queries.insertSnapshot(body);
                    } else {
                        return error(res, err.message, 409);
                    }
                } else {
                    return error(res, err.message, 409);
                }
            }
            return json(res, { inserted: true }, 201);
        }

        {
            const m = matchRoute('/api/snapshots/:sessionId', pathname);
            if (m.match && method === 'GET') {
                const limit = parseInt(query.limit || '500');
                return json(res, queries.getSnapshots(m.params.sessionId, limit));
            }
        }

        // ── Alerts ──────────────────────────────────────
        if (pathname === '/api/alerts' && method === 'POST') {
            let body = await readBody(req);
            const { data: validatedAlert, error: validationError } = validate(alertSchema, body);
            if (validationError) return error(res, validationError, 400);
            body = validatedAlert;
            try {
                queries.insertAlert(body);
            } catch (err) {
                if (err.message.includes('FOREIGN KEY') && body.sessionId) {
                    const existing = queries.getSession('nyc', body.targetDate || '');
                    if (existing) {
                        body.sessionId = existing.id;
                        queries.insertAlert(body);
                    } else {
                        return error(res, err.message, 409);
                    }
                } else {
                    return error(res, err.message, 409);
                }
            }
            return json(res, { inserted: true }, 201);
        }

        // ── Spend Tracking ──────────────────────────────
        if (pathname === '/api/spend' && method === 'GET') {
            const date = query.date || new Date().toISOString().slice(0, 10);
            return json(res, getSpendData(date));
        }

        if (pathname === '/api/spend' && method === 'POST') {
            const body = await readBody(req);
            const { data, error: validationError } = validate(spendSchema, body);
            if (validationError) return error(res, validationError, 400);
            const result = recordSpend(data.date, data.amount, data.details || {});
            return json(res, result, 201);
        }

        // ── Config Overrides ────────────────────────────
        if (pathname === '/api/config/overrides' && method === 'GET') {
            return json(res, loadConfigOverrides());
        }

        if (pathname === '/api/config/overrides' && method === 'PUT') {
            const body = await readBody(req);
            saveConfigOverrides(body);
            return json(res, { saved: true });
        }

        {
            const m = matchRoute('/api/config/overrides/:section/:field', pathname);
            if (m.match && method === 'DELETE') {
                const overrides = loadConfigOverrides();
                if (overrides[m.params.section]) {
                    delete overrides[m.params.section][m.params.field];
                    if (Object.keys(overrides[m.params.section]).length === 0) {
                        delete overrides[m.params.section];
                    }
                    saveConfigOverrides(overrides);
                }
                return json(res, { reset: true });
            }
        }

        if (pathname === '/api/config/overrides' && method === 'DELETE') {
            saveConfigOverrides({});
            return json(res, { resetAll: true });
        }

        // ── Full Config (defaults + overrides) ──────────
        if (pathname === '/api/config' && method === 'GET') {
            const overrides = loadConfigOverrides();
            const isAdmin = query.admin === '1';
            if (isAdmin) {
                return json(res, buildAdminConfig(overrides));
            }
            return json(res, buildFlatConfig(overrides));
        }

        // ── DB Sessions (upsert via POST) ───────────────
        if (pathname === '/api/db/sessions' && method === 'POST') {
            const body = await readBody(req);
            const { data, error: validationError } = validate(sessionSchema, body);
            if (validationError) return error(res, validationError, 400);
            try {
                const result = queries.upsertSession(data);
                return json(res, { upserted: true, existingId: result?.existingId || null }, 201);
            } catch (err) {
                console.error(`❌ POST /api/db/sessions: ${err.message}`);
                return error(res, err.message, 409);
            }
        }

        // ── Restart Signal ──────────────────────────────
        if (pathname === '/api/restart-signal' && method === 'GET') {
            const signalPath = path.join(OUTPUT_DIR, '.restart-requested');
            const requested = fs.existsSync(signalPath);
            return json(res, { requested });
        }
        if (pathname === '/api/restart-signal' && method === 'DELETE') {
            const signalPath = path.join(OUTPUT_DIR, '.restart-requested');
            if (fs.existsSync(signalPath)) {
                try {
                    fs.unlinkSync(signalPath);
                } catch {
                    /* intentional: file may not exist */
                }
            }
            return json(res, { cleared: true });
        }
        if (pathname === '/api/restart-signal' && method === 'POST') {
            const signalPath = path.join(OUTPUT_DIR, '.restart-requested');
            fs.writeFileSync(signalPath, new Date().toISOString());
            return json(res, { signaled: true }, 201);
        }

        // ── Markets ─────────────────────────────────────
        if (pathname === '/api/markets' && method === 'GET') {
            return json(res, queries.getActiveMarkets());
        }

        // ── Forecast Accuracy ───────────────────────────
        if (pathname === '/api/forecast-accuracy' && method === 'GET') {
            return json(res, queries.getForecastAccuracy());
        }

        // ── 404 ─────────────────────────────────────────
        error(res, `Not found: ${method} ${pathname}`, 404);
    } catch (err) {
        console.error(`❌ ${method} ${pathname}:`, err.message);
        error(res, err.message, 500);
    }
}

// ── Helper: Trade Summary ───────────────────────────────────────────────

function handleTradeSummary(res, query) {
    const dates = listSessionFiles();
    const limit = parseInt(query.limit || '15');
    const recent = dates.slice(-limit).reverse();
    const trades = [];
    const coveredDates = new Set();

    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

    // Source 1: Session files (primary source - has rich monitoring data)
    for (const date of recent) {
        const data = loadSessionFile(date);
        if (!data?.buyOrder) continue;
        const latest = data.snapshots?.[data.snapshots.length - 1];

        const buyOrder = { ...data.buyOrder };
        if (buyOrder.positions) {
            try {
                const dbPositions = queries.getActivePositions(data.targetDate || date);
                const posMap = {};
                for (const p of dbPositions) {
                    posMap[p.question] = p;
                }
                buyOrder.positions = buyOrder.positions.map((p) => {
                    const dbPos = posMap[p.question];
                    return {
                        ...p,
                        positionId: dbPos?.id || p.positionId || null,
                        soldAt: dbPos?.sold_at || p.soldAt || null,
                        soldStatus: dbPos?.status === 'sold' ? 'placed' : p.soldStatus || null,
                    };
                });
            } catch {
                /* intentional: DB lookup is optional enrichment */
            }
        }

        const sessionDate = data.targetDate || date;
        let sessionStatus = data.status;
        if (sessionStatus === 'active' && sessionDate < today) {
            sessionStatus = 'completed';
        }

        trades.push({
            date: sessionDate,
            buyOrder,
            status: sessionStatus,
            phase: data.phase,
            resolution: data.resolution || null,
            latestSnapshot: latest
                ? {
                      timestamp: latest.timestamp,
                      target: latest.target,
                      below: latest.below,
                      above: latest.above,
                      forecastTempF: latest.forecastTempF,
                  }
                : null,
        });
        coveredDates.add(sessionDate);
    }

    // Source 2: DB trades that have no session file (chain-backfilled)
    try {
        const dbTrades = queries.getAllTrades(200);
        const byDate = {};
        for (const t of dbTrades) {
            if (coveredDates.has(t.target_date)) continue;
            if (!byDate[t.target_date]) byDate[t.target_date] = [];
            byDate[t.target_date].push(t);
        }

        for (const [targetDate, dateTrades] of Object.entries(byDate)) {
            const buyTrades = dateTrades.filter((t) => t.type === 'buy');
            const sellTrades = dateTrades.filter((t) => t.type === 'sell');
            if (buyTrades.length === 0) continue;

            const allPositions = [];
            let totalCost = 0;
            for (const bt of buyTrades) {
                totalCost += bt.total_cost || 0;
                const positions = queries.getPositionsForTrade(bt.id);
                for (const p of positions) {
                    allPositions.push({
                        question: p.question,
                        label: p.label || 'chain',
                        buyPrice: p.price,
                        shares: p.shares,
                        tokenId: p.token_id,
                        conditionId: p.condition_id,
                        positionId: p.id,
                        status: p.status,
                        soldAt: p.sold_at || null,
                    });
                }
            }

            let totalProceeds = 0;
            for (const st of sellTrades) {
                totalProceeds += st.total_proceeds || 0;
            }

            const isPast = targetDate < today;
            const isToday = targetDate === today;

            trades.push({
                date: targetDate,
                buyOrder: {
                    placedAt: buyTrades[0].placed_at,
                    totalCost: parseFloat(totalCost.toFixed(4)),
                    positions: allPositions,
                    mode: 'live',
                    source: 'chain-backfill',
                },
                status: isPast ? 'completed' : 'active',
                phase: isPast ? 'resolve' : isToday ? 'monitor' : 'buy',
                resolution: null,
                latestSnapshot: null,
                sellProceeds: totalProceeds > 0 ? parseFloat(totalProceeds.toFixed(4)) : undefined,
            });
        }
    } catch (err) {
        console.warn('DB trade merge failed: ' + err.message);
    }

    trades.sort((a, b) => b.date.localeCompare(a.date));
    const limited = trades.slice(0, limit);

    return json(res, { trades: limited });
}

// ── Helper: Get Session File ────────────────────────────────────────────

function handleGetSessionFile(res, date, query) {
    const data = loadSessionFile(date);
    if (!data) return error(res, 'Session file not found', 404);

    if (query.slim) {
        const limit = parseInt(query.slim) || 20;
        if (data.snapshots && data.snapshots.length > limit) {
            const lastSnaps = data.snapshots.slice(-limit);
            for (const snap of lastSnaps) {
                if (snap.allRanges && lastSnaps.indexOf(snap) < lastSnaps.length - 1) {
                    delete snap.allRanges;
                }
            }
            data.snapshots = lastSnaps;
            data._slimmed = true;
            data._totalSnapshots = data.snapshots.length + (data.snapshots.length - limit);
        }
    }

    return json(res, data);
}

// ── Helper: Analytics ───────────────────────────────────────────────────

function handleAnalytics(res) {
    const db = getDb();
    try {
        const pnlByDate = db
            .prepare(
                `SELECT t.target_date, t.market_id, SUM(CASE WHEN t.type = 'buy' THEN COALESCE(t.actual_cost, t.total_cost) ELSE 0 END) as total_bought, SUM(CASE WHEN t.type = 'sell' THEN t.total_proceeds ELSE 0 END) as total_sold, SUM(CASE WHEN t.type = 'redeem' THEN t.total_proceeds ELSE 0 END) as total_redeemed, COUNT(DISTINCT t.id) as trade_count, COUNT(DISTINCT CASE WHEN t.type = 'buy' THEN t.id END) as buy_count, COUNT(DISTINCT CASE WHEN t.type = 'sell' THEN t.id END) as sell_count FROM trades t WHERE t.status != 'failed' GROUP BY t.target_date, t.market_id ORDER BY t.target_date DESC`,
            )
            .all();
        const totals = {
            totalInvested: pnlByDate.reduce((s, r) => s + r.total_bought, 0),
            totalSold: pnlByDate.reduce((s, r) => s + r.total_sold, 0),
            totalRedeemed: pnlByDate.reduce((s, r) => s + r.total_redeemed, 0),
            tradingDays: pnlByDate.length,
            totalTrades: db.prepare("SELECT COUNT(*) as c FROM trades WHERE status != 'failed'").get().c,
        };
        totals.realizedPnL = totals.totalSold + totals.totalRedeemed - totals.totalInvested;
        return json(res, { pnlByDate, totals, serverTime: new Date().toISOString() });
    } catch (err) {
        return error(res, err.message, 500);
    }
}
