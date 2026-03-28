# 🌡️ TempEdge — Polymarket Temperature Trading System

**Automated prediction market trading on [Polymarket](https://polymarket.com/) for New York City daily high temperature markets.**

TempEdge monitors weather forecasts, discovers Polymarket temperature binary options, evaluates liquidity and forecast confidence, places orders via the CLOB API, tracks P&L in real time, and automatically redeems winning positions on-chain — all running as Kubernetes microservices behind a VPN sidecar.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────────────┐
│                          tempedge namespace                              │
│                                                                          │
│  ┌────────────┐   ┌────────────┐   ┌──────────────────────────────────┐  │
│  │ weather-svc│   │ market-svc │   │          trading-svc             │  │
│  │   :3002    │   │   :3003    │   │   :3004                          │  │
│  │            │   │            │   │  ┌──────────┐  ┌──────────────┐  │  │
│  │ WC + Meteo │   │ Gamma API  │   │  │  Node    │  │   Gluetun    │  │  │
│  └─────┬──────┘   └─────┬──────┘   │  │  app     │  │   VPN        │  │  │
│        │                │          │  └──────────┘  └──────────────┘  │  │
│        │                │          └────────────┬─────────────────────┘  │
│        │                │                       │                        │
│  ┌─────┴────────────────┴───────────────────────┴────────────────────┐   │
│  │                        monitor (:3002)                            │   │
│  │  Orchestrator: forecast → strategy → liquidity → buy/sell/redeem  │   │
│  └──────────────────────────┬────────────────────────────────────────┘   │
│                             │                                            │
│  ┌──────────────┐    ┌──────┴───────┐    ┌────────────────────────┐      │
│  │ liquidity-svc│    │   data-svc   │    │    dashboard-svc       │      │
│  │    :3001     │    │    :3005     │    │       :3000            │      │
│  │  WebSocket   │    │  SQLite DB   │    │  Portfolio / Admin     │      │
│  │  orderbooks  │    │  Sessions    │    │  Analytics / Trades    │      │
│  └──────────────┘    │  Config      │    └────────────────────────┘      │
│                      │  Trades      │                                    │
│  ┌──────────────┐    │  Metrics     │    ┌────────────────────────┐      │
│  │ auto-redeem  │    └──────────────┘    │    Prometheus          │      │
│  │  CronJob     │                        │    Grafana (optional)  │      │
│  │  every 6h    │                        └────────────────────────┘      │
│  └──────────────┘                                                        │
└──────────────────────────────────────────────────────────────────────────┘
```

### Services

| Service | Port | Description |
|---------|------|-------------|
| **dashboard-svc** | 3000 | Web UI — live portfolio cards, P&L charts, trade log, analytics, admin config |
| **liquidity-svc** | 3001 | WebSocket connection to Polymarket orderbooks per active session |
| **weather-svc** | 3002 | Multi-source weather forecast (Weather Company + Open-Meteo fallback) |
| **market-svc** | 3003 | Polymarket Gamma API integration — event/market/range discovery |
| **trading-svc** | 3004 | Buy, sell, and redeem orders via CLOB API (runs behind VPN sidecar) |
| **data-svc** | 3005 | SQLite database, session/trade persistence, config store, spend tracking |
| **monitor** | — | Core orchestrator — runs on a timer, coordinates all services, strategy engine |
| **auto-redeem** | — | Kubernetes CronJob — scans & redeems on-chain positions every 6 hours |

### Shared Modules

| Module | Purpose |
|--------|---------|
| `shared/services.js` | Service registry — single source of truth for all inter-service URLs |
| `shared/health.js` | Health check responses with dependency monitoring |
| `shared/logger.js` | Structured JSON logging with `X-Request-Id` correlation |
| `shared/httpClient.js` | HTTP client with timeout, JSON handling, correlation ID propagation |
| `shared/httpServer.js` | Shared response helpers (JSON, CORS, body parsing) |
| `shared/configSchema.js` | Centralized config schema with defaults, env mapping, admin UI metadata |
| `shared/dates.js` | Eastern Time date utilities and trading phase determination |
| `shared/pnl.js` | P&L computation from buy orders + market snapshots |
| `shared/circuitBreaker.js` | Circuit breaker (closed → open → half-open) for external API resilience |
| `shared/cache.js` | Async-safe TTL cache with periodic eviction and max-size enforcement |
| `shared/metrics.js` | Zero-dependency Prometheus metrics (counter, gauge, histogram) |
| `shared/rateLimiter.js` | In-memory sliding-window rate limiter for HTTP endpoints |
| `shared/retry.js` | Exponential backoff retry with jitter, abort support, and observability |
| `shared/serviceAuth.js` | Inter-service HMAC-based auth middleware with constant-time comparison |

---

## Prerequisites

- **Docker Desktop** with Kubernetes enabled, or **Rancher Desktop**
- **Node.js** 20+
- **kubectl** configured for your local cluster
- **PowerShell** (Windows) for deploy/pipeline scripts

### Accounts & API Keys

| Service | Required | How to Get |
|---------|----------|------------|
| **Polymarket** | Yes (for trading) | Create wallet, get builder credentials from Polymarket developer portal |
| **Weather Company** | Yes (primary weather source) | [Weather Underground API](https://www.wunderground.com/member/api-keys) |
| **NordVPN** | Yes (for VPN sidecar) | [Service credentials](https://my.nordaccount.com/dashboard/nordvpn/manual-configuration/) (not login credentials) |
| **Open-Meteo** | No (free fallback) | No API key required |

---

## Quick Start

### 1. Clone & Configure

```powershell
git clone https://github.com/joeykb/polymarket-trading.git
cd polymarket-trading

# Copy and fill in your environment config
cp .env.example .env
# Edit .env with your API keys and trading settings
```

### 2. Create Kubernetes Secrets

Copy the example templates and fill in real values:

```powershell
# Trading credentials (wallet key, builder creds)
cp k8s/secrets/trading-secret.example.yaml k8s/trading-secret.yaml
# Edit k8s/trading-secret.yaml with your Polymarket credentials

# VPN credentials (NordVPN service credentials)
cp k8s/secrets/vpn-secret.example.yaml k8s/vpn-secret.yaml
# Edit k8s/vpn-secret.yaml with your NordVPN service credentials

# Weather API key
cp k8s/secrets/weather-secret.example.yaml k8s/weather-api-keys-secret.yaml
# Edit k8s/weather-api-keys-secret.yaml with your WC_API_KEY
```

### 3. Get a NordVPN OpenVPN Config

Download a `.ovpn` file from NordVPN and place it in the `k8s/` directory:

```powershell
# Download from: https://nordvpn.com/servers/tools/
# Place as: k8s/us1234.nordvpn.com.udp.ovpn (any NordVPN .ovpn file)
```

### 4. Deploy

```powershell
# Full pipeline: lint → test → build → deploy
.\pipeline.ps1 deploy

# Or deploy specific services only
.\pipeline.ps1 deploy -Only trading-svc,monitor

# Or skip tests and lint
.\pipeline.ps1 deploy -SkipTests -SkipLint

# Legacy deploy (build + deploy, no lint/test)
.\deploy.ps1
```

### 5. Access the Dashboard

```powershell
# The dashboard is exposed via NodePort
# Default: http://localhost:30301

# Or port-forward manually
kubectl port-forward -n tempedge svc/dashboard-svc 3000:3000
```

---

## Configuration

Configuration is managed at three levels (highest priority first):

1. **Admin overrides** — Set via the `/admin` page at runtime, persisted to DB
2. **Environment variables** — K8s ConfigMap + Secrets
3. **Code defaults** — Fallback values in `shared/configSchema.js`

### Key Settings

| Variable | Default | Description |
|----------|---------|-------------|
| `TRADING_MODE` | `disabled` | `disabled` / `dry-run` / `live` |
| `MAX_POSITION_COST` | `2.00` | Max USDC per position |
| `MAX_DAILY_SPEND` | `5.00` | Max USDC per day |
| `BUY_SIZE` | `0` | Shares per buy order (0 = auto-calculate) |
| `MONITOR_INTERVAL` | `15` | Minutes between monitoring cycles |
| `BUY_HOUR_EST` | `9.5` | Buy trigger hour (ET, decimal — 9.5 = 9:30am) |
| `EV_THRESHOLD` | `0.05` | Minimum expected value ($) to place a buy |
| `MAX_ENTRY_PRICE` | `0.40` | Max target range price ($) — prices above are skipped |
| `MAX_HEDGE_COST` | `0.10` | Max price for a hedge range in medium-tier trades |
| `STOP_LOSS_ENABLED` | `0` | Enable automatic stop-loss selling |
| `STOP_LOSS_PCT` | `50` | Sell all if P&L drops below -N% |
| `MANUAL_SELL_ENABLED` | `0` | Show sell buttons on dashboard |
| `SERVICE_AUTH_KEY` | *(empty)* | Shared secret for inter-service auth (empty = auth disabled) |

See [`.env.example`](.env.example) for the complete list (60+ settings across 8 categories).

### Admin Page

Navigate to `http://localhost:30301/admin` to view and edit all configuration at runtime. Changes take effect immediately without restarting services. Fields with predefined options (e.g., `TRADING_MODE`, `LIQUIDITY_BUY_MODE`) render as dropdowns.

---

## How It Works

### Trading Lifecycle

```
1. DISCOVERY (T-2 to T-4 days)
   Monitor discovers Polymarket temperature events via market-svc
   → Weather forecast fetched from weather-svc (WC primary, Open-Meteo fallback)
   → Target range and hedge ranges identified
   → Trajectory analysis begins (T+4 → T+3 → T+2 forecast path)

2. STRATEGY (confidence & edge computation)
   8 independent signals build a confidence score:
     • Trend convergence & volatility
     • Days to target & directional consistency
     • Range stability (T+4→T+2 stayed in same 2°F range?)
     • Forecast acceleration (settling or speeding up?)
     • Drift magnitude & data point count
   Confidence → position tier:
     • High (≥50%): target only — max ROI
     • Medium (40-50%): target + cheapest hedge
     • Low (<40%): SKIP entirely
   EV = (confidence × $1.00) - totalDeployedCost

3. LIQUIDITY CHECK (buy window)
   Liquidity-svc opens WebSocket streams to Polymarket orderbooks
   → Monitors bid/ask depth and spread for each range
   → Two modes: 'threshold' (immediate) or 'best-window' (wait for optimal)
   → Deadline hour forces buy even if illiquid

4. BUY (buy window, typically 9:30am ET)
   Monitor triggers buy at configured hour
   → Trading-svc places GTC limit orders via CLOB API
   → Orders routed through VPN sidecar (jurisdictional compliance)
   → Spend tracked and capped per position and daily limits
   → On-chain fill verification via Polygon RPC

5. MONITOR (T-1 to T)
   Real-time P&L tracking via live CLOB prices
   → Dashboard shows current value, forecast shifts, alerts
   → Stop-loss guardrails: % threshold and absolute floor
   → Auto-sell on large forecast shifts (rebalance threshold)

6. RESOLVE (T)
   Market resolves based on actual high temperature
   → Monitor detects eventClosed

7. REDEEM (post-resolution)
   Auto-redeem CronJob runs every 6 hours:
   → NegRiskAdapter.redeemPositions() for neg-risk markets
   → CTF.redeemPositions() for standard markets
   → USDC.e returned to wallet
   → Losing positions burned to clear portfolio
```

### On-Chain Operations

The trading-svc handles all on-chain interactions:

- **Buy/Sell** — CLOB API limit orders (off-chain matching, on-chain settlement)
- **Redeem** — Direct contract calls to Polygon (CTF or NegRiskAdapter)
- **Approvals** — Automatic CTF approval for NegRiskAdapter when needed
- **Fill Verification** — On-chain order fill confirmation before recording to DB

All CLOB API traffic is routed through the Gluetun VPN sidecar for jurisdictional compliance. On-chain RPC calls (balance checks, redemptions) bypass the VPN via `NO_PROXY` since Polygon RPCs are not geo-blocked.

---

## Project Structure

```
polymarket-trading/
├── services/
│   ├── dashboard-svc/           # Web UI + admin + analytics
│   │   ├── static/
│   │   │   ├── index.html       # Main dashboard page
│   │   │   ├── admin.html       # Runtime config editor
│   │   │   ├── analytics.html   # Historical P&L analytics
│   │   │   ├── js/
│   │   │   │   ├── dashboard.js          # Core dashboard logic
│   │   │   │   ├── dashboard-panels.js   # Panel rendering (portfolio cards, liquidity)
│   │   │   │   ├── dashboard-renderers.js # Card/component renderers
│   │   │   │   ├── admin.js              # Admin page logic (dropdowns, save/reset)
│   │   │   │   └── analytics.js          # P&L charts, performance history
│   │   │   └── css/
│   │   │       ├── dashboard.css   # Main dashboard styles
│   │   │       ├── admin.css       # Admin page styles
│   │   │       └── analytics.css   # Analytics page styles
│   │   ├── server.js            # HTTP server + API proxy + /health + /metrics
│   │   ├── data.js              # Data aggregation from downstream services
│   │   └── pnl.js               # Live P&L overlay
│   ├── data-svc/                # Database + config store
│   │   ├── index.js             # HTTP server startup
│   │   ├── routes.js            # Route handlers (40+ endpoints)
│   │   ├── schemas.js           # Zod validation schemas
│   │   ├── db.js                # SQLite connection + WAL mode
│   │   ├── queries.js           # SQL query functions
│   │   ├── storage.js           # Session file + config file I/O
│   │   └── schema.sql           # Database schema (7 tables)
│   ├── liquidity-svc/           # WebSocket orderbook streams
│   │   └── index.js             # Session-aware WS connection manager
│   ├── market-svc/              # Polymarket Gamma API
│   │   └── index.js             # Event/market/range discovery + caching
│   ├── monitor/                 # Core orchestrator
│   │   ├── index.js             # Timer loop + health endpoint
│   │   ├── orchestrator.js      # Per-session orchestration logic
│   │   ├── strategy.js          # Pure decision functions (trend, edge, trajectory)
│   │   ├── buyFlow.js           # Buy execution pipeline
│   │   ├── sellFlow.js          # Sell execution pipeline
│   │   ├── sessionManager.js    # Session lifecycle management
│   │   ├── snapshot.js          # Snapshot creation and persistence
│   │   ├── positions.js         # Position tracking and reconciliation
│   │   ├── alerts.js            # Alert generation (forecast/price/phase)
│   │   ├── persistence.js       # DB write resilience
│   │   ├── svcClients.js        # Inter-service HTTP client wrappers
│   │   └── monitorConfig.js     # Hot-reloadable config from data-svc
│   ├── trading-svc/             # CLOB API + on-chain redeem
│   │   ├── index.js             # HTTP API + /health + /metrics
│   │   ├── client.js            # CLOB client initialization
│   │   ├── buy.js               # GTC limit order placement
│   │   ├── sell.js              # Position sell logic
│   │   ├── verify.js            # On-chain fill verification
│   │   ├── redeem.js            # CTF / NegRisk redemption
│   │   ├── validation.js        # Order input validation
│   │   └── trading.js           # Trading utilities
│   └── weather-svc/             # Weather forecast (WC + Open-Meteo)
│       └── index.js             # Dual-source forecast with circuit breaker
├── shared/                      # Shared modules (npm workspace: tempedge-shared)
│   ├── index.js                 # Barrel re-export
│   ├── services.js              # Service URL registry
│   ├── health.js                # Health checks + dependency monitoring
│   ├── logger.js                # Structured JSON logging + X-Request-Id
│   ├── httpClient.js            # HTTP client + correlation ID forwarding
│   ├── httpServer.js            # JSON responses, body parsing, CORS
│   ├── configSchema.js          # Centralized config schema + admin builder
│   ├── dates.js                 # Eastern Time utilities + phase determination
│   ├── pnl.js                   # P&L computation engine
│   ├── circuitBreaker.js        # Circuit breaker for external services
│   ├── cache.js                 # TTL cache with eviction + max-size
│   ├── metrics.js               # Prometheus exposition format (counters/gauges/histograms)
│   ├── rateLimiter.js           # Sliding window rate limiter
│   ├── retry.js                 # Exponential backoff with jitter
│   └── serviceAuth.js           # Inter-service auth (X-Service-Key header)
├── tests/                       # Vitest test suite (321 tests across 20 files)
│   ├── strategy.test.js         # Edge computation, trend, trajectory (strategy)
│   ├── schemas.test.js          # Zod validation (29 tests)
│   ├── dates.test.js            # Date utilities + phase logic
│   ├── config.test.js           # Config schema + resolution
│   ├── queries.test.js          # DB operations via in-memory SQLite
│   ├── pnl.test.js              # P&L computation
│   ├── sellFlow.test.js         # Sell pipeline logic
│   ├── httpClient.test.js       # HTTP client + timeout + correlation
│   ├── health.test.js           # Health checks + dependency mocking
│   ├── alerts.test.js           # Alert generation
│   ├── positions.test.js        # Position tracking
│   ├── snapshot.test.js         # Snapshot logic
│   ├── svcClients.test.js       # Service client wrappers
│   ├── validation.test.js       # Trading input validation
│   ├── circuitBreaker.test.js   # Circuit breaker state machine
│   ├── cache.test.js            # TTL cache behavior
│   ├── metrics.test.js          # Prometheus metrics rendering
│   ├── rateLimiter.test.js      # Rate limiter sliding window
│   ├── retry.test.js            # Retry with backoff + jitter
│   └── serviceAuth.test.js      # Inter-service auth middleware
├── scripts/                     # Utility scripts
│   ├── manual-redeem.js         # Manual on-chain redemption
│   └── manual-redeem.mjs        # ESM version of manual redeem
├── src/scripts/
│   └── redeem.js                # Standalone redeem script (used by CronJob)
├── docs/
│   └── openapi.yaml             # OpenAPI 3.1 specification
├── specs/                       # Design specifications
│   ├── 00-project-overview.md
│   ├── 01-architecture.md
│   ├── 02-data-models.md
│   ├── 03-features/             # Feature specs
│   └── 04-api-contracts.md
├── k8s/                         # Kubernetes manifests
│   ├── namespace.yaml
│   ├── configmap.yaml
│   ├── pvc.yaml
│   ├── *-svc.yaml               # Per-service deployments
│   ├── auto-redeem.yaml         # CronJob — redeems on-chain every 6h
│   ├── prometheus-config.yaml   # Prometheus scrape configuration
│   ├── grafana-dashboard.json   # Pre-built Grafana dashboard
│   ├── green/                   # Blue-green deployment manifests
│   │   ├── *-green.yaml         # Green-stack service variants
│   │   └── pvc-green.yaml       # Isolated PVC for green stack
│   ├── secrets/                 # Secret templates (examples only, never committed)
│   ├── service-auth-secret.yaml # Inter-service auth key
│   └── promote-green.ps1        # Green → production promotion helper
├── pipeline.ps1                 # Unified CI/CD pipeline (lint → test → build → deploy)
├── deploy.ps1                   # Legacy build + deploy script
├── deploy-green.ps1             # Blue-green deployment script
├── generate-green-manifests.ps1 # Auto-generate green K8s manifests
├── teardown.ps1                 # Remove services from cluster
├── vitest.config.js             # Test runner config (forks pool, coverage thresholds)
├── eslint.config.js             # ESLint 9 flat config + Prettier
├── .prettierrc                  # Code formatting rules
└── package.json                 # npm workspaces, scripts, dependencies
```

---

## Database Schema

The data-svc uses **SQLite with WAL mode** for concurrent read access across containers. The database lives on a Kubernetes PersistentVolumeClaim and survives pod restarts.

| Table | Purpose |
|-------|---------|
| `markets` | Market definitions (city, slug pattern, weather station config) |
| `sessions` | One per target date per market — lifecycle state (scout → buy → resolve) |
| `trades` | Append-only log of every buy, sell, redeem with cost/proceeds |
| `positions` | Token-level position tracking (fill price, sell, redeem lifecycle) |
| `snapshots` | Time-series forecast + price data (replaces JSON snapshot arrays) |
| `alerts` | Queryable alert history (forecast shifts, price spikes, phase changes) |
| `config_overrides` | Admin config overrides (survives restarts, keyed by section.field) |

---

## Observability

### Prometheus Metrics

Every service exposes a `/metrics` endpoint in Prometheus exposition format. The custom metrics library (`shared/metrics.js`) is zero-dependency and supports:

- **Counters** — `http_requests_total` (method, path, status)
- **Histograms** — `http_request_duration_ms` with configurable buckets
- **Gauges** — `active_connections`, custom per-service gauges
- **Process metrics** — uptime, heap, RSS (auto-registered)

A ready-to-use Prometheus scrape config is included at `k8s/prometheus-config.yaml` with both K8s pod auto-discovery and static service fallbacks.

### Grafana Dashboard

A pre-built Grafana dashboard JSON is at `k8s/grafana-dashboard.json`, pre-configured for all 7 services.

### Circuit Breakers

External API calls (Weather Company, Polymarket CLOB) are wrapped in circuit breakers that trip after consecutive failures and auto-recover via half-open probes. Breaker stats are exposed on `/health` endpoints.

---

## Operations

### Unified Pipeline (Recommended)

The `pipeline.ps1` script is the primary entry point for all deployment operations:

```powershell
# Full deploy: lint → test → build → deploy (production)
.\pipeline.ps1 deploy

# Deploy specific services
.\pipeline.ps1 deploy -Only trading-svc,monitor

# Skip lint/tests for fast iteration
.\pipeline.ps1 deploy -SkipTests -SkipLint

# Deploy an isolated green stack for testing
.\pipeline.ps1 green

# Promote green → production (re-tag images + swap pods)
.\pipeline.ps1 promote

# Rollback production to previous images
.\pipeline.ps1 rollback

# Check cluster health + selector status
.\pipeline.ps1 status

# Remove green stack
.\pipeline.ps1 teardown

# Full teardown (delete namespace, PVC, everything)
.\pipeline.ps1 teardown -Full

# Dry run (show what would happen)
.\pipeline.ps1 promote -DryRun
```

### Blue-Green Deployments

TempEdge supports full blue-green deployments for zero-downtime releases:

1. **Green stack** runs in the same namespace with `-green` suffixed names
2. Green services talk to each other via green-prefixed K8s DNS names (fully isolated)
3. Green dashboard is accessible at `http://localhost:30302` for side-by-side comparison
4. Promotion re-tags Docker images `:green` → `:latest`, restarts production pods, and fixes service selectors

### View Logs

```powershell
# Follow logs for a specific service
kubectl logs -n tempedge deployment/monitor -f

# Trading-svc (has VPN sidecar — specify container)
kubectl logs -n tempedge deployment/trading-svc -c trading-svc -f

# VPN sidecar logs
kubectl logs -n tempedge deployment/trading-svc -c vpn -f

# Auto-redeem CronJob (last execution)
kubectl logs -n tempedge job/$(kubectl get jobs -n tempedge -l component=auto-redeem --sort-by=.metadata.creationTimestamp -o name | Select-Object -Last 1)
```

### Teardown

```powershell
# Remove all services (keep namespace + PVC data)
.\teardown.ps1

# Full teardown (delete everything including data)
.\teardown.ps1 -Full

# Remove specific services only
.\teardown.ps1 -Only monitor,trading-svc
```

### Manual Redeem

If you need to redeem positions outside the automated CronJob:

```powershell
# Dry run — shows what would be redeemed
node scripts/manual-redeem.js --dry-run

# Live redeem via standalone script
node src/scripts/redeem.js
```

---

## Strategy Engine

The monitor's strategy engine (`services/monitor/strategy.js`) makes purely data-driven buy decisions with zero side effects:

### Confidence Signals (8 independent inputs)

| # | Signal | Boost | Penalty | Source |
|---|--------|-------|---------|--------|
| 1 | Trend convergence | +0.12 | -0.12 | `analyzeTrend()` |
| 2 | Volatility (forecast jitter) | +0.08 | -0.08 | `analyzeTrend()` |
| 3 | Days to target | +0.12 (T+1) | -0.10 (T+4) | snapshot |
| 4 | Directional consistency | +0.05 | — | `analyzeTrend()` |
| 5 | Data point count | +0.05 | -0.05 | trend history |
| 6 | Range stability (T+4→T+2) | +0.15 | -0.10 | `analyzeTrajectory()` |
| 7 | Forecast acceleration | +0.06 | -0.06 | `analyzeTrajectory()` |
| 8 | Drift magnitude | +0.04 | -0.06 | `analyzeTrajectory()` |

### Position Tiers

| Tier | Confidence | Ranges Bought | Rationale |
|------|-----------|---------------|-----------|
| **High** | ≥50% | Target only | Max ROI when forecast is strong |
| **Medium** | 40-50% | Target + cheapest hedge (≤$0.10) | Balanced risk/reward |
| **Low** | <40% | **SKIP** | Capital preservation |

### Guardrails

- **Max entry price**: $0.40 (configurable) — refuses expensive targets
- **EV threshold**: $0.05 (configurable) — requires positive expected value
- **Stop-loss**: Configurable % threshold and absolute floor
- **Daily spend cap**: Enforced across all positions

---

## Security

| Item | Protection |
|------|-----------|
| Private keys | K8s Secrets only — never in code or git |
| API keys | K8s Secrets — removed from all code defaults |
| VPN credentials | K8s Secrets — NordVPN service credentials |
| CLOB API traffic | Routed through Gluetun VPN sidecar |
| Inter-service comms | `X-Service-Key` header with constant-time comparison |
| Secret files | Blocked by `.gitignore` |
| Example templates | Safe placeholders committed for reference |

### Secret Files (never committed)

```
k8s/trading-secret.yaml             # Polymarket wallet + builder creds
k8s/vpn-secret.yaml                 # NordVPN service credentials
k8s/weather-api-keys-secret.yaml    # Weather Company API key
k8s/service-auth-secret.yaml        # Inter-service auth key
k8s/*.ovpn                          # VPN config files
.env                                # Local environment config
```

---

## Dashboard

The dashboard provides real-time monitoring at `http://localhost:30301`:

- **Portfolio Cards** — One per active session date showing forecast, positions, live P&L
- **Trade Readiness Thermometer** — SVG gauge showing system confidence, tier, and trade intent
- **Live Liquidity** — Real-time orderbook depth for owned positions
- **Trade Log** — Complete execution history with P&L per trade
- **Status Bar** — Monitor status, wallet balance, last update time
- **Analytics** (`/analytics`) — Historical P&L charts, cumulative returns, trade history with date filtering
- **Admin Page** (`/admin`) — Edit all 60+ configuration settings at runtime with dropdowns for choice fields

---

## Development

### npm Workspaces

The project uses npm workspaces for dependency management. Dev dependencies (eslint, prettier, vitest) are at root; production deps are per-service.

```powershell
# Install all dependencies
npm install

# Run tests (321 tests, <600ms)
npm test

# Watch mode
npm run test:watch

# Coverage report (v8 provider)
npm run test:coverage

# Lint all code
npm run lint

# Auto-fix formatting
npm run lint:fix

# Format with Prettier
npm run format
```

### Test Coverage

The test suite enforces coverage thresholds:

| Scope | Lines | Functions | Branches |
|-------|-------|-----------|----------|
| **shared/** | ≥75% | ≥70% | ≥65% |
| **Global** | ≥20% | ≥25% | ≥20% |

Tests run in `forks` pool mode (required for `better-sqlite3` native bindings in test isolation).

### API Documentation

The full API is documented in [`docs/openapi.yaml`](docs/openapi.yaml) (OpenAPI 3.1). You can view it with any OpenAPI viewer like [Swagger Editor](https://editor.swagger.io/) or the VS Code OpenAPI extension.

### Adding Environment Variables

1. Add the schema entry to `shared/configSchema.js` (with key, default, description, and optional `choices`)
2. Update `.env.example` with the new setting
3. If it should be admin-editable, no other changes needed — the admin page auto-discovers from the schema
4. For sensitive values, add `sensitive: true` to hide defaults in the admin UI

---

## License

Private repository. All rights reserved.
