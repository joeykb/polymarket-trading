# 🌡️ TempEdge — Polymarket Temperature Trading System

**Automated prediction market trading on [Polymarket](https://polymarket.com/) for New York City daily high temperature markets.**

TempEdge monitors weather forecasts, discovers Polymarket temperature binary options, evaluates liquidity, places orders via the CLOB API, tracks P&L in real time, and automatically redeems winning positions on-chain — all running as Kubernetes microservices behind a VPN.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        tempedge namespace                       │
│                                                                 │
│  ┌────────────┐   ┌────────────┐   ┌─────────────────────────┐ │
│  │ weather-svc│   │ market-svc │   │      trading-svc        │ │
│  │   :3002    │   │   :3003    │   │   :3004                 │ │

│  │            │   │            │   │  ┌───────┐ ┌──────────┐ │ │
│  │ WC + Meteo │   │ Gamma API  │   │  │ Node  │ │  Gluetun │ │ │
│  └─────┬──────┘   └─────┬──────┘   │  │  app  │ │  VPN     │ │ │
│        │                │          │  └───┬───┘ └────┬─────┘ │ │
│        │                │          │      └──────────┘       │ │
│        │                │          └────────────┬────────────┘ │
│        │                │                       │              │
│  ┌─────┴────────────────┴───────────────────────┴───────────┐  │
│  │                       monitor (:3002)                     │  │
│  │        Orchestrator: forecast → market → buy/sell/redeem  │  │
│  └──────────────────────────┬────────────────────────────────┘  │
│                             │                                   │
│  ┌──────────────┐    ┌──────┴───────┐    ┌──────────────┐      │
│  │ liquidity-svc│    │   data-svc   │    │dashboard-svc │      │
│  │    :3001     │    │    :3005     │    │    :3000     │      │
│  │  WebSocket   │    │  SQLite DB   │    │   Web UI     │      │
│  │  orderbooks  │    │  Sessions    │    │   Admin      │      │
│  └──────────────┘    │  Config      │    └──────────────┘      │
│                      └──────────────┘                           │
└─────────────────────────────────────────────────────────────────┘
```

### Services

| Service | Port | Description |
|---------|------|-------------|
| **dashboard-svc** | 3000 | Web UI — live portfolio cards, P&L tracking, trade log, admin config |
| **liquidity-svc** | 3001 | WebSocket connection to Polymarket orderbooks per active session |
| **monitor** | 3002 | Core orchestrator — runs on a timer, coordinates all services |
| **market-svc** | 3003 | Polymarket Gamma API integration — event/market/range discovery |
| **trading-svc** | 3004 | Buy, sell, and redeem orders via CLOB API (runs behind VPN sidecar) |
| **data-svc** | 3005 | SQLite database, session file management, config store, spend tracking |
| **weather-svc** | 3002 | Multi-source weather forecast (Weather Company + Open-Meteo fallback) |

### Shared Modules

| Module | Purpose |
|--------|---------|
| `shared/services.js` | Service registry — single source of truth for all service URLs |
| `shared/health.js` | Health check responses with dependency monitoring |
| `shared/logger.js` | Structured JSON logging with `X-Request-Id` correlation |
| `shared/httpClient.js` | HTTP client with timeout, JSON handling, correlation ID propagation |
| `shared/httpServer.js` | Shared response helpers (JSON, CORS, body parsing) |
| `shared/configSchema.js` | Centralized config schema with defaults, env mapping, and admin UI metadata |
| `shared/dates.js` | Eastern Time date utilities and trading phase determination |
| `shared/pnl.js` | P&L computation from buy orders + market snapshots |

---

## Prerequisites

- **Docker Desktop** with Kubernetes enabled, or **Rancher Desktop**
- **Node.js** 20+
- **kubectl** configured for your local cluster
- **PowerShell** (Windows) for deploy/teardown scripts

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
# Build all Docker images and deploy to Kubernetes
.\deploy.ps1

# Or deploy specific services only
.\deploy.ps1 -Only trading-svc,monitor

# Or skip builds (deploy only)
.\deploy.ps1 -NoBuild
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

1. **Admin overrides** — Set via the `/admin` page at runtime, persisted to disk
2. **Environment variables** — K8s ConfigMap + Secrets
3. **Code defaults** — Fallback values in `shared/configSchema.js`

### Key Settings

| Variable | Default | Description |
|----------|---------|-------------|
| `TRADING_MODE` | `disabled` | `disabled` / `dry-run` / `live` |
| `MAX_POSITION_COST` | `2.00` | Max USDC per position |
| `MAX_DAILY_SPEND` | `5.00` | Max USDC per day |
| `BUY_SIZE` | `5` | Shares per buy order |
| `MONITOR_INTERVAL` | `15` | Minutes between monitoring cycles |
| `BUY_HOUR_EST` | `9.5` | Buy trigger hour (ET, decimal) |
| `MANUAL_SELL_ENABLED` | `0` | Show sell buttons on dashboard |

See [`.env.example`](.env.example) for the complete list.

### Admin Page

Navigate to `http://localhost:30301/admin` to view and edit all configuration at runtime. Changes take effect immediately without restarting services.

---

## How It Works

### Trading Lifecycle

```
1. DISCOVERY (T-2 days)
   Monitor discovers Polymarket temperature events via market-svc
   → Weather forecast fetched from weather-svc
   → Target range and hedge ranges identified

2. LIQUIDITY CHECK (T-2 to T-1)
   Liquidity-svc opens WebSocket streams to Polymarket orderbooks
   → Monitors bid/ask depth and spread for each range
   → Waits for sufficient liquidity before buying

3. BUY (buy window)
   Monitor triggers buy at configured hour (default 9:30am ET)
   → Trading-svc places GTC limit orders via CLOB API
   → Orders routed through VPN sidecar (jurisdictional compliance)
   → Spend tracked and capped per position and daily limits

4. MONITOR (T-1 to T)
   Real-time P&L tracking via live CLOB prices
   → Dashboard shows current value, forecast shifts, alerts
   → Auto-sell on large forecast shifts (rebalance threshold)

5. RESOLVE (T)
   Market resolves based on actual high temperature
   → Monitor detects eventClosed

6. REDEEM (post-resolution)
   Trading-svc redeems winning positions on-chain
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

All CLOB API traffic is routed through the Gluetun VPN sidecar for jurisdictional compliance. On-chain RPC calls (balance checks, redemptions) bypass the VPN via `NO_PROXY` since Polygon RPCs are not geo-blocked.

---

## Project Structure

```
polymarket-trading/
├── services/
│   ├── dashboard-svc/        # Web UI + admin page
│   │   ├── static/           # Frontend (HTML, CSS, JS)
│   │   ├── server.js         # HTTP server + API proxy + /health
│   │   ├── data.js           # Data aggregation from downstream services
│   │   └── pnl.js            # Live P&L overlay
│   ├── data-svc/             # Database + config store
│   │   ├── index.js          # HTTP server startup
│   │   ├── routes.js         # Route handlers (40+ endpoints)
│   │   ├── schemas.js        # Zod validation schemas
│   │   ├── db.js             # SQLite connection + WAL mode
│   │   ├── queries.js        # SQL query functions
│   │   ├── storage.js        # Session file + config file I/O
│   │   └── schema.sql        # Database schema (6 tables)
│   ├── liquidity-svc/        # WebSocket orderbook streams
│   ├── market-svc/           # Polymarket Gamma API
│   ├── monitor/              # Core orchestrator
│   │   ├── index.js          # Timer loop
│   │   └── orchestrator.js   # Trading logic
│   ├── trading-svc/          # CLOB API + on-chain redeem
│   │   ├── index.js          # HTTP API + /health
│   │   ├── client.js         # CLOB client initialization
│   │   ├── buy.js            # GTC limit order placement
│   │   ├── sell.js           # Position sell logic
│   │   ├── verify.js         # On-chain fill verification
│   │   └── redeem.js         # CTF / NegRisk redemption
│   └── weather-svc/          # Weather forecast (WC + Open-Meteo)
├── shared/                   # Shared modules (npm workspace)
│   ├── services.js           # Service URL registry
│   ├── health.js             # Health checks with dependency monitoring
│   ├── logger.js             # Structured JSON logging + X-Request-Id
│   ├── httpClient.js         # HTTP client with correlation ID forwarding
│   ├── httpServer.js         # JSON responses, body parsing, CORS
│   ├── configSchema.js       # Centralized config schema + admin builder
│   ├── dates.js              # Eastern Time utilities + phase determination
│   └── pnl.js                # P&L computation engine
├── tests/                    # Vitest test suite (102 tests)
│   ├── pnl.test.js           # P&L computation (13 tests)
│   ├── dates.test.js         # Date utilities + phase logic (22 tests)
│   ├── config.test.js        # Config schema + resolution (17 tests)
│   ├── queries.test.js       # DB operations via in-memory SQLite (16 tests)
│   ├── schemas.test.js       # Zod validation (24 tests)
│   └── health.test.js        # Health checks + dependency mocking (10 tests)
├── docs/
│   └── openapi.yaml          # OpenAPI 3.1 specification
├── k8s/                      # Kubernetes manifests
│   ├── namespace.yaml
│   ├── configmap.yaml
│   ├── pvc.yaml
│   ├── *-svc.yaml            # Per-service deployments
│   └── secrets/              # Secret templates (examples only)
├── vitest.config.js          # Test runner configuration
├── eslint.config.js          # ESLint 9 flat config + Prettier
├── .prettierrc               # Code formatting rules
├── deploy.ps1                # Build + deploy all services
└── teardown.ps1              # Remove services from cluster
```

---

## Operations

### Deploy / Update a Single Service

```powershell
# Rebuild and redeploy just trading-svc
.\deploy.ps1 -Only trading-svc

# Rebuild and redeploy multiple services
.\deploy.ps1 -Only trading-svc,monitor
```

### View Logs

```powershell
# Follow logs for a specific service
kubectl logs -n tempedge deployment/monitor -f

# Trading-svc (has VPN sidecar — specify container)
kubectl logs -n tempedge deployment/trading-svc -c trading-svc -f

# VPN sidecar logs
kubectl logs -n tempedge deployment/trading-svc -c vpn -f
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

If you need to redeem positions outside the automated flow:

```powershell
# Dry run — shows what would be redeemed
node src/scripts/redeem.js --dry-run

# Live redeem
node src/scripts/redeem.js
```

---

## Security

| Item | Protection |
|------|-----------|
| Private keys | K8s Secrets only — never in code or git |
| API keys | K8s Secrets — removed from all code defaults |
| VPN credentials | K8s Secrets — NordVPN service credentials |
| CLOB API traffic | Routed through Gluetun VPN sidecar |
| Secret files | Blocked by `.gitignore` |
| Example templates | Safe placeholders committed for reference |

### Secret Files (never committed)

```
k8s/trading-secret.yaml          # Polymarket wallet + builder creds
k8s/vpn-secret.yaml              # NordVPN service credentials
k8s/weather-api-keys-secret.yaml # Weather Company API key
k8s/*.ovpn                       # VPN config files
.env                             # Local environment config
```

---

## Dashboard

The dashboard provides real-time monitoring at `http://localhost:30301`:

- **Portfolio Cards** — One per active session date showing forecast, positions, live P&L
- **Live Liquidity** — Real-time orderbook depth for owned positions
- **Trade Log** — Complete execution history with P&L per trade
- **Status Bar** — Monitor status, wallet balance, last update time
- **Admin Page** (`/admin`) — Edit all configuration at runtime

---

## Development

### npm Workspaces

The project uses npm workspaces for dependency management. Dev dependencies (eslint, prettier, vitest) are at root; production deps are per-service.

```powershell
# Install all dependencies
npm install

# Run tests (102 tests, <300ms)
npm test

# Watch mode
npm run test:watch

# Lint all code
npm run lint

# Auto-fix formatting
npm run lint:fix

# Check syntax only (no execution)
npm run check
```

### API Documentation

The full API is documented in [`docs/openapi.yaml`](docs/openapi.yaml) (OpenAPI 3.1). You can view it with any OpenAPI viewer like [Swagger Editor](https://editor.swagger.io/) or the VS Code OpenAPI extension.

### Adding Environment Variables

1. Add the schema entry to `shared/configSchema.js`
2. Update the relevant service's `.env.example`
3. If it should be admin-editable, no other changes needed — the admin page auto-discovers from the schema

---

## License

Private repository. All rights reserved.
