# ADR-002 — `reinforce()` computes the liquidity delta caller-side, and is a slippage-bearing transaction

**Status:** accepted. Unblocks P4.
**Supersedes:** `Implementation Architecture v0.1` §7.5 and the "leaves the
remainder in reserve" claim in §5.3. Marks assumption **V14 resolved-negative**.
**Raised by:** `docs/REVIEW.md` §2.1.

## The finding that forces this

The architecture document assumed `increaseLiquidity` could be handed unbalanced
maxima and would take what it could, returning the remainder. It cannot. From the
deployed source (`v4-periphery` at the pinned commit `3c31961fb9`, which is
byte-for-byte the `PositionManager` on 4663):

- `INCREASE_LIQUIDITY` takes `(tokenId, liquidity, amount0Max, amount1Max,
  hookData)`. **The caller specifies the liquidity delta.**
- `amount0Max` / `amount1Max` are slippage caps, enforced by
  `validateMaxIn(...)`. They **revert**; they do not truncate, and they do not
  cause a partial fill.
- The action that would have matched the original assumption,
  `INCREASE_LIQUIDITY_FROM_DELTAS`, carries the comment
  *"DEPRECATED - vulnerable to sandwich attacks, do not use"*.

So there is no partial fill and no automatic remainder anywhere in the API. V14 is
false.

## Decision

The locker computes the delta itself:

1. Read spot `sqrtPriceX96` from `StateView`, and use the position's
   `tickLower` / `tickUpper` **as stored at registration**. They are immutable —
   do not re-read them per call. A per-call read is both a wasted SLOAD and a
   trust boundary we do not need to open.
2. ```solidity
   liquidity = LiquidityAmounts.getLiquidityForAmounts(
       sqrtPriceX96, sqrtPriceAtTick(lower), sqrtPriceAtTick(upper),
       reserve0, reserve1
   );
   ```
3. Call `increaseLiquidity` with `amount0Max = reserve0`, `amount1Max = reserve1`
   — subject to the rounding caveat below.
4. Measure actual consumption by balance delta and return the remainder to the
   splitter's reserve.
5. `require(liquidity >= minLiquidityOut)`.

**Interface:** `reinforce(poolId, minLiquidityOut, sqrtPriceLower, sqrtPriceUpper)`.
It takes price bounds because it is a transaction with slippage. Treating it as
anything else is the mistake this ADR corrects.

## Security correction — this function has price exposure

The architecture document claims `reinforce()` involves "no swap, no oracle, no
slippage beyond a minimum-liquidity check". **That is wrong and must be corrected
in the document.** Step 2 reads spot price, so the *ratio* at which the reserve
deploys is price-sensitive even though no swap occurs.

The attack: push spot to an extreme, trigger `reinforce`, and the reserve deploys
one-sided at a ratio nobody would have chosen. Reading the deployed
`getLiquidityForAmounts` (`src/libraries/LiquidityAmounts.sol` lines 55–76) makes
the severity precise, because it has three branches and only one of them is the
"min of two" case people quote:

| spot vs range | line | behaviour |
|---|---|---|
| `spot <= lower` | 67 | liquidity from **`amount0` only** — `reserve1` contributes nothing |
| `lower < spot < upper` | 69–72 | `min(liquidity0, liquidity1)` — the balanced case |
| `spot >= upper` | 74 | liquidity from **`amount1` only** — `reserve0` contributes nothing |

So at an extreme the function does not merely deploy at a poor ratio; one entire
side of the reserve is left undeployed while the other is consumed. The exposure
is bounded — by the reserve size, and by the fees the attacker pays to move price
and move it back — but it is real, it is reachable by anyone, and `reinforce` is
permissionless and keeper-driven, which is precisely the combination that makes it
worth attacking.

Mitigation is the interface change above: the caller passes the price band it
expects, and the locker reverts outside it. A keeper that submits a wide band is
making a choice we can see, rather than one the protocol made for it silently.

`minLiquidityOut` must not be derived from the same spot price read inside the
same call — that is circular and would authorise whatever price it found. It has
to come from the caller, computed off-chain against an earlier observation, which
is what makes it a slippage parameter rather than a formality.

## The rounding caveat — `amount0Max = reserve0` can revert by one wei

`getLiquidityForAmounts` **floors** (it is built on `FullMath.mulDiv`), while v4
computes the amounts *owed* for a liquidity increase with **`roundUp = true`**
(`v4-core/src/libraries/SqrtPriceMath.sol` lines 269 and 286: for
`liquidity > 0`, both `getAmount0Delta` and `getAmount1Delta` are called with
`roundUp` set). Floor on the way in and ceiling on the way out means the required
amount can exceed the reserve by 1 wei per side.

So "the required amounts are `<=` reserves by construction, and the call cannot
revert on slippage" is *almost* true and not reliably true. P4 must handle it
deliberately, and the options are:

- reduce the computed `liquidity` by one before calling, giving up a dust amount
  of depth in exchange for a call that cannot fail this way; or
- confirm with `getAmountsForLiquidity` (rounding up) before calling, and reduce
  `liquidity` only when it actually would not fit.

The second is exact and costs one more computation; the first is one line. Either
is acceptable, and both must be covered by a test that constructs the off-by-one
case rather than hoping fuzzing finds it. `SafeCast.toUint128` inside
`getLiquidityForAmount0/1` is a second, separate revert path for absurd
reserve-to-range ratios, and is acceptable — it is a bound on nonsense inputs, not
on realistic ones.

## Documented fallback — `PoolManager.donate()`, not the primary path

`donate()` takes exact amounts. No ratio math, no price read, therefore no
price-manipulation surface at all. It is recorded here as the fallback rather than
the primary because it has two real costs:

1. **It reverts when the pool has no in-range liquidity.** That is not a rare
   edge: a Bootstrap market's token-only position sits *above* spot and is
   therefore out of range by design. Exactly the markets most likely to want
   reinforcement are the ones where `donate` fails.
2. **It is fee growth, not depth.** It pays existing LPs rather than deepening the
   book. The public claim would have to weaken from "strengthens liquidity" to
   "returns value to LPs" — which is honest, but it is a different product
   statement and must not be made accidentally.

## Consequences

- [ ] §7.5 rewritten: caller-supplied liquidity, no partial fill, remainder
      returns by unspent credit rather than by the API leaving it behind.
- [ ] §5.3's "no slippage" claim corrected to state the spot-price dependence.
- [ ] `reinforce` signature gains `sqrtPriceLower` / `sqrtPriceUpper`.
- [ ] P4 delivers a written sandwich analysis before the implementation, including
      the one-sided-deployment case at each of the three branches above.
- [ ] P4 tests the 1-wei rounding boundary explicitly.
- [ ] `tickLower` / `tickUpper` stored at registration and treated as immutable.
- [ ] The SDK's keeper helper computes `minLiquidityOut` and the price band from an
      observation *before* the transaction, never from inside it.

## Alternatives rejected

**`INCREASE_LIQUIDITY_FROM_DELTAS`.** It is the action that matches the original
design, and upstream has marked it deprecated and sandwich-vulnerable. Using an
action whose own authors documented it as unsafe would need an argument far
stronger than convenience.

**Make `donate()` the primary path.** Tempting, because it removes the price
exposure entirely. Rejected because it fails precisely for Bootstrap markets, and
because it changes what reinforcement *is* — LP revenue rather than depth. Kept as
a documented fallback for the cases where it is the better answer.

**Permissioned keeper.** Would reduce the attack surface by restricting who can
trigger deployment at a bad price. Rejected because it introduces a privileged
role into a system whose disclosure position is that no privileged role can reach
a live market (§6.2, D5) — the same reasoning as ADR-003. A slippage parameter
achieves the protection without the role.
