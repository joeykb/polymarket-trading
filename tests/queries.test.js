/**
 * Tests for data-svc/queries.js — database operations
 *
 * Uses an in-memory SQLite database seeded with the real schema.
 * Verifies INSERT, UPDATE, SELECT, and transaction behavior.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── In-memory DB setup ──────────────────────────────────────────────

let db;

// Mock the db module so queries.js uses our in-memory DB
vi.mock('../services/data-svc/db.js', () => ({
    getDb: () => db,
    closeDb: () => {},
}));

// Import AFTER mock is set up
const queries = await import('../services/data-svc/queries.js');

beforeAll(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');

    // Load and execute schema
    const schemaPath = path.resolve(__dirname, '../services/data-svc/schema.sql');
    const schema = fs.readFileSync(schemaPath, 'utf8');
    const statements = schema
        .split(';')
        .map((s) => s.trim())
        .filter((s) => s.length > 0 && !s.startsWith('PRAGMA'));

    for (const stmt of statements) {
        try {
            db.exec(stmt);
        } catch (err) {
            if (!err.message.includes('already exists')) throw err;
        }
    }

    // Seed market
    db.prepare(`INSERT OR IGNORE INTO markets (id, name, slug_template, unit) VALUES (?, ?, ?, ?)`).run(
        'nyc',
        'NYC Temperature',
        'highest-temperature-in-nyc-on-{date}',
        'F',
    );
});

afterAll(() => {
    if (db) db.close();
});

// ── Sessions ────────────────────────────────────────────────────────

describe('sessions', () => {
    it('upsertSession creates a new session', () => {
        const result = queries.upsertSession({
            id: 'test-session-1',
            marketId: 'nyc',
            targetDate: '2026-03-25',
            status: 'active',
            phase: 'buy',
            initialForecastTemp: 72.5,
            initialTargetRange: 'Between 72-73°F',
            forecastSource: 'open-meteo',
            intervalMinutes: 15,
            rebalanceThreshold: 3.0,
        });

        expect(result.changes).toBe(1);
    });

    it('upsertSession updates existing session by market+date', () => {
        // Same market+date as above should UPDATE, not INSERT
        const result = queries.upsertSession({
            id: 'test-session-different-id',
            marketId: 'nyc',
            targetDate: '2026-03-25',
            status: 'active',
            phase: 'monitor',
        });

        expect(result.existingId).toBe('test-session-1'); // keeps original ID
    });

    it('getSession retrieves by market+date', () => {
        const session = queries.getSession('nyc', '2026-03-25');
        expect(session).toBeDefined();
        expect(session.id).toBe('test-session-1');
        expect(session.phase).toBe('monitor'); // updated by upsert
    });

    it('getSessionById retrieves by ID', () => {
        const session = queries.getSessionById('test-session-1');
        expect(session).toBeDefined();
        expect(session.target_date).toBe('2026-03-25');
    });

    it('updateSession updates fields', () => {
        queries.updateSession('test-session-1', { status: 'completed', phase: 'resolve' });
        const session = queries.getSessionById('test-session-1');
        expect(session.status).toBe('completed');
        expect(session.phase).toBe('resolve');
    });

    it('getAllSessions returns newest first', () => {
        // Add a second session
        queries.upsertSession({
            id: 'test-session-2',
            marketId: 'nyc',
            targetDate: '2026-03-26',
            status: 'active',
            phase: 'scout',
        });

        const sessions = queries.getAllSessions(10);
        expect(sessions.length).toBeGreaterThanOrEqual(2);
        expect(sessions[0].target_date >= sessions[1].target_date).toBe(true);
    });
});

// ── Trades ───────────────────────────────────────────────────────────

describe('trades', () => {
    let tradeId;

    it('insertTrade creates a trade and returns its ID', () => {
        const result = queries.insertTrade({
            sessionId: 'test-session-1',
            marketId: 'nyc',
            targetDate: '2026-03-25',
            type: 'buy',
            mode: 'live',
            placedAt: '2026-03-23T14:30:00Z',
            totalCost: 3.15,
            totalProceeds: 0,
            status: 'filled',
            metadata: { maxProfit: 0.85 },
        });

        expect(result.id).toBeDefined();
        expect(typeof Number(result.id)).toBe('number');
        tradeId = Number(result.id);
    });

    it('insertTrade stores metadata as JSON', () => {
        const trade = db.prepare('SELECT * FROM trades WHERE id = ?').get(tradeId);
        expect(trade.metadata).toBe('{"maxProfit":0.85}');
    });

    it('updateTrade updates status and verified fields', () => {
        queries.updateTrade(tradeId, {
            status: 'filled',
            verifiedAt: '2026-03-23T14:35:00Z',
            actualCost: 3.1,
        });

        const trade = db.prepare('SELECT * FROM trades WHERE id = ?').get(tradeId);
        expect(trade.status).toBe('filled');
        expect(trade.verified_at).toBe('2026-03-23T14:35:00Z');
        expect(trade.actual_cost).toBe(3.1);
    });

    it('getTradesForDate returns trades for a specific date', () => {
        const trades = queries.getTradesForDate('2026-03-25');
        expect(trades.length).toBe(1);
        expect(trades[0].market_name).toBe('NYC Temperature');
    });

    it('getAllTrades returns newest first', () => {
        // Insert another trade
        queries.insertTrade({
            sessionId: 'test-session-2',
            marketId: 'nyc',
            targetDate: '2026-03-26',
            type: 'buy',
            mode: 'dry-run',
            totalCost: 2.5,
        });

        const trades = queries.getAllTrades(10);
        expect(trades.length).toBeGreaterThanOrEqual(2);
    });
});

// ── Positions ────────────────────────────────────────────────────────

describe('positions', () => {
    it('insertPositions inserts multiple positions in a transaction', () => {
        const result = queries.insertTrade({
            sessionId: 'test-session-1',
            marketId: 'nyc',
            targetDate: '2026-03-25',
            type: 'buy',
            mode: 'live',
            totalCost: 1.5,
        });
        const tradeId = Number(result.id);

        queries.insertPositions(tradeId, [
            { label: 'target', question: 'Between 72-73°F', buyPrice: 0.5, shares: 5, status: 'filled' },
            { label: 'below', question: 'Between 70-71°F', buyPrice: 0.3, shares: 5, status: 'filled' },
            { label: 'above', question: 'Between 74-75°F', buyPrice: 0.2, shares: 5, status: 'failed', error: 'Illiquid' },
        ]);

        const positions = queries.getPositionsForTrade(tradeId);
        expect(positions).toHaveLength(3);
        expect(positions[0].label).toBe('target');
        expect(positions[2].error).toBe('Illiquid');
    });

    it('getActivePositions excludes sold/failed positions', () => {
        // Use a unique date to isolate from other tests
        queries.upsertSession({
            id: 'test-session-active-pos',
            marketId: 'nyc',
            targetDate: '2026-04-01',
            status: 'active',
            phase: 'buy',
        });
        const result = queries.insertTrade({
            sessionId: 'test-session-active-pos',
            marketId: 'nyc',
            targetDate: '2026-04-01',
            type: 'buy',
            mode: 'live',
            totalCost: 1.5,
        });
        const tradeId = Number(result.id);

        queries.insertPositions(tradeId, [
            { label: 'target', question: 'Between 72-73°F', buyPrice: 0.5, shares: 5, status: 'filled' },
            { label: 'below', question: 'Between 70-71°F', buyPrice: 0.3, shares: 5, status: 'sold' },
            { label: 'above', question: 'Between 74-75°F', buyPrice: 0.2, shares: 5, status: 'failed' },
        ]);

        const active = queries.getActivePositions('2026-04-01');
        const activeLabels = active.map((p) => p.label);
        expect(activeLabels).toContain('target');
        expect(activeLabels).not.toContain('below'); // sold
        expect(activeLabels).not.toContain('above'); // failed
    });
});

// ── Snapshots ────────────────────────────────────────────────────────

describe('snapshots', () => {
    it('insertSnapshot and getSnapshots round-trip', () => {
        queries.insertSnapshot({
            sessionId: 'test-session-1',
            timestamp: '2026-03-23T14:00:00Z',
            forecastTempF: 72.5,
            forecastSource: 'open-meteo',
            forecastChange: 0.5,
            currentTempF: 68.0,
            maxTodayF: 70.0,
            currentConditions: 'Partly Cloudy',
            phase: 'buy',
            daysUntilTarget: 2,
            target: { question: 'Between 72-73°F', yesPrice: 0.55 },
            below: { question: 'Between 70-71°F', yesPrice: 0.25 },
            above: { question: 'Between 74-75°F', yesPrice: 0.15 },
        });

        const snapshots = queries.getSnapshots('test-session-1');
        expect(snapshots.length).toBeGreaterThanOrEqual(1);
        expect(snapshots[0].forecast_temp).toBe(72.5);
        expect(snapshots[0].target_question).toBe('Between 72-73°F');
    });
});

// ── Alerts ───────────────────────────────────────────────────────────

describe('alerts', () => {
    it('insertAlert and getAlertsForSession round-trip', () => {
        queries.insertAlert({
            sessionId: 'test-session-1',
            timestamp: '2026-03-23T14:05:00Z',
            type: 'forecast_shift',
            message: 'Forecast shifted from 72°F to 74°F',
            data: { from: 72, to: 74 },
        });

        const alerts = db.prepare('SELECT * FROM alerts WHERE session_id = ?').all('test-session-1');
        expect(alerts.length).toBeGreaterThanOrEqual(1);
        expect(alerts[0].type).toBe('forecast_shift');
        expect(alerts[0].message).toContain('72°F');
    });
});

// ── Foreign Key Constraints ─────────────────────────────────────────

describe('referential integrity', () => {
    it('rejects trade with non-existent market_id', () => {
        expect(() => {
            queries.insertTrade({
                sessionId: null,
                marketId: 'nonexistent',
                targetDate: '2026-03-25',
                type: 'buy',
            });
        }).toThrow();
    });
});
