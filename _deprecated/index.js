/**
 * TempEdge — Polymarket NYC Temperature Predictor
 * 
 * Main orchestrator for Phase 1: Observation Mode
 * 
 * Usage:
 *   node src/index.js                  # Auto-detect next available date
 *   node src/index.js 2026-03-07       # Specific target date
 */

import { fetchForecast, fetchAllForecastDays } from './services/weather.js';
import { discoverMarket } from './services/polymarket.js';
import { selectRanges } from './services/rangeSelector.js';
import { writeObservation } from './utils/fileWriter.js';
import { getTomorrowET, nowISO } from './utils/dateUtils.js';
import crypto from 'crypto';

/**
 * Print a formatted console summary
 * @param {import('./models/types.js').SelectedRanges} selection
 * @param {string} targetDate
 * @param {number} forecastTempF
 */
function printSummary(selection, targetDate, forecastTempF) {
    const pad = (s, len) => s.toString().padEnd(len);
    const padL = (s, len) => s.toString().padStart(len);

    const formatRange = (label, range) => {
        if (!range) return `║  ${pad(label, 4)} (none)   │  --         │  --                    ║`;
        const question = pad(range.question, 10);
        const price = padL((range.yesPrice * 100).toFixed(1) + '¢', 6);
        const prob = padL(range.impliedProbability.toFixed(1) + '%', 6);
        return `║  ${pad(label, 4)} ${question}│  YES: ${price}│  Prob: ${prob}          ║`;
    };

    const dateFmt = new Date(targetDate + 'T00:00:00').toLocaleDateString('en-US', {
        month: 'long', day: 'numeric', year: 'numeric'
    });

    console.log('');
    console.log('╔══════════════════════════════════════════════════════╗');
    console.log('║  TempEdge - Polymarket NYC Temperature Predictor     ║');
    console.log('╠══════════════════════════════════════════════════════╣');
    console.log(`║  Target Date:  ${pad(dateFmt, 39)}║`);
    console.log(`║  KLGA Forecast High:  ${pad(forecastTempF + '°F (Open-Meteo)', 32)}║`);
    console.log(`║  Rounded-Up Target:   ${pad(selection.target.question + ' range', 32)}║`);
    console.log('╠══════════════════════════════════════════════════════╣');
    console.log(formatRange('⬇️ ', selection.below));
    console.log(formatRange('🎯', selection.target));
    console.log(formatRange('⬆️ ', selection.above));
    console.log('╠══════════════════════════════════════════════════════╣');
    console.log(`║  Total cost: $${pad(selection.totalCost.toFixed(3), 8)}│  Profit if hit: $${pad(selection.potentialProfit.toFixed(3), 7)}║`);
    console.log(`║  ROI: ${pad(selection.roi, 48)}║`);
    console.log('╚══════════════════════════════════════════════════════╝');
}

/**
 * Print all available ranges with prices
 * @param {import('./models/types.js').TemperatureRange[]} ranges
 * @param {import('./models/types.js').SelectedRanges} selection
 */
function printAllRanges(ranges, selection) {
    console.log('\n  All Available Ranges:');
    console.log('  ┌─────────────────┬──────────┬───────────┬────────────┬──────────┐');
    console.log('  │ Range           │ YES      │ Implied % │ Volume     │ Selected │');
    console.log('  ├─────────────────┼──────────┼───────────┼────────────┼──────────┤');

    const sorted = [...ranges].sort((a, b) => a.lowTemp - b.lowTemp);
    for (const range of sorted) {
        const q = range.question.padEnd(15);
        const yes = (range.yesPrice.toFixed(3) + '').padEnd(8);
        const prob = (range.impliedProbability.toFixed(1) + '%').padEnd(9);
        const vol = ('$' + range.volume.toFixed(0)).padEnd(10);
        let marker = '  ';
        if (range.marketId === selection.target.marketId) marker = '🎯';
        else if (selection.below && range.marketId === selection.below.marketId) marker = '⬇️';
        else if (selection.above && range.marketId === selection.above.marketId) marker = '⬆️';
        console.log(`  │ ${q} │ ${yes} │ ${prob} │ ${vol} │   ${marker}   │`);
    }

    console.log('  └─────────────────┴──────────┴───────────┴────────────┴──────────┘');
}

/**
 * Main execution
 */
async function main() {
    console.log('\n🌡️  TempEdge — Polymarket NYC Temperature Predictor\n');
    console.log('═══════════════════════════════════════════════════');

    // Determine target date
    let targetDate = process.argv[2];
    if (!targetDate) {
        targetDate = getTomorrowET();
        console.log(`\n  No date specified. Using tomorrow: ${targetDate}`);
    } else {
        console.log(`\n  Target date: ${targetDate}`);
    }

    // Step 1: Fetch weather forecast
    console.log('\n📡 Step 1: Fetching weather forecast...');
    const forecast = await fetchForecast(targetDate);

    // Step 2: Discover Polymarket event
    console.log('\n🔍 Step 2: Discovering Polymarket event...');
    let event;
    try {
        event = await discoverMarket(targetDate);
    } catch (err) {
        console.error(`\n  ❌ ${err.message}`);
        console.log('\n  Attempting to find any available temperature events...');

        // Fetch all forecast days and try each
        const forecastDays = await fetchAllForecastDays();
        let foundEvent = null;
        for (const day of forecastDays) {
            try {
                foundEvent = await discoverMarket(day.date);
                targetDate = day.date;
                console.log(`  ✅ Found event for ${day.date} instead.`);
                break;
            } catch {
                continue;
            }
        }

        if (!foundEvent) {
            console.error('\n  ❌ No temperature events found for any forecast date.');
            console.log('  Temperature markets may not be actively listed right now.');
            process.exit(1);
        }
        event = foundEvent;

        // Re-fetch forecast for the found date if it changed
        if (targetDate !== forecast.date) {
            console.log(`\n  Re-fetching forecast for ${targetDate}...`);
            const updatedForecast = await fetchForecast(targetDate);
            Object.assign(forecast, updatedForecast);
        }
    }

    // Step 3: Select ranges
    console.log('\n🎯 Step 3: Selecting ranges (always round UP)...');
    const selection = selectRanges(forecast.highTempF, event.ranges, targetDate);

    // Step 4: Print results
    printSummary(selection, targetDate, forecast.highTempF);
    printAllRanges(event.ranges, selection);

    // Step 5: Write observation file
    console.log('\n💾 Step 4: Writing observation file...');
    /** @type {import('./models/types.js').ObservationRecord} */
    const record = {
        id: crypto.randomUUID(),
        targetDate,
        forecast,
        event: {
            id: event.id,
            title: event.title,
            slug: event.slug,
            targetDate: event.targetDate,
            active: event.active,
            closed: event.closed,
            ranges: event.ranges,
        },
        selection,
        createdAt: nowISO(),
    };

    const filePath = writeObservation(record);
    console.log(`\n  ✅ Output saved to: ${filePath}`);
    console.log('\n═══════════════════════════════════════════════════');
    console.log('  Done! Review the output file for full details.\n');
}

main().catch(err => {
    console.error('\n❌ Fatal error:', err.message);
    console.error(err.stack);
    process.exit(1);
});
