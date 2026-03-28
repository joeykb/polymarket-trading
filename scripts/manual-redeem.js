/**
 * Manual Redeem — targeted dates only
 */

const DATA_SVC = process.env.DATA_SVC_URL || 'http://data-svc:3005';
const TRADING_SVC = process.env.TRADING_SVC_URL || 'http://trading-svc:3004';
const SERVICE_KEY = process.env.SERVICE_AUTH_KEY || '';

// Only redeem these specific dates
const TARGET_DATES = ['2026-03-24', '2026-03-25'];

async function apiGet(base, path) {
    const res = await fetch(`${base}${path}`, {
        headers: { 'x-service-key': SERVICE_KEY },
    });
    if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
    return res.json();
}

async function apiPost(base, path, body) {
    const res = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-service-key': SERVICE_KEY,
        },
        body: JSON.stringify(body),
    });
    const text = await res.text();
    console.log(`   HTTP ${res.status}: ${text.slice(0, 500)}`);
    if (!res.ok) throw new Error(`POST ${path} → ${res.status}: ${text.slice(0, 200)}`);
    return JSON.parse(text);
}

async function main() {
    for (const date of TARGET_DATES) {
        console.log(`\n📅 ${date}:`);
        const session = await apiGet(DATA_SVC, `/api/session-files/${date}`);

        console.log(`   Status: ${session.status}`);
        console.log(`   redeemExecuted: ${session.redeemExecuted}`);
        console.log(`   Positions: ${session.buyOrder?.positions?.length || 0}`);

        if (!session.buyOrder?.positions?.length) {
            console.log('   ⏭️  No positions');
            continue;
        }

        for (const p of session.buyOrder.positions) {
            console.log(`   📦 ${p.label}: ${p.shares} shares, buyPrice=${p.buyPrice}, sold=${!!p.soldAt}, tokenId=${p.tokenId?.slice(0,15)}...`);
        }

        const unsold = session.buyOrder.positions.filter(p => !p.soldAt);
        if (unsold.length === 0) {
            console.log('   All sold — nothing to redeem');
            continue;
        }

        console.log(`\n   🎯 Calling trading-svc /api/redeem...`);
        try {
            const result = await apiPost(TRADING_SVC, '/api/redeem', { session });

            if (result && !result.error && result.success !== false) {
                session.redeemExecuted = true;
                session.redeemResult = result;
                session.status = 'completed';
                await fetch(`${DATA_SVC}/api/session-files/${date}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json', 'x-service-key': SERVICE_KEY },
                    body: JSON.stringify(session),
                });
                console.log(`   💾 Session updated — redeemed!`);
            }
        } catch (err) {
            console.error(`   ❌ ${err.message}`);
        }

        // Wait 15s between redeems to avoid rate limiting
        if (TARGET_DATES.indexOf(date) < TARGET_DATES.length - 1) {
            console.log('   ⏳ Waiting 15s to avoid rate limit...');
            await new Promise(r => setTimeout(r, 15000));
        }
    }
    console.log('\n✅ Done');
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
