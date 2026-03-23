/**
 * TempEdge Market Service — Polymarket event discovery + range selection
 *
 * Wraps the Gamma API (no auth required) for:
 *   - Market discovery (slug, search, pagination)
 *   - Temperature range extraction and transformation
 *   - Forecast-to-range selection logic
 *
 * Stateless — no database, no persistent state.
 *
 * Port: 3003
 *
 * API:
 *   GET /api/market?date=2026-03-23           → discover event + ranges
 *   GET /api/ranges?date=2026-03-23&forecastF=59  → selected ranges (target, above, below)
 *   GET /health                               → health check
 */

import 'dotenv/config';
import http from 'http';
import { healthResponse } from '../../shared/health.js';
import { createLogger, requestLogger } from '../../shared/logger.js';
import { nowISO, formatDateForSlug, extractDateFromTitle } from '../../shared/dates.js';
import { jsonResponse as jsonRes, errorResponse as errRes } from '../../shared/httpServer.js';

const log = createLogger('market-svc');

const PORT = parseInt(process.env.MARKET_SVC_PORT || '3003');
const GAMMA_BASE = process.env.GAMMA_BASE_URL || 'https://gamma-api.polymarket.com';
const SLUG_TEMPLATE = process.env.SLUG_TEMPLATE || 'highest-temperature-in-nyc-on-{date}';
const MAX_SEARCH_PAGES = parseInt(process.env.MAX_SEARCH_PAGES || '3');
const SEARCH_PAGE_SIZE = parseInt(process.env.SEARCH_PAGE_SIZE || '100');

// ── Range Parsing ───────────────────────────────────────────────────────

function parseRange(question) {
    const rangeMatch = question.match(/(\d+)-(\d+)/);
    if (rangeMatch) {
        return { low: parseInt(rangeMatch[1]), high: parseInt(rangeMatch[2]), isOpenEnd: false, openEndDirection: null };
    }
    const upperMatch = question.match(/(\d+).*or higher/i);
    if (upperMatch) {
        return { low: parseInt(upperMatch[1]), high: Infinity, isOpenEnd: true, openEndDirection: 'above' };
    }
    const lowerMatch = question.match(/(\d+).*or (?:lower|below)/i);
    if (lowerMatch) {
        return { low: -Infinity, high: parseInt(lowerMatch[1]), isOpenEnd: true, openEndDirection: 'below' };
    }
    throw new Error(`Cannot parse range from question: "${question}"`);
}

function transformMarket(market) {
    const range = parseRange(market.question);
    let yesPrice = 0,
        noPrice = 0;

    try {
        const prices = JSON.parse(market.outcomePrices);
        yesPrice = parseFloat(prices[0]);
        noPrice = parseFloat(prices[1]);
    } catch {
        /* intentional: malformed outcomePrices JSON */
    }

    const bestBid = parseFloat(market.bestBid) || 0;
    const bestAsk = parseFloat(market.bestAsk) || 0;
    if (bestAsk > 0) yesPrice = bestAsk;

    let clobTokenIds = [];
    try {
        clobTokenIds = JSON.parse(market.clobTokenIds);
    } catch {
        /* intentional: may not be valid JSON */
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

// (Date utilities now imported from shared/dates.js)

// ── Gamma API Discovery ────────────────────────────────────────────────

async function gammaFetch(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Gamma API ${res.status}: ${res.statusText}`);
    return res.json();
}

async function trySlugDiscovery(targetDate) {
    const dateSlug = formatDateForSlug(targetDate);
    const slug = SLUG_TEMPLATE.replace('{date}', dateSlug);
    try {
        const data = await gammaFetch(`${GAMMA_BASE}/events?slug=${slug}`);
        if (Array.isArray(data) && data.length > 0) return data[0];
    } catch {
        /* intentional: slug may not exist */
    }
    return null;
}

async function trySlugWithoutYear(targetDate) {
    const [year, month, day] = targetDate.split('-').map(Number);
    const d = new Date(year, month - 1, day);
    const monthName = d.toLocaleDateString('en-US', { month: 'long' }).toLowerCase();
    const slug = `highest-temperature-in-nyc-on-${monthName}-${day}`;
    try {
        const data = await gammaFetch(`${GAMMA_BASE}/events?slug=${slug}`);
        if (Array.isArray(data) && data.length > 0) return data[0];
    } catch {
        /* intentional: slug variant may not exist */
    }
    return null;
}

async function searchAllTemperatureEvents() {
    const results = [];
    try {
        const maxOffset = MAX_SEARCH_PAGES * SEARCH_PAGE_SIZE;
        for (let offset = 0; offset < maxOffset; offset += SEARCH_PAGE_SIZE) {
            const url =
                `${GAMMA_BASE}/events?` +
                new URLSearchParams({
                    active: 'true',
                    closed: 'false',
                    limit: String(SEARCH_PAGE_SIZE),
                    offset: String(offset),
                });
            const data = await gammaFetch(url);
            if (!Array.isArray(data) || data.length === 0) break;

            for (const event of data) {
                const t = event.title?.toLowerCase() || '';
                const s = event.slug?.toLowerCase() || '';
                if ((t.includes('temperature') && t.includes('nyc')) || s.includes('highest-temperature-in-nyc')) {
                    results.push(event);
                }
            }
            if (results.length > 0) break;
        }
    } catch (err) {
        console.warn(`  ⚠️  Series search failed: ${err.message}`);
    }

    if (results.length === 0) {
        const today = new Date();
        for (let i = 0; i <= 7; i++) {
            const d = new Date(today);
            d.setDate(d.getDate() + i);
            const dateStr = d.toISOString().split('T')[0];
            try {
                const event = await trySlugDiscovery(dateStr);
                if (event) results.push(event);
            } catch {
                /* intentional: individual date discovery failure */
            }
        }
    }
    return results;
}

async function discoverMarket(targetDate) {
    let event = await trySlugDiscovery(targetDate);
    if (!event) event = await trySlugWithoutYear(targetDate);
    if (!event) {
        const allEvents = await searchAllTemperatureEvents();
        event = allEvents.find((e) => extractDateFromTitle(e.title) === targetDate);
        if (!event) {
            throw new Error(`No temperature market found for ${targetDate}`);
        }
    }

    const markets = event.markets || [];
    if (markets.length === 0) throw new Error(`Event "${event.title}" has no markets`);

    const ranges = markets.map(transformMarket).sort((a, b) => a.lowTemp - b.lowTemp);
    return {
        id: event.id,
        title: event.title,
        slug: event.slug,
        targetDate: extractDateFromTitle(event.title) || targetDate,
        active: event.active,
        closed: event.closed,
        ranges,
    };
}

// ── Range Selection ─────────────────────────────────────────────────────

function findTargetRange(forecastTempF, ranges) {
    const sorted = [...ranges].sort((a, b) => a.lowTemp - b.lowTemp);
    const roundedUp = Math.ceil(forecastTempF);
    const rangeStart = roundedUp % 2 === 0 ? roundedUp : roundedUp - 1;

    for (const range of sorted) {
        if (range.isOpenEnd && range.openEndDirection === 'above') {
            if (rangeStart >= range.lowTemp) return range;
        } else if (range.isOpenEnd && range.openEndDirection === 'below') {
            if (rangeStart <= range.highTemp) return range;
        } else {
            if (rangeStart === range.lowTemp) return range;
        }
    }
    return sorted[sorted.length - 1];
}

function selectRanges(forecastTempF, ranges, targetDate) {
    const sorted = [...ranges].sort((a, b) => a.lowTemp - b.lowTemp);
    const target = findTargetRange(forecastTempF, sorted);
    const targetIndex = sorted.findIndex((r) => r.marketId === target.marketId);

    const below = targetIndex > 0 ? sorted[targetIndex - 1] : null;
    const above = targetIndex < sorted.length - 1 ? sorted[targetIndex + 1] : null;

    const totalCost = parseFloat((target.yesPrice + (below?.yesPrice ?? 0) + (above?.yesPrice ?? 0)).toFixed(4));
    const potentialProfit = parseFloat((1.0 - totalCost).toFixed(4));
    const roi = totalCost > 0 ? (((1.0 - totalCost) / totalCost) * 100).toFixed(1) + '%' : 'N/A';

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

// (HTTP helpers now imported from shared/httpServer.js)

// ── Request Handler ─────────────────────────────────────────────────────

async function handleRequest(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;
    const query = Object.fromEntries(url.searchParams);

    try {
        if (path === '/health') {
            return jsonRes(res, healthResponse('market-svc', { gammaBase: GAMMA_BASE }));
        }

        if (path === '/api/market') {
            if (!query.date) return errRes(res, 'date parameter required');
            const event = await discoverMarket(query.date);
            return jsonRes(res, event);
        }

        if (path === '/api/ranges') {
            if (!query.date || !query.forecastF) return errRes(res, 'date and forecastF parameters required');
            const event = await discoverMarket(query.date);
            const selection = selectRanges(parseFloat(query.forecastF), event.ranges, query.date);
            return jsonRes(res, { ...selection, eventId: event.id, eventTitle: event.title, closed: event.closed });
        }

        errRes(res, `Not found: ${path}`, 404);
    } catch (err) {
        console.error(`❌ ${path}:`, err.message);
        errRes(res, err.message, 500);
    }
}

// ── Server ──────────────────────────────────────────────────────────────

const server = http.createServer(requestLogger(log, handleRequest));
server.listen(PORT, () => {
    log.info('started', { port: PORT, gammaBase: GAMMA_BASE });
});

process.on('SIGINT', () => {
    server.close();
    process.exit(0);
});
process.on('SIGTERM', () => {
    server.close();
    process.exit(0);
});
