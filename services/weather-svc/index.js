/**
 * TempEdge Weather Service — HTTP API for forecast + current conditions
 *
 * Wraps Weather Company (primary) and Open-Meteo (fallback) APIs.
 * Stateless — no database, no persistent state.
 *
 * Multi-market support: pass lat, lon, unit, tz, station query params
 * to fetch forecasts for any city. Defaults to NYC (KLGA) when omitted.
 *
 * Port: 3002
 *
 * API:
 *   GET /api/forecast?date=2026-03-23[&lat=X&lon=Y&unit=C&tz=TZ]  → forecast high temp
 *   GET /api/current[&lat=X&lon=Y&unit=C&tz=TZ]                   → current conditions
 *   GET /api/weather?date=2026-03-23[&lat=X&lon=Y&unit=C&tz=TZ]   → forecast + current
 *   GET /api/forecast-days[&lat=X&lon=Y&unit=C&tz=TZ]             → all available forecast days
 *   GET /health                                                     → health check
 */

import 'dotenv/config';
import http from 'http';
import { healthResponse } from '../../shared/health.js';
import { createLogger, requestLogger } from '../../shared/logger.js';
import { nowISO } from '../../shared/dates.js';
import { jsonResponse as jsonRes, errorResponse as errRes } from '../../shared/httpServer.js';
import { TtlCache } from '../../shared/cache.js';
import { CircuitBreaker, CircuitOpenError } from '../../shared/circuitBreaker.js';
import { createMetrics, createHttpMetrics } from '../../shared/metrics.js';

const metrics = createMetrics('weather_svc');
const { wrapHandler } = createHttpMetrics(metrics);
const apiCalls = metrics.counter('api_calls_total', 'External API calls', ['provider', 'result']);

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

/**
 * Build station config from query params or fallback to env defaults.
 * Enables multi-market support: each call specifies its own coordinates.
 */
function stationCfg(query = {}) {
    const base = cfg();
    return {
        lat: parseFloat(query.lat) || base.lat,
        lon: parseFloat(query.lon) || base.lon,
        unit: query.unit || 'F',  // 'F' or 'C'
        tz: query.tz || 'America/New_York',
        stationName: query.station || 'KLGA',
    };
}

// ── Weather Company (Primary) ───────────────────────────────────────────

async function fetchWCForecast(targetDate, station = {}) {
    const c = cfg();
    const lat = station.lat || c.lat;
    const lon = station.lon || c.lon;
    const url = `${c.wcBase}/forecast/daily/5day?geocode=${lat},${lon}&format=json&units=e&language=en-US&apiKey=${c.apiKey}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`WC API ${res.status}: ${res.statusText}`);

    const data = await res.json();
    const dates = data.validTimeLocal || [];
    const idx = dates.findIndex((d) => d?.startsWith(targetDate));
    if (idx === -1) {
        throw new Error(`${targetDate} not in WC forecast (available: ${dates.map((d) => d?.slice(0, 10)).join(',')})`);
    }
    let highTemp = data.temperatureMax[idx];
    if (highTemp == null) throw new Error(`No max temp for ${targetDate} from WC`);

    // WC always returns °F; convert to °C if requested
    const unit = station.unit || 'F';
    if (unit === 'C') highTemp = Math.round(((highTemp - 32) * 5) / 9 * 10) / 10;

    return { source: 'weather-company', station: station.stationName || 'KLGA', date: targetDate, highTemp, unit, fetchedAt: nowISO() };
}

async function fetchWCCurrent(station = {}) {
    const c = cfg();
    const lat = station.lat || c.lat;
    const lon = station.lon || c.lon;
    const url = `${c.wcBase}/observations/current?geocode=${lat},${lon}&format=json&units=e&language=en-US&apiKey=${c.apiKey}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`WC current API ${res.status}`);

    const data = await res.json();
    const unit = station.unit || 'F';
    const convert = (f) => unit === 'C' && f != null ? Math.round(((f - 32) * 5) / 9 * 10) / 10 : f;

    return {
        source: 'weather-company',
        station: station.stationName || 'KLGA',
        temp: convert(data.temperature),
        feelsLike: convert(data.temperatureFeelsLike),
        maxSince7am: convert(data.temperatureMaxSince7am ?? null),
        unit,
        conditions: data.wxPhraseLong || 'Unknown',
        observedAt: data.validTimeLocal || nowISO(),
        fetchedAt: nowISO(),
        // Legacy field for backwards compatibility
        tempF: data.temperature,
    };
}

// ── Open-Meteo (Fallback) ───────────────────────────────────────────────

async function fetchOMForecast(targetDate, station = {}) {
    const c = cfg();
    const lat = station.lat || c.lat;
    const lon = station.lon || c.lon;
    const unit = station.unit || 'F';
    const tz = station.tz || 'America/New_York';
    const params = new URLSearchParams({
        latitude: lat.toString(),
        longitude: lon.toString(),
        daily: 'temperature_2m_max',
        temperature_unit: unit === 'C' ? 'celsius' : 'fahrenheit',
        timezone: tz,
        forecast_days: '7',
    });
    const res = await fetch(`${c.omBase}?${params}`);
    if (!res.ok) throw new Error(`Open-Meteo API ${res.status}`);

    const data = await res.json();
    const idx = data.daily.time.indexOf(targetDate);
    if (idx === -1) throw new Error(`${targetDate} not in Open-Meteo forecast`);

    return { source: 'open-meteo', station: station.stationName || 'KLGA', date: targetDate, highTemp: data.daily.temperature_2m_max[idx], unit, fetchedAt: nowISO() };
}

async function fetchOMCurrent(station = {}) {
    const c = cfg();
    const lat = station.lat || c.lat;
    const lon = station.lon || c.lon;
    const unit = station.unit || 'F';
    const tz = station.tz || 'America/New_York';
    const params = new URLSearchParams({
        latitude: lat.toString(),
        longitude: lon.toString(),
        current: 'temperature_2m,apparent_temperature,weather_code',
        temperature_unit: unit === 'C' ? 'celsius' : 'fahrenheit',
        timezone: tz,
    });
    const res = await fetch(`${c.omBase}?${params}`);
    if (!res.ok) throw new Error(`Open-Meteo current API ${res.status}`);

    const data = await res.json();
    return {
        source: 'open-meteo',
        station: station.stationName || 'KLGA',
        temp: Math.round(data.current.temperature_2m),
        feelsLike: Math.round(data.current.apparent_temperature),
        maxSince7am: null,
        unit,
        conditions: `WMO code ${data.current.weather_code}`,
        observedAt: data.current.time || nowISO(),
        fetchedAt: nowISO(),
        // Legacy
        tempF: unit === 'F' ? Math.round(data.current.temperature_2m) : null,
    };
}

// ── Circuit Breakers ────────────────────────────────────────────────────

const wcBreaker = new CircuitBreaker('weather-company', {
    failureThreshold: 3,
    resetTimeMs: 60_000,
    onStateChange: (name, from, to) => log.warn('circuit_breaker_state_change', { breaker: name, from, to }),
});
const omBreaker = new CircuitBreaker('open-meteo', {
    failureThreshold: 3,
    resetTimeMs: 60_000,
    onStateChange: (name, from, to) => log.warn('circuit_breaker_state_change', { breaker: name, from, to }),
});

// ── Resilient fetchers ──────────────────────────────────────────────────

async function fetchForecast(targetDate, station = {}) {
    const retries = cfg().retries;
    if (wcBreaker.isAvailable()) {
        for (let i = 1; i <= retries; i++) {
            try {
                return await wcBreaker.call(() => fetchWCForecast(targetDate, station));
            } catch (e) {
                if (e instanceof CircuitOpenError) break;
                log.warn('wc_forecast_retry', { attempt: i, retries, error: e.message });
                if (i < retries) await new Promise((r) => setTimeout(r, 1000 * i));
            }
        }
    } else {
        log.warn('wc_circuit_open', { action: 'skipping_to_fallback' });
    }
    log.info('forecast_fallback', { provider: 'open-meteo' });
    for (let i = 1; i <= retries; i++) {
        try {
            return await omBreaker.call(() => fetchOMForecast(targetDate, station));
        } catch (e) {
            if (e instanceof CircuitOpenError) break;
            log.warn('om_forecast_retry', { attempt: i, retries, error: e.message });
            if (i < retries) await new Promise((r) => setTimeout(r, 1000 * i));
        }
    }
    throw new Error(`All forecast sources failed after ${retries * 2} attempts`);
}

async function fetchCurrent(station = {}) {
    try {
        return await wcBreaker.call(() => fetchWCCurrent(station));
    } catch (e) {
        if (!(e instanceof CircuitOpenError)) {
            log.warn('wc_current_failed', { error: e.message, fallback: 'open-meteo' });
        }
        return await omBreaker.call(() => fetchOMCurrent(station));
    }
}

async function fetchAllDays(station = {}) {
    const c = cfg();
    const lat = station.lat || c.lat;
    const lon = station.lon || c.lon;
    const unit = station.unit || 'F';
    const tz = station.tz || 'America/New_York';
    try {
        const url = `${c.wcBase}/forecast/daily/5day?geocode=${lat},${lon}&format=json&units=e&language=en-US&apiKey=${c.apiKey}`;
        const res = await fetch(url);
        if (res.ok) {
            const data = await res.json();
            return data.validTimeLocal
                .map((d, i) => {
                    let temp = data.temperatureMax[i];
                    if (unit === 'C' && temp != null) temp = Math.round(((temp - 32) * 5) / 9 * 10) / 10;
                    return { date: d?.slice(0, 10), highTemp: temp, unit };
                })
                .filter((d) => d.date && d.highTemp != null);
        }
    } catch {
        /* fall through */
    }

    const params = new URLSearchParams({
        latitude: lat.toString(),
        longitude: lon.toString(),
        daily: 'temperature_2m_max',
        temperature_unit: unit === 'C' ? 'celsius' : 'fahrenheit',
        timezone: tz,
        forecast_days: '7',
    });
    const res = await fetch(`${c.omBase}?${params}`);
    if (!res.ok) throw new Error(`Open-Meteo API ${res.status}`);
    const data = await res.json();
    return data.daily.time.map((date, i) => ({ date, highTemp: data.daily.temperature_2m_max[i], unit }));
}

// ── TTL Cache ───────────────────────────────────────────────────────────
// Cache keys include lat/lon to avoid cross-market cache hits.

const cache = new TtlCache({ evictIntervalMs: 60_000, maxEntries: 200 });

const FORECAST_TTL = 5 * 60 * 1000;
const CURRENT_TTL = 2 * 60 * 1000;
const FORECAST_DAYS_TTL = 3 * 60 * 1000;

function cacheKey(prefix, query) {
    return `${prefix}:${query.lat || 'default'},${query.lon || 'default'}`;
}

// ── Request Handler ─────────────────────────────────────────────────────

async function handleRequest(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;
    const query = Object.fromEntries(url.searchParams);

    try {
        if (path === '/metrics') {
            return metrics.handleRequest(res);
        }

        if (path === '/health') {
            return jsonRes(res, healthResponse('weather-svc', {
                sources: ['weather-company', 'open-meteo'],
                cache: cache.stats(),
                breakers: { wc: wcBreaker.stats(), om: omBreaker.stats() },
            }));
        }

        if (path === '/api/forecast') {
            if (!query.date) return errRes(res, 'date parameter required');
            const station = stationCfg(query);
            const key = `${cacheKey('forecast', query)}:${query.date}`;
            const forecast = await cache.get(key, FORECAST_TTL, () => fetchForecast(query.date, station));
            return jsonRes(res, forecast);
        }

        if (path === '/api/current') {
            const station = stationCfg(query);
            const key = cacheKey('current', query);
            const current = await cache.get(key, CURRENT_TTL, () => fetchCurrent(station));
            return jsonRes(res, current);
        }

        if (path === '/api/weather') {
            if (!query.date) return errRes(res, 'date parameter required');
            const station = stationCfg(query);
            const fKey = `${cacheKey('forecast', query)}:${query.date}`;
            const cKey = cacheKey('current', query);
            const [forecast, current] = await Promise.all([
                cache.get(fKey, FORECAST_TTL, () => fetchForecast(query.date, station)),
                cache.get(cKey, CURRENT_TTL, () => fetchCurrent(station)),
            ]);
            return jsonRes(res, { forecast, current });
        }

        if (path === '/api/forecast-days') {
            const station = stationCfg(query);
            const key = cacheKey('forecast-days', query);
            const days = await cache.get(key, FORECAST_DAYS_TTL, () => fetchAllDays(station));
            return jsonRes(res, days);
        }

        errRes(res, `Not found: ${path}`, 404);
    } catch (err) {
        log.error('request_error', { path, error: err.message });
        errRes(res, err.message, 500);
    }
}

// ── Server ──────────────────────────────────────────────────────────────

const server = http.createServer(wrapHandler(requestLogger(log, handleRequest)));

server.listen(PORT, () => {
    const c = cfg();
    log.info('started', { port: PORT, lat: c.lat, lon: c.lon, wcKey: c.apiKey ? 'configured' : 'missing' });
});

function gracefulShutdown(signal) {
    log.info('shutdown_initiated', { signal });
    server.close(() => {
        log.info('shutdown_complete', { signal });
        process.exit(0);
    });
    setTimeout(() => {
        log.warn('shutdown_forced', { signal, reason: 'timeout after 10s' });
        process.exit(1);
    }, 10_000).unref();
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
