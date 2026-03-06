/**
 * Range selection service — matches forecast to Polymarket ranges
 * 
 * KEY RULE: ALWAYS ROUND UP
 * If forecast is 41.2°F, target range is 42-43°F (not 40-41°F)
 */

import { nowISO } from '../utils/dateUtils.js';

/**
 * Find the target range by rounding UP the forecast temperature
 * @param {number} forecastTempF - e.g. 41.2
 * @param {import('../models/types.js').TemperatureRange[]} ranges - sorted by lowTemp ascending
 * @returns {import('../models/types.js').TemperatureRange}
 */
export function findTargetRange(forecastTempF, ranges) {
    const sorted = [...ranges].sort((a, b) => a.lowTemp - b.lowTemp);

    // ALWAYS ROUND UP: ceil to next integer, then align to even range boundary
    const roundedUp = Math.ceil(forecastTempF);
    const rangeStart = roundedUp % 2 === 0 ? roundedUp : roundedUp - 1;

    console.log(`  Forecast: ${forecastTempF}°F → ceil: ${roundedUp} → rangeStart: ${rangeStart}`);

    for (const range of sorted) {
        if (range.isOpenEnd && range.openEndDirection === 'above') {
            // "48°F or higher"
            if (rangeStart >= range.lowTemp) return range;
        } else if (range.isOpenEnd && range.openEndDirection === 'below') {
            // "35°F or lower"
            if (rangeStart <= range.highTemp) return range;
        } else {
            // Standard range: "40-41°F"
            if (rangeStart === range.lowTemp) return range;
        }
    }

    // Fallback: if rounded-up value exceeds all ranges, pick the highest
    console.warn(`  ⚠️  No exact match for rangeStart=${rangeStart}, falling back to highest range`);
    return sorted[sorted.length - 1];
}

/**
 * Select the target range and adjacent ranges (above and below)
 * @param {number} forecastTempF
 * @param {import('../models/types.js').TemperatureRange[]} ranges
 * @param {string} targetDate
 * @returns {import('../models/types.js').SelectedRanges}
 */
export function selectRanges(forecastTempF, ranges, targetDate) {
    const sorted = [...ranges].sort((a, b) => a.lowTemp - b.lowTemp);
    const target = findTargetRange(forecastTempF, sorted);
    const targetIndex = sorted.findIndex(r => r.marketId === target.marketId);

    const below = targetIndex > 0 ? sorted[targetIndex - 1] : null;
    const above = targetIndex < sorted.length - 1 ? sorted[targetIndex + 1] : null;

    // Cost analysis
    const targetCost = target.yesPrice;
    const belowCost = below?.yesPrice ?? 0;
    const aboveCost = above?.yesPrice ?? 0;
    const totalCost = parseFloat((targetCost + belowCost + aboveCost).toFixed(4));
    const potentialProfit = parseFloat((1.0 - totalCost).toFixed(4));
    const roi = totalCost > 0
        ? ((1.0 - totalCost) / totalCost * 100).toFixed(1) + '%'
        : 'N/A';

    return {
        target,
        below,
        above,
        forecastTempF,
        forecastSource: 'weather-company',
        targetDate,
        selectionTimestamp: nowISO(),
        totalCost,
        potentialProfit,
        roi,
    };
}
