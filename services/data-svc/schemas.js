/**
 * TempEdge — Request body validation schemas
 *
 * Uses zod for runtime validation on critical API endpoints.
 * Prevents malformed data from reaching the database or triggering trades.
 *
 * Usage in route handlers:
 *   import { tradeSchema, validate } from './schemas.js';
 *   const body = await readBody(req);
 *   const { data, error } = validate(tradeSchema, body);
 *   if (error) return errorResponse(res, error, 400);
 */

import { z } from 'zod';

// ── Sessions ────────────────────────────────────────────────────────────

export const sessionSchema = z.object({
    id: z.string().min(1, 'Session ID is required'),
    marketId: z.string().default('nyc'),
    targetDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'targetDate must be YYYY-MM-DD'),
    status: z.enum(['active', 'completed', 'stopped']).default('active'),
    phase: z.enum(['scout', 'track', 'buy', 'monitor', 'resolve']).default('scout'),
    initialForecastTemp: z.number().optional(),
    initialTargetRange: z.string().optional(),
    forecastSource: z.string().optional(),
    intervalMinutes: z.number().int().positive().default(15),
    rebalanceThreshold: z.number().positive().default(3.0),
});

export const sessionUpdateSchema = z
    .object({
        status: z.enum(['active', 'completed', 'stopped']).optional(),
        phase: z.enum(['scout', 'track', 'buy', 'monitor', 'resolve']).optional(),
    })
    .refine((data) => Object.keys(data).length > 0, {
        message: 'At least one field is required for update',
    });

// ── Trades ──────────────────────────────────────────────────────────────

export const tradeSchema = z.object({
    sessionId: z.string().nullable().optional(),
    marketId: z.string().default('nyc'),
    targetDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'targetDate must be YYYY-MM-DD'),
    type: z.enum(['buy', 'sell', 'redeem']),
    mode: z.enum(['live', 'dry-run']).default('live'),
    placedAt: z.string().optional(),
    totalCost: z.number().min(0).default(0),
    totalProceeds: z.number().min(0).default(0),
    status: z.enum(['placed', 'filled', 'failed', 'redeemed']).default('placed'),
    metadata: z.record(z.unknown()).nullable().optional(),
});

export const tradeUpdateSchema = z
    .object({
        status: z.enum(['placed', 'filled', 'failed', 'redeemed']).optional(),
        verifiedAt: z.string().optional(),
        actualCost: z.number().min(0).optional(),
        fillSummary: z.record(z.unknown()).optional(),
        totalProceeds: z.number().min(0).optional(),
    })
    .refine((data) => Object.keys(data).length > 0, {
        message: 'At least one field is required for update',
    });

// ── Positions ───────────────────────────────────────────────────────────

const positionItemSchema = z.object({
    label: z.string().optional(),
    question: z.string().min(1, 'Question is required'),
    marketId: z.string().optional(),
    polymarket_id: z.string().optional(),
    conditionId: z.string().optional(),
    condition_id: z.string().optional(),
    clobTokenIds: z.array(z.string()).optional(),
    clob_token_ids: z.string().optional(),
    orderId: z.string().nullable().optional(),
    order_id: z.string().nullable().optional(),
    tokenId: z.string().nullable().optional(),
    token_id: z.string().nullable().optional(),
    buyPrice: z.number().min(0).optional(),
    price: z.number().min(0).optional(),
    shares: z.number().min(0).optional(),
    size: z.number().min(0).optional(),
    status: z.enum(['placed', 'filled', 'partial', 'failed', 'sold', 'redeemed']).default('placed'),
    fillPrice: z.number().nullable().optional(),
    fill_price: z.number().nullable().optional(),
    fillShares: z.number().nullable().optional(),
    fill_shares: z.number().nullable().optional(),
    error: z.string().nullable().optional(),
});

export const positionsInsertSchema = z.object({
    tradeId: z.number().int().positive('tradeId is required'),
    positions: z.array(positionItemSchema).min(1, 'At least one position is required'),
});

export const positionSoldSchema = z.object({
    sellPrice: z.number().min(0, 'sellPrice is required'),
    soldAt: z.string().min(1, 'soldAt timestamp is required'),
    sellOrderId: z.string().nullable().optional(),
});

export const positionRedeemedSchema = z.object({
    redeemedValue: z.number().min(0, 'redeemedValue is required'),
    redeemedAt: z.string().min(1, 'redeemedAt timestamp is required'),
    redeemedTx: z.string().nullable().optional(),
});

export const positionUpdateSchema = z
    .object({
        status: z.enum(['placed', 'filled', 'partial', 'failed', 'sold', 'redeemed']).optional(),
        label: z.string().optional(),
        orderId: z.string().nullable().optional(),
        order_id: z.string().nullable().optional(),
        tokenId: z.string().nullable().optional(),
        token_id: z.string().nullable().optional(),
        price: z.number().min(0).optional(),
        shares: z.number().min(0).optional(),
        fillPrice: z.number().nullable().optional(),
        fill_price: z.number().nullable().optional(),
        fillShares: z.number().nullable().optional(),
        fill_shares: z.number().nullable().optional(),
        error: z.string().nullable().optional(),
        soldAt: z.string().nullable().optional(),
        sold_at: z.string().nullable().optional(),
        sellPrice: z.number().min(0).nullable().optional(),
        sell_price: z.number().min(0).nullable().optional(),
        sellOrderId: z.string().nullable().optional(),
        sell_order_id: z.string().nullable().optional(),
        redeemedAt: z.string().nullable().optional(),
        redeemed_at: z.string().nullable().optional(),
        redeemedValue: z.number().min(0).nullable().optional(),
        redeemed_value: z.number().min(0).nullable().optional(),
        redeemedTx: z.string().nullable().optional(),
        redeemed_tx: z.string().nullable().optional(),
    })
    .refine((data) => Object.keys(data).length > 0, {
        message: 'At least one field is required for update',
    });

// ── Snapshots ───────────────────────────────────────────────────────────

export const snapshotSchema = z
    .object({
        sessionId: z.string().min(1, 'sessionId is required'),
        timestamp: z.string().min(1, 'timestamp is required'),
        forecastTempF: z.number().optional(),
        forecast_temp: z.number().optional(),
        forecastSource: z.string().optional(),
        forecast_source: z.string().optional(),
        forecastChange: z.number().optional(),
        forecast_change: z.number().optional(),
        phase: z.string().optional(),
        daysUntilTarget: z.number().int().optional(),
        days_until_target: z.number().int().optional(),
        target: z.object({ question: z.string(), yesPrice: z.number() }).passthrough().nullable().optional(),
        below: z.object({ question: z.string(), yesPrice: z.number() }).passthrough().nullable().optional(),
        above: z.object({ question: z.string(), yesPrice: z.number() }).passthrough().nullable().optional(),
    })
    .passthrough();

// ── Alerts ───────────────────────────────────────────────────────────────

export const alertSchema = z.object({
    sessionId: z.string().min(1, 'sessionId is required'),
    timestamp: z.string().min(1, 'timestamp is required'),
    type: z.string().min(1, 'type is required'),
    message: z.string().optional(),
    data: z.any().optional(),
});

// ── Spend ───────────────────────────────────────────────────────────────

export const spendSchema = z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD'),
    amount: z.number().positive('amount must be positive'),
    details: z.record(z.unknown()).optional(),
});

// ── Validation Helper ───────────────────────────────────────────────────

/**
 * Validate request body against a zod schema.
 * @param {z.ZodSchema} schema
 * @param {unknown} body
 * @returns {{ data: any, error: string|null }}
 */
export function validate(schema, body) {
    const result = schema.safeParse(body);
    if (result.success) {
        return { data: result.data, error: null };
    }
    const messages = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    return { data: null, error: `Validation failed: ${messages}` };
}
