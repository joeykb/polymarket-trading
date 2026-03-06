# Feature: Weather Forecast Fetch

## Overview
Fetch the forecasted daily high temperature for NYC LaGuardia Airport (KLGA) for the target date.

## Primary Source: Open-Meteo API

### Endpoint (Verified Working)
```
GET https://api.open-meteo.com/v1/forecast
  ?latitude=40.7769
  &longitude=-73.8740
  &daily=temperature_2m_max
  &temperature_unit=fahrenheit
  &timezone=America/New_York
  &forecast_days=7
```

### Response (Verified 2026-03-06)
```json
{
  "latitude": 40.76809,
  "longitude": -73.862785,
  "daily_units": { "time": "iso8601", "temperature_2m_max": "°F" },
  "daily": {
    "time": ["2026-03-06", "2026-03-07", "2026-03-08"],
    "temperature_2m_max": [39.7, 47.7, 58.2]
  }
}
```

### Key Details
- **No API key required** — free for non-commercial use
- **Coordinates**: 40.7769, -73.8740 (LaGuardia Airport)
- **Returns**: Up to 16 days of daily high temperatures
- **Units**: Temperature in Fahrenheit (`temperature_unit=fahrenheit`)
- **Timezone**: America/New_York (so "day" aligns with local NYC time)

### Implementation Notes
1. Pick the target date from the response `daily.time` array
2. Get corresponding `temperature_2m_max` value
3. If target date is beyond forecast range, throw an error
4. Consider fetching multiple days to identify "next available" Polymarket event

## Secondary Source: Weather Underground (Phase 2)

### URL
```
https://www.wunderground.com/forecast/us/ny/new-york-city/KLGA
```

### Challenge
- Page is **JavaScript-rendered** — the forecast data is NOT in the raw HTML
- Requires Puppeteer/Playwright to scrape

### Approach (Phase 2)
1. Use Puppeteer to load the page
2. Wait for the forecast table to render
3. Extract daily high temps from the DOM
4. Cross-reference with Open-Meteo data for validation

## Target Date Selection Logic

```
Today = March 6, 2026

1. Check: Is there an active Polymarket market for TODAY?
   - If yes but market is closing soon (< 6 hours), skip to tomorrow
   - If yes and still open, use today's date

2. Check: Is there an active Polymarket market for TOMORROW?
   - If yes, use tomorrow's date (preferred — gives time to observe)

3. Fallback: Find the NEXT active market date
   - Search Polymarket for the next available temperature event

Preferred behavior: Target TOMORROW's market (1 day in advance)
```

## Error Handling
- Network timeout: Retry up to 3 times with exponential backoff
- No forecast for target date: Log error, suggest manual check
- API rate limiting: Open-Meteo is generous, but implement delays between calls
