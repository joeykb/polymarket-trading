/**
 * Polymarket service — discovers temperature markets and extracts range data
 * 
 * Uses the Gamma API (no auth required for reads):
 *   https://gamma-api.polymarket.com
 * 
 * Strategy: Try multiple discovery approaches in order:
 *   1. Direct slug construction (fastest)
 *   2. Keyword search via /events endpoint  
 *   3. Fallback: public search
 */

import { formatDateForSlug } from '../utils/dateUtils.js';
import { config } from '../config.js';

const GAMMA_BASE = config.polymarket.gammaBaseUrl;

/**
 * Parse a temperature range from a Polymarket market question string
 * @param {string} question - e.g. "40-41°F", "48°F or higher", "35°F or lower"
 * @returns {{low: number, high: number, isOpenEnd: boolean, openEndDirection: string|null}}
 */
function parseRange(question) {
    // Pattern 1: "40-41°F"
    const rangeMatch = question.match(/(\d+)-(\d+)/);
    if (rangeMatch) {
        return {
            low: parseInt(rangeMatch[1]),
            high: parseInt(rangeMatch[2]),
            isOpenEnd: false,
            openEndDirection: null,
        };
    }

    // Pattern 2: "48°F or higher" or "48° or higher"
    const upperMatch = question.match(/(\d+).*or higher/i);
    if (upperMatch) {
        return {
            low: parseInt(upperMatch[1]),
            high: Infinity,
            isOpenEnd: true,
            openEndDirection: 'above',
        };
    }

    // Pattern 3: "35°F or lower" or "45°F or below"
    const lowerMatch = question.match(/(\d+).*or (?:lower|below)/i);
    if (lowerMatch) {
        return {
            low: -Infinity,
            high: parseInt(lowerMatch[1]),
            isOpenEnd: true,
            openEndDirection: 'below',
        };
    }

    throw new Error(`Cannot parse range from question: "${question}"`);
}

/**
 * Transform a Polymarket market object into our TemperatureRange type
 * @param {Object} market - Raw Polymarket market object from Gamma API
 * @returns {import('../models/types.js').TemperatureRange}
 */
function transformMarket(market) {
    const range = parseRange(market.question);

    // Price hierarchy: bestAsk (what you'd pay to buy) > outcomePrices (mid/computed)
    // Polymarket UI shows bestAsk as the "Buy Yes" price
    let yesPrice = 0;
    let noPrice = 0;
    let bestBid = 0;
    let bestAsk = 0;

    try {
        const prices = JSON.parse(market.outcomePrices);
        yesPrice = parseFloat(prices[0]);
        noPrice = parseFloat(prices[1]);
    } catch {
        console.warn(`  ⚠️  Could not parse outcomePrices for "${market.question}"`);
    }

    // Use bestAsk as the actual buy price (matches Polymarket UI)
    bestBid = parseFloat(market.bestBid) || 0;
    bestAsk = parseFloat(market.bestAsk) || 0;
    if (bestAsk > 0) {
        yesPrice = bestAsk;
    }

    // clobTokenIds is a JSON-encoded string array
    let clobTokenIds = [];
    try {
        clobTokenIds = JSON.parse(market.clobTokenIds);
    } catch {
        // ok to ignore - only needed for Phase 3 trading
    }

    return {
        marketId: market.id,
        question: market.question,
        conditionId: market.conditionId,
        lowTemp: range.low,
        highTemp: range.high,
        isOpenEnd: range.isOpenEnd,
        openEndDirection: range.openEndDirection,
        yesPrice,
        noPrice,
        bestBid,
        bestAsk,
        impliedProbability: parseFloat((yesPrice * 100).toFixed(1)),
        volume: parseFloat(market.volume) || 0,
        clobTokenIds,
    };
}

/**
 * Extract date from Polymarket event title
 * @param {string} title - e.g. "Highest temperature in NYC on March 7?"
 * @returns {string|null} - ISO date string or null
 */
function extractDateFromTitle(title) {
    const match = title.match(/on (\w+ \d+)\??/i);
    if (match) {
        const dateStr = match[1]; // "March 7"
        const currentYear = new Date().getFullYear();
        const parsed = new Date(`${dateStr}, ${currentYear}`);
        if (!isNaN(parsed.getTime())) {
            return parsed.toISOString().split('T')[0];
        }
    }
    return null;
}

/**
 * Fetch data from Gamma API with error handling
 * @param {string} url 
 * @returns {Promise<any>}
 */
async function gammaFetch(url) {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Gamma API returned ${response.status}: ${response.statusText}`);
    }
    return response.json();
}

/**
 * Strategy 1: Try constructing the slug directly
 * @param {string} targetDate - e.g. "2026-03-07"
 * @returns {Promise<Object|null>}
 */
async function trySlugDiscovery(targetDate) {
    const dateSlug = formatDateForSlug(targetDate);
    const slug = config.polymarket.slugTemplate.replace('{date}', dateSlug);
    console.log(`  Trying slug: ${slug}`);

    try {
        const data = await gammaFetch(`${GAMMA_BASE}/events?slug=${slug}`);
        if (Array.isArray(data) && data.length > 0) {
            return data[0];
        }
    } catch {
        // slug didn't work, try next strategy
    }
    return null;
}

/**
 * Strategy 2: Try slug WITHOUT the year (fallback for old-style slugs)
 * Some older events might not have the year in the slug.
 * @param {string} targetDate - e.g. "2026-03-07"
 * @returns {Promise<Object|null>}
 */
async function trySlugWithoutYear(targetDate) {
    const [year, month, day] = targetDate.split('-').map(Number);
    const date = new Date(year, month - 1, day);
    const monthName = date.toLocaleDateString('en-US', { month: 'long' }).toLowerCase();
    const slug = `highest-temperature-in-nyc-on-${monthName}-${day}`;
    console.log(`  Trying slug (no year): ${slug}`);

    try {
        const data = await gammaFetch(`${GAMMA_BASE}/events?slug=${slug}`);
        if (Array.isArray(data) && data.length > 0) {
            return data[0];
        }
    } catch {
        // slug didn't work, try next strategy
    }
    return null;
}

/**
 * Strategy 3: Discover via the NYC Daily Weather series slug
 * The Gamma API's tag/title search is unreliable, but the series slug works.
 * @returns {Promise<Object[]>}
 */
async function searchAllTemperatureEvents() {
    console.log('  Searching via NYC Daily Weather series...');
    const results = [];

    try {
        // The temperature markets belong to the "nyc-daily-weather" series.
        // We can find them by querying events with this series_slug.
        const url = `${GAMMA_BASE}/events?` + new URLSearchParams({
            active: 'true',
            closed: 'false',
            limit: '20',
        });

        // Since the Gamma API filtering is unreliable, fetch a large batch
        // and filter client-side for temperature events
        const maxOffset = config.polymarket.maxSearchPages * config.polymarket.searchPageSize;
        const pageSize = config.polymarket.searchPageSize;
        for (let offset = 0; offset < maxOffset; offset += pageSize) {
            const paginatedUrl = `${GAMMA_BASE}/events?` + new URLSearchParams({
                active: 'true',
                closed: 'false',
                limit: String(pageSize),
                offset: String(offset),
            });

            const data = await gammaFetch(paginatedUrl);
            if (!Array.isArray(data) || data.length === 0) break;

            for (const event of data) {
                const titleLower = event.title?.toLowerCase() || '';
                const slugLower = event.slug?.toLowerCase() || '';
                if (
                    (titleLower.includes('temperature') && titleLower.includes('nyc')) ||
                    slugLower.includes('highest-temperature-in-nyc')
                ) {
                    results.push(event);
                }
            }

            // If we found some temperature events, stop paginating
            if (results.length > 0) break;
        }
    } catch (err) {
        console.warn(`  ⚠️  Series search failed: ${err.message}`);
    }

    // Fallback: try direct slug construction for nearby dates
    if (results.length === 0) {
        console.log('  Trying nearby date slugs...');
        const today = new Date();
        for (let i = 0; i <= 7; i++) {
            const d = new Date(today);
            d.setDate(d.getDate() + i);
            const dateStr = d.toISOString().split('T')[0];
            try {
                const event = await trySlugDiscovery(dateStr);
                if (event) {
                    results.push(event);
                }
            } catch {
                // ignore and try next date
            }
        }
    }

    return results;
}

/**
 * Discover the Polymarket temperature event for a given target date
 * @param {string} targetDate - ISO date string, e.g. "2026-03-07"
 * @returns {Promise<import('../models/types.js').PolymarketEvent>}
 */
export async function discoverMarket(targetDate) {
    console.log(`  Looking for Polymarket temperature event for ${targetDate}...`);

    // Strategy 1: Direct slug
    let event = await trySlugDiscovery(targetDate);

    // Strategy 2: Try slug without year (fallback for old-style)
    if (!event) {
        event = await trySlugWithoutYear(targetDate);
    }

    // Strategy 3: Broad search + match
    if (!event) {
        const allEvents = await searchAllTemperatureEvents();
        event = allEvents.find(e => {
            const extracted = extractDateFromTitle(e.title);
            return extracted === targetDate;
        });

        // If no exact match, show available dates
        if (!event && allEvents.length > 0) {
            const available = allEvents.map(e => ({
                title: e.title,
                date: extractDateFromTitle(e.title),
                slug: e.slug,
            }));
            console.log('\n  Available temperature events:');
            available.forEach(a => console.log(`    • ${a.title} → ${a.date}`));
            throw new Error(
                `No temperature market found for ${targetDate}. See available events above.`
            );
        }
    }

    if (!event) {
        throw new Error(
            `Could not find a Polymarket temperature event for ${targetDate}. ` +
            `The market may not be created yet (typically created 1-2 days before).`
        );
    }

    // Parse markets into temperature ranges
    const markets = event.markets || [];
    if (markets.length === 0) {
        throw new Error(`Event "${event.title}" has no markets (ranges). Event ID: ${event.id}`);
    }

    const ranges = markets.map(transformMarket).sort((a, b) => a.lowTemp - b.lowTemp);

    /** @type {import('../models/types.js').PolymarketEvent} */
    const result = {
        id: event.id,
        title: event.title,
        slug: event.slug,
        targetDate: extractDateFromTitle(event.title) || targetDate,
        active: event.active,
        closed: event.closed,
        ranges,
    };

    console.log(`  ✅ Found: "${event.title}" with ${ranges.length} ranges`);
    return result;
}
