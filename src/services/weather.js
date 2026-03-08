/**
 * Weather service — fetches forecast + current conditions
 *
 * PRIMARY: Weather Company API (powers Weather Underground — matches Polymarket resolution source)
 * FALLBACK: Open-Meteo API (free, no auth required)
 *
 * Polymarket resolution source:
 *   https://www.wunderground.com/history/daily/us/ny/new-york-city/KLGA
 *   "highest temperature recorded at LaGuardia Airport Station in degrees Fahrenheit"
 *   Precision: whole degrees Fahrenheit
 */

import { nowISO } from '../utils/dateUtils.js';
import { config } from '../config.js';

// Weather values are read dynamically from config for hot-reload support
const wc = () => ({
    lat: config.weather.stationLat,
    lon: config.weather.stationLon,
    apiKey: config.weather.wcApiKey,
    base: config.weather.wcBaseUrl,
    openMeteo: config.weather.openMeteoUrl,
});

// ── Weather Company (Primary) ───────────────────────────────────────────

/**
 * Fetch forecast from Weather Company API (WU source)
 * @param {string} targetDate - ISO date string, e.g. "2026-03-08"
 * @returns {Promise<import('../models/types.js').WeatherForecast>}
 */
async function fetchWCForecast(targetDate) {
    const w = wc();
    const url = `${w.base}/forecast/daily/5day?geocode=${w.lat},${w.lon}&format=json&units=e&language=en-US&apiKey=${w.apiKey}`;

    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Weather Company API returned ${response.status}: ${response.statusText}`);
    }

    const data = await response.json();

    // Find the target date in the forecast array
    const dates = data.validTimeLocal || [];
    let dateIndex = -1;
    for (let i = 0; i < dates.length; i++) {
        if (dates[i] && dates[i].startsWith(targetDate)) {
            dateIndex = i;
            break;
        }
    }

    if (dateIndex === -1) {
        const availableDates = dates.map(d => d?.slice(0, 10)).join(', ');
        throw new Error(
            `Target date ${targetDate} not found in WC forecast. Available: ${availableDates}`
        );
    }

    const highTempF = data.temperatureMax[dateIndex];
    if (highTempF === null || highTempF === undefined) {
        throw new Error(`No max temperature available for ${targetDate} from WC`);
    }

    return {
        source: 'weather-company',
        station: 'KLGA',
        date: targetDate,
        highTempF,
        fetchedAt: nowISO(),
    };
}

/**
 * Fetch current conditions from Weather Company API
 * @returns {Promise<import('../models/types.js').CurrentConditions>}
 */
async function fetchWCCurrentConditions() {
    const w = wc();
    const url = `${w.base}/observations/current?geocode=${w.lat},${w.lon}&format=json&units=e&language=en-US&apiKey=${w.apiKey}`;

    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`WC current conditions API returned ${response.status}`);
    }

    const data = await response.json();

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

/**
 * Fetch forecast from Open-Meteo API (fallback)
 * @param {string} targetDate
 * @returns {Promise<import('../models/types.js').WeatherForecast>}
 */
async function fetchOpenMeteoForecast(targetDate) {
    const params = new URLSearchParams({
        latitude: KLGA_LAT.toString(),
        longitude: KLGA_LON.toString(),
        daily: 'temperature_2m_max',
        temperature_unit: 'fahrenheit',
        timezone: 'America/New_York',
        forecast_days: '7',
    });

    const url = `${OPEN_METEO_URL}?${params}`;
    const response = await fetch(url);

    if (!response.ok) {
        throw new Error(`Open-Meteo API returned ${response.status}: ${response.statusText}`);
    }

    const data = await response.json();
    const dateIndex = data.daily.time.indexOf(targetDate);

    if (dateIndex === -1) {
        throw new Error(`Target date ${targetDate} not found in Open-Meteo forecast`);
    }

    return {
        source: 'open-meteo',
        station: 'KLGA',
        date: targetDate,
        highTempF: data.daily.temperature_2m_max[dateIndex],
        fetchedAt: nowISO(),
    };
}

/**
 * Fetch current conditions from Open-Meteo (fallback)
 * @returns {Promise<import('../models/types.js').CurrentConditions>}
 */
async function fetchOpenMeteoCurrentConditions() {
    const w = wc();
    const params = new URLSearchParams({
        latitude: w.lat.toString(),
        longitude: w.lon.toString(),
        current: 'temperature_2m,apparent_temperature,weather_code',
        temperature_unit: 'fahrenheit',
        timezone: 'America/New_York',
    });

    const url = `${w.openMeteo}?${params}`;
    const response = await fetch(url);

    if (!response.ok) {
        throw new Error(`Open-Meteo current API returned ${response.status}`);
    }

    const data = await response.json();
    const current = data.current;

    return {
        source: 'open-meteo',
        station: 'KLGA',
        tempF: Math.round(current.temperature_2m),
        feelsLikeF: Math.round(current.apparent_temperature),
        maxSince7amF: null,
        conditions: `WMO code ${current.weather_code}`,
        observedAt: current.time || nowISO(),
        fetchedAt: nowISO(),
    };
}

// ── Public API ──────────────────────────────────────────────────────────

/**
 * Fetch forecast high temperature — tries WC first, falls back to Open-Meteo
 * @param {string} targetDate - ISO date string, e.g. "2026-03-08"
 * @param {number} [retries=2] - Number of retries per source
 * @returns {Promise<import('../models/types.js').WeatherForecast>}
 */
export async function fetchForecast(targetDate, retries = config.weather.retries) {
    // Try Weather Company first (matches Polymarket resolution source)
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            console.log(`  Fetching WC/WU forecast (attempt ${attempt}/${retries})...`);
            const forecast = await fetchWCForecast(targetDate);
            console.log(`  ✅ WC forecast for ${targetDate}: ${forecast.highTempF}°F`);
            return forecast;
        } catch (err) {
            console.warn(`  ⚠️  WC attempt ${attempt} failed: ${err.message}`);
            if (attempt < retries) {
                await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
            }
        }
    }

    // Fallback to Open-Meteo
    console.log('  ⚡ Falling back to Open-Meteo...');
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const forecast = await fetchOpenMeteoForecast(targetDate);
            console.log(`  ✅ Open-Meteo forecast for ${targetDate}: ${forecast.highTempF}°F (⚠️ fallback source)`);
            return forecast;
        } catch (err) {
            console.warn(`  ⚠️  Open-Meteo attempt ${attempt} failed: ${err.message}`);
            if (attempt < retries) {
                await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
            }
        }
    }

    throw new Error(`Failed to fetch forecast from any source after ${retries * 2} total attempts`);
}

/**
 * Fetch current conditions at KLGA — tries WC first, falls back to Open-Meteo
 * @returns {Promise<import('../models/types.js').CurrentConditions>}
 */
export async function fetchCurrentConditions() {
    try {
        return await fetchWCCurrentConditions();
    } catch (err) {
        console.warn(`  ⚠️  WC current conditions failed: ${err.message}, trying Open-Meteo...`);
        return await fetchOpenMeteoCurrentConditions();
    }
}

/**
 * Fetch both forecast AND current conditions in parallel
 * @param {string} targetDate
 * @returns {Promise<{forecast: import('../models/types.js').WeatherForecast, current: import('../models/types.js').CurrentConditions}>}
 */
export async function fetchWeatherData(targetDate) {
    const [forecast, current] = await Promise.all([
        fetchForecast(targetDate),
        fetchCurrentConditions(),
    ]);
    return { forecast, current };
}

/**
 * Fetch all available forecast days (useful for finding which dates have markets)
 * @returns {Promise<{date: string, highTempF: number}[]>}
 */
export async function fetchAllForecastDays() {
    // Try WC first
    try {
        const url = `${WC_BASE}/forecast/daily/5day?geocode=${KLGA_LAT},${KLGA_LON}&format=json&units=e&language=en-US&apiKey=${WC_API_KEY}`;
        const response = await fetch(url);
        if (response.ok) {
            const data = await response.json();
            return data.validTimeLocal
                .map((dateStr, i) => ({
                    date: dateStr?.slice(0, 10),
                    highTempF: data.temperatureMax[i],
                }))
                .filter(d => d.date && d.highTempF !== null);
        }
    } catch { /* fall through */ }

    // Fallback to Open-Meteo
    const w = wc();
    const params = new URLSearchParams({
        latitude: w.lat.toString(),
        longitude: w.lon.toString(),
        daily: 'temperature_2m_max',
        temperature_unit: 'fahrenheit',
        timezone: 'America/New_York',
        forecast_days: '7',
    });

    const url = `${w.openMeteo}?${params}`;
    const response = await fetch(url);

    if (!response.ok) {
        throw new Error(`Open-Meteo API returned ${response.status}`);
    }

    const data = await response.json();
    return data.daily.time.map((date, i) => ({
        date,
        highTempF: data.daily.temperature_2m_max[i],
    }));
}
