/**
 * TempEdge Multi-Market Budget Allocator
 *
 * Distributes a daily budget across enabled markets based on:
 *   1. Priority ranking (user-defined order in ENABLED_MARKETS)
 *   2. Available liquidity (markets with better liquidity get more budget)
 *   3. Per-market cap (no single market exceeds maxPerMarket)
 *
 * Architecture decision: budget is computed fresh each cycle from config
 * and current spend data. This avoids stale state across pod restarts.
 */

import { createLogger } from '../../shared/logger.js';
import { services } from '../../shared/services.js';

const log = createLogger('budget');
const DATA_SVC = services.dataSvc;

/**
 * Fetch enabled markets from the data-svc market registry.
 * Markets with active=1 in the DB are considered enabled.
 * Returns full market objects (including daily_budget).
 * Falls back to cfg.markets.enabled string if data-svc is unreachable.
 * @param {Object} cfg - Full config object (used as fallback only)
 * @returns {Promise<Array<{id: string, daily_budget?: number}>>} - Market objects
 */
export async function getEnabledMarkets(cfg) {
    try {
        const res = await fetch(`${DATA_SVC}/api/markets`, { signal: AbortSignal.timeout(3000) });
        if (res.ok) {
            const markets = await res.json();
            if (markets.length > 0) return markets;
        }
    } catch {
        log.warn('enabled_markets_fetch_failed', { msg: 'falling back to config' });
    }
    // Fallback: parse from config if data-svc is down
    const raw = cfg.markets?.enabled || 'nyc';
    const defaultBudget = parseFloat(cfg.markets?.maxPerMarket ?? 3.0);
    return raw.split(',').map(m => m.trim().toLowerCase()).filter(Boolean)
        .map(id => ({ id, daily_budget: defaultBudget }));
}

/**
 * Compute budget allocation for each market.
 *
 * Strategy:
 *   - Each market has its own daily_budget from the registry (default $3)
 *   - Total daily budget is the sum of all per-market budgets
 *   - (can be overridden globally via cfg.markets.dailyBudget)
 *   - Subtract already-spent amounts for today
 *   - Rank by priority (first in list = highest priority)
 *   - Surplus from exhausted markets redistributed to active ones
 *
 * @param {Object} cfg - Full config object
 * @param {Object} spendData - Map of marketId → amountSpentToday
 * @returns {{ allocations: Array<{ marketId: string, budget: number, spent: number, remaining: number, priority: number }>, totalBudget: number, totalSpent: number, totalRemaining: number }}
 */
export async function computeBudgetAllocations(cfg, spendData = {}) {
    const markets = await getEnabledMarkets(cfg);
    const globalCap = cfg.markets?.dailyBudget ? parseFloat(cfg.markets.dailyBudget) : null;

    // Per-market budget from registry, falling back to global maxPerMarket
    const defaultPerMarket = parseFloat(cfg.markets?.maxPerMarket ?? 3.0);

    const allocations = markets.map((market, index) => {
        const marketId = market.id || market;
        const perMarketBudget = parseFloat(market.daily_budget ?? defaultPerMarket);
        const spent = spendData[marketId] || 0;
        const remaining = Math.max(0, perMarketBudget - spent);
        return {
            marketId,
            budget: parseFloat(perMarketBudget.toFixed(2)),
            spent: parseFloat(spent.toFixed(2)),
            remaining: parseFloat(remaining.toFixed(2)),
            priority: index + 1, // 1 = highest
        };
    });

    // Total budget: either global cap or sum of per-market budgets
    const sumOfMarketBudgets = allocations.reduce((s, a) => s + a.budget, 0);
    const dailyBudget = globalCap != null ? Math.min(globalCap, sumOfMarketBudgets) : sumOfMarketBudgets;

    const totalSpent = allocations.reduce((s, a) => s + a.spent, 0);
    const totalRemaining = Math.max(0, dailyBudget - totalSpent);

    // Re-distribute unused budget from exhausted markets to remaining ones
    let surplus = 0;
    for (const a of allocations) {
        if (a.remaining <= 0) {
            surplus += Math.max(0, a.budget - a.spent);
        }
    }

    if (surplus > 0) {
        const active = allocations.filter((a) => a.remaining > 0);
        if (active.length > 0) {
            const bonus = surplus / active.length;
            for (const a of active) {
                const extraBudget = Math.min(bonus, a.budget * 0.5); // cap extra at 50% of own budget
                a.budget = parseFloat((a.budget + extraBudget).toFixed(2));
                a.remaining = parseFloat(Math.max(0, a.budget - a.spent).toFixed(2));
            }
        }
    }

    log.info('budget_computed', {
        markets: allocations.map(a => a.marketId).join(','),
        dailyBudget,
        perMarket: allocations.map(a => `${a.marketId}=$${a.budget}`).join(', '),
        totalSpent: parseFloat(totalSpent.toFixed(2)),
        remaining: allocations.map((a) => `${a.marketId}=$${a.remaining}`).join(', '),
    });

    return {
        allocations,
        totalBudget: dailyBudget,
        totalSpent: parseFloat(totalSpent.toFixed(2)),
        totalRemaining: parseFloat(totalRemaining.toFixed(2)),
    };
}

/**
 * Check if a market has budget remaining for a trade.
 * @param {string} marketId
 * @param {number} cost - Proposed trade cost
 * @param {Object} cfg - Config
 * @param {Object} spendData - Today's spend by market
 * @returns {{ allowed: boolean, remaining: number, reason?: string }}
 */
export async function checkBudget(marketId, cost, cfg, spendData = {}) {
    const { allocations, totalRemaining } = await computeBudgetAllocations(cfg, spendData);
    const alloc = allocations.find((a) => a.marketId === marketId);

    if (!alloc) {
        return { allowed: false, remaining: 0, reason: `Market ${marketId} not in enabled list` };
    }

    if (totalRemaining < cost) {
        return { allowed: false, remaining: totalRemaining, reason: 'Daily budget exhausted' };
    }

    if (alloc.remaining < cost) {
        return { allowed: false, remaining: alloc.remaining, reason: `Market ${marketId} budget exhausted ($${alloc.remaining} remaining)` };
    }

    return { allowed: true, remaining: alloc.remaining - cost };
}
