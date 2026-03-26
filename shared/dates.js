/**
 * Shared date utilities for TempEdge.
 *
 * Consolidates date functions previously duplicated across:
 *   - src/utils/dateUtils.js
 *   - services/monitor/orchestrator.js
 *   - services/dashboard-svc/server.js
 *   - services/market-svc/index.js
 *   - services/weather-svc/index.js
 */

/**
 * Current ISO timestamp.
 * @returns {string}
 */
export function nowISO() {
    return new Date().toISOString();
}

/**
 * Today's date in YYYY-MM-DD format in Eastern Time.
 * @returns {string}
 */
export function getTodayET() {
    return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

/**
 * Date N days from today in YYYY-MM-DD format in Eastern Time.
 * @param {number} offset - Number of days ahead (can be negative)
 * @returns {string}
 */
export function getDateOffsetET(offset) {
    // Compute entirely in ET to avoid DST boundary issues when server TZ != ET
    const nowET = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
    nowET.setDate(nowET.getDate() + offset);
    return nowET.toLocaleDateString('en-CA');
}

/**
 * Tomorrow's date in YYYY-MM-DD format in Eastern Time.
 * @returns {string}
 */
export function getTomorrowET() {
    return getDateOffsetET(1);
}

/**
 * Default target date (today + 2) in YYYY-MM-DD format in Eastern Time.
 * Strategy: buy ranges 2 days in advance.
 * @returns {string}
 */
export function getTargetDateET() {
    return getDateOffsetET(2);
}

/**
 * Number of calendar days between today (ET) and a target date.
 * @param {string} dateStr - ISO date string, e.g. "2026-03-08"
 * @returns {number} - 0 = today, 1 = tomorrow, negative = past
 */
export function daysUntil(dateStr) {
    const today = getTodayET();
    const target = new Date(dateStr + 'T12:00:00');
    const now = new Date(today + 'T12:00:00');
    return Math.round((target - now) / (1000 * 60 * 60 * 24));
}

/**
 * Determine the monitoring phase based on days until target.
 *
 * Default thresholds:
 *   scout  = 4+ days out
 *   track  = 3 days out
 *   buy    = 2 days out
 *   monitor = 1 day out
 *   resolve = 0 or past
 *
 * @param {string} targetDate
 * @returns {"scout" | "track" | "buy" | "monitor" | "resolve"}
 */
export function getPhase(targetDate) {
    const days = daysUntil(targetDate);
    if (days <= 0) return 'resolve';
    if (days === 1) return 'monitor';
    if (days === 2) return 'buy';
    if (days === 3) return 'track';
    return 'scout';
}

/**
 * Format "2026-03-07" as "March 7".
 * @param {string} isoDate
 * @returns {string}
 */
export function formatDateLabel(isoDate) {
    const [year, month, day] = isoDate.split('-').map(Number);
    const date = new Date(year, month - 1, day);
    return date.toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
}

/**
 * Format "2026-03-08" as "march-8-2026" for Polymarket slug construction.
 * @param {string} isoDate
 * @returns {string}
 */
export function formatDateForSlug(isoDate) {
    const [year, month, day] = isoDate.split('-').map(Number);
    const date = new Date(year, month - 1, day);
    const monthName = date.toLocaleDateString('en-US', { month: 'long' }).toLowerCase();
    return `${monthName}-${day}-${year}`;
}

/**
 * Extract a date from a Polymarket event title like "... on March 23?"
 * @param {string} title
 * @returns {string|null} - ISO date string or null
 */
export function extractDateFromTitle(title) {
    const match = title.match(/on (\w+ \d+)\??/i);
    if (match) {
        const parsed = new Date(`${match[1]}, ${new Date().getFullYear()}`);
        if (!isNaN(parsed.getTime())) return parsed.toISOString().split('T')[0];
    }
    return null;
}
