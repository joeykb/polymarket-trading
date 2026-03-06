# API Contracts

## 1. Open-Meteo Forecast API

### Request
```http
GET https://api.open-meteo.com/v1/forecast
  ?latitude=40.7769
  &longitude=-73.8740
  &daily=temperature_2m_max
  &temperature_unit=fahrenheit
  &timezone=America/New_York
  &forecast_days=7
```

### Response (200 OK)
```json
{
  "latitude": 40.76809,
  "longitude": -73.862785,
  "generationtime_ms": 0.048,
  "utc_offset_seconds": -18000,
  "timezone": "America/New_York",
  "timezone_abbreviation": "GMT-5",
  "elevation": 1.0,
  "daily_units": {
    "time": "iso8601",
    "temperature_2m_max": "°F"
  },
  "daily": {
    "time": ["2026-03-06", "2026-03-07", "2026-03-08", ...],
    "temperature_2m_max": [39.7, 47.7, 58.2, ...]
  }
}
```

### Notes
- No authentication required
- Rate limit: 10,000 requests/day (generous)
- Coordinates 40.7769, -73.8740 = LaGuardia Airport
- Forecast covers up to 16 days

---

## 2. Polymarket Gamma API — Event/Market Search

### Request (Search)
```http
GET https://gamma-api.polymarket.com/public-search
  ?q=Highest+temperature+in+NYC
```

### Request (Events Listing)
```http
GET https://gamma-api.polymarket.com/events
  ?active=true
  &closed=false
  &limit=50
  &order=startDate
  &ascending=false
```

### Response (200 OK) — Event Object
```json
{
  "id": "...",
  "title": "Highest temperature in NYC on March 7?",
  "slug": "highest-temperature-in-nyc-on-march-7",
  "active": true,
  "closed": false,
  "enableNegRisk": true,
  "markets": [
    {
      "id": "...",
      "question": "40-41°F",
      "conditionId": "0x...",
      "outcomes": "[\"Yes\", \"No\"]",
      "outcomePrices": "[\"0.49\", \"0.54\"]",
      "volume": "10710",
      "active": true,
      "closed": false,
      "clobTokenIds": "[\"...\", \"...\"]"
    },
    ...
  ]
}
```

### Notes
- No authentication required for read
- `outcomePrices` is a JSON-encoded string (must be parsed)
- `clobTokenIds` is a JSON-encoded string array (must be parsed)
- `enableNegRisk: true` indicates multi-outcome market structure
- Markets are sorted by range (ascending)

---

## 3. Polymarket CLOB API — Real-time Price (Phase 2+)

### Request
```http
GET https://clob.polymarket.com/price
  ?token_id={clobTokenId}
  &side=BUY
```

### Response (200 OK)
```json
{
  "price": "0.49"
}
```

### Notes
- No authentication required for price reads
- `side=BUY` returns the best ask (price to buy YES)
- `side=SELL` returns the best bid (price to sell YES)
- Use for real-time pricing when Gamma API prices lag

---

## 4. Polymarket CLOB API — Trading (Phase 3)

### Authentication Required
- API Key + Secret
- Polygon wallet for on-chain settlements
- USDC deposit needed

### Place Order
```http
POST https://clob.polymarket.com/order
Authorization: ...
Content-Type: application/json

{
  "tokenID": "...",
  "price": "0.49",
  "size": "10",
  "side": "BUY",
  "feeRateBps": "0"
}
```

> Phase 3 implementation details will be added when ready.
