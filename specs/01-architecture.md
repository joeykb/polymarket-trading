# Architecture

## Tech Stack

| Layer         | Technology                  | Rationale                                                        |
|---------------|-----------------------------|-----------------------------------------------------------------|
| Runtime       | Node.js (v20+)             | Already in your environment, great async HTTP support             |
| Language      | JavaScript (ESM modules)    | Simple, fast iteration                                           |
| Weather API   | Open-Meteo (primary)        | Free, no API key, returns JSON, accurate forecasts for KLGA      |
|               | Weather Underground (backup)| The user's preferred source — requires scraping (JS-rendered page)|
| Market API    | Polymarket Gamma API        | Free, no auth needed for market discovery and price data          |
|               | Polymarket CLOB API         | Real-time prices; auth needed for trading (Phase 3)              |
| Output        | JSON + Markdown files       | Human-readable observation logs                                  |
| Scheduling    | node-cron or Windows Task Scheduler | Periodic re-checks (Phase 2)                           |

## Directory Structure

```
polymarket/
├── specs/                     # Project specifications (this folder)
│   ├── 00-project-overview.md
│   ├── 01-architecture.md
│   ├── 02-data-models.md
│   ├── 03-features/
│   │   ├── weather-fetch.md
│   │   ├── market-discovery.md
│   │   ├── range-selection.md
│   │   ├── observation-output.md
│   │   └── monitoring-dashboard.md  # Phase 2 spec
│   └── 04-api-contracts.md
├── src/
│   ├── index.js               # Phase 1: single-shot observation
│   ├── monitor.js             # Phase 2: periodic monitoring loop
│   ├── dashboard.js           # Phase 2: web dashboard server
│   ├── services/
│   │   ├── weather.js          # Fetch forecast from Open-Meteo
│   │   ├── polymarket.js       # Discover and parse Polymarket events
│   │   ├── rangeSelector.js    # Select target + adjacent ranges
│   │   └── monitor.js          # Monitoring service (snapshots, alerts)
│   ├── models/
│   │   └── types.js            # JSDoc type definitions
│   └── utils/
│       ├── dateUtils.js        # Date formatting helpers
│       └── fileWriter.js       # Write observation output files
├── k8s/                        # Kubernetes manifests
│   ├── namespace.yaml          # tempedge namespace
│   ├── configmap.yaml          # Runtime configuration
│   ├── pvc.yaml                # Persistent volume for output
│   ├── deployment.yaml         # Monitor + dashboard pods
│   └── service.yaml            # NodePort service (port 30300)
├── output/                     # Generated observation + monitoring files
├── Dockerfile                  # Container image (Node 20 Alpine)
├── .dockerignore
├── deploy.ps1                  # One-command K8s deploy
├── teardown.ps1                # Clean K8s teardown
├── package.json
├── .env                        # API keys (if needed later)
└── README.md
```


## Data Flow (Phase 1)

```
┌──────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  Open-Meteo   │────▶│   weather.js      │────▶│ Forecast High   │
│  API (KLGA)   │     │                  │     │ e.g. 41.2°F     │
└──────────────┘     └──────────────────┘     └────────┬────────┘
                                                        │
                                                        ▼
┌──────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  Polymarket   │────▶│  polymarket.js    │────▶│ Market Ranges   │
│  Gamma API    │     │                  │     │ 38-39, 40-41,   │
└──────────────┘     └──────────────────┘     │ 42-43, ...      │
                                               └────────┬────────┘
                                                        │
                                                        ▼
                                               ┌─────────────────┐
                                               │ rangeSelector.js │
                                               │ Match forecast   │
                                               │ Pick target +    │
                                               │ adjacent ranges  │
                                               └────────┬────────┘
                                                        │
                                                        ▼
                                               ┌─────────────────┐
                                               │ fileWriter.js    │
                                               │ Write JSON +     │
                                               │ Markdown output  │
                                               └─────────────────┘
```

## Key Design Decisions

### 1. Open-Meteo as Primary Weather Source
- **Verified working**: `https://api.open-meteo.com/v1/forecast?latitude=40.7769&longitude=-73.8740&daily=temperature_2m_max&temperature_unit=fahrenheit&timezone=America/New_York`
- Returns daily `temperature_2m_max` in °F for LaGuardia Airport coordinates
- No API key required, free for non-commercial use
- Up to 16-day forecast

### 2. Weather Underground as Secondary/Validation Source
- WU's forecast page (`https://www.wunderground.com/forecast/us/ny/new-york-city/KLGA`) is JavaScript-rendered
- Data is NOT in the raw HTML — requires browser scraping (Puppeteer/Playwright) or finding their internal API calls
- **Decision**: Use Open-Meteo as primary. Explore WU scraping as a validation source in Phase 2.
- WU may offer a paid API through The Weather Company (IBM) — evaluate if needed

### 3. Polymarket Discovery Strategy
- The Gamma API's search/filter endpoints don't easily match "temperature" events by title
- **Decision**: Use the Polymarket search endpoint (`/public-search?q=Highest+temperature+in+NYC`) to discover the event, then fetch individual market details
- The temperature markets are **multi-outcome events** (neg-risk enabled), where each 2°F range is a separate market within the event
- Each range outcome has its own `clobTokenId`, `outcomePrices`, `question` (e.g., "40-41°F")

### 4. Range Selection Logic
- Parse forecast temperature (e.g., 41.2°F)
- Match to the correct Polymarket range (40-41°F includes temps ≥ 40 and < 42)
- Select: **target range** + **1 range below** + **1 range above**
- Handle edge cases: forecast at boundary, forecast at extremes ("36°F or lower", "48°F or higher")
