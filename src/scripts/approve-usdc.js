/**
 * One-time setup: Approve USDC for Polymarket exchange contracts
 * 
 * Must be run ONCE before placing any orders via CLOB API.
 * This sends on-chain transactions on Polygon to approve USDC spending.
 * 
 * Usage: node src/scripts/approve-usdc.js
 */

import { ethers } from 'ethers';
import { config as dotenvConfig } from 'dotenv';
dotenvConfig();

const POLYGON_RPC = process.env.POLYGON_RPC_URL || 'https://polygon.drpc.org';

// Polymarket contracts on Polygon
const USDC_ADDRESS = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359'; // Native USDC on Polygon
const USDC_E_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174'; // USDC.e (bridged) — approve both
const CTF_EXCHANGE = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E';
const NEG_RISK_CTF_EXCHANGE = '0xC5d563A36AE78145C45a50134d48A1215220f80a';
const NEG_RISK_ADAPTER = '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296';
const CTF_CONTRACT = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';

// ERC20 approve ABI
const ERC20_ABI = [
    'function approve(address spender, uint256 amount) returns (bool)',
    'function allowance(address owner, address spender) view returns (uint256)',
    'function balanceOf(address owner) view returns (uint256)',
    'function decimals() view returns (uint8)',
];

// CTF setApprovalForAll ABI
const CTF_ABI = [
    'function setApprovalForAll(address operator, bool approved)',
    'function isApprovedForAll(address owner, address operator) view returns (bool)',
];

const MAX_UINT256 = ethers.constants.MaxUint256;

// Gas overrides needed for free RPCs through VPN
const GAS_OVERRIDES = {
    gasLimit: 100000,
    maxFeePerGas: ethers.utils.parseUnits('200', 'gwei'),
    maxPriorityFeePerGas: ethers.utils.parseUnits('30', 'gwei'),
};

async function main() {
    const privateKey = process.env.POLYMARKET_PRIVATE_KEY;
    if (!privateKey) {
        console.error('POLYMARKET_PRIVATE_KEY not set');
        process.exit(1);
    }

    // Use StaticJsonRpcProvider to skip auto chain detection (works better through VPN)
    const provider = new ethers.providers.StaticJsonRpcProvider(POLYGON_RPC, 137);
    const wallet = new ethers.Wallet(privateKey, provider);
    console.log(`\nWallet: ${wallet.address}`);

    // Check MATIC balance for gas
    const maticBal = await provider.getBalance(wallet.address);
    console.log(`MATIC balance: ${ethers.utils.formatEther(maticBal)}`);
    if (maticBal.lt(ethers.utils.parseEther('0.01'))) {
        console.error('⚠️  Low MATIC — need at least 0.01 MATIC for gas fees');
        console.error('   Send some MATIC to your wallet on Polygon');
        process.exit(1);
    }

    // Check balances for both USDC variants
    const usdc = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, wallet);
    const usdcE = new ethers.Contract(USDC_E_ADDRESS, ERC20_ABI, wallet);
    const decimalsNative = await usdc.decimals();
    const decimalsE = await usdcE.decimals();
    const balNative = await usdc.balanceOf(wallet.address);
    const balE = await usdcE.balanceOf(wallet.address);
    console.log(`USDC (native) balance: $${ethers.utils.formatUnits(balNative, decimalsNative)}`);
    console.log(`USDC.e (bridged) balance: $${ethers.utils.formatUnits(balE, decimalsE)}`);

    // Approve BOTH USDC variants for all three exchange contracts
    const spenders = [
        { name: 'CTF Exchange', address: CTF_EXCHANGE },
        { name: 'Neg Risk CTF Exchange', address: NEG_RISK_CTF_EXCHANGE },
        { name: 'Neg Risk Adapter', address: NEG_RISK_ADAPTER },
    ];

    const tokens = [
        { name: 'USDC', contract: usdc, decimals: decimalsNative },
        { name: 'USDC.e', contract: usdcE, decimals: decimalsE },
    ];

    for (const token of tokens) {
        console.log(`\n--- Approving ${token.name} ---`);
        for (const { name, address } of spenders) {
            const current = await token.contract.allowance(wallet.address, address);
            if (current.gt(0)) {
                console.log(`✅ ${name}: already approved`);
                continue;
            }
            console.log(`🔐 Approving ${name} for ${token.name}...`);
            const tx = await token.contract.approve(address, MAX_UINT256, GAS_OVERRIDES);
            console.log(`   TX: ${tx.hash}`);
            await tx.wait();
            console.log(`   ✅ Approved`);
        }
    }

    // Approve CTF (Conditional Token Framework) for exchanges
    const ctf = new ethers.Contract(CTF_CONTRACT, CTF_ABI, wallet);
    const ctfSpenders = [
        { name: 'CTF Exchange (CTF)', address: CTF_EXCHANGE },
        { name: 'Neg Risk CTF Exchange (CTF)', address: NEG_RISK_CTF_EXCHANGE },
    ];

    for (const { name, address } of ctfSpenders) {
        const approved = await ctf.isApprovedForAll(wallet.address, address);
        if (approved) {
            console.log(`✅ ${name}: already approved`);
            continue;
        }
        console.log(`🔐 Approving ${name}...`);
        const tx = await ctf.setApprovalForAll(address, true, GAS_OVERRIDES);
        console.log(`   TX: ${tx.hash}`);
        await tx.wait();
        console.log(`   ✅ Approved`);
    }

    console.log('\n✅ All approvals complete! You can now place orders via CLOB API.');
}

main().catch((err) => {
    console.error('Fatal:', err.message);
    process.exit(1);
});
