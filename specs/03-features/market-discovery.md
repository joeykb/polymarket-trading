# Feature: Polymarket Market Discovery

## Overview
Find the active "Highest temperature in NYC" event on Polymarket and extract all temperature range markets with their current prices.

## API Details

### Base URL
```
https://gamma-api.polymarket.com
```

### Authentication
- **None required** for market discovery (read-only)
- Authentication needed only for Phase 3 (trading)

### Discovery Strategy

> **IMPORTANT:** The Gamma API `tag`, `title_contains`, and `question_contains` parameters are **unreliable** —
> they return completely unrelated results (e.g., `tag=Weather` returns EPL soccer markets).
> The only reliable discovery method is **direct slug construction**.

#### Strategy 1: Direct Slug (Primary — CONFIRMED WORKING ✅)
Temperature events follow a predictable slug pattern that **includes the year**:
```
highest-temperature-in-nyc-on-{month}-{day}-{year}
```

Example:
```
GET https://gamma-api.polymarket.com/events?slug=highest-temperature-in-nyc-on-march-8-2026
```

Returns a single-element array with the full event and all child markets.

**Slug construction:**
```javascript
function formatDateForSlug(isoDate) {
  const [year, month, day] = isoDate.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  const monthName = date.toLocaleDateString('en-US', { month: 'long' }).toLowerCase();
  return `${monthName}-${day}-${year}`;  // e.g. "march-8-2026"
}
```

#### Strategy 2: Slug Without Year (Fallback)
Some older events may not include the year in their slug:
```
GET https://gamma-api.polymarket.com/events?slug=highest-temperature-in-nyc-on-march-8
```

#### Strategy 3: Broad Search + Client-Side Filtering (Last Resort)
Fetch batches of active events and filter client-side for temperature markets:
```
GET https://gamma-api.polymarket.com/events?active=true&closed=false&limit=50&offset=0
```
Filter by:
- `title` contains "temperature" AND "nyc"
- OR `slug` contains "highest-temperature-in-nyc"

Falls back to trying nearby date slugs (today through +7 days).

### What Does NOT Work ❌
| Approach | Why it fails |
|---|---|
| `tag=Weather` | Returns unrelated markets (sports, politics) |
| `tag=NYC` | Returns unrelated results |
| `title_contains=temperature` | Returns unrelated results |
| `question_contains=highest+temperature` | Returns GTA, crypto markets |
| Slug without year (as primary) | Returns empty for newer events |

### Event & Series Structure

Temperature events belong to the **"NYC Daily Weather"** series:
- **Series slug:** `nyc-daily-weather`
- **Tags:** `Weather`, `New York City`, `Daily Temperature`, `Recurring`
- **Recurrence:** Daily

A temperature event is a **multi-outcome event** (negRisk = true). It contains multiple child `markets`, each representing a 2°F temperature range.

```
Event: "Highest temperature in NYC on March 7?"  (id: 247562)
├── Market: "33°F or below"     → YES: 0.05¢   (lowTemp: -∞, highTemp: 33)
├── Market: "34-35°F"           → YES: 0.10¢   (lowTemp: 34, highTemp: 35)
├── Market: "36-37°F"           → YES: 0.45¢   (lowTemp: 36, highTemp: 37)
├── Market: "38-39°F"           → YES: 0.55¢   (lowTemp: 38, highTemp: 39)
├── Market: "40-41°F"           → YES: 0.70¢   (lowTemp: 40, highTemp: 41)
├── Market: "42-43°F"           → YES: 1.55¢   (lowTemp: 42, highTemp: 43)
├── Market: "44-45°F"           → YES: 11.0¢   (lowTemp: 44, highTemp: 45)
├── Market: "46-47°F"           → YES: 18.0¢   (lowTemp: 46, highTemp: 47)
└── Market: "48°F or higher"    → YES: 67.5¢   (lowTemp: 48, highTemp: ∞)
```

### Market Object Fields We Need
```javascript
{
  "id": "1506388",                    // Market ID
  "question": "Will the highest temperature in New York City be 48°F or higher on March 7?",
  "conditionId": "0x...",             // For trading (Phase 3)
  "groupItemTitle": "48°F or higher", // Short range label
  "groupItemThreshold": "8",          // Sort order index
  "outcomes": "[\"Yes\", \"No\"]",
  "outcomePrices": "[\"0.675\", \"0.325\"]", // JSON-encoded string array
  "volume": "3772.65",
  "clobTokenIds": "[\"...\", \"...\"]",      // YES and NO token IDs (JSON-encoded)
  "active": true,
  "closed": false,
  "bestBid": 0.67,                    // Current best bid
  "bestAsk": 0.68,                    // Current best ask
  "spread": 0.01                      // Bid-ask spread
}
```

### Parsing the Range from `question`
The `question` field contains the full market question. Parse ranges from it:

```javascript
function parseRange(question) {
  // Pattern 1: "between 40-41°F" → { low: 40, high: 41, isOpenEnd: false }
  const rangeMatch = question.match(/(\d+)-(\d+)/);
  if (rangeMatch) {
    return { low: parseInt(rangeMatch[1]), high: parseInt(rangeMatch[2]), isOpenEnd: false };
  }

  // Pattern 2: "48°F or higher" → { low: 48, high: Infinity, isOpenEnd: true, direction: "above" }
  const upperMatch = question.match(/(\d+).*or higher/i);
  if (upperMatch) {
    return { low: parseInt(upperMatch[1]), high: Infinity, isOpenEnd: true, direction: "above" };
  }

  // Pattern 3: "45°F or below" OR "35°F or lower"
  const lowerMatch = question.match(/(\d+).*or (?:lower|below)/i);
  if (lowerMatch) {
    return { low: -Infinity, high: parseInt(lowerMatch[1]), isOpenEnd: true, direction: "below" };
  }

  throw new Error(`Cannot parse range from question: ${question}`);
}
```

> **Note:** Polymarket uses "or below" in questions (not "or lower"). The regex handles both.

### Real-Time Prices (Optional — Phase 2+)
For more accurate pricing, hit the CLOB API:
```
GET https://clob.polymarket.com/price?token_id={clobTokenId}&side=BUY
```
Returns: `{ "price": "0.49" }`

## Date Extraction from Event Title
```javascript
function extractDate(title) {
  // "Highest temperature in NYC on March 7?" → "2026-03-07"
  const match = title.match(/on (\w+ \d+)\?/);
  if (match) {
    const dateStr = match[1]; // "March 7"
    const currentYear = new Date().getFullYear();
    return new Date(`${dateStr}, ${currentYear}`).toISOString().split('T')[0];
  }
  return null;
}
```

## Resolution Source
- Markets resolve based on data from **Weather Underground**:
  `https://www.wunderground.com/history/daily/us/ny/new-york-city/KLGA`
- Measures temperatures to **whole degrees Fahrenheit**
- Only finalized data is used for resolution
- Post-finalization revisions are NOT considered

## Error Handling
- **No matching event found:** Check if market hasn't been created yet (typically created 1-2 days before)
- **Multiple matching events:** Pick the one with the nearest future date
- **API returns empty:** Try slug with/without year, then try nearby dates, then broad search
- **Rate limiting:** Gamma API has generous limits but implement exponential backoff

## Verified Working Example (2026-03-06)
```bash
# This returns the full event with all 9 markets:
curl "https://gamma-api.polymarket.com/events?slug=highest-temperature-in-nyc-on-march-8-2026"

# March 7 also works:
curl "https://gamma-api.polymarket.com/events?slug=highest-temperature-in-nyc-on-march-7-2026"
```
