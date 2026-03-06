# Polymarket NYC Temperature Predictor

## Project Codename
**TempEdge**

## Elevator Pitch
A Node.js application that monitors Polymarket's "Highest temperature in NYC" daily markets, cross-references Weather Underground / Open-Meteo forecasts for LaGuardia Airport (KLGA), selects the 3 most strategic temperature ranges to bet on, and outputs them for observation (and eventually, automated purchasing).

## Problem Statement
Polymarket offers daily prediction markets on NYC's high temperature, broken into 2°F ranges (e.g., 38-39°F, 40-41°F). Manually checking the weather forecast, finding the right Polymarket ranges, and monitoring them is tedious and time-sensitive. We want to automate the data gathering, range selection, and observation — and eventually, the purchasing and position management.

## Target Users
- Solo operator (you) — running locally on a Windows machine.

## Key Success Metrics
- Correctly identifies the right Polymarket market for the next available day
- Accurately fetches forecast high temperature for KLGA
- Selects the correct 3 ranges (target + adjacent ranges)
- Outputs data in a human-readable observation file
- Runs on-demand or on a schedule

## Phased Approach

### Phase 1: Observation Mode (MVP) ✅ Complete
1. Fetch forecast high temperature for NYC LaGuardia (KLGA) from weather source
2. Find the active Polymarket "Highest temperature in NYC on [date]" market
3. Parse all available temperature ranges and their current prices
4. Match the forecast to the correct range, then select that range + 1 above + 1 below
5. Write selected ranges (with prices, volumes, probabilities) to an observation file

### Phase 2: Monitoring Dashboard ✅ Complete
- `node src/monitor.js` — Periodic re-checks at configurable intervals (default 15 min)
- Tracks price movements on selected ranges with delta tracking
- Detects forecast shifts, range shifts, and price spikes with alerts
- `node src/dashboard.js` — Local web dashboard at http://localhost:3000
- Dashboard shows stat cards, SVG price chart, alert feed, and full ranges table

### Phase 3: Automated Trading
- Connect to Polymarket CLOB API (authenticated)
- Purchase YES shares on 3 selected ranges 1 day in advance
- As event time approaches, sell off the 2 least likely ranges
- Keep the range most likely to hit

### Phase 4: Historical Analysis
- Track past predictions vs. actuals
- Build a history of wins/losses
- Optimize range selection strategy (e.g., weight toward range above in winter)

## Current Status (2026-03-06)

**Phase 1 ✅ | Phase 2 ✅ | Phase 3 🔜**

### Commands
| Command | Description |
|---------|-------------|
| `node src/index.js [date]` | Single-shot observation run |
| `node src/monitor.js [date] [--interval N]` | Start monitoring loop (default: 15 min) |
| `node src/dashboard.js [--port N] [--date D]` | Web dashboard at localhost:3000 |

### Verified Phase 1 Run
```
Target Date:     March 7, 2026
Forecast High:   47.7°F (Open-Meteo, KLGA)
Rounded-Up:      48°F → "48°F or higher" range
Selected Ranges: 46-47°F ⬇️ | 48°F+ 🎯 | (none) ⬆️
Total Cost:      $0.855
ROI:             17.0%
Output:          output/2026-03-07.json
```

### Key Technical Findings
- **Weather source:** Open-Meteo API (free, reliable, no auth required)
- **Market discovery:** Direct slug with year format works reliably: `highest-temperature-in-nyc-on-{month}-{day}-{year}`
- **Gamma API search is broken:** `tag=Weather`, `title_contains`, `question_contains` all return unrelated results
- **Market question format:** Uses "or below" (not "or lower") for the low-end open range
- **Market ranges:** 2°F buckets, typically 9 ranges spanning ~16°F around the expected temp

