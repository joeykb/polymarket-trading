-- TempEdge Database Schema
-- SQLite with WAL mode for concurrent read access across containers

-- Enable WAL mode for multi-process safety (monitor writes, dashboard reads)
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
PRAGMA foreign_keys = ON;

-- ── Markets ──────────────────────────────────────────────────────────────
-- Each market represents a city/location with its own slug pattern and weather config
CREATE TABLE IF NOT EXISTS markets (
    id          TEXT PRIMARY KEY,        -- e.g. 'nyc', 'london'
    name        TEXT NOT NULL,           -- e.g. 'NYC Temperature'
    slug_template TEXT NOT NULL,         -- e.g. 'highest-temperature-in-nyc-on-{date}'
    unit        TEXT NOT NULL DEFAULT 'F', -- 'F' or 'C'
    station_lat REAL,
    station_lon REAL,
    station_name TEXT,                   -- e.g. 'KLGA', 'EGLL'
    active      INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Sessions ─────────────────────────────────────────────────────────────
-- One session per target date per market. Replaces the JSON session files.
CREATE TABLE IF NOT EXISTS sessions (
    id                    TEXT PRIMARY KEY,  -- UUID
    market_id             TEXT NOT NULL REFERENCES markets(id),
    target_date           TEXT NOT NULL,     -- e.g. '2026-03-20'
    status                TEXT NOT NULL DEFAULT 'active', -- active|completed|stopped
    phase                 TEXT NOT NULL DEFAULT 'scout',  -- scout|track|buy|monitor|resolve
    initial_forecast_temp REAL,
    initial_target_range  TEXT,
    forecast_source       TEXT,
    interval_minutes      INTEGER NOT NULL DEFAULT 15,
    rebalance_threshold   REAL NOT NULL DEFAULT 3.0,
    started_at            TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at            TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(market_id, target_date)
);

-- ── Trades ───────────────────────────────────────────────────────────────
-- Append-only log of every buy, sell, and redeem. Survives pod restarts!
CREATE TABLE IF NOT EXISTS trades (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id      TEXT REFERENCES sessions(id),
    market_id       TEXT NOT NULL REFERENCES markets(id),
    target_date     TEXT NOT NULL,
    type            TEXT NOT NULL,       -- 'buy', 'sell', 'redeem'
    mode            TEXT NOT NULL DEFAULT 'live', -- 'live', 'dry-run'
    placed_at       TEXT NOT NULL DEFAULT (datetime('now')),
    total_cost      REAL NOT NULL DEFAULT 0,
    total_proceeds  REAL NOT NULL DEFAULT 0,
    status          TEXT NOT NULL DEFAULT 'placed', -- placed|filled|failed|redeemed
    verified_at     TEXT,
    actual_cost     REAL,
    fill_summary    TEXT,               -- JSON: {filled, partial, unfilled}
    metadata        TEXT                -- JSON for extra fields (liquidityWait, etc.)
);

-- ── Positions ────────────────────────────────────────────────────────────
-- Individual token-level positions within a trade. Tracks full lifecycle.
CREATE TABLE IF NOT EXISTS positions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    trade_id        INTEGER NOT NULL REFERENCES trades(id),
    label           TEXT,               -- 'target', 'below', 'above'
    question        TEXT NOT NULL,      -- Full market question
    polymarket_id   TEXT,               -- Polymarket market ID
    condition_id    TEXT,
    clob_token_ids  TEXT,               -- JSON array of token IDs
    order_id        TEXT,               -- CLOB order ID
    token_id        TEXT,               -- Primary token ID used
    price           REAL NOT NULL DEFAULT 0,  -- Buy or sell price
    shares          REAL NOT NULL DEFAULT 0,
    status          TEXT NOT NULL DEFAULT 'placed', -- placed|filled|partial|failed|sold|redeemed
    fill_price      REAL,
    fill_shares     REAL,
    error           TEXT,
    -- Sell tracking
    sold_at         TEXT,
    sell_price      REAL,
    sell_order_id   TEXT,
    -- Redeem tracking
    redeemed_at     TEXT,
    redeemed_value  REAL,
    redeemed_tx     TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Snapshots ────────────────────────────────────────────────────────────
-- Time-series of forecast + price data points. Replaces JSON snapshot arrays.
CREATE TABLE IF NOT EXISTS snapshots (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id        TEXT NOT NULL REFERENCES sessions(id),
    timestamp         TEXT NOT NULL,
    forecast_temp     REAL,
    forecast_source   TEXT,
    forecast_change   REAL DEFAULT 0,
    current_temp      REAL,
    max_today         REAL,
    current_conditions TEXT,
    phase             TEXT,
    days_until_target INTEGER,
    -- Price data for the 3 ranges
    target_question   TEXT,
    target_price      REAL,
    target_price_change REAL DEFAULT 0,
    below_question    TEXT,
    below_price       REAL,
    below_price_change REAL DEFAULT 0,
    above_question    TEXT,
    above_price       REAL,
    above_price_change REAL DEFAULT 0,
    total_cost        REAL,
    range_shifted     INTEGER DEFAULT 0,
    shifted_from      TEXT,
    event_closed      INTEGER DEFAULT 0
);

-- ── Alerts ───────────────────────────────────────────────────────────────
-- Queryable alert history (forecast shifts, price spikes, buy triggers)
CREATE TABLE IF NOT EXISTS alerts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  TEXT NOT NULL REFERENCES sessions(id),
    timestamp   TEXT NOT NULL,
    type        TEXT NOT NULL, -- forecast_shift|range_shift|price_spike|buy_executed|phase_change
    message     TEXT,
    data        TEXT           -- JSON
);

-- ── Indexes ──────────────────────────────────────────────────────────────
-- Query patterns: by date, by session, by market, by status

CREATE INDEX IF NOT EXISTS idx_sessions_market_date ON sessions(market_id, target_date);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
CREATE INDEX IF NOT EXISTS idx_trades_session ON trades(session_id);
CREATE INDEX IF NOT EXISTS idx_trades_date ON trades(target_date);
CREATE INDEX IF NOT EXISTS idx_trades_type ON trades(type);
CREATE INDEX IF NOT EXISTS idx_trades_market_date ON trades(market_id, target_date);
CREATE INDEX IF NOT EXISTS idx_positions_trade ON positions(trade_id);
CREATE INDEX IF NOT EXISTS idx_positions_condition ON positions(condition_id);
CREATE INDEX IF NOT EXISTS idx_positions_status ON positions(status);
CREATE INDEX IF NOT EXISTS idx_snapshots_session ON snapshots(session_id);
CREATE INDEX IF NOT EXISTS idx_snapshots_timestamp ON snapshots(timestamp);
CREATE INDEX IF NOT EXISTS idx_snapshots_session_ts ON snapshots(session_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_alerts_session ON alerts(session_id);
CREATE INDEX IF NOT EXISTS idx_alerts_type ON alerts(type);
CREATE INDEX IF NOT EXISTS idx_alerts_session_ts ON alerts(session_id, timestamp);

-- ── Config Overrides ────────────────────────────────────────────────────
-- Admin overrides stored in DB (previously in config-overrides.json).
-- Survives pod restarts since the DB lives on the PVC.
CREATE TABLE IF NOT EXISTS config_overrides (
    section     TEXT NOT NULL,           -- e.g. 'trading', 'monitor'
    field       TEXT NOT NULL,           -- e.g. 'mode', 'intervalMinutes'
    value       TEXT NOT NULL,           -- stored as text, cast by consumer
    updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (section, field)
);
