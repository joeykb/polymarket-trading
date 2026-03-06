# Feature: Range Selection

## Overview
Given a forecast temperature and a set of Polymarket temperature ranges, select the 3 best ranges to observe (and eventually buy): the **target range** and the **ranges immediately above and below** it.

## Key Rule: ALWAYS ROUND UP
When a forecast temperature falls within a range, we **always round UP to the next range**.

- Forecast 41.2°F → Target: **42-43°F** (not 40-41°F)
- Forecast 39.7°F → Target: **40-41°F** (not 38-39°F)
- Forecast 42.0°F → Target: **42-43°F** (exact match — no rounding needed)

**Rationale**: The forecast is a prediction. If it says 41.2°F, the actual temp is likely to drift up. We target the range above the raw forecast.

## Algorithm

### Step 1: Parse All Available Ranges
- Sort ranges by `lowTemp` ascending
- Ensure edge ranges ("X°F or lower", "X°F or higher") are at the correct ends

### Step 2: Round Up and Match Forecast to Target Range
```javascript
function findTargetRange(forecastTempF, ranges) {
  // Sort ranges by lowTemp
  const sorted = ranges.sort((a, b) => a.lowTemp - b.lowTemp);
  
  // ALWAYS ROUND UP: ceil to the next even number (range boundary)
  // 41.2 → ceil to 42 → target range starts at 42
  // 39.7 → ceil to 40 → target range starts at 40
  // 42.0 → stays 42 → target range starts at 42
  const roundedUp = Math.ceil(forecastTempF);
  // Align to even range boundary (ranges are 36-37, 38-39, 40-41, etc.)
  const rangeStart = roundedUp % 2 === 0 ? roundedUp : roundedUp - 1;
  
  for (const range of sorted) {
    if (range.isOpenEnd && range.openEndDirection === "above") {
      // "48°F or higher" — if rangeStart >= this range's lowTemp
      if (rangeStart >= range.lowTemp) return range;
    } else if (range.isOpenEnd && range.openEndDirection === "below") {
      // "35°F or lower" — if rangeStart <= this range's highTemp
      if (rangeStart <= range.highTemp) return range;
    } else {
      // Standard range: "40-41°F"
      if (rangeStart === range.lowTemp) return range;
    }
  }
  
  // Fallback: if rounded-up value exceeds all ranges, pick the highest
  return sorted[sorted.length - 1];
}
```

### Step 3: Select Adjacent Ranges
```javascript
function selectRanges(forecastTempF, ranges) {
  const sorted = ranges.sort((a, b) => a.lowTemp - b.lowTemp);
  const targetIndex = sorted.findIndex(r => r === findTargetRange(forecastTempF, sorted));
  
  return {
    target: sorted[targetIndex],
    below: targetIndex > 0 ? sorted[targetIndex - 1] : null,
    above: targetIndex < sorted.length - 1 ? sorted[targetIndex + 1] : null,
  };
}
```

## Edge Cases

### 1. Forecast Already Aligned to Range Start
Example: forecast = 42.0°F
- Ceil(42.0) = 42, rangeStart = 42
- Target: **42-43°F** ✅

### 2. Forecast Mid-Range (Round Up)
Example: forecast = 41.2°F
- Ceil(41.2) = 42, rangeStart = 42
- Target: **42-43°F**, Below: 40-41°F, Above: 44-45°F

### 3. Forecast at Odd Number
Example: forecast = 39.7°F
- Ceil(39.7) = 40, rangeStart = 40
- Target: **40-41°F**, Below: 38-39°F, Above: 42-43°F

### 4. Forecast Rounds Into Open-End Range
Example: forecast = 47.3°F
- Ceil(47.3) = 48, rangeStart = 48
- Target: **48°F or higher**, Below: 46-47°F, Above: null

### 5. Forecast at Low Extreme
Example: forecast = 34°F
- Target: "35°F or lower" (or whatever the lowest range is)
- Below: `null` (no range below)
- Above: "36-37°F"

### 6. No Adjacent Range Available
- If target is the first range: `below = null`
- If target is the last range: `above = null`
- These are valid states — output should note "no lower/upper range available"

## Cost Analysis
The output should include a quick cost analysis:

```javascript
function analyzeCost(selected) {
  const targetCost = selected.target.yesPrice;
  const belowCost = selected.below?.yesPrice ?? 0;
  const aboveCost = selected.above?.yesPrice ?? 0;
  
  const totalCost = targetCost + belowCost + aboveCost;
  const potentialProfit = 1.0 - totalCost; // One will resolve to $1 if correct
  
  return {
    totalCost,
    potentialProfit,
    roi: ((1.0 - totalCost) / totalCost * 100).toFixed(1) + '%',
    breakEvenIfOneHits: true, // Always true if totalCost < $1
  };
}
```

> **Important**: In Polymarket's neg-risk structure, buying YES on 3 ranges costs the sum of all 3 prices. Only ONE can resolve to $1. So if you buy YES at $0.26 + $0.49 + $0.07 = $0.82, you get $1 back if any one hits = $0.18 profit. But you need the forecast to be accurate to one of those 3 ranges.
