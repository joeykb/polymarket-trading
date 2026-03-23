/**
 * Tests for shared/dates.js — date utilities
 *
 * Date logic is critical for phase determination (scout → track → buy → monitor → resolve).
 * Incorrect phase = incorrect trading behavior.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    nowISO,
    getTodayET,
    getDateOffsetET,
    getTomorrowET,
    getTargetDateET,
    daysUntil,
    getPhase,
    formatDateLabel,
    formatDateForSlug,
    extractDateFromTitle,
} from '../shared/dates.js';

// ── Pure formatters (no date mocking needed) ────────────────────────

describe('formatDateLabel', () => {
    it('formats ISO date as "Month Day"', () => {
        expect(formatDateLabel('2026-03-23')).toBe('March 23');
    });

    it('handles January', () => {
        expect(formatDateLabel('2026-01-01')).toBe('January 1');
    });

    it('handles December', () => {
        expect(formatDateLabel('2026-12-31')).toBe('December 31');
    });
});

describe('formatDateForSlug', () => {
    it('formats ISO date as lowercase slug', () => {
        expect(formatDateForSlug('2026-03-23')).toBe('march-23-2026');
    });

    it('handles single-digit days', () => {
        expect(formatDateForSlug('2026-03-07')).toBe('march-7-2026');
    });
});

describe('extractDateFromTitle', () => {
    it('extracts date from Polymarket title', () => {
        const title = 'Highest temperature in NYC on March 23?';
        const result = extractDateFromTitle(title);
        expect(result).toBe('2026-03-23');
    });

    it('handles title without question mark', () => {
        const title = 'Highest temperature in NYC on March 23';
        const result = extractDateFromTitle(title);
        expect(result).toBe('2026-03-23');
    });

    it('returns null for non-matching title', () => {
        expect(extractDateFromTitle('Some random event')).toBeNull();
    });
});

// ── Phase determination (relative to current date) ──────────────────

describe('getPhase', () => {
    // To test phases, we use daysUntil which depends on "today".
    // We test by computing target dates relative to actual today.

    const todayStr = getTodayET();
    const addDays = (dateStr, n) => {
        const d = new Date(dateStr + 'T12:00:00');
        d.setDate(d.getDate() + n);
        return d.toISOString().split('T')[0];
    };

    it('returns "resolve" for today', () => {
        expect(getPhase(todayStr)).toBe('resolve');
    });

    it('returns "resolve" for past dates', () => {
        expect(getPhase(addDays(todayStr, -1))).toBe('resolve');
        expect(getPhase(addDays(todayStr, -5))).toBe('resolve');
    });

    it('returns "monitor" for tomorrow', () => {
        expect(getPhase(addDays(todayStr, 1))).toBe('monitor');
    });

    it('returns "buy" for day after tomorrow', () => {
        expect(getPhase(addDays(todayStr, 2))).toBe('buy');
    });

    it('returns "track" for 3 days out', () => {
        expect(getPhase(addDays(todayStr, 3))).toBe('track');
    });

    it('returns "scout" for 4+ days out', () => {
        expect(getPhase(addDays(todayStr, 4))).toBe('scout');
        expect(getPhase(addDays(todayStr, 10))).toBe('scout');
    });
});

// ── daysUntil ───────────────────────────────────────────────────────

describe('daysUntil', () => {
    const todayStr = getTodayET();
    const addDays = (dateStr, n) => {
        const d = new Date(dateStr + 'T12:00:00');
        d.setDate(d.getDate() + n);
        return d.toISOString().split('T')[0];
    };

    it('returns 0 for today', () => {
        expect(daysUntil(todayStr)).toBe(0);
    });

    it('returns positive for future dates', () => {
        expect(daysUntil(addDays(todayStr, 3))).toBe(3);
    });

    it('returns negative for past dates', () => {
        expect(daysUntil(addDays(todayStr, -2))).toBe(-2);
    });
});

// ── Time-sensitive helpers ──────────────────────────────────────────

describe('time helpers', () => {
    it('nowISO returns an ISO string', () => {
        const result = nowISO();
        expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });

    it('getTodayET returns YYYY-MM-DD format', () => {
        const result = getTodayET();
        expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('getTomorrowET returns one day after today', () => {
        expect(daysUntil(getTomorrowET())).toBe(1);
    });

    it('getTargetDateET returns two days after today', () => {
        expect(daysUntil(getTargetDateET())).toBe(2);
    });

    it('getDateOffsetET(0) equals getTodayET()', () => {
        expect(getDateOffsetET(0)).toBe(getTodayET());
    });
});
