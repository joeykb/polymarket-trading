# Feature: Observation Output

## Overview
Write the selected ranges, forecast data, and market data to a JSON file for human review and historical tracking.

## Output Files

### JSON File: `output/{date}.json`
Machine-readable, used for tracking and potential programmatic re-reads.

See full schema in `02-data-models.md` → ObservationRecord.

### Console Output
When running the tool, print a condensed summary:

```
╔══════════════════════════════════════════════════════╗
║  TempEdge - Polymarket NYC Temperature Predictor     ║
╠══════════════════════════════════════════════════════╣
║  Target Date:  March 7, 2026                         ║
║  KLGA Forecast High:  47.7°F (Open-Meteo)           ║
║  Rounded-Up Target:   48°F+ range                    ║
╠══════════════════════════════════════════════════════╣
║  ⬇️  46-47°F  │  YES: 3.6¢  │  Prob: 3.6%           ║
║  🎯  48°F+    │  YES: 0.5¢  │  Prob: 0.5%           ║
║  ⬆️  (none)   │  --         │  --                    ║
╠══════════════════════════════════════════════════════╣
║  Total cost: $0.041  │  Profit if hit: $0.959        ║
╚══════════════════════════════════════════════════════╝

Output saved to: output/2026-03-07.json
```

## File Overwrite Policy
- If `output/{date}.json` already exists, append a timestamp suffix: `{date}_1030.json`
- This allows multiple snapshots throughout the day to track price changes

