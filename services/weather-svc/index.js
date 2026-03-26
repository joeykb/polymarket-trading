/**
 * TempEdge Weather Service — HTTP API for forecast + current conditions
 *
 * Wraps Weather Company (primary) and Open-Meteo (fallback) APIs.
 * Stateless — no database, no persistent state.
 *
 * Port: 3002
 *
 * API:
 *   GET /api/forecast?date=2026-03-23              → forecast high temp
 *   GET /api/current                               → current conditions
 *   GET /api/weather?date=2026-03-23               → forecast + current
 *   GET /api/forecast-days                         → all available forecast days
 *   GET /health                                    → health check
 */

import 'dotenv/config';
import http from 'http';
import { healthResponse } from '../../shared/health.js';
import { createLogger, requestLogger } from '../../shared/logger.js';
import { nowISO } from '../../shared/dates.js';
import { jsonResponse as jsonRes, errorResponse as errRes } from '../../shared/httpServer.js';
import { TtlCache } from '../../shared/cache.js';
import { CircuitBreaker, CircuitOpenError } from '../../shared/circuitBreaker.js';

const log = createLogger('weather-svc');

const PORT = parseInt(process.env.WEATHER_SVC_PORT || '3002');

// ── Config (from env vars) ──────────────────────────────────────────────

const cfg = () => ({
    lat: parseFloat(process.env.STATION_LAT || '40.7769'),
    lon: parseFloat(process.env.STATION_LON || '-73.8740'),
    apiKey: process.env.WC_API_KEY || '',
    wcBase: process.env.WC_BASE_URL || 'https://api.weather.com/v3/wx',
    omBase: process.env.OPEN_METEO_URL || 'https://api.open-meteo.com/v1/forecast',
    retries: parseInt(process.env.WEATHER_RETRIES || '2'),
});

// ── Weather Company (Primary) ───────────────────────────────────────────

async function fetchWCForecast(targetDate) {
    const c = cfg();
    const url = `${c.wcBase}/forecast/daily/5day?geocode=${c.lat},${c.lon}&format=json&units=e&language=en-US&apiKey=${c.apiKey}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`WC API ${res.status}: ${res.statusText}`);

    const data = await res.json();
    const dates = data.validTimeLocal || [];
    const idx = dates.findIndex((d) => d?.startsWith(targetDate));
    if (idx === -1) {
        throw new Error(`${targetDate} not in WC forecast (available: ${dates.map((d) => d?.slice(0, 10)).join(',')})`);
    }
    const highTempF = data.temperatureMax[idx];
    if (highTempF == null) throw new Error(`No max temp for ${targetDate} from WC`);

    return { source: 'weather-company', station: 'KLGA', date: targetDate, highTempF, fetchedAt: nowISO() };
}

async function fetchWCCurrent() {
    const c = cfg();
    const url = `${c.wcBase}/observations/current?geocode=${c.lat},${c.lon}&format=json&units=e&language=en-US&apiKey=${c.apiKey}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`WC current API ${res.status}`);

    const data = await res.json();
    return {
        source: 'weather-company',
        station: 'KLGA',
        tempF: data.temperature,
        feelsLikeF: data.temperatureFeelsLike,
        maxSince7amF: data.temperatureMaxSince7am ?? null,
        conditions: data.wxPhraseLong || 'Unknown',
        observedAt: data.validTimeLocal || nowISO(),
        fetchedAt: nowISO(),
    };
}

// ── Open-Meteo (Fallback) ───────────────────────────────────────────────

async function fetchOMForecast(targetDate) {
    const c = cfg();
    const params = new URLSearchParams({
        latitude: c.lat.toString(),
        longitude: c.lon.toString(),
        daily: 'temperature_2m_max',
        temperature_unit: 'fahrenheit',
        timezone: 'America/New_York',
        forecast_days: '7',
    });
    const res = await fetch(`${c.omBase}?${params}`);
    if (!res.ok) throw new Error(`Open-Meteo API ${res.status}`);

    const data = await res.json();
    const idx = data.daily.time.indexOf(targetDate);
    if (idx === -1) throw new Error(`${targetDate} not in Open-Meteo forecast`);

    return { source: 'open-meteo', station: 'KLGA', date: targetDate, highTempF: data.daily.temperature_2m_max[idx], fetchedAt: nowISO() };
}

async function fetchOMCurrent() {
    const c = cfg();
    const params = new URLSearchParams({
        latitude: c.lat.toString(),
        longitude: c.lon.toString(),
        current: 'temperature_2m,apparent_temperature,weather_code',
        temperature_unit: 'fahrenheit',
        timezone: 'America/New_York',
    });
    const res = await fetch(`${c.omBase}?${params}`);
    if (!res.ok) throw new Error(`Open-Meteo current API ${res.status}`);

    const data = await res.json();
    return {
        source: 'open-meteo',
        station: 'KLGA',
        tempF: Math.round(data.current.temperature_2m),
        feelsLikeF: Math.round(data.current.apparent_temperature),
        maxSince7amF: null,
        conditions: `WMO code ${data.current.weather_code}`,
        observedAt: data.current.time || nowISO(),
        fetchedAt: nowISO(),
    };
}

// ── Circuit Breakers ────────────────────────────────────────────────────
// Skip straight to fallback when a provider is consistently failing.

const wcBreaker = new CircuitBreaker('weather-company', {
    failureThreshold: 3,
    resetTimeMs: 60_000,
    onStateChange: (name, from, to) => console.log(`  ⚡ ${name}: ${from} → ${to}`),
});
const omBreaker = new CircuitBreaker('open-meteo', {
    failureThreshold: 3,
    resetTimeMs: 60_000,
    onStateChange: (name, from, to) => console.log(`  ⚡ ${name}: ${from} → ${to}`),
});

// ── Resilient fetchers ──────────────────────────────────────────────────

async function fetchForecast(targetDate) {
    const retries = cfg().retries;
    // Try Weather Company (if breaker allows)
    if (wcBreaker.isAvailable()) {
        for (let i = 1; i <= retries; i++) {
            try {
                return await wcBreaker.call(() => fetchWCForecast(targetDate));
            } catch (e) {
                if (e instanceof CircuitOpenError) break; // skip remaining retries
                console.warn(`  ⚠️  WC forecast attempt ${i}/${retries}: ${e.message}`);
                if (i < retries) await new Promise((r) => setTimeout(r, 1000 * i));
            }
        }
    } else {
        console.warn('  ⚡ WC circuit open — skipping to fallback');
    }
    // Fallback to Open-Meteo
    console.log('  ⚡ Falling back to Open-Meteo...');
    for (let i = 1; i <= retries; i++) {
        try {
            return await omBreaker.call(() => fetchOMForecast(targetDate));
        } catch (e) {
            if (e instanceof CircuitOpenError) break;
            console.warn(`  ⚠️  Open-Meteo attempt ${i}/${retries}: ${e.message}`);
            if (i < retries) await new Promise((r) => setTimeout(r, 1000 * i));
        }
    }
    throw new Error(`All forecast sources failed after ${retries * 2} attempts`);
}

async function fetchCurrent() {
    try {
        return await wcBreaker.call(() => fetchWCCurrent());
    } catch (e) {
        if (!(e instanceof CircuitOpenError)) {
            console.warn(`  ⚠️  WC current failed: ${e.message}, trying Open-Meteo`);
        }
        return await omBreaker.call(() => fetchOMCurrent());
    }
}

async function fetchAllDays() {
    const c = cfg();
    try {
        const url = `${c.wcBase}/forecast/daily/5day?geocode=${c.lat},${c.lon}&format=json&units=e&language=en-US&apiKey=${c.apiKey}`;
        const res = await fetch(url);
        if (res.ok) {
            const data = await res.json();
            return data.validTimeLocal
                .map((d, i) => ({ date: d?.slice(0, 10), highTempF: data.temperatureMax[i] }))
                .filter((d) => d.date && d.highTempF != null);
        }
    } catch {
        /* fall through */
    }

    const params = new URLSearchParams({
        latitude: c.lat.toString(),
        longitude: c.lon.toString(),
        daily: 'temperature_2m_max',
        temperature_unit: 'fahrenheit',
        timezone: 'America/New_York',
        forecast_days: '7',
    });
    const res = await fetch(`${c.omBase}?${params}`);
    if (!res.ok) throw new Error(`Open-Meteo API ${res.status}`);
    const data = await res.json();
    return data.daily.time.map((date, i) => ({ date, highTempF: data.daily.temperature_2m_max[i] }));
}

// ── TTL Cache ───────────────────────────────────────────────────────────
// Avoids redundant external API calls when the dashboard polls every 30s.
// Uses shared TtlCache — always async, with automatic eviction.

const cache = new TtlCache({ evictIntervalMs: 60_000, maxEntries: 50 });

const FORECAST_TTL = 5 * 60 * 1000; // 5 min — forecasts change slowly
const CURRENT_TTL = 2 * 60 * 1000; // 2 min — current conditions
const FORECAST_DAYS_TTL = 3 * 60 * 1000; // 3 min — multi-day overview

// (HTTP helpers now imported from shared/httpServer.js)

// ── Request Handler ─────────────────────────────────────────────────────

async function handleRequest(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;
    const query = Object.fromEntries(url.searchParams);

    try {
        if (path === '/health') {
            return jsonRes(res, healthResponse('weather-svc', {
                sources: ['weather-company', 'open-meteo'],
                cache: cache.stats(),
                breakers: { wc: wcBreaker.stats(), om: omBreaker.stats() },
            }));
        }

        if (path === '/api/forecast') {
            if (!query.date) return errRes(res, 'date parameter required');
            const forecast = await cache.get(`forecast:${query.date}`, FORECAST_TTL, () => fetchForecast(query.date));
            return jsonRes(res, forecast);
        }

        if (path === '/api/current') {
            const current = await cache.get('current', CURRENT_TTL, () => fetchCurrent());
            return jsonRes(res, current);
        }

        if (path === '/api/weather') {
            if (!query.date) return errRes(res, 'date parameter required');
            const [forecast, current] = await Promise.all([
                cache.get(`forecast:${query.date}`, FORECAST_TTL, () => fetchForecast(query.date)),
                cache.get('current', CURRENT_TTL, () => fetchCurrent()),
            ]);
            return jsonRes(res, { forecast, current });
        }

        if (path === '/api/forecast-days') {
            const days = await cache.get('forecast-days', FORECAST_DAYS_TTL, () => fetchAllDays());
            return jsonRes(res, days);
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
    const c = cfg();
    log.info('started', { port: PORT, station: 'KLGA', lat: c.lat, lon: c.lon, wcKey: c.apiKey ? 'configured' : 'missing' });
});

process.on('SIGINT', () => {
    server.close();
    process.exit(0);
});
process.on('SIGTERM', () => {
    server.close();
    process.exit(0);
});
