# Deprecated — Pre-Microservices Monolith Code

These files are the **original monolith implementation** that was decomposed into
the microservices architecture in `services/`.

They are preserved here for reference only. **Do not import or run these files** —
use the corresponding microservice instead.

## Mapping

| Deprecated File | Replaced By |
|:----------------|:------------|
| `services/monitor.js` (57KB) | `services/monitor/orchestrator.js` |
| `services/trading.js` (41KB) | `services/trading-svc/trading.js` |
| `services/liquidityStream.js` (17KB) | `services/liquidity-svc/index.js` |
| `services/polymarket.js` (11KB) | `services/market-svc/index.js` |
| `services/weather.js` (10KB) | `services/weather-svc/index.js` |
| `services/rangeSelector.js` (3KB) | Inlined in `services/market-svc/index.js` |
| `liquidity.js` (24KB) | `services/liquidity-svc/index.js` |
| `monitor.js` (16KB) | `services/monitor/index.js` |
| `index.js` (9KB) | Obsolete monolith entry point |
| `dashboard/` | `services/dashboard-svc/` |
| `models/types.js` | Inlined in each service |

## Still Active in `src/`

The following files remain in `src/` because they are still referenced:

| File | Used By |
|:-----|:--------|
| `src/config.js` | `shared/dateUtils.js` (to be cleaned up separately) |
| `src/db/` | `src/scripts/*.js` (operational scripts) |
| `src/utils/` | `src/db/` and `src/scripts/` |
| `src/scripts/` | One-off operational tools (redeem, reconcile, backfill, etc.) |
