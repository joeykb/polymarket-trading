/**
 * Patch: Make CLOB resolution check resilient in redeem.js
 * Run: node scripts/patch-redeem.js
 */
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'services', 'trading-svc', 'redeem.js');
let content = fs.readFileSync(file, 'utf8');

// Normalize line endings for consistent matching
const eol = content.includes('\r\n') ? '\r\n' : '\n';
const normalized = content.replace(/\r\n/g, '\n');

// Find and replace the resolution check block
const oldBlock = `            // Check resolution first
            const resolution = await checkMarketResolution(conditionId);
            if (!resolution.resolved) {`;

const newBlock = `            // Check resolution via CLOB — don't let CLOB failures block redemption
            let resolution = { resolved: false };
            try {
                resolution = await checkMarketResolution(conditionId);
            } catch (clobErr) {
                log.warn('clob_resolution_failed', { conditionId: conditionId.slice(0, 10), error: clobErr.message });
                const targetDate = session.targetDate;
                const isExpired = targetDate && new Date(targetDate + 'T23:59:59-05:00') < new Date();
                if (isExpired) {
                    log.info('redeem_past_date', { targetDate, action: 'proceeding_on_chain' });
                    resolution = { resolved: true, outcome: null, clobFailed: true };
                } else {
                    results.push({ label: pos0.label, question: pos0.question, status: 'clob_error', conditionId, error: clobErr.message });
                    continue;
                }
            }
            if (!resolution.resolved) {`;

if (!normalized.includes(oldBlock)) {
    console.log('ERROR: Target block not found. File may already be patched.');
    process.exit(1);
}

const patched = normalized.replace(oldBlock, newBlock);

// Restore original line endings
const final = eol === '\r\n' ? patched.replace(/\n/g, '\r\n') : patched;
fs.writeFileSync(file, final);
console.log('✅ Patched redeem.js — CLOB resolution check is now resilient');
