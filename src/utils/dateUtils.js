/**
 * Date formatting utilities for TempEdge
 */

import { config } from '../config.js';

/**
 * Get today's date in YYYY-MM-DD format in Eastern Time
 * @returns {string}
 */
export function getTodayET() {
    return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

/**
 * Get tomorrow's date in YYYY-MM-DD format in Eastern Time
 * @returns {string}
 */
export function getTomorrowET() {
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    return tomorrow.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

/**
 * Get the target date (today + 2) in YYYY-MM-DD format in Eastern Time
 * Strategy: buy ranges 2 days in advance
 * @returns {string}
 */
export function getTargetDateET() {
    const now = new Date();
    const target = new Date(now);
    target.setDate(target.getDate() + 2);
    return target.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

/**
 * Get the number of days between now and a target date (in ET)
 * @param {string} targetDate - ISO date string, e.g. "2026-03-08"
 * @returns {number} - 0 = today, 1 = tomorrow, 2 = day after tomorrow, etc.
 */
export function daysUntil(targetDate) {
    const today = getTodayET();
    const [tY, tM, tD] = today.split('-').map(Number);
    const [dY, dM, dD] = targetDate.split('-').map(Number);
    const todayMs = new Date(tY, tM - 1, tD).getTime();
    const targetMs = new Date(dY, dM - 1, dD).getTime();
    return Math.round((targetMs - todayMs) / (1000 * 60 * 60 * 24));
}

/**
 * Determine the monitoring phase based on days until target
 * @param {string} targetDate
 * @returns {"buy" | "monitor" | "resolve"}
 */
export function getPhase(targetDate) {
    const days = daysUntil(targetDate);
    if (days >= config.phases.buyDaysMin) return 'buy';
    if (days === 1) return 'monitor';
    return 'resolve';  // days <= 0
}

/**
 * Format a date string like "March 7" from "2026-03-07"
 * @param {string} isoDate - e.g. "2026-03-07"
 * @returns {string} - e.g. "March 7"
 */
export function formatDateLabel(isoDate) {
    const [year, month, day] = isoDate.split('-').map(Number);
    const date = new Date(year, month - 1, day);
    return date.toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
}

/**
 * Format a date string like "march-8-2026" for slug construction
 * Polymarket slugs include the year: highest-temperature-in-nyc-on-march-8-2026
 * @param {string} isoDate - e.g. "2026-03-08"
 * @returns {string} - e.g. "march-8-2026"
 */
export function formatDateForSlug(isoDate) {
    const [year, month, day] = isoDate.split('-').map(Number);
    const date = new Date(year, month - 1, day);
    const monthName = date.toLocaleDateString('en-US', { month: 'long' }).toLowerCase();
    return `${monthName}-${day}-${year}`;
}

/**
 * Get current ISO timestamp
 * @returns {string}
 */
export function nowISO() {
    return new Date().toISOString();
}
