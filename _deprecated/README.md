# Deprecated — Pre-Microservices Code

These files are the **original monolith implementation** that was decomposed into
the microservices architecture in `services/`.

**Do not import or run these files** — use the corresponding microservice instead.

## Mapping

| Deprecated File | Replaced By |
|:----------------|:------------|
| `services/monitor.js` | `services/monitor/orchestrator.js` |
| `services/trading.js` | `services/trading-svc/{buy,sell,redeem,verify,client}.js` |
| `services/liquidityStream.js` | `services/liquidity-svc/index.js` |
| `services/polymarket.js` | `services/market-svc/index.js` |
| `services/weather.js` | `services/weather-svc/index.js` |
| `services/rangeSelector.js` | Inlined in `services/market-svc/index.js` |
| `liquidity.js` | `services/liquidity-svc/index.js` |
| `monitor.js` | `services/monitor/index.js` |
| `index.js` | Obsolete monolith entry point |
| `dashboard/` | `services/dashboard-svc/` |
| `models/types.js` | Inlined in each service |

## `src/` (moved here 2026-03-23)

Previously lived at `<root>/src/`. Consolidated into `_deprecated/` since nothing
in the active `services/` or `shared/` directories references it.

| File | Superseded By |
|:-----|:-------------|
| `src/config.js` | `shared/configSchema.js` |
| `src/utils/dateUtils.js` | `shared/dates.js` |
| `src/db/` | `services/data-svc/db.js` + `queries.js` |
| `src/scripts/redeem.js` | `services/trading-svc/redeem.js` |
| `src/scripts/approve-usdc.js` | One-off, no longer needed |
| `src/scripts/backfill-*.js` | One-off DB migration scripts |
| `src/scripts/reconcile.js` | One-off reconciliation |
