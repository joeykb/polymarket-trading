/**
 * Tests for services/monitor/alerts.js — Alert detection
 *
 * Pure function tests — no I/O, no mocking needed.
 */
import { describe, it, expect } from 'vitest';
import { detectAlerts } from '../services/monitor/alerts.js';

const makeSession = (overrides = {}) => ({
    initialForecastTempF: 65,
    ...overrides,
});

const makeSnapshot = (overrides = {}) => ({
    forecastTempF: 65,
    phase: 'monitor',
    daysUntilTarget: 2,
    eventClosed: false,
    rangeShifted: false,
    target: { question: 'Between 64-65°F', yesPrice: 0.5, priceChange: 0 },
    below: null,
    above: null,
    ...overrides,
});

const defaultConfig = {
    forecastShiftThreshold: 2,
    rebalanceThreshold: 3,
    priceSpikeThreshold: 0.05,
};

// ── Market Closed ───────────────────────────────────────────────────────

describe('detectAlerts — market closed', () => {
    it('emits market_closed alert when event is closed', () => {
        const current = makeSnapshot({ eventClosed: true });
        const alerts = detectAlerts(current, null, makeSession(), defaultConfig);
        expect(alerts).toHaveLength(1);
        expect(alerts[0].type).toBe('market_closed');
    });

    it('does not emit when event is open', () => {
        const current = makeSnapshot({ eventClosed: false });
        const alerts = detectAlerts(current, null, makeSession(), defaultConfig);
        expect(alerts).toHaveLength(0);
    });
});

// ── Phase Change ────────────────────────────────────────────────────────

describe('detectAlerts — phase change', () => {
    it('emits phase_change when phase differs from previous', () => {
        const current = makeSnapshot({ phase: 'resolve' });
        const previous = makeSnapshot({ phase: 'monitor' });
        const alerts = detectAlerts(current, previous, makeSession(), defaultConfig);
        const phaseAlert = alerts.find((a) => a.type === 'phase_change');
        expect(phaseAlert).toBeDefined();
        expect(phaseAlert.data.from).toBe('monitor');
        expect(phaseAlert.data.to).toBe('resolve');
    });

    it('does not emit when phase is unchanged', () => {
        const current = makeSnapshot({ phase: 'monitor' });
        const previous = makeSnapshot({ phase: 'monitor' });
        const alerts = detectAlerts(current, previous, makeSession(), defaultConfig);
        const phaseAlert = alerts.find((a) => a.type === 'phase_change');
        expect(phaseAlert).toBeUndefined();
    });
});

// ── Forecast Shift ──────────────────────────────────────────────────────

describe('detectAlerts — forecast shift', () => {
    it('emits forecast_shift when shift exceeds threshold', () => {
        const current = makeSnapshot({ forecastTempF: 68 }); // +3 from initial 65
        const previous = makeSnapshot({ forecastTempF: 66 });
        const session = makeSession({ initialForecastTempF: 65 });
        const alerts = detectAlerts(current, previous, session, defaultConfig);
        const shiftAlert = alerts.find((a) => a.type === 'forecast_shift');
        expect(shiftAlert).toBeDefined();
        expect(shiftAlert.data.delta).toBe(3);
    });

    it('marks shift as drastic when above rebalance threshold', () => {
        const current = makeSnapshot({ forecastTempF: 69 }); // +4 from initial 65
        const previous = makeSnapshot({ forecastTempF: 66 });
        const session = makeSession({ initialForecastTempF: 65 });
        const alerts = detectAlerts(current, previous, session, defaultConfig);
        const shiftAlert = alerts.find((a) => a.type === 'forecast_shift');
        expect(shiftAlert.data.isDrastic).toBe(true);
    });

    it('does not emit when shift is below threshold', () => {
        const current = makeSnapshot({ forecastTempF: 66 }); // +1 from initial 65
        const previous = makeSnapshot({ forecastTempF: 65.5 });
        const session = makeSession({ initialForecastTempF: 65 });
        const alerts = detectAlerts(current, previous, session, defaultConfig);
        const shiftAlert = alerts.find((a) => a.type === 'forecast_shift');
        expect(shiftAlert).toBeUndefined();
    });
});

// ── Range Shift ─────────────────────────────────────────────────────────

describe('detectAlerts — range shift', () => {
    it('emits range_shift when target range changes', () => {
        const current = makeSnapshot({
            rangeShifted: true,
            shiftedFrom: 'Between 64-65°F',
            target: { question: 'Between 66-67°F', yesPrice: 0.5, priceChange: 0 },
        });
        const previous = makeSnapshot();
        const alerts = detectAlerts(current, previous, makeSession(), defaultConfig);
        const rangeAlert = alerts.find((a) => a.type === 'range_shift');
        expect(rangeAlert).toBeDefined();
        expect(rangeAlert.data.from).toBe('Between 64-65°F');
        expect(rangeAlert.data.to).toBe('Between 66-67°F');
    });
});

// ── Price Spike ─────────────────────────────────────────────────────────

describe('detectAlerts — price spike', () => {
    it('emits price_spike when target price changes by >= threshold', () => {
        const current = makeSnapshot({
            target: { question: 'Q1', yesPrice: 0.55, priceChange: 0.06 },
        });
        const previous = makeSnapshot();
        const alerts = detectAlerts(current, previous, makeSession(), defaultConfig);
        const spike = alerts.find((a) => a.type === 'price_spike');
        expect(spike).toBeDefined();
        expect(spike.data.label).toBe('target');
    });

    it('does not emit when price change is below threshold', () => {
        const current = makeSnapshot({
            target: { question: 'Q1', yesPrice: 0.52, priceChange: 0.02 },
        });
        const previous = makeSnapshot();
        const alerts = detectAlerts(current, previous, makeSession(), defaultConfig);
        const spike = alerts.find((a) => a.type === 'price_spike');
        expect(spike).toBeUndefined();
    });

    it('detects spike on below range', () => {
        const current = makeSnapshot({
            below: { question: 'Q2', yesPrice: 0.4, priceChange: -0.08 },
        });
        const previous = makeSnapshot();
        const alerts = detectAlerts(current, previous, makeSession(), defaultConfig);
        const spike = alerts.find((a) => a.type === 'price_spike' && a.data.label === 'below');
        expect(spike).toBeDefined();
    });

    it('returns empty for null above range', () => {
        const current = makeSnapshot({ above: null });
        const previous = makeSnapshot();
        const alerts = detectAlerts(current, previous, makeSession(), defaultConfig);
        const spike = alerts.find((a) => a.type === 'price_spike' && a.data.label === 'above');
        expect(spike).toBeUndefined();
    });
});

// ── No previous snapshot ────────────────────────────────────────────────

describe('detectAlerts — first cycle (no previous)', () => {
    it('returns only market_closed if applicable, no other alerts', () => {
        const current = makeSnapshot({ eventClosed: false });
        const alerts = detectAlerts(current, null, makeSession(), defaultConfig);
        expect(alerts).toHaveLength(0);
    });

    it('can emit market_closed on first cycle', () => {
        const current = makeSnapshot({ eventClosed: true });
        const alerts = detectAlerts(current, null, makeSession(), defaultConfig);
        expect(alerts).toHaveLength(1);
        expect(alerts[0].type).toBe('market_closed');
    });
});
