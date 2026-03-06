/**
 * @typedef {Object} WeatherForecast
 * @property {string} source - "weather-company" | "open-meteo"
 * @property {string} station - "KLGA"
 * @property {string} date - Target date ISO string, e.g. "2026-03-08"
 * @property {number} highTempF - Forecasted high temperature in Fahrenheit
 * @property {string} fetchedAt - ISO timestamp when forecast was fetched
 */

/**
 * @typedef {Object} CurrentConditions
 * @property {string} source - "weather-company" | "open-meteo"
 * @property {string} station - "KLGA"
 * @property {number} tempF - Current temperature in Fahrenheit
 * @property {number} feelsLikeF - Feels-like temperature
 * @property {number|null} maxSince7amF - Max temperature since 7am (WC only)
 * @property {string} conditions - Weather description, e.g. "Cloudy"
 * @property {string} observedAt - When the observation was taken
 * @property {string} fetchedAt - When we fetched it
 */

/**
 * @typedef {Object} TemperatureRange
 * @property {string} marketId - Polymarket market ID for this range
 * @property {string} question - e.g. "40-41°F"
 * @property {string} conditionId - Condition ID for the market
 * @property {number} lowTemp - Lower bound (inclusive), e.g. 40
 * @property {number} highTemp - Upper bound (inclusive), e.g. 41
 * @property {boolean} isOpenEnd - True for ranges like "48°F or higher"
 * @property {string|null} openEndDirection - "above" | "below" | null
 * @property {number} yesPrice - Current YES price (0-1)
 * @property {number} noPrice - Current NO price (0-1)
 * @property {number} impliedProbability - YES price as percentage
 * @property {number} volume - Total volume in USD
 * @property {string[]} clobTokenIds - [yesTokenId, noTokenId]
 */

/**
 * @typedef {Object} PolymarketEvent
 * @property {string} id - Polymarket event ID
 * @property {string} title - e.g. "Highest temperature in NYC on March 7?"
 * @property {string} slug - URL slug
 * @property {string} targetDate - The date the market is predicting for
 * @property {boolean} active
 * @property {boolean} closed
 * @property {TemperatureRange[]} ranges - All available temperature ranges
 */

/**
 * @typedef {Object} SelectedRanges
 * @property {TemperatureRange} target - The range matching the forecast
 * @property {TemperatureRange|null} below - One range below target
 * @property {TemperatureRange|null} above - One range above target
 * @property {number} forecastTempF - The forecast temperature used for selection
 * @property {string} forecastSource - Weather source used
 * @property {string} targetDate - The date this prediction is for
 * @property {string} selectionTimestamp - When this selection was made (ISO)
 * @property {number} totalCost - Sum of YES prices for all 3 ranges
 * @property {number} potentialProfit - $1.00 minus totalCost
 * @property {string} roi - ROI percentage string
 */

/**
 * @typedef {Object} ObservationRecord
 * @property {string} id - Unique record ID
 * @property {string} targetDate
 * @property {WeatherForecast} forecast
 * @property {PolymarketEvent} event
 * @property {SelectedRanges} selection
 * @property {string} createdAt - ISO timestamp
 */

// ── Phase 2: Monitoring Types ──────────────────────────────────────────

/**
 * @typedef {Object} SnapshotRange
 * @property {string} marketId
 * @property {string} question - e.g. "46-47°F"
 * @property {number} yesPrice - Current YES price (0-1)
 * @property {number} priceChange - Delta from previous snapshot
 * @property {number} impliedProbability
 * @property {number} volume
 */

/**
 * @typedef {Object} MonitoringSnapshot
 * @property {string} timestamp - ISO timestamp
 * @property {number} forecastTempF - Current forecast high (from WC/WU)
 * @property {string} forecastSource - "weather-company" | "open-meteo"
 * @property {number} forecastChange - Delta from previous snapshot (°F)
 * @property {number|null} currentTempF - Live current temperature at KLGA
 * @property {number|null} maxTodayF - Max temperature since 7am today
 * @property {string|null} currentConditions - e.g. "Cloudy"
 * @property {string} phase - "buy" | "monitor" | "resolve"
 * @property {number} daysUntilTarget - Days remaining until target date
 * @property {SnapshotRange} target - Target range snapshot
 * @property {SnapshotRange|null} below - Below range snapshot
 * @property {SnapshotRange|null} above - Above range snapshot
 * @property {number} totalCost - Sum of YES prices for selected ranges
 * @property {boolean} rangeShifted - True if target range changed from previous
 * @property {string|null} shiftedFrom - Previous range question if shifted
 */

/**
 * @typedef {Object} MonitoringAlert
 * @property {string} timestamp - ISO timestamp
 * @property {string} type - "forecast_shift" | "range_shift" | "price_spike" | "market_closed" | "phase_change"
 * @property {string} message - Human-readable alert message
 * @property {Object} data - Alert-specific data
 */

/**
 * @typedef {Object} MonitoringSession
 * @property {string} id - Session UUID
 * @property {string} targetDate - e.g. "2026-03-08"
 * @property {string} startedAt - ISO timestamp
 * @property {string} status - "active" | "completed" | "stopped"
 * @property {string} phase - Current phase: "buy" | "monitor" | "resolve"
 * @property {number} intervalMinutes - Re-check interval
 * @property {number} initialForecastTempF - Forecast at session start
 * @property {string} initialTargetRange - Target range question at session start
 * @property {string} forecastSource - Primary weather source being used
 * @property {number} rebalanceThreshold - °F change required to rebalance (default: 7)
 * @property {MonitoringSnapshot[]} snapshots - Time series of checks
 * @property {MonitoringAlert[]} alerts - Triggered alerts
 */

export { };
