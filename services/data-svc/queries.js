/**
 * TempEdge Database — Named query functions
 *
 * All database operations go through these functions.
 * Keeps SQL centralized and provides a clean API for the rest of the app.
 */

import { getDb } from './db.js';

// ── Sessions ─────────────────────────────────────────────────────────────

/**
 * Create or update a session
 */
export function upsertSession({
    id,
    marketId,
    targetDate,
    status,
    phase,
    initialForecastTemp,
    initialTargetRange,
    forecastSource,
    intervalMinutes,
    rebalanceThreshold,
}) {
    const db = getDb();
    if (!marketId) throw new Error('marketId is required for session upsert');
    // Try by id first, then by (market_id, target_date) — handles monitor restarts with new UUIDs
    const existing = db.prepare('SELECT id FROM sessions WHERE market_id = ? AND target_date = ?').get(marketId, targetDate);
    if (existing) {
        // Update existing session (keep original ID)
        db.prepare(
            `
            UPDATE sessions SET status = ?, phase = ?, updated_at = datetime('now')
            WHERE id = ?
        `,
        ).run(status, phase, existing.id);
        return { changes: 1, existingId: existing.id };
    }
    return db
        .prepare(
            `
        INSERT INTO sessions (id, market_id, target_date, status, phase, initial_forecast_temp, initial_target_range, forecast_source, interval_minutes, rebalance_threshold)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
        )
        .run(
            id,
            marketId,
            targetDate,
            status,
            phase,
            initialForecastTemp,
            initialTargetRange,
            forecastSource,
            intervalMinutes || 15,
            rebalanceThreshold || 3.0,
        );
}

/**
 * Update session status/phase.
 * Uses an explicit column whitelist to prevent SQL injection.
 */
const ALLOWED_SESSION_UPDATE_FIELDS = {
    status: 'status',
    phase: 'phase',
    initialForecastTemp: 'initial_forecast_temp',
    initialTargetRange: 'initial_target_range',
    forecastSource: 'forecast_source',
    intervalMinutes: 'interval_minutes',
    rebalanceThreshold: 'rebalance_threshold',
};

export function updateSession(id, updates) {
    const db = getDb();
    const fields = [];
    const values = [];
    for (const [key, val] of Object.entries(updates)) {
        const col = ALLOWED_SESSION_UPDATE_FIELDS[key];
        if (!col) continue; // silently ignore unknown fields
        fields.push(`${col} = ?`);
        values.push(val);
    }
    if (fields.length === 0) return { changes: 0 };
    fields.push("updated_at = datetime('now')");
    values.push(id);
    return db.prepare(`UPDATE sessions SET ${fields.join(', ')} WHERE id = ?`).run(...values);
}

/**
 * Get session by market + date
 */
export function getSession(marketId, targetDate) {
    const db = getDb();
    return db.prepare('SELECT * FROM sessions WHERE market_id = ? AND target_date = ?').get(marketId, targetDate);
}

/**
 * Get session by ID
 */
export function getSessionById(id) {
    const db = getDb();
    return db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
}

/**
 * Get all sessions for the Trade Log (newest first)
 */
export function getAllSessions(limit = 30) {
    const db = getDb();
    return db.prepare('SELECT * FROM sessions ORDER BY target_date DESC LIMIT ?').all(limit);
}

// ── Trades ───────────────────────────────────────────────────────────────

/**
 * Insert a new trade (buy, sell, or redeem). Append-only — never overwritten.
 * @returns {{ id: number }} The inserted trade row ID
 */
export function insertTrade({ sessionId, marketId, targetDate, type, mode, placedAt, totalCost, totalProceeds, status, metadata }) {
    const db = getDb();
    const result = db
        .prepare(
            `
        INSERT INTO trades (session_id, market_id, target_date, type, mode, placed_at, total_cost, total_proceeds, status, metadata)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
        )
        .run(
            sessionId,
            marketId || (sessionId ? 'nyc' : (() => { throw new Error('marketId is required for trade insert'); })()),
            targetDate,
            type,
            mode || 'live',
            placedAt || new Date().toISOString(),
            totalCost || 0,
            totalProceeds || 0,
            status || 'placed',
            metadata ? JSON.stringify(metadata) : null,
        );
    return { id: result.lastInsertRowid };
}

/**
 * Update trade after verification
 */
export function updateTrade(id, updates) {
    const db = getDb();
    const fieldMap = {
        status: 'status',
        verifiedAt: 'verified_at',
        actualCost: 'actual_cost',
        fillSummary: 'fill_summary',
        totalProceeds: 'total_proceeds',
    };
    const fields = [];
    const values = [];
    for (const [key, val] of Object.entries(updates)) {
        const col = fieldMap[key] || key.replace(/([A-Z])/g, '_$1').toLowerCase();
        fields.push(`${col} = ?`);
        values.push(key === 'fillSummary' && val ? JSON.stringify(val) : val);
    }
    if (fields.length === 0) return;
    values.push(id);
    return db.prepare(`UPDATE trades SET ${fields.join(', ')} WHERE id = ?`).run(...values);
}

/**
 * Get all trades for a date (across markets)
 */
export function getTradesForDate(targetDate) {
    const db = getDb();
    return db
        .prepare(
            `
        SELECT t.*, m.name as market_name, m.unit
        FROM trades t
        JOIN markets m ON t.market_id = m.id
        WHERE t.target_date = ?
        ORDER BY t.placed_at
    `,
        )
        .all(targetDate);
}

/**
 * Get all trades for the Trade Log (newest first)
 */
export function getAllTrades(limit = 50) {
    const db = getDb();
    return db
        .prepare(
            `
        SELECT t.*, m.name as market_name, m.unit
        FROM trades t
        JOIN markets m ON t.market_id = m.id
        ORDER BY t.placed_at DESC
        LIMIT ?
    `,
        )
        .all(limit);
}

/**
 * Get trades grouped by date+market for the Trade Log
 */
export function getTradeLog(limit = 30) {
    const db = getDb();
    return db
        .prepare(
            `
        SELECT
            t.target_date,
            t.market_id,
            m.name as market_name,
            t.type,
            t.mode,
            t.placed_at,
            t.total_cost,
            t.total_proceeds,
            t.status,
            t.id as trade_id,
            s.phase,
            s.status as session_status,
            s.initial_forecast_temp
        FROM trades t
        JOIN markets m ON t.market_id = m.id
        LEFT JOIN sessions s ON t.session_id = s.id
        ORDER BY t.target_date DESC, t.placed_at ASC
        LIMIT ?
    `,
        )
        .all(limit);
}

// ── Positions ────────────────────────────────────────────────────────────

/**
 * Insert positions for a trade (batch)
 */
export function insertPositions(tradeId, positions) {
    const db = getDb();
    const stmt = db.prepare(`
        INSERT INTO positions (trade_id, label, question, polymarket_id, condition_id, clob_token_ids, order_id, token_id, price, shares, status, fill_price, fill_shares, error)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertMany = db.transaction((rows) => {
        for (const p of rows) {
            stmt.run(
                tradeId,
                p.label,
                p.question,
                p.marketId || p.polymarket_id,
                p.conditionId || p.condition_id,
                p.clobTokenIds ? JSON.stringify(p.clobTokenIds) : p.clob_token_ids || null,
                p.orderId || p.order_id || null,
                p.tokenId || p.token_id || null,
                p.buyPrice || p.price || 0,
                p.shares || p.size || 0,
                p.status || 'placed',
                p.fillPrice || p.fill_price || null,
                p.fillShares || p.fill_shares || null,
                p.error || null,
            );
        }
    });

    insertMany(positions);
}

/**
 * Get positions for a trade
 */
export function getPositionsForTrade(tradeId) {
    const db = getDb();
    return db.prepare('SELECT * FROM positions WHERE trade_id = ?').all(tradeId);
}

/**
 * Get all active positions (not sold/redeemed) for a date
 */
export function getActivePositions(targetDate) {
    const db = getDb();
    return db
        .prepare(
            `
        SELECT p.*, t.target_date, t.type as trade_type, t.market_id
        FROM positions p
        JOIN trades t ON p.trade_id = t.id
        WHERE t.target_date = ?
          AND p.status NOT IN ('sold', 'redeemed', 'failed')
          AND t.type = 'buy'
        ORDER BY p.label
    `,
        )
        .all(targetDate);
}

export function getAllPositionsForDate(targetDate) {
    const db = getDb();
    return db
        .prepare(
            `
        SELECT p.*, t.target_date, t.type as trade_type, t.market_id
        FROM positions p
        JOIN trades t ON p.trade_id = t.id
        WHERE t.target_date = ?
          AND t.type = 'buy'
        ORDER BY p.label
    `,
        )
        .all(targetDate);
}

/**
 * Update position status (sold, redeemed, etc.).
 * Uses an explicit column whitelist to prevent SQL injection.
 */
const ALLOWED_POSITION_UPDATE_FIELDS = {
    status: 'status',
    label: 'label',
    orderId: 'order_id',
    order_id: 'order_id',
    tokenId: 'token_id',
    token_id: 'token_id',
    price: 'price',
    shares: 'shares',
    fillPrice: 'fill_price',
    fill_price: 'fill_price',
    fillShares: 'fill_shares',
    fill_shares: 'fill_shares',
    error: 'error',
    soldAt: 'sold_at',
    sold_at: 'sold_at',
    sellPrice: 'sell_price',
    sell_price: 'sell_price',
    sellOrderId: 'sell_order_id',
    sell_order_id: 'sell_order_id',
    redeemedAt: 'redeemed_at',
    redeemed_at: 'redeemed_at',
    redeemedValue: 'redeemed_value',
    redeemed_value: 'redeemed_value',
    redeemedTx: 'redeemed_tx',
    redeemed_tx: 'redeemed_tx',
};

export function updatePosition(id, updates) {
    const db = getDb();
    const fields = [];
    const values = [];
    for (const [key, val] of Object.entries(updates)) {
        const col = ALLOWED_POSITION_UPDATE_FIELDS[key];
        if (!col) continue; // silently ignore unknown fields
        fields.push(`${col} = ?`);
        values.push(val);
    }
    if (fields.length === 0) return { changes: 0 };
    values.push(id);
    return db.prepare(`UPDATE positions SET ${fields.join(', ')} WHERE id = ?`).run(...values);
}

/**
 * Mark position as sold
 */
export function markPositionSold(positionId, { sellPrice, soldAt, sellOrderId }) {
    const db = getDb();
    return db
        .prepare(
            `
        UPDATE positions SET status = 'sold', sell_price = ?, sold_at = ?, sell_order_id = ?
        WHERE id = ?
    `,
        )
        .run(sellPrice, soldAt, sellOrderId, positionId);
}

/**
 * Mark position as redeemed
 */
export function markPositionRedeemed(positionId, { redeemedValue, redeemedAt, redeemedTx }) {
    const db = getDb();
    return db
        .prepare(
            `
        UPDATE positions SET status = 'redeemed', redeemed_value = ?, redeemed_at = ?, redeemed_tx = ?
        WHERE id = ?
    `,
        )
        .run(redeemedValue, redeemedAt, redeemedTx, positionId);
}

/**
 * Mark position(s) by condition_id + target_date as redeemed or burned.
 * Used by the auto-redeem CronJob which has conditionId but not DB position ID.
 *
 * @param {string} conditionId
 * @param {string} targetDate - e.g. '2026-03-29'
 * @param {Object} updates - { status, redeemedAt, redeemedValue, redeemedTx, fillShares }
 * @returns {Object} { changes }
 */
export function markPositionByCondition(conditionId, targetDate, updates) {
    const db = getDb();
    const fields = [];
    const values = [];

    // Build dynamic SET clause from allowed fields
    const allowed = {
        status: 'status',
        redeemedAt: 'redeemed_at',
        redeemedValue: 'redeemed_value',
        redeemedTx: 'redeemed_tx',
        fillShares: 'fill_shares',
    };
    for (const [key, col] of Object.entries(allowed)) {
        if (updates[key] !== undefined) {
            fields.push(`${col} = ?`);
            values.push(updates[key]);
        }
    }
    if (fields.length === 0) return { changes: 0 };

    // Find positions by condition_id joined through trades with matching target_date
    values.push(conditionId, targetDate);
    return db.prepare(`
        UPDATE positions SET ${fields.join(', ')}
        WHERE condition_id = ? AND trade_id IN (
            SELECT id FROM trades WHERE target_date = ?
        )
    `).run(...values);
}

// ── Snapshots ────────────────────────────────────────────────────────────

/**
 * Insert a monitoring snapshot
 */
export function insertSnapshot(snapshot) {
    const db = getDb();
    return db
        .prepare(
            `
        INSERT INTO snapshots (
            session_id, timestamp, forecast_temp, forecast_source, forecast_change,
            current_temp, max_today, current_conditions, phase, days_until_target,
            target_question, target_price, target_price_change,
            below_question, below_price, below_price_change,
            above_question, above_price, above_price_change,
            total_cost, range_shifted, shifted_from, event_closed
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
        )
        .run(
            snapshot.sessionId,
            snapshot.timestamp,
            snapshot.forecastTempF || snapshot.forecast_temp,
            snapshot.forecastSource || snapshot.forecast_source,
            snapshot.forecastChange || snapshot.forecast_change || 0,
            snapshot.currentTempF || snapshot.current_temp || null,
            snapshot.maxTodayF || snapshot.max_today || null,
            snapshot.currentConditions || snapshot.current_conditions || null,
            snapshot.phase,
            snapshot.daysUntilTarget || snapshot.days_until_target,
            snapshot.target?.question || snapshot.target_question,
            snapshot.target?.yesPrice || snapshot.target_price,
            snapshot.target?.priceChange || snapshot.target_price_change || 0,
            snapshot.below?.question || snapshot.below_question || null,
            snapshot.below?.yesPrice || snapshot.below_price || null,
            snapshot.below?.priceChange || snapshot.below_price_change || 0,
            snapshot.above?.question || snapshot.above_question || null,
            snapshot.above?.yesPrice || snapshot.above_price || null,
            snapshot.above?.priceChange || snapshot.above_price_change || 0,
            snapshot.totalCost || snapshot.total_cost || null,
            snapshot.rangeShifted ? 1 : 0,
            snapshot.shiftedFrom || snapshot.shifted_from || null,
            snapshot.eventClosed ? 1 : 0,
        );
}

/**
 * Get snapshots for chart rendering
 */
export function getSnapshots(sessionId, limit = 500) {
    const db = getDb();
    return db
        .prepare(
            `
        SELECT * FROM snapshots WHERE session_id = ? ORDER BY timestamp ASC LIMIT ?
    `,
        )
        .all(sessionId, limit);
}

// ── Alerts ───────────────────────────────────────────────────────────────

/**
 * Insert an alert
 */
export function insertAlert({ sessionId, timestamp, type, message, data }) {
    const db = getDb();
    return db
        .prepare(
            `
        INSERT INTO alerts (session_id, timestamp, type, message, data)
        VALUES (?, ?, ?, ?, ?)
    `,
        )
        .run(sessionId, timestamp, type, message, data ? JSON.stringify(data) : null);
}

/**
 * Insert multiple alerts in a single transaction (batch)
 */
export function insertAlertsBatch(alerts) {
    if (!alerts || alerts.length === 0) return;
    const db = getDb();
    const stmt = db.prepare(`INSERT INTO alerts (session_id, timestamp, type, message, data) VALUES (?, ?, ?, ?, ?)`);
    const insertMany = db.transaction((items) => {
        for (const a of items) {
            stmt.run(a.sessionId, a.timestamp, a.type, a.message, a.data ? JSON.stringify(a.data) : null);
        }
    });
    insertMany(alerts);
}

// ── Historical Analytics ─────────────────────────────────────────────────

/**
 * Get detailed per-trade performance with forecast context.
 * Joins trades → positions → sessions → snapshots to build
 * a complete picture of each trade's lifecycle.
 *
 * @param {string} [from] - Start date (inclusive), e.g. '2026-03-01'
 * @param {string} [to]   - End date (inclusive), e.g. '2026-03-27'
 * @returns {{ trades: Array, summary: Object }}
 */
export function getTradePerformance(from, to, marketId) {
    const db = getDb();

    // Build date filter — two versions: with 't.' alias (for buy query) and without (for sell query)
    let dateFilterAliased = '';
    let dateFilterDirect = '';
    const params = [];
    if (from) { dateFilterAliased += ' AND t.target_date >= ?'; dateFilterDirect += ' AND target_date >= ?'; params.push(from); }
    if (to)   { dateFilterAliased += ' AND t.target_date <= ?'; dateFilterDirect += ' AND target_date <= ?'; params.push(to); }
    if (marketId && marketId !== 'all') { dateFilterAliased += ' AND t.market_id = ?'; dateFilterDirect += ' AND market_id = ?'; params.push(marketId); }

    // Get all buy trades with session context
    const buyTrades = db.prepare(`
        SELECT
            t.id as trade_id,
            t.session_id,
            t.market_id,
            t.target_date,
            t.placed_at,
            t.mode,
            t.total_cost,
            t.total_proceeds,
            t.status as trade_status,
            t.actual_cost,
            s.initial_forecast_temp,
            s.initial_target_range,
            s.status as session_status,
            s.phase as session_phase
        FROM trades t
        LEFT JOIN sessions s ON t.session_id = s.id
        WHERE t.type = 'buy'
          AND t.status != 'failed'
          ${dateFilterAliased}
        ORDER BY t.target_date DESC, t.placed_at ASC
    `).all(...params);

    // Get all sell/redeem trades indexed by target_date
    const sellTrades = db.prepare(`
        SELECT target_date, type, total_proceeds, placed_at
        FROM trades
        WHERE type IN ('sell', 'redeem')
          AND status != 'failed'
          ${dateFilterDirect}
        ORDER BY target_date, placed_at
    `).all(...params);

    const sellByDate = {};
    for (const st of sellTrades) {
        if (!sellByDate[st.target_date]) sellByDate[st.target_date] = [];
        sellByDate[st.target_date].push(st);
    }

    const trades = [];
    let totalCost = 0;
    let totalProceeds = 0;
    let wins = 0;
    let losses = 0;
    let bestTrade = null;
    let worstTrade = null;

    for (const bt of buyTrades) {
        // Get positions for this trade
        const positions = db.prepare(`
            SELECT label, question, price, shares, fill_price, fill_shares,
                   status, sell_price, sold_at, redeemed_value, redeemed_at
            FROM positions
            WHERE trade_id = ?
            ORDER BY label
        `).all(bt.trade_id);

        // Get forecast at time of buy (closest snapshot to placed_at)
        let forecastAtBuy = bt.initial_forecast_temp;
        if (bt.session_id) {
            const buySnap = db.prepare(`
                SELECT forecast_temp
                FROM snapshots
                WHERE session_id = ?
                  AND timestamp <= ?
                ORDER BY timestamp DESC
                LIMIT 1
            `).get(bt.session_id, bt.placed_at);
            if (buySnap) forecastAtBuy = buySnap.forecast_temp;
        }

        // Get final forecast (last snapshot for this session)
        let finalForecast = forecastAtBuy;
        if (bt.session_id) {
            const lastSnap = db.prepare(`
                SELECT forecast_temp
                FROM snapshots
                WHERE session_id = ?
                ORDER BY timestamp DESC
                LIMIT 1
            `).get(bt.session_id);
            if (lastSnap) finalForecast = lastSnap.forecast_temp;
        }

        // Get forecast trend (sampled — every Nth snapshot)
        let forecastTrend = [];
        if (bt.session_id) {
            const allSnaps = db.prepare(`
                SELECT timestamp, forecast_temp, target_price, phase
                FROM snapshots
                WHERE session_id = ?
                ORDER BY timestamp ASC
            `).all(bt.session_id);

            // Sample to ~30 points max for sparklines
            const step = Math.max(1, Math.floor(allSnaps.length / 30));
            forecastTrend = allSnaps
                .filter((_, i) => i % step === 0 || i === allSnaps.length - 1)
                .map(s => ({
                    t: s.timestamp,
                    temp: s.forecast_temp,
                    price: s.target_price,
                    phase: s.phase,
                }));
        }

        // Compute realized P&L for this trade
        const cost = bt.actual_cost || bt.total_cost || 0;
        const dateSells = sellByDate[bt.target_date] || [];
        const dateProceeds = dateSells.reduce((s, st) => s + (st.total_proceeds || 0), 0);

        // Position-level P&L
        const positionsOut = positions.map(p => {
            const buyVal = (p.fill_price || p.price || 0) * (p.fill_shares || p.shares || 0);
            let sellVal = 0;
            if (p.status === 'sold' && p.sell_price != null) {
                sellVal = p.sell_price * (p.fill_shares || p.shares || 0);
            } else if (p.status === 'redeemed' && p.redeemed_value != null) {
                sellVal = p.redeemed_value;
            }
            return {
                label: p.label,
                question: p.question,
                buyPrice: p.fill_price || p.price,
                shares: p.fill_shares || p.shares,
                sellPrice: p.sell_price,
                redeemedValue: p.redeemed_value,
                status: p.status,
                pnl: sellVal > 0 ? parseFloat((sellVal - buyVal).toFixed(4)) : null,
            };
        });

        const realizedPnL = dateProceeds > 0
            ? parseFloat((dateProceeds - cost).toFixed(4))
            : null;

        const realizedPnLPct = realizedPnL != null && cost > 0
            ? parseFloat(((realizedPnL / cost) * 100).toFixed(1))
            : null;

        const outcome = realizedPnL == null ? 'pending'
            : realizedPnL > 0 ? 'profit' : realizedPnL < 0 ? 'loss' : 'breakeven';

        totalCost += cost;
        if (dateProceeds > 0) totalProceeds += dateProceeds;
        if (realizedPnL != null && realizedPnL > 0) wins++;
        if (realizedPnL != null && realizedPnL < 0) losses++;
        if (realizedPnL != null && (bestTrade == null || realizedPnL > bestTrade.pnl)) {
            bestTrade = { date: bt.target_date, pnl: realizedPnL };
        }
        if (realizedPnL != null && (worstTrade == null || realizedPnL < worstTrade.pnl)) {
            worstTrade = { date: bt.target_date, pnl: realizedPnL };
        }

        trades.push({
            targetDate: bt.target_date,
            marketId: bt.market_id,
            sessionId: bt.session_id,
            placedAt: bt.placed_at,
            mode: bt.mode,
            totalCost: parseFloat(cost.toFixed(4)),
            initialForecast: bt.initial_forecast_temp,
            initialTargetRange: bt.initial_target_range,
            forecastAtBuy: forecastAtBuy,
            finalForecast: finalForecast,
            forecastTrend,
            positions: positionsOut,
            outcome,
            realizedPnL,
            realizedPnLPct,
            sessionStatus: bt.session_status,
            sessionPhase: bt.session_phase,
        });
    }

    const settled = wins + losses;
    const summary = {
        totalTrades: buyTrades.length,
        settledTrades: settled,
        totalCost: parseFloat(totalCost.toFixed(4)),
        totalProceeds: parseFloat(totalProceeds.toFixed(4)),
        netPnL: parseFloat((totalProceeds - totalCost).toFixed(4)),
        winRate: settled > 0 ? parseFloat((wins / settled).toFixed(3)) : null,
        wins,
        losses,
        avgPnLPerTrade: settled > 0 ? parseFloat(((totalProceeds - totalCost) / settled).toFixed(4)) : null,
        bestTrade,
        worstTrade,
    };

    return { trades, summary };
}

/**
 * Get the full forecast timeline for a specific session (for expanded sparkline view).
 */
export function getForecastTimeline(sessionId) {
    const db = getDb();
    return db.prepare(`
        SELECT timestamp, forecast_temp, forecast_change, target_price,
               below_price, above_price, phase, current_temp, max_today
        FROM snapshots
        WHERE session_id = ?
        ORDER BY timestamp ASC
    `).all(sessionId);
}

// ── Markets ──────────────────────────────────────────────────────────────

/**
 * Get all active markets
 */
export function getActiveMarkets() {
    const db = getDb();
    return db.prepare('SELECT * FROM markets WHERE active = 1').all();
}

/**
 * Get a single market by ID
 */
export function getMarketById(id) {
    const db = getDb();
    return db.prepare('SELECT * FROM markets WHERE id = ?').get(id);
}

/**
 * Add a new market
 */
export function addMarket({ id, name, slugTemplate, unit, stationLat, stationLon, stationName, timezone }) {
    const db = getDb();
    return db
        .prepare(
            `
        INSERT OR IGNORE INTO markets (id, name, slug_template, unit, station_lat, station_lon, station_name, timezone)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
        )
        .run(id, name, slugTemplate, unit || 'F', stationLat, stationLon, stationName, timezone || 'America/New_York');
}

/**
 * Update a market's active status
 */
export function setMarketActive(id, active) {
    const db = getDb();
    return db.prepare('UPDATE markets SET active = ? WHERE id = ?').run(active ? 1 : 0, id);
}

/**
 * Update market fields (partial update — only supplied fields are changed).
 */
export function updateMarket(id, fields) {
    const db = getDb();
    const allowed = ['name', 'slug_template', 'unit', 'station_lat', 'station_lon', 'station_name', 'timezone', 'daily_budget', 'active'];
    const sets = [];
    const values = [];
    for (const [key, val] of Object.entries(fields)) {
        if (allowed.includes(key)) {
            sets.push(`${key} = ?`);
            values.push(val);
        }
    }
    if (sets.length === 0) return { changes: 0 };
    values.push(id);
    return db.prepare(`UPDATE markets SET ${sets.join(', ')} WHERE id = ?`).run(...values);
}

/**
 * Get today's spend per market (sum of buy trades' actual_cost or total_cost).
 * Used for budget enforcement.
 * @param {string} today - ISO date string (YYYY-MM-DD)
 * @returns {Object} Map of marketId → totalSpent
 */
export function getDailySpendByMarket(today) {
    const db = getDb();
    const rows = db.prepare(`
        SELECT market_id, SUM(COALESCE(actual_cost, total_cost)) as total_spent
        FROM trades
        WHERE type = 'buy' AND status != 'failed'
          AND created_at >= ? AND created_at < date(?, '+1 day')
        GROUP BY market_id
    `).all(today, today);

    const result = {};
    for (const row of rows) {
        result[row.market_id] = row.total_spent || 0;
    }
    return result;
}

/**
 * Get all registered markets.
 * @returns {Array} List of market objects
 */
export function getMarkets() {
    const db = getDb();
    try {
        return db.prepare('SELECT id, name, slug_template, unit, station_lat, station_lon, station_name, timezone, daily_budget, active FROM markets ORDER BY id').all();
    } catch {
        // Table may not exist yet — return fallback
        return [{ id: 'nyc', name: 'NYC Temperature', unit: 'F', timezone: 'America/New_York' }];
    }
}

