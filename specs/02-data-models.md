# Data Models

## Core Types (JSDoc)

### WeatherForecast
```javascript
/**
 * @typedef {Object} WeatherForecast
 * @property {string} source - "open-meteo" | "wunderground"
 * @property {string} station - "KLGA"
 * @property {string} date - Target date ISO string, e.g. "2026-03-07"
 * @property {number} highTempF - Forecasted high temperature in Fahrenheit
 * @property {string} fetchedAt - ISO timestamp when forecast was fetched
 */
```

### PolymarketEvent
```javascript
/**
 * @typedef {Object} PolymarketEvent
 * @property {string} id - Polymarket event ID
 * @property {string} title - e.g. "Highest temperature in NYC on March 7?"
 * @property {string} slug - URL slug
 * @property {string} targetDate - The date the market is predicting for, e.g. "2026-03-07"
 * @property {boolean} active - Whether the event is still open for trading
 * @property {boolean} closed - Whether the event has been resolved
 * @property {TemperatureRange[]} ranges - All available temperature ranges
 */
```

### TemperatureRange
```javascript
/**
 * @typedef {Object} TemperatureRange
 * @property {string} marketId - Polymarket market ID for this range
 * @property {string} question - e.g. "40-41°F"
 * @property {string} conditionId - Condition ID for the market
 * @property {number} lowTemp - Lower bound (inclusive), e.g. 40
 * @property {number} highTemp - Upper bound (inclusive), e.g. 41
 * @property {boolean} isOpenEnd - True for ranges like "48°F or higher" or "36°F or lower"
 * @property {string} openEndDirection - "above" | "below" | null
 * @property {number} yesPrice - Current YES price (0-1), e.g. 0.49
 * @property {number} noPrice - Current NO price (0-1), e.g. 0.54
 * @property {number} impliedProbability - YES price as percentage, e.g. 49
 * @property {number} volume - Total volume in USD
 * @property {string[]} clobTokenIds - [yesTokenId, noTokenId]
 */
```

### SelectedRanges
```javascript
/**
 * @typedef {Object} SelectedRanges
 * @property {TemperatureRange} target - The range matching the forecast
 * @property {TemperatureRange|null} below - One range below target
 * @property {TemperatureRange|null} above - One range above target
 * @property {number} forecastTempF - The forecast temperature used for selection
 * @property {string} forecastSource - Weather source used
 * @property {string} targetDate - The date this prediction is for
 * @property {string} selectionTimestamp - When this selection was made (ISO)
 * @property {number} totalCost - Sum of YES prices for all 3 ranges (in cents)
 * @property {number} potentialProfit - $1.00 minus totalCost (guaranteed return if one hits)
 */
```

### ObservationRecord
```javascript
/**
 * @typedef {Object} ObservationRecord
 * @property {string} id - Unique record ID (uuid)
 * @property {string} targetDate - e.g. "2026-03-07"
 * @property {WeatherForecast} forecast
 * @property {PolymarketEvent} event
 * @property {SelectedRanges} selection
 * @property {string} createdAt - ISO timestamp
 * @property {ObservationUpdate[]} updates - Subsequent re-checks (Phase 2)
 */
```

### ObservationUpdate (Phase 2)
```javascript
/**
 * @typedef {Object} ObservationUpdate
 * @property {string} timestamp - ISO timestamp of this check
 * @property {number} updatedForecastTempF - May shift as day approaches
 * @property {TemperatureRange} target - Updated prices
 * @property {TemperatureRange|null} below - Updated prices
 * @property {TemperatureRange|null} above - Updated prices
 * @property {string} notes - Any notable changes
 */
```

## Polymarket Range Parsing

Based on the screenshot, the temperature market structure for NYC is:

| Range Label      | lowTemp | highTemp | isOpenEnd | openEndDirection |
|------------------|---------|----------|-----------|------------------|
| "36-37°F"        | 36      | 37       | false     | null             |
| "38-39°F"        | 38      | 39       | false     | null             |
| "40-41°F"        | 40      | 41       | false     | null             |
| "42-43°F"        | 42      | 43       | false     | null             |
| "44-45°F"        | 44      | 45       | false     | null             |
| "46-47°F"        | 46      | 47       | false     | null             |
| "48°F or higher" | 48      | Infinity | true      | "above"          |

> **Note**: There may also be a "35°F or lower" type range at the bottom. The available ranges change day-to-day based on forecast. We parse whatever ranges are available from the event.

## Range Matching Algorithm — ALWAYS ROUND UP

```
Given forecastTempF = 41.2:
1. Ceil(41.2) = 42
2. Align to even range boundary: 42
3. Target range: 42-43°F (rangeStart=42)
4. Below range: 40-41°F (rangeStart=40)  
5. Above range: 44-45°F (rangeStart=44)

Given forecastTempF = 39.7:
1. Ceil(39.7) = 40
2. Align to even: 40
3. Target: 40-41°F, Below: 38-39°F, Above: 42-43°F

Given forecastTempF = 42.0 (exact):
1. Ceil(42.0) = 42
2. Target: 42-43°F, Below: 40-41°F, Above: 44-45°F

Edge Case - Forecast near extremes (35.5):
1. Ceil(35.5) = 36, rangeStart = 36
2. Target: 36-37°F
3. Below: "35°F or lower" (if it exists), Above: 38-39°F
```

## Output File Schema

### JSON Output (`output/2026-03-07.json`)
```json
{
  "id": "abc123",
  "targetDate": "2026-03-07",
  "createdAt": "2026-03-06T10:30:00-05:00",
  "forecast": {
    "source": "open-meteo",
    "station": "KLGA",
    "date": "2026-03-07",
    "highTempF": 47.7,
    "fetchedAt": "2026-03-06T10:30:00-05:00"
  },
  "selection": {
    "forecastTempF": 47.7,
    "forecastSource": "open-meteo",
    "targetDate": "2026-03-07",
    "selectionTimestamp": "2026-03-06T10:30:01-05:00",
    "totalCost": 0.82,
    "potentialProfit": 0.18,
    "target": {
      "question": "46-47°F",
      "yesPrice": 0.036,
      "impliedProbability": 3.6,
      "volume": 18820
    },
    "below": {
      "question": "44-45°F",
      "yesPrice": 0.078,
      "impliedProbability": 7.8,
      "volume": 16744
    },
    "above": {
      "question": "48°F or higher",
      "yesPrice": 0.005,
      "impliedProbability": 0.5,
      "volume": 49784
    }
  }
}
```
