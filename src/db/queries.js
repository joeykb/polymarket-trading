/**
 * TempEdge Database — Named query functions
 *
 * All database operations go through these functions.
 * Keeps SQL centralized and provides a clean API for the rest of the app.
 */

import { getDb } from './index.js';

// ── Sessions ─────────────────────────────────────────────────────────────

/**
 * Create or update a session
 */
export function upsertSession({ id, marketId, targetDate, status, phase, initialForecastTemp, initialTargetRange, forecastSource, intervalMinutes, rebalanceThreshold }) {
    const db = getDb();
    return db.prepare(`
        INSERT INTO sessions (id, market_id, target_date, status, phase, initial_forecast_temp, initial_target_range, forecast_source, interval_minutes, rebalance_threshold)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            status = excluded.status,
            phase = excluded.phase,
            updated_at = datetime('now')
    `).run(id, marketId || 'nyc', targetDate, status, phase, initialForecastTemp, initialTargetRange, forecastSource, intervalMinutes || 15, rebalanceThreshold || 3.0);
}

/**
 * Update session status/phase
 */
export function updateSession(id, updates) {
    const db = getDb();
    const fields = [];
    const values = [];
    for (const [key, val] of Object.entries(updates)) {
        const col = key.replace(/([A-Z])/g, '_$1').toLowerCase(); // camelCase → snake_case
        fields.push(`${col} = ?`);
        values.push(val);
    }
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
    const result = db.prepare(`
        INSERT INTO trades (session_id, market_id, target_date, type, mode, placed_at, total_cost, total_proceeds, status, metadata)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        sessionId, marketId || 'nyc', targetDate, type, mode || 'live',
        placedAt || new Date().toISOString(),
        totalCost || 0, totalProceeds || 0,
        status || 'placed',
        metadata ? JSON.stringify(metadata) : null,
    );
    return { id: result.lastInsertRowid };
}

/**
 * Update trade after verification
 */
export function updateTrade(id, { status, verifiedAt, actualCost, fillSummary }) {
    const db = getDb();
    return db.prepare(`
        UPDATE trades SET status = ?, verified_at = ?, actual_cost = ?, fill_summary = ?
        WHERE id = ?
    `).run(status, verifiedAt, actualCost, fillSummary ? JSON.stringify(fillSummary) : null, id);
}

/**
 * Get all trades for a date (across markets)
 */
export function getTradesForDate(targetDate) {
    const db = getDb();
    return db.prepare(`
        SELECT t.*, m.name as market_name, m.unit
        FROM trades t
        JOIN markets m ON t.market_id = m.id
        WHERE t.target_date = ?
        ORDER BY t.placed_at
    `).all(targetDate);
}

/**
 * Get all trades for the Trade Log (newest first)
 */
export function getAllTrades(limit = 50) {
    const db = getDb();
    return db.prepare(`
        SELECT t.*, m.name as market_name, m.unit
        FROM trades t
        JOIN markets m ON t.market_id = m.id
        ORDER BY t.placed_at DESC
        LIMIT ?
    `).all(limit);
}

/**
 * Get trades grouped by date+market for the Trade Log
 */
export function getTradeLog(limit = 30) {
    const db = getDb();
    return db.prepare(`
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
    `).all(limit);
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
                p.clobTokenIds ? JSON.stringify(p.clobTokenIds) : (p.clob_token_ids || null),
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
    return db.prepare(`
        SELECT p.*, t.target_date, t.type as trade_type, t.market_id
        FROM positions p
        JOIN trades t ON p.trade_id = t.id
        WHERE t.target_date = ?
          AND p.status NOT IN ('sold', 'redeemed', 'failed')
          AND t.type = 'buy'
        ORDER BY p.label
    `).all(targetDate);
}

/**
 * Update position status (sold, redeemed, etc.)
 */
export function updatePosition(id, updates) {
    const db = getDb();
    const fields = [];
    const values = [];
    for (const [key, val] of Object.entries(updates)) {
        const col = key.replace(/([A-Z])/g, '_$1').toLowerCase();
        fields.push(`${col} = ?`);
        values.push(val);
    }
    values.push(id);
    return db.prepare(`UPDATE positions SET ${fields.join(', ')} WHERE id = ?`).run(...values);
}

/**
 * Mark position as sold
 */
export function markPositionSold(positionId, { sellPrice, soldAt, sellOrderId }) {
    const db = getDb();
    return db.prepare(`
        UPDATE positions SET status = 'sold', sell_price = ?, sold_at = ?, sell_order_id = ?
        WHERE id = ?
    `).run(sellPrice, soldAt, sellOrderId, positionId);
}

/**
 * Mark position as redeemed
 */
export function markPositionRedeemed(positionId, { redeemedValue, redeemedAt, redeemedTx }) {
    const db = getDb();
    return db.prepare(`
        UPDATE positions SET status = 'redeemed', redeemed_value = ?, redeemed_at = ?, redeemed_tx = ?
        WHERE id = ?
    `).run(redeemedValue, redeemedAt, redeemedTx, positionId);
}

// ── Snapshots ────────────────────────────────────────────────────────────

/**
 * Insert a monitoring snapshot
 */
export function insertSnapshot(snapshot) {
    const db = getDb();
    return db.prepare(`
        INSERT INTO snapshots (
            session_id, timestamp, forecast_temp, forecast_source, forecast_change,
            current_temp, max_today, current_conditions, phase, days_until_target,
            target_question, target_price, target_price_change,
            below_question, below_price, below_price_change,
            above_question, above_price, above_price_change,
            total_cost, range_shifted, shifted_from, event_closed
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
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
    return db.prepare(`
        SELECT * FROM snapshots WHERE session_id = ? ORDER BY timestamp ASC LIMIT ?
    `).all(sessionId, limit);
}

// ── Alerts ───────────────────────────────────────────────────────────────

/**
 * Insert an alert
 */
export function insertAlert({ sessionId, timestamp, type, message, data }) {
    const db = getDb();
    return db.prepare(`
        INSERT INTO alerts (session_id, timestamp, type, message, data)
        VALUES (?, ?, ?, ?, ?)
    `).run(sessionId, timestamp, type, message, data ? JSON.stringify(data) : null);
}

// ── Analytics ────────────────────────────────────────────────────────────

/**
 * Get P&L summary across all dates
 */
export function getPnLSummary() {
    const db = getDb();
    return db.prepare(`
        SELECT
            t.target_date,
            t.market_id,
            m.name as market_name,
            SUM(CASE WHEN t.type = 'buy' THEN t.total_cost ELSE 0 END) as total_bought,
            SUM(CASE WHEN t.type = 'sell' THEN t.total_proceeds ELSE 0 END) as total_sold,
            SUM(CASE WHEN t.type = 'redeem' THEN t.total_proceeds ELSE 0 END) as total_redeemed,
            COUNT(DISTINCT t.id) as trade_count
        FROM trades t
        JOIN markets m ON t.market_id = m.id
        GROUP BY t.target_date, t.market_id
        ORDER BY t.target_date DESC
    `).all();
}

/**
 * Get forecast accuracy over time
 */
export function getForecastAccuracy() {
    const db = getDb();
    return db.prepare(`
        SELECT
            s.target_date,
            s.initial_forecast_temp,
            (SELECT sn.forecast_temp FROM snapshots sn
             WHERE sn.session_id = s.id
             ORDER BY sn.timestamp DESC LIMIT 1) as final_forecast,
            (SELECT sn.current_temp FROM snapshots sn
             WHERE sn.session_id = s.id AND sn.current_temp IS NOT NULL
             ORDER BY sn.timestamp DESC LIMIT 1) as actual_temp,
            s.market_id
        FROM sessions s
        WHERE s.phase IN ('resolve', 'monitor')
        ORDER BY s.target_date DESC
    `).all();
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
 * Add a new market
 */
export function addMarket({ id, name, slugTemplate, unit, stationLat, stationLon, stationName }) {
    const db = getDb();
    return db.prepare(`
        INSERT OR IGNORE INTO markets (id, name, slug_template, unit, station_lat, station_lon, station_name)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, name, slugTemplate, unit || 'F', stationLat, stationLon, stationName);
}
