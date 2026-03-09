/**
 * TempEdge — Centralized Configuration
 *
 * Single source of truth for all runtime parameters.
 * Priority (highest wins):
 *   1. Environment variables (.env / K8s ConfigMap / shell)
 *   2. Admin overrides (output/config-overrides.json — editable via dashboard)
 *   3. Built-in defaults
 *
 * Usage:
 *   import { config } from '../config.js';
 *   console.log(config.trading.maxSpreadPct);
 */

import { config as dotenvConfig } from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

dotenvConfig();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OVERRIDES_PATH = path.resolve(
    process.env.OUTPUT_DIR || path.join(__dirname, '../output'),
    'config-overrides.json'
);

// ── Helpers ─────────────────────────────────────────────────────────────

function envVal(key) {
    const val = process.env[key];
    return val !== undefined && val !== '' ? val : undefined;
}

function coerce(raw, def) {
    if (raw === undefined) return undefined;
    if (typeof def === 'number') {
        const n = Number(raw);
        return isNaN(n) ? undefined : n;
    }
    return String(raw);
}

// ── Schema ──────────────────────────────────────────────────────────────

/** @type {Record<string, {key: string, default: any, readOnly?: boolean, sensitive?: boolean, description?: string, requiresRestart?: boolean}>} */
const SCHEMA = {
    // Trading
    'trading.mode':             { key: 'TRADING_MODE',           default: 'disabled',  description: 'Trading execution mode' },
    'trading.privateKey':       { key: 'POLYMARKET_PRIVATE_KEY', default: '',           description: 'Wallet private key', sensitive: true, readOnly: true },
    'trading.maxPositionCost':  { key: 'MAX_POSITION_COST',      default: 2.00,         description: 'Max cost per position ($)' },
    'trading.maxDailySpend':    { key: 'MAX_DAILY_SPEND',        default: 5.00,         description: 'Max total daily spend ($)' },
    'trading.buySize':          { key: 'BUY_SIZE',               default: 0,            description: 'Share quantity (0 = auto)' },
    'trading.minOrderValue':    { key: 'MIN_ORDER_VALUE',        default: 1.05,         description: 'Min order value buffer ($)' },
    'trading.maxSpreadPct':     { key: 'MAX_SPREAD_PCT',         default: 0.20,         description: 'Max bid-ask spread before skip' },
    'trading.minAskDepth':      { key: 'MIN_ASK_DEPTH',          default: 5,            description: 'Min shares at ask to fill' },
    'trading.clobHost':         { key: 'CLOB_HOST',              default: 'https://clob.polymarket.com', description: 'CLOB API endpoint', requiresRestart: true },
    'trading.chainId':          { key: 'CHAIN_ID',               default: 137,          description: 'Polygon chain ID', requiresRestart: true },

    // Monitoring
    'monitor.intervalMinutes':        { key: 'MONITOR_INTERVAL',         default: 15,   description: 'Minutes between checks' },
    'monitor.forecastShiftThreshold': { key: 'FORECAST_SHIFT_THRESHOLD', default: 1.0,  description: '°F change to trigger alert' },
    'monitor.priceSpikeThreshold':    { key: 'PRICE_SPIKE_THRESHOLD',    default: 0.05, description: 'Price change (¢) to trigger alert' },
    'monitor.rebalanceThreshold':     { key: 'REBALANCE_THRESHOLD',      default: 7.0,  description: '°F change to rebalance ranges' },
    'monitor.buyHourEST':             { key: 'BUY_HOUR_EST',             default: 7,    description: 'Hour (ET) to trigger buy' },

    // Liquidity streaming (WebSocket)
    'liquidity.wsEnabled':         { key: 'WS_LIQUIDITY_ENABLED',    default: 1,           description: 'Enable WebSocket liquidity streaming (1/0)' },
    'liquidity.buyMode':           { key: 'LIQUIDITY_BUY_MODE',      default: 'threshold', description: 'Buy trigger: threshold or best-window' },
    'liquidity.checkIntervalSecs': { key: 'LIQUIDITY_CHECK_SECS',    default: 30,          description: 'Seconds between liquidity assessments' },
    'liquidity.windowMinutes':     { key: 'LIQUIDITY_WINDOW_MINS',   default: 60,          description: 'Minutes to track for best-window mode' },
    'liquidity.buyDeadlineHour':   { key: 'LIQUIDITY_DEADLINE_HOUR', default: 10.5,        description: 'Deadline hour (ET, decimal) to buy if still illiquid (10.5 = 10:30am)' },
    'liquidity.requireAllLiquid':  { key: 'LIQUIDITY_ALL_REQUIRED',  default: 1,           description: 'Require ALL tokens liquid (1) or ANY (0)' },

    // Weather
    'weather.stationLat':   { key: 'WEATHER_LAT',     default: 40.7769,  description: 'Station latitude' },
    'weather.stationLon':   { key: 'WEATHER_LON',     default: -73.8740, description: 'Station longitude' },
    'weather.stationName':  { key: 'WEATHER_STATION',  default: 'KLGA',   description: 'Weather station ID' },
    'weather.wcApiKey':     { key: 'WC_API_KEY',       default: 'e1f10a1e78da46f5b10a1e78da96f525', description: 'Weather Company API key', sensitive: true },
    'weather.wcBaseUrl':    { key: 'WC_BASE_URL',      default: 'https://api.weather.com/v3/wx',    description: 'Weather Company base URL', requiresRestart: true },
    'weather.openMeteoUrl': { key: 'OPEN_METEO_URL',   default: 'https://api.open-meteo.com/v1/forecast', description: 'Open-Meteo fallback URL', requiresRestart: true },
    'weather.retries':      { key: 'WEATHER_RETRIES',  default: 2,        description: 'Retries per weather source' },

    // Polymarket
    'polymarket.gammaBaseUrl':   { key: 'GAMMA_BASE_URL',   default: 'https://gamma-api.polymarket.com',     description: 'Gamma API base URL', requiresRestart: true },
    'polymarket.slugTemplate':   { key: 'SLUG_TEMPLATE',    default: 'highest-temperature-in-nyc-on-{date}', description: 'Market slug pattern' },
    'polymarket.maxSearchPages': { key: 'MAX_SEARCH_PAGES', default: 4,                                      description: 'Max event search pages' },
    'polymarket.searchPageSize': { key: 'SEARCH_PAGE_SIZE', default: 50,                                     description: 'Events per search page' },

    // Dashboard
    'dashboard.port':              { key: 'DASHBOARD_PORT',          default: 3000,  description: 'Dashboard HTTP port', requiresRestart: true },
    'dashboard.refreshInterval':   { key: 'DASHBOARD_REFRESH_MS',    default: 10000, description: 'Card refresh interval (ms)' },
    'dashboard.liquidityPollMs':   { key: 'DASHBOARD_LIQUIDITY_MS',  default: 5000,  description: 'Liquidity panel poll interval (ms)' },

    // Phase thresholds
    'phases.buyDaysMin': { key: 'PHASE_BUY_DAYS_MIN', default: 2, description: 'Days before target = buy phase' },
};

// ── Overrides File ──────────────────────────────────────────────────────

function loadOverrides() {
    try {
        if (fs.existsSync(OVERRIDES_PATH)) {
            return JSON.parse(fs.readFileSync(OVERRIDES_PATH, 'utf-8'));
        }
    } catch (err) {
        console.warn(`⚠️  Failed to load config overrides: ${err.message}`);
    }
    return {};
}

function saveOverrides(overrides) {
    const dir = path.dirname(OVERRIDES_PATH);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(OVERRIDES_PATH, JSON.stringify(overrides, null, 2), 'utf-8');
}

// ── Build Config Object ─────────────────────────────────────────────────

/** @type {Record<string, Record<string, any>>} */
let _overrides = loadOverrides();

function resolveValue(path, schemaDef) {
    const { key, default: def } = schemaDef;
    const [section, field] = path.split('.');

    // Priority 1: Environment variable
    const envRaw = envVal(key);
    if (envRaw !== undefined) {
        const val = coerce(envRaw, def);
        if (val !== undefined) return { value: val, source: 'env' };
    }

    // Priority 2: Admin override file
    const overrideVal = _overrides?.[section]?.[field];
    if (overrideVal !== undefined) {
        const val = coerce(overrideVal, def);
        if (val !== undefined) return { value: val, source: 'override' };
    }

    // Priority 3: Default
    return { value: def, source: 'default' };
}

function buildConfig() {
    const cfg = {};
    for (const [p, schema] of Object.entries(SCHEMA)) {
        const [section, field] = p.split('.');
        if (!cfg[section]) cfg[section] = {};
        cfg[section][field] = resolveValue(p, schema).value;
    }
    // Normalize trading mode
    if (cfg.trading?.mode) cfg.trading.mode = cfg.trading.mode.toLowerCase();
    return cfg;
}

/**
 * The live config object. Mutable — gets rebuilt on updateConfig().
 * Services should read from this at call time rather than caching at module load.
 */
export let config = buildConfig();

// ── Mutations ───────────────────────────────────────────────────────────

/**
 * Update one or more config values via the admin UI.
 * Persists to config-overrides.json and hot-reloads the in-memory config.
 *
 * @param {Record<string, Record<string, any>>} updates - { section: { field: value } }
 * @returns {{ applied: string[], skipped: string[], requiresRestart: string[] }}
 */
export function updateConfig(updates) {
    const applied = [];
    const skipped = [];
    const requiresRestart = [];

    for (const [section, fields] of Object.entries(updates)) {
        for (const [field, newValue] of Object.entries(fields)) {
            const path = `${section}.${field}`;
            const schema = SCHEMA[path];

            if (!schema) {
                skipped.push(`${path}: unknown config key`);
                continue;
            }
            if (schema.readOnly) {
                skipped.push(`${path}: read-only (set via env var only)`);
                continue;
            }

            // Check if env var takes precedence
            const envRaw = envVal(schema.key);
            if (envRaw !== undefined) {
                skipped.push(`${path}: locked by env var ${schema.key}`);
                continue;
            }

            // Coerce to correct type
            const coerced = coerce(newValue, schema.default);
            if (coerced === undefined) {
                skipped.push(`${path}: invalid value "${newValue}"`);
                continue;
            }

            // Store override
            if (!_overrides[section]) _overrides[section] = {};
            _overrides[section][field] = coerced;
            applied.push(path);

            if (schema.requiresRestart) {
                requiresRestart.push(path);
            }
        }
    }

    // Persist
    saveOverrides(_overrides);

    // Hot-reload
    config = buildConfig();

    return { applied, skipped, requiresRestart };
}

/**
 * Reset a config value back to its default (remove override).
 * @param {string} section
 * @param {string} field
 */
export function resetConfigValue(section, field) {
    if (_overrides[section]) {
        delete _overrides[section][field];
        if (Object.keys(_overrides[section]).length === 0) {
            delete _overrides[section];
        }
        saveOverrides(_overrides);
        config = buildConfig();
    }
}

/**
 * Reset ALL overrides back to defaults.
 */
export function resetAllOverrides() {
    _overrides = {};
    saveOverrides(_overrides);
    config = buildConfig();
}

// ── Introspection (for /api/config and admin page) ──────────────────────

/**
 * Return a full config snapshot for the admin API.
 * Each entry includes { value, source, default, envKey, description, ... }.
 */
export function getConfigSnapshot() {
    const snapshot = {};

    for (const [p, schema] of Object.entries(SCHEMA)) {
        const [section, field] = p.split('.');
        if (!snapshot[section]) snapshot[section] = {};

        const { value, source } = resolveValue(p, schema);

        // Mask sensitive values
        if (schema.sensitive) {
            const displayVal = typeof value === 'string' && value.length > 6
                ? '••••' + value.slice(-6)
                : value ? '(set)' : '(not set)';
            snapshot[section][field] = {
                value: displayVal,
                source,
                default: '(hidden)',
                envKey: schema.key,
                description: schema.description || '',
                readOnly: true,
                sensitive: true,
                requiresRestart: !!schema.requiresRestart,
            };
            continue;
        }

        snapshot[section][field] = {
            value,
            source,
            default: schema.default,
            envKey: schema.key,
            description: schema.description || '',
            readOnly: !!schema.readOnly,
            sensitive: false,
            requiresRestart: !!schema.requiresRestart,
            lockedByEnv: source === 'env',
        };
    }

    return snapshot;
}
