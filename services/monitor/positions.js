/**
 * TempEdge Monitor — Position Utility Functions
 *
 * Extracted from orchestrator.js to eliminate 4× duplication of tokenId
 * resolution and 3× duplication of sellable-position collection.
 */

// ── Token ID Resolution ─────────────────────────────────────────────────

/**
 * Resolve the CLOB token ID for a position.
 *
 * Searches (in order):
 *   1. Direct fields: clobTokenId, clobTokenIds[0], tokenId
 *   2. Snapshot ranges: matches by question to find clobTokenIds
 *
 * Mutates the position in-place if a match is found in the snapshot.
 *
 * @param {Object} position - Position with question, clobTokenId, clobTokenIds, tokenId
 * @param {Object} snapshot - Current snapshot with target/below/above ranges
 * @returns {string|null} - Resolved token ID, or null if not found
 */
export function resolveTokenId(position, snapshot) {
    let tokenId = position.clobTokenId || position.clobTokenIds?.[0] || position.tokenId;
    if (!tokenId && snapshot) {
        for (const key of ['target', 'below', 'above']) {
            const range = snapshot[key];
            if (range && range.question === position.question && range.clobTokenIds?.[0]) {
                tokenId = range.clobTokenIds[0];
                position.clobTokenIds = range.clobTokenIds;
                position.tokenId = tokenId;
                break;
            }
        }
    }
    return tokenId || null;
}

// ── Sellable Position Collection ─────────────────────────────────────────

/**
 * Collect positions from a buy order that are eligible for selling.
 *
 * Filters out:
 *   - Failed/rejected positions
 *   - Already-sold positions
 *   - Positions that fail the optional filterFn predicate
 *
 * Resolves tokenIds using the current snapshot.
 *
 * @param {Object} session - Session with buyOrder.positions[]
 * @param {Object} snapshot - Current snapshot for tokenId resolution
 * @param {Function} [filterFn] - Optional predicate: (position) => boolean.
 *   Return true to INCLUDE the position. Defaults to include all.
 * @returns {Array<Object>} - Array of { label, question, clobTokenId, conditionId, shares }
 */
export function collectSellablePositions(session, snapshot, filterFn = () => true) {
    if (!session.buyOrder?.positions) return [];

    const result = [];
    for (const pos of session.buyOrder.positions) {
        if (pos.status === 'failed' || pos.status === 'rejected') continue;
        if (pos.soldAt) continue;
        if (!filterFn(pos)) continue;

        const tokenId = resolveTokenId(pos, snapshot);

        result.push({
            label: pos.label,
            question: pos.question,
            clobTokenId: tokenId,
            conditionId: pos.conditionId,
            shares: pos.shares || 1,
        });
    }

    return result;
}
