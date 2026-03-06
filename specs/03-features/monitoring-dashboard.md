# Feature: Phase 2 — Monitoring Dashboard

## Overview
Phase 2 adds periodic monitoring of active temperature markets. Instead of a single snapshot (Phase 1), TempEdge will:

1. **Run periodic re-checks** — re-fetch weather forecast + market prices at configurable intervals
2. **Track price movements** — append snapshots to a history file for each target date
3. **Detect forecast shifts** — alert when the forecast changes enough to shift the target range
4. **Web dashboard** — a local browser UI showing live status, price history charts, and alerts

## Commands

### `node src/index.js` (unchanged)
Single-shot: fetch forecast → discover market → select ranges → write output.

### `node src/monitor.js [date]`
Start the monitoring loop for a specific date (defaults to tomorrow):

```
node src/monitor.js                # Monitor tomorrow
node src/monitor.js 2026-03-08     # Monitor specific date
```

Behavior:
1. Run the Phase 1 pipeline immediately on startup
2. Schedule re-checks every N minutes (default: 15 min, configurable)
3. On each re-check:
   - Re-fetch forecast from Open-Meteo
   - Re-fetch market prices from Gamma API
   - Compare with previous snapshot
   - Detect forecast shift / price movement / range shift
   - Append update to history file
   - Log summary to console
4. Stop when the market closes (event.closed === true) or the target date passes

### `node src/dashboard.js`
Start a local HTTP server serving the monitoring dashboard:

```
node src/dashboard.js              # Default port 3000
node src/dashboard.js --port 8080  # Custom port
```

## Monitoring Data Model

### MonitoringSession
```javascript
/**
 * @typedef {Object} MonitoringSession
 * @property {string} id - Session UUID
 * @property {string} targetDate - e.g. "2026-03-08"
 * @property {string} startedAt - ISO timestamp
 * @property {string} status - "active" | "completed" | "stopped"
 * @property {number} intervalMinutes - Re-check interval
 * @property {MonitoringSnapshot[]} snapshots - Time series of checks
 * @property {MonitoringAlert[]} alerts - Triggered alerts
 */
```

### MonitoringSnapshot
```javascript
/**
 * @typedef {Object} MonitoringSnapshot
 * @property {string} timestamp - ISO timestamp
 * @property {number} forecastTempF - Current forecast
 * @property {number} forecastChange - Delta from previous snapshot (°F)
 * @property {SnapshotRange} target - Target range snapshot
 * @property {SnapshotRange|null} below - Below range snapshot
 * @property {SnapshotRange|null} above - Above range snapshot
 * @property {number} totalCost - Sum of YES prices
 * @property {boolean} rangeShifted - True if target range changed from previous
 * @property {string|null} shiftedFrom - Previous range question if shifted
 */
```

### SnapshotRange
```javascript
/**
 * @typedef {Object} SnapshotRange
 * @property {string} marketId
 * @property {string} question - e.g. "46-47°F"
 * @property {number} yesPrice - Current YES price
 * @property {number} priceChange - Delta from previous snapshot
 * @property {number} impliedProbability
 * @property {number} volume
 */
```

### MonitoringAlert
```javascript
/**
 * @typedef {Object} MonitoringAlert
 * @property {string} timestamp - ISO timestamp
 * @property {string} type - "forecast_shift" | "range_shift" | "price_spike" | "market_closed"
 * @property {string} message - Human-readable alert message
 * @property {Object} data - Alert-specific data
 */
```

## Alert Conditions

| Alert Type        | Trigger                                                         | Severity |
|-------------------|-----------------------------------------------------------------|----------|
| `forecast_shift`  | Forecast changes by ≥ 1°F from initial forecast                | ⚠️ Warn  |
| `range_shift`     | Forecast change causes the target range to change               | 🔴 High  |
| `price_spike`     | Any selected range YES price changes by ≥ 5¢ in one interval   | ⚠️ Warn  |
| `market_closed`   | The event's `closed` flag becomes true                          | ✅ Info  |

## Storage

### File: `output/monitor-{date}.json`
```json
{
  "session": { ... },
  "snapshots": [ ... ],
  "alerts": [ ... ]
}
```

Each monitoring run appends to the same file for the target date. If restarted, it picks up the existing session or starts a new one.

## Dashboard UI

### Route: `GET /`
Single-page dashboard showing:

1. **Header** — Target date, forecast, session status
2. **Selected Ranges Card** — Current prices for target/below/above with sparkline-style change indicators
3. **Price History Chart** — Line chart of YES prices over time for the 3 selected ranges
4. **Forecast Tracker** — Shows forecast changes over time
5. **Alert Feed** — Chronological list of alerts with severity indicators
6. **All Ranges Table** — Full range table with current prices (like Phase 1 console output)

### Route: `GET /api/status`
JSON endpoint returning current session state.

### Route: `GET /api/snapshots`
JSON endpoint returning all snapshots for charting.

### Tech Stack
- **Server**: Node.js native `http` module (no Express dependency needed for Phase 2)
- **Frontend**: Single HTML file with inline CSS/JS
- **Charts**: Lightweight inline SVG or Canvas charting (no external dependencies)
- **Updates**: Poll `/api/status` every 15 seconds from the browser

## Implementation Plan

### Step 1: Monitoring Service (`src/services/monitor.js`)
- `startMonitoring(targetDate, intervalMinutes)` — main loop
- `takeSnapshot(targetDate, previousSnapshot)` — single re-check
- `detectAlerts(currentSnapshot, previousSnapshot, initialForecast)` — alert logic
- File I/O for session persistence

### Step 2: Monitor Entry Point (`src/monitor.js`)
- CLI argument parsing
- Start monitoring loop with `setInterval`
- Graceful shutdown on SIGINT
- Console output with colored status

### Step 3: Dashboard Server (`src/dashboard.js`)
- HTTP server with static HTML + API routes
- Reads monitoring session file on each request
- Serves the dashboard UI

### Step 4: Dashboard Frontend (inline in HTML)
- Responsive single-page layout
- Auto-refreshing price chart
- Alert feed with color-coded severity
