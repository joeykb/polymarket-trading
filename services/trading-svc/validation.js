/**
 * Trading Service — Request Body Validation
 *
 * Lightweight schema validation for POST endpoints.
 * Prevents malformed/malicious payloads from reaching trading logic.
 *
 * Each validator returns { valid: true, data } or { valid: false, error }.
 */

/**
 * Validate /api/buy request body.
 * Required: snapshot object with at least a target range.
 */
export function validateBuyRequest(body) {
    if (!body || typeof body !== 'object') {
        return { valid: false, error: 'Request body must be a JSON object' };
    }

    const { snapshot, liqTokens, context } = body;

    if (!snapshot || typeof snapshot !== 'object') {
        return { valid: false, error: 'snapshot is required and must be an object' };
    }

    // Snapshot must have at least a target range
    if (!snapshot.target || typeof snapshot.target !== 'object') {
        return { valid: false, error: 'snapshot.target is required' };
    }

    if (liqTokens !== undefined && !Array.isArray(liqTokens)) {
        return { valid: false, error: 'liqTokens must be an array' };
    }

    if (context !== undefined && typeof context !== 'object') {
        return { valid: false, error: 'context must be an object' };
    }

    return { valid: true, data: { snapshot, liqTokens: liqTokens || [], context: context || {} } };
}

/**
 * Validate /api/sell request body.
 * Required: positions array with at least one entry.
 */
export function validateSellRequest(body) {
    if (!body || typeof body !== 'object') {
        return { valid: false, error: 'Request body must be a JSON object' };
    }

    const { positions, context } = body;

    if (!Array.isArray(positions) || positions.length === 0) {
        return { valid: false, error: 'positions must be a non-empty array' };
    }

    for (let i = 0; i < positions.length; i++) {
        const p = positions[i];
        if (!p || typeof p !== 'object') {
            return { valid: false, error: `positions[${i}] must be an object` };
        }
        if (!p.clobTokenId && !p.clobTokenIds) {
            return { valid: false, error: `positions[${i}] must have clobTokenId or clobTokenIds` };
        }
    }

    if (context !== undefined && typeof context !== 'object') {
        return { valid: false, error: 'context must be an object' };
    }

    return { valid: true, data: { positions, context: context || {} } };
}

/**
 * Validate /api/retry request body.
 * Required: position object with clobTokenIds.
 */
export function validateRetryRequest(body) {
    if (!body || typeof body !== 'object') {
        return { valid: false, error: 'Request body must be a JSON object' };
    }

    const { position, liqTokenData } = body;

    if (!position || typeof position !== 'object') {
        return { valid: false, error: 'position is required and must be an object' };
    }

    if (!position.clobTokenIds && !position.clobTokenId) {
        return { valid: false, error: 'position must have clobTokenIds or clobTokenId' };
    }

    return { valid: true, data: { position, liqTokenData: liqTokenData || null } };
}

/**
 * Validate /api/redeem request body.
 * Required: session object with buyOrder.positions.
 */
export function validateRedeemRequest(body) {
    if (!body || typeof body !== 'object') {
        return { valid: false, error: 'Request body must be a JSON object' };
    }

    const { session } = body;

    if (!session || typeof session !== 'object') {
        return { valid: false, error: 'session is required and must be an object' };
    }

    return { valid: true, data: { session } };
}
