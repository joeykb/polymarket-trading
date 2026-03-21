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

const PORT = parseInt(process.env.WEATHER_SVC_PORT || '3002');

// ── Config (from env vars) ──────────────────────────────────────────────

const cfg = () => ({
    lat:       parseFloat(process.env.STATION_LAT || '40.7769'),
    lon:       parseFloat(process.env.STATION_LON || '-73.8740'),
    apiKey:    process.env.WC_API_KEY || '',
    wcBase:    process.env.WC_BASE_URL || 'https://api.weather.com/v3/wx',
    omBase:    process.env.OPEN_METEO_URL || 'https://api.open-meteo.com/v1/forecast',
    retries:   parseInt(process.env.WEATHER_RETRIES || '2'),
});

function nowISO() { return new Date().toISOString(); }

// ── Weather Company (Primary) ───────────────────────────────────────────

async function fetchWCForecast(targetDate) {
    const c = cfg();
    const url = `${c.wcBase}/forecast/daily/5day?geocode=${c.lat},${c.lon}&format=json&units=e&language=en-US&apiKey=${c.apiKey}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`WC API ${res.status}: ${res.statusText}`);

    const data = await res.json();
    const dates = data.validTimeLocal || [];
    const idx = dates.findIndex(d => d?.startsWith(targetDate));
    if (idx === -1) {
        throw new Error(`${targetDate} not in WC forecast (available: ${dates.map(d => d?.slice(0, 10)).join(',')})`);
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
        source: 'weather-company', station: 'KLGA',
        tempF: data.temperature, feelsLikeF: data.temperatureFeelsLike,
        maxSince7amF: data.temperatureMaxSince7am ?? null,
        conditions: data.wxPhraseLong || 'Unknown',
        observedAt: data.validTimeLocal || nowISO(), fetchedAt: nowISO(),
    };
}

// ── Open-Meteo (Fallback) ───────────────────────────────────────────────

async function fetchOMForecast(targetDate) {
    const c = cfg();
    const params = new URLSearchParams({
        latitude: c.lat.toString(), longitude: c.lon.toString(),
        daily: 'temperature_2m_max', temperature_unit: 'fahrenheit',
        timezone: 'America/New_York', forecast_days: '7',
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
        latitude: c.lat.toString(), longitude: c.lon.toString(),
        current: 'temperature_2m,apparent_temperature,weather_code',
        temperature_unit: 'fahrenheit', timezone: 'America/New_York',
    });
    const res = await fetch(`${c.omBase}?${params}`);
    if (!res.ok) throw new Error(`Open-Meteo current API ${res.status}`);

    const data = await res.json();
    return {
        source: 'open-meteo', station: 'KLGA',
        tempF: Math.round(data.current.temperature_2m),
        feelsLikeF: Math.round(data.current.apparent_temperature),
        maxSince7amF: null,
        conditions: `WMO code ${data.current.weather_code}`,
        observedAt: data.current.time || nowISO(), fetchedAt: nowISO(),
    };
}

// ── Resilient fetchers ──────────────────────────────────────────────────

async function fetchForecast(targetDate) {
    const retries = cfg().retries;
    for (let i = 1; i <= retries; i++) {
        try { return await fetchWCForecast(targetDate); }
        catch (e) {
            console.warn(`  ⚠️  WC forecast attempt ${i}/${retries}: ${e.message}`);
            if (i < retries) await new Promise(r => setTimeout(r, 1000 * i));
        }
    }
    console.log('  ⚡ Falling back to Open-Meteo...');
    for (let i = 1; i <= retries; i++) {
        try { return await fetchOMForecast(targetDate); }
        catch (e) {
            console.warn(`  ⚠️  Open-Meteo attempt ${i}/${retries}: ${e.message}`);
            if (i < retries) await new Promise(r => setTimeout(r, 1000 * i));
        }
    }
    throw new Error(`All forecast sources failed after ${retries * 2} attempts`);
}

async function fetchCurrent() {
    try { return await fetchWCCurrent(); }
    catch (e) {
        console.warn(`  ⚠️  WC current failed: ${e.message}, trying Open-Meteo`);
        return await fetchOMCurrent();
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
                .filter(d => d.date && d.highTempF != null);
        }
    } catch { /* fall through */ }

    const params = new URLSearchParams({
        latitude: c.lat.toString(), longitude: c.lon.toString(),
        daily: 'temperature_2m_max', temperature_unit: 'fahrenheit',
        timezone: 'America/New_York', forecast_days: '7',
    });
    const res = await fetch(`${c.omBase}?${params}`);
    if (!res.ok) throw new Error(`Open-Meteo API ${res.status}`);
    const data = await res.json();
    return data.daily.time.map((date, i) => ({ date, highTempF: data.daily.temperature_2m_max[i] }));
}

// ── HTTP Helpers ────────────────────────────────────────────────────────

function jsonRes(res, data, status = 200) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
}

function errRes(res, message, status = 400) {
    jsonRes(res, { error: message }, status);
}

// ── Request Handler ─────────────────────────────────────────────────────

async function handleRequest(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;
    const query = Object.fromEntries(url.searchParams);

    try {
        if (path === '/health') {
            return jsonRes(res, { status: 'ok', sources: ['weather-company', 'open-meteo'] });
        }

        if (path === '/api/forecast') {
            if (!query.date) return errRes(res, 'date parameter required');
            const forecast = await fetchForecast(query.date);
            return jsonRes(res, forecast);
        }

        if (path === '/api/current') {
            const current = await fetchCurrent();
            return jsonRes(res, current);
        }

        if (path === '/api/weather') {
            if (!query.date) return errRes(res, 'date parameter required');
            const [forecast, current] = await Promise.all([
                fetchForecast(query.date),
                fetchCurrent(),
            ]);
            return jsonRes(res, { forecast, current });
        }

        if (path === '/api/forecast-days') {
            const days = await fetchAllDays();
            return jsonRes(res, days);
        }

        errRes(res, `Not found: ${path}`, 404);
    } catch (err) {
        console.error(`❌ ${path}:`, err.message);
        errRes(res, err.message, 500);
    }
}

// ── Server ──────────────────────────────────────────────────────────────

const server = http.createServer(handleRequest);

server.listen(PORT, () => {
    const c = cfg();
    console.log(`\n🌤️  TempEdge Weather Service`);
    console.log(`   Port:    ${PORT}`);
    console.log(`   Station: KLGA (${c.lat}, ${c.lon})`);
    console.log(`   WC key:  ${c.apiKey ? '✅ configured' : '❌ missing'}`);
    console.log(`   Ready.\n`);
});

process.on('SIGINT', () => { server.close(); process.exit(0); });
process.on('SIGTERM', () => { server.close(); process.exit(0); });
