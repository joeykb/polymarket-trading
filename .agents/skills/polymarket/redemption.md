# Redeeming Positions on Polymarket

> [!CAUTION]
> Neg-risk and standard markets use **completely different** redemption paths. Using the wrong one will either silently no-op ($0 payout) or revert. Read this document carefully before implementing redemption.

## Quick Reference

| Market Type | Contract to Call | Function Signature | Key Difference |
|---|---|---|---|
| Standard | CTF (`0x4D97...6045`) | `redeemPositions(address, bytes32, bytes32, uint256[])` | 4th arg = **indexSets** `[1, 2]` |
| Neg-risk | NegRiskAdapter (`0xd91E...5296`) | `redeemPositions(bytes32, uint256[])` | 2nd arg = **amounts** `[yesAmt, noAmt]` |

## Standard Market Redemption

For markets where `negRisk === false`:

```javascript
// CTF.redeemPositions(collateralToken, parentCollectionId, conditionId, indexSets)
await ctf.redeemPositions(
    '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174', // USDC.e
    ethers.constants.HashZero,                      // parentCollectionId = 0x000...
    conditionId,                                    // from CLOB API market.condition_id
    [1, 2],                                         // indexSets: 1=Yes, 2=No (redeems both, only winner pays)
);
```

- **indexSets `[1, 2]`** means "attempt to redeem both Yes and No positions"
- Burns your **entire** balance automatically — no amount parameter needed
- Only the winning side pays out; losing side burns for $0
- `parentCollectionId` is always `HashZero` for standard markets
- Collateral token is always USDC.e on Polygon

## Neg-Risk Market Redemption

> [!IMPORTANT]
> This is the critical section. Neg-risk markets use the **NegRiskAdapter**, NOT direct CTF calls. The function signature looks similar but the parameters mean completely different things.

### Architecture

The NegRiskAdapter wraps the CTF with an intermediate token called `WrappedCollateral (wcol)`:

```
USDC.e → WrappedCollateral (wcol) → CTF position tokens
```

When you buy via CLOB, the Neg Risk CTF Exchange:
1. Takes your USDC.e
2. Calls `NegRiskAdapter.splitPosition()` which wraps USDC.e into wcol
3. Splits wcol into CTF position tokens via `CTF.splitPosition(wcol, ...)`
4. Transfers CTF position tokens to your wallet (EOA)

The position tokens live on the CTF contract but use **wcol as collateral** (not USDC.e).

### Token ID Computation for Neg-Risk

```
conditionId = keccak256(NegRiskAdapter, questionId, 2)   // oracle = NegRiskAdapter itself
collectionId = getCollectionId(HashZero, conditionId, indexSet)  // 1=Yes, 2=No  
positionId = getPositionId(wcol, collectionId)           // wcol, NOT USDC.e!
```

- **wcol address**: Call `NegRiskAdapter.wcol()` → `0x3A3BD7bb9528E159577F7C2e685CC81A765002E2`
- **oracle**: The NegRiskAdapter itself (`0xd91E...5296`)
- The adapter has a helper: `adapter.getPositionId(questionId, true/false)` returns the positionId

### How NegRiskAdapter.redeemPositions Works

Source: [NegRiskAdapter.sol](https://github.com/Polymarket/neg-risk-ctf-adapter/blob/main/src/NegRiskAdapter.sol)

```solidity
function redeemPositions(bytes32 _conditionId, uint256[] calldata _amounts) public {
    uint256[] memory positionIds = Helpers.positionIds(address(wcol), _conditionId);
    
    // 1. Pulls position tokens FROM msg.sender
    ctf.safeBatchTransferFrom(msg.sender, address(this), positionIds, _amounts, "");
    
    // 2. Redeems via CTF (using wcol as collateral)
    ctf.redeemPositions(address(wcol), bytes32(0), _conditionId, Helpers.partition());
    
    // 3. Unwraps wcol → USDC.e and sends to msg.sender
    uint256 payout = wcol.balanceOf(address(this));
    if (payout > 0) {
        wcol.unwrap(msg.sender, payout);
    }
}
```

### Calling redeemPositions

```javascript
const adapter = new ethers.Contract(NEG_RISK_ADAPTER, [
    'function redeemPositions(bytes32 conditionId, uint256[] amounts)',
], wallet);

// Get the raw token balance (in USDC.e decimals, i.e. 6)
const balance = await ctf.balanceOf(wallet.address, winningTokenId);

// amounts[0] = yes token amount to redeem
// amounts[1] = no token amount to redeem
await adapter.redeemPositions(
    conditionId,
    [balance, 0],   // Redeeming YES tokens only (we won YES)
    gasOverrides,
);
```

> [!WARNING]
> The 2nd parameter is **amounts** (actual token quantities), NOT indexSets!
> - `[5000000, 0]` = "redeem 5.0 yes tokens and 0 no tokens" ✅
> - `[1, 2]` = "redeem 0.000001 yes tokens and 0.000002 no tokens" ❌ (almost zero payout)

### Prerequisites

1. **Market must be resolved** — check via `clobClient.getMarket(conditionId).closed === true`
2. **CTF approval for NegRiskAdapter** — the adapter calls `ctf.safeBatchTransferFrom(msg.sender, ...)`:
   ```javascript
   const isApproved = await ctf.isApprovedForAll(wallet.address, NEG_RISK_ADAPTER);
   if (!isApproved) {
       await ctf.setApprovalForAll(NEG_RISK_ADAPTER, true);
   }
   ```
3. **Must call from the wallet holding the tokens** — the adapter pulls from `msg.sender`
4. **conditionId** — from the CLOB API: `market.condition_id`

## Common Pitfalls

### ❌ Pitfall 1: Calling CTF.redeemPositions for neg-risk tokens

```javascript
// WRONG — for neg-risk, collateral is wcol not USDC.e, so this targets wrong positions
ctf.redeemPositions(USDC_E, HashZero, conditionId, [1, 2]);
```

This will succeed (not revert) but produce a **$0 payout** because there are no positions backed by USDC.e with `parentCollectionId = HashZero` for this conditionId. The actual positions use wcol as collateral.

### ❌ Pitfall 2: Passing indexSets instead of amounts to NegRiskAdapter

```javascript
// WRONG — [1, 2] means "1 unit of yes, 2 units of no" (0.000003 USDC.e total)
adapter.redeemPositions(conditionId, [1, 2]);
```

The CTF's `redeemPositions` uses indexSets. The NegRiskAdapter's `redeemPositions` uses amounts. They have the same function name but different semantics.

### ❌ Pitfall 3: Using the Relayer/Safe wallet when tokens are on EOA

```javascript
// WRONG — tokens are on the EOA, not the Safe wallet
relayClient.execute([{ to: NEG_RISK_ADAPTER, data: encodedRedeemCall }]);
```

The relayer executes from your Safe wallet (`proxyWallet`). If you bought via CLOB with signature type 0 (EOA), the tokens are on the EOA. The adapter does `ctf.safeBatchTransferFrom(msg.sender=Safe, ...)` which fails because the Safe has no tokens.

### ❌ Pitfall 4: Computing parentCollectionId from neg_risk_market_id

```javascript
// WRONG — this computes a nested parentCollectionId but targets the wrong position layer
const parent = await ctf.getCollectionId(HashZero, negRiskMarketId, 1);
ctf.redeemPositions(USDC_E, parent, conditionId, [1, 2]);
```

This passes gas estimation but still pays $0 because it's targeting USDC.e-backed positions that don't exist at this collection path.

## Complete Working Implementation

See [redeem.js](../../src/scripts/redeem.js) for the full implementation. Key logic:

```javascript
if (negRisk) {
    // 1. Get raw balance of winning token
    const yesBalance = await ctf.balanceOf(wallet.address, winningTokenId);
    
    // 2. Ensure CTF approval for adapter
    const approved = await ctf.isApprovedForAll(wallet.address, NEG_RISK_ADAPTER);
    if (!approved) await ctf.setApprovalForAll(NEG_RISK_ADAPTER, true);
    
    // 3. Call adapter with AMOUNTS (not indexSets)
    const tx = await adapter.redeemPositions(conditionId, [yesBalance, 0]);
    await tx.wait();
} else {
    // Standard market — use CTF directly with indexSets
    const tx = await ctf.redeemPositions(USDC_E, HashZero, conditionId, [1, 2]);
    await tx.wait();
}
```

## Checking Resolution Status

```javascript
const market = await clobClient.getMarket(conditionId);
const resolved = market.closed === true;
const negRisk = market.neg_risk === true;
const winningToken = market.tokens?.find(t => t.winner === true);
const winner = winningToken?.outcome?.toUpperCase(); // "YES" or "NO"
const winnerTokenId = winningToken?.token_id;
```

## Contract Addresses (Polygon)

| Contract | Address |
|---|---|
| CTF | `0x4D97DCd97eC945f40cF65F87097ACe5EA0476045` |
| NegRiskAdapter | `0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296` |
| WrappedCollateral (wcol) | `0x3A3BD7bb9528E159577F7C2e685CC81A765002E2` |
| USDC.e | `0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174` |
| Neg Risk CTF Exchange | `0xC5d563A36AE78145C45a50134d48A1215220f80a` |

## Gas Estimates

| Operation | Typical Gas |
|---|---|
| NegRiskAdapter.redeemPositions (5 shares) | ~180,000 - 200,000 |
| CTF.redeemPositions (standard) | ~60,000 - 80,000 |
| CTF.setApprovalForAll | ~46,000 |

## Debugging Checklist

If redemption fails or pays $0:

1. **Check `negRisk` flag** — are you using the right contract?
2. **Check token balance** — `ctf.balanceOf(wallet, tokenId)` > 0?
3. **Check you're calling from the right wallet** — tokens on EOA vs Safe?
4. **For NegRiskAdapter** — are you passing amounts or indexSets?
5. **Check CTF approval** — `ctf.isApprovedForAll(wallet, NEG_RISK_ADAPTER)` === true?
6. **Check resolution** — `clobClient.getMarket(conditionId).closed` === true?
7. **Verify on Polygonscan** — look for `PayoutRedemption` event with payout > 0
