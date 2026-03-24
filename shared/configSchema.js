/**
 * TempEdge Configuration Schema — Single Source of Truth
 *
 * Defines all configuration entries with defaults, descriptions,
 * env var mappings, and admin UI metadata.
 *
 * Previously duplicated in:
 *   - src/config.js (monolith)
 *   - services/data-svc/index.js (config API)
 */

export const CONFIG_SCHEMA = {
    // ── Trading ──────────────────────────────────────────────────────
    'trading.mode': {
        key: 'TRADING_MODE',
        default: 'disabled',
        description: 'Trading execution mode',
        choices: ['disabled', 'dry-run', 'live'],
    },
    'trading.privateKey': {
        key: 'POLYMARKET_PRIVATE_KEY',
        default: '',
        description: 'Wallet private key',
        sensitive: true,
        readOnly: true,
    },
    'trading.maxPositionCost': { key: 'MAX_POSITION_COST', default: 2.0, description: 'Max cost per position ($)' },
    'trading.maxDailySpend': { key: 'MAX_DAILY_SPEND', default: 5.0, description: 'Max total daily spend ($)' },
    'trading.buySize': { key: 'BUY_SIZE', default: 0, description: 'Share quantity (0 = auto)' },
    'trading.minOrderValue': { key: 'MIN_ORDER_VALUE', default: 1.05, description: 'Min order value buffer ($)' },
    'trading.maxSpreadPct': { key: 'MAX_SPREAD_PCT', default: 0.2, description: 'Max bid-ask spread before skip' },
    'trading.minAskDepth': { key: 'MIN_ASK_DEPTH', default: 5, description: 'Min shares at ask to fill' },
    'trading.clobHost': {
        key: 'CLOB_HOST',
        default: 'https://clob.polymarket.com',
        description: 'CLOB API endpoint',
        requiresRestart: true,
    },
    'trading.chainId': { key: 'CHAIN_ID', default: 137, description: 'Polygon chain ID', requiresRestart: true, choices: [137, 80002] },

    // ── Monitoring ───────────────────────────────────────────────────
    'monitor.intervalMinutes': { key: 'MONITOR_INTERVAL', default: 15, description: 'Minutes between checks', requiresRestart: true },
    'monitor.forecastShiftThreshold': { key: 'FORECAST_SHIFT_THRESHOLD', default: 1.0, description: '°F change to trigger alert' },
    'monitor.priceSpikeThreshold': { key: 'PRICE_SPIKE_THRESHOLD', default: 0.05, description: 'Price change (¢) to trigger alert' },
    'monitor.rebalanceThreshold': {
        key: 'REBALANCE_THRESHOLD',
        default: 3.0,
        description: '°F change to trigger rebalance at T+3+. T+1 uses 1°F and T+2 uses 2°F (fixed).',
    },
    'monitor.buyHourEST': { key: 'BUY_HOUR_EST', default: 9.5, description: 'Hour (ET, decimal) to trigger buy (9.5 = 9:30am)' },
    'monitor.evThreshold': {
        key: 'EV_THRESHOLD',
        default: 0.05,
        description: 'Min expected value ($) to place a buy. EV = (confidence × $1) - totalDeployedCost. Set to 0 to disable.',
    },
    'monitor.maxEntryPrice': {
        key: 'MAX_ENTRY_PRICE',
        default: 0.40,
        description: 'Max target range price ($) to consider for entry. Prices above this are skipped.',
    },
    'monitor.maxHedgeCost': {
        key: 'MAX_HEDGE_COST',
        default: 0.10,
        description: 'Max price ($) for a hedge range in medium-tier trades. Above this, hedge is skipped.',
    },
    'monitor.stopLossEnabled': {
        key: 'STOP_LOSS_ENABLED',
        default: 0,
        description: 'Enable automatic stop-loss sell when P&L drops below threshold',
        choices: [0, 1],
    },
    'monitor.stopLossPct': {
        key: 'STOP_LOSS_PCT',
        default: 50,
        description: 'Stop-loss trigger: sell all if P&L % drops below -N% (e.g. 50 = sell at -50%)',
    },
    'monitor.stopLossFloor': {
        key: 'STOP_LOSS_FLOOR',
        default: -1.5,
        description: 'Stop-loss absolute floor: sell all if P&L drops below -$N (e.g. -1.5)',
    },

    // ── Liquidity ────────────────────────────────────────────────────
    'liquidity.wsEnabled': {
        key: 'WS_LIQUIDITY_ENABLED',
        default: 1,
        description: 'Enable WebSocket liquidity streaming',
        choices: [0, 1],
    },
    'liquidity.buyMode': {
        key: 'LIQUIDITY_BUY_MODE',
        default: 'threshold',
        description: 'Buy trigger mode',
        choices: ['threshold', 'best-window'],
    },
    'liquidity.checkIntervalSecs': { key: 'LIQUIDITY_CHECK_SECS', default: 30, description: 'Seconds between liquidity assessments' },
    'liquidity.windowMinutes': { key: 'LIQUIDITY_WINDOW_MINS', default: 60, description: 'Minutes to track for best-window mode' },
    'liquidity.buyDeadlineHour': {
        key: 'LIQUIDITY_DEADLINE_HOUR',
        default: 10.5,
        description: 'Deadline hour (ET, decimal) to buy if still illiquid (10.5 = 10:30am)',
    },
    'liquidity.requireAllLiquid': {
        key: 'LIQUIDITY_ALL_REQUIRED',
        default: 0,
        description: 'Require ALL tokens liquid (1) or ANY (0). Set to 0 for tier-filtered trades.',
        choices: [0, 1],
    },
    'liquidity.spreadThreshold': {
        key: 'LIQUIDITY_SPREAD_THRESHOLD',
        default: 0.2,
        description: 'Max bid-ask spread % to be "liquid" (0.20 = 20%)',
    },
    'liquidity.depthThreshold': { key: 'LIQUIDITY_DEPTH_THRESHOLD', default: 5, description: 'Min shares at ask to be "liquid"' },

    // ── Weather ──────────────────────────────────────────────────────
    'weather.stationLat': { key: 'WEATHER_LAT', default: 40.7769, description: 'Station latitude' },
    'weather.stationLon': { key: 'WEATHER_LON', default: -73.874, description: 'Station longitude' },
    'weather.stationName': { key: 'WEATHER_STATION', default: 'KLGA', description: 'Weather station ID' },
    'weather.wcApiKey': { key: 'WC_API_KEY', default: '', description: 'Weather Company API key', sensitive: true },
    'weather.wcBaseUrl': {
        key: 'WC_BASE_URL',
        default: 'https://api.weather.com/v3/wx',
        description: 'Weather Company base URL',
        requiresRestart: true,
    },
    'weather.openMeteoUrl': {
        key: 'OPEN_METEO_URL',
        default: 'https://api.open-meteo.com/v1/forecast',
        description: 'Open-Meteo fallback URL',
        requiresRestart: true,
    },
    'weather.retries': { key: 'WEATHER_RETRIES', default: 2, description: 'Retries per weather source' },

    // ── Polymarket ───────────────────────────────────────────────────
    'polymarket.gammaBaseUrl': {
        key: 'GAMMA_BASE_URL',
        default: 'https://gamma-api.polymarket.com',
        description: 'Gamma API base URL',
        requiresRestart: true,
    },
    'polymarket.slugTemplate': {
        key: 'SLUG_TEMPLATE',
        default: 'highest-temperature-in-nyc-on-{date}',
        description: 'Market slug pattern',
    },
    'polymarket.maxSearchPages': { key: 'MAX_SEARCH_PAGES', default: 4, description: 'Max event search pages' },
    'polymarket.searchPageSize': { key: 'SEARCH_PAGE_SIZE', default: 50, description: 'Events per search page' },

    // ── Dashboard ────────────────────────────────────────────────────
    'dashboard.port': { key: 'DASHBOARD_PORT', default: 3000, description: 'Dashboard HTTP port', requiresRestart: true },
    'dashboard.refreshInterval': { key: 'DASHBOARD_REFRESH_MS', default: 10000, description: 'Card refresh interval (ms)' },
    'dashboard.liquidityPollMs': { key: 'DASHBOARD_LIQUIDITY_MS', default: 5000, description: 'Liquidity panel poll interval (ms)' },
    'dashboard.manualSellEnabled': {
        key: 'MANUAL_SELL_ENABLED',
        default: 0,
        description: 'Show manual sell buttons on positions',
        choices: [0, 1],
    },

    // ── Phase Thresholds ─────────────────────────────────────────────
    'phases.buyDaysMin': { key: 'PHASE_BUY_DAYS_MIN', default: 2, description: 'Days before target = buy phase' },
    'phases.scoutDaysMax': { key: 'PHASE_SCOUT_DAYS_MAX', default: 4, description: 'How far ahead to start scouting forecasts' },
    'phases.trendThreshold': { key: 'TREND_THRESHOLD_F', default: 2, description: '°F shift over scout window to declare a trend' },
};

/**
 * Resolve a config value from environment variables and overrides.
 * Priority: overrides > env vars > schema defaults.
 *
 * @param {string} dotPath - e.g. "trading.mode"
 * @param {Object} [overrides={}] - Section-keyed overrides, e.g. { trading: { mode: 'live' } }
 * @returns {{ value: any, source: 'override'|'env'|'default' }}
 */
export function resolveConfigValue(dotPath, overrides = {}) {
    const schema = CONFIG_SCHEMA[dotPath];
    if (!schema) return { value: undefined, source: 'default' };

    const [section, field] = dotPath.split('.');
    const overrideVal = overrides[section]?.[field];
    const envVal = process.env[schema.key];

    if (overrideVal !== undefined) {
        return { value: overrideVal, source: 'override' };
    }
    if (envVal !== undefined && envVal !== '') {
        const value = typeof schema.default === 'number' ? Number(envVal) : envVal;
        return { value, source: 'env' };
    }
    return { value: schema.default, source: 'default' };
}

/**
 * Build the full admin config response with metadata for each entry.
 * @param {Object} overrides
 * @returns {Object} - Section-keyed config with metadata
 */
export function buildAdminConfig(overrides = {}) {
    const result = {};
    for (const [dotPath, schema] of Object.entries(CONFIG_SCHEMA)) {
        const [section, field] = dotPath.split('.');
        if (!result[section]) result[section] = {};

        const { value, source } = resolveConfigValue(dotPath, overrides);
        result[section][field] = {
            envKey: schema.key,
            value,
            default: schema.sensitive ? '(hidden)' : schema.default,
            source,
            description: schema.description || '',
            sensitive: schema.sensitive || false,
            requiresRestart: schema.requiresRestart || false,
            readOnly: schema.readOnly || false,
            lockedByEnv: source === 'env',
            choices: schema.choices || null,
        };
    }
    return result;
}

/**
 * Build the flat config response for service consumption.
 * @param {Object} overrides
 * @returns {Object} - Section-keyed flat config, e.g. { trading: { mode: 'live', ... } }
 */
export function buildFlatConfig(overrides = {}) {
    const defaults = {
        monitor: {
            intervalMinutes: 15,
            rebalanceThreshold: 3,
            forecastShiftThreshold: 2,
            priceSpikeThreshold: 0.05,
            buyHourEST: 9.5,
            evThreshold: 0.05,
            maxEntryPrice: 0.40,
            maxHedgeCost: 0.10,
            stopLossEnabled: false,
            stopLossPct: 50,
            stopLossFloor: -1.5,
        },
        liquidity: {
            wsEnabled: true,
            checkIntervalSecs: 30,
            buyDeadlineHour: 10.5,
            requireAllLiquid: false,
            spreadThreshold: 0.2,
            depthThreshold: 5,
        },
        phases: { scoutDaysMax: 4, trendThreshold: 2 },
        trading: {},
    };
    for (const section of Object.keys(overrides)) {
        if (!defaults[section]) defaults[section] = {};
        Object.assign(defaults[section], overrides[section]);
    }
    return defaults;
}
