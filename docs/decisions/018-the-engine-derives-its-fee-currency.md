# ADR-018 — A programmable market's fee currency is derived, not chosen

Status: **accepted.** Confirmed against a real PoolManager before acceptance:
`EngineHook.swaps.t.sol` exercises all four swap shapes in both currency
orientations, and the derived fee is collected correctly in every one. Extends
ADR-008 (a market's quote asset is a parameter) and sits beside the reasoning in
`InstantHook`'s header about being paid in ether.

This is the one decision in the deterministic engine that changes something a
creator can see, and it was forced by a constraint rather than preferred — so the
argument is recorded in full rather than summarised.

## Decision

`AgenMarketSpec` does not say which asset a market's fees are collected in. The
compiler derives it:

| The market has | Fees are collected in |
| --- | --- |
| no size tiers | the **quote asset** — ether, or the equity token the pool is quoted against |
| any size tier | the **launched token** |

It is deterministic, it is fixed at launch, it is inside `implementationHash`, and
the review card states it in words rather than leaving it to be discovered.

## Why it cannot simply always be the quote asset

Because of how v4 lets a hook move value, and it is worth writing the table out.

A hook gets two chances to take a fee and each can only move one currency:
`beforeSwap`'s `BeforeSwapDelta` lands on the swap's **specified** currency, and
`afterSwap`'s returned `int128` lands on the **unspecified** one. Which is which
follows from `(amountSpecified < 0) == zeroForOne`, the same test `Hooks.afterSwap`
uses to place a delta.

A size tier is measured on the **token** leg. "A sell of at least 1% of total
supply" is a statement about tokens and means something entirely different measured
in ether. So for a tier to be applicable at the moment a fee is charged, the leg the
fee comes out of has to be knowable at the same time as the token leg.

With the fee on the quote leg, two of the four swap shapes cannot satisfy that:

| side | kind | quote is | charged in | token leg known there? |
| --- | --- | --- | --- | --- |
| buy | exact input | specified | `beforeSwap` | **no** |
| buy | exact output | unspecified | `afterSwap` | yes |
| sell | exact input | unspecified | `afterSwap` | yes |
| sell | exact output | specified | `beforeSwap` | **no** |

An exact-input buy — the ordinary way anybody buys anything — and an exact-output
sell would both have to charge before the pool has computed the token amount. No
tier could be applied to either.

With the fee on the token leg, all four work, because the fee leg and the tier leg
are the same leg: whichever callback can settle it also knows the amount.

## What was rejected

**Revert the two shapes that cannot see the token leg.** Honest, and the old
`core-tests.ts` already accepted reverting as an outcome for exact-output sells. But
it removes exact-input buying from any market with a buy tier, which is most of what
a trader does.

**Infer the token amount from the pool price in `beforeSwap`.** Abandons exactness
for the one number the market is built on. The whole engine exists to stop
approximating economics.

**Charge a worst-case rate and refund the difference in `afterSwap`.** The refund
lands on the unspecified currency, which is the other leg — so a trader
overcharged in ether is refunded in tokens.

**Let the creator choose.** It is not a free choice. Choosing the quote asset for a
tier-bearing market is choosing a market that cannot apply its own tiers to half its
trades, and presenting that as an option is presenting a broken configuration as a
preference.

**Mix legs per side.** Coherent, and it makes the vault hold two assets and the
distribution pay out in two, which turns "80% to the creator" into two numbers in two
currencies.

## The cost, stated plainly

A creator whose market charges more on large sells is paid in their own token rather
than in ether. That is a real difference from what `InstantHook`'s header argues for,
and the argument there still holds on its own terms: being paid in the thing you were
trying to sell is worse than being paid in ether.

What changed is the alternative. `InstantHook` charges a flat rate, so nothing about
its fee depends on the token leg and it can always take ether. A market whose rate
depends on trade size does not have that option, and the choice is not between ether
and tokens — it is between tokens and a market whose size rules silently do not apply
to ordinary trades.

A market with no size tiers is unaffected and still collects in the quote asset,
which is most markets.

## What would change this

A second hook permission set that reads the token leg in `beforeSwap` without
settling there, or a v4 change letting a hook settle an unspecified currency early,
would remove the constraint. Either is a new engine version rather than a change to
this one: `engineVersion` exists so a market already launched is never reinterpreted
under rules written after it.

## Under a native ETH quote

The derivation does not consult what kind of asset the quote is, so a native quote changes
nothing about it. Spelled out because it is easy to state backwards:

| market | fee collected in |
| --- | --- |
| native ETH quote, flat | native ETH |
| native ETH quote, time ladder | native ETH |
| native ETH quote, quote-volume ladder | native ETH |
| native ETH quote, launched-token size tiers | **the launched token** |

So a tiered ether-quoted market's vault holds the ERC-20 it launched, and an untiered one's
holds native ETH. Both are exercised against a real `PoolManager` in
`EngineNative.t.sol`.

Native currency is `Currency.wrap(address(0))` throughout, which is v4's own
representation. It is not modelled as an ERC-20 and nothing is wrapped anywhere: a market
quoted in ETH is quoted in ETH, and a creator never sees WETH. `CurrencyLibrary` resolves
`balanceOfSelf` to the native balance, `transfer` to a bare call and `toId()` to zero, so
the vault, the hook and the factory needed no native branch — only the removal of a guard,
and the proof.

One consequence worth noting: because the zero address sorts below every ERC-20, a
native-quoted launch gets `currency0` for free and satisfies `AgenCurve`'s
token-as-`currency1` requirement without a salt search.

## Trade size is measured pre-fee

A consequence worth stating separately, because it is what makes the whole thing
coherent. A size threshold is evaluated against the launched-token amount
attributable to the underlying pool swap **before** the programmable fee is applied.

Otherwise it is circular: the rate depends on the amount, the amount depends on the
fee, and the fee depends on the rate. Concretely, a market charging 4% in its own
token on sells at or above 1% of supply would — if it read the amount after the fee
— see 96% of the threshold at the boundary and charge the base rate instead. It
would never once apply its own tier at the point its own prompt was most explicit
about.

So the order is fixed:

```text
derive side → derive gross token amount → evaluate threshold
→ determine rate → calculate fee → settle fee
```

What "gross" resolves to depends on the shape, and only on the shape:

- the token is the swap's specified currency — `|amountSpecified|`, the amount the
  trader named. `BeforeSwapDelta` then adjusts the pool's own swap by exactly the
  fee, so the named amount is the pre-fee figure by construction.
- the token is unspecified — the token component of the `BalanceDelta` in
  `afterSwap`. `beforeSwap` returned no delta in that case, so the pool computed
  that leg knowing nothing of the fee.

The same rule governs a trade ceiling, which reads the gross amount for the same
reason: a ceiling is a statement about the trade the trader asked for, not about
what was left of it after Agen took a cut.

## Volume is independent of the fee currency

A market may collect its fee in the launched token and still count its volume
trigger in the quote asset. The two are separate concepts and neither is defined in
terms of the other — "after 100 ETH of volume" is a statement about ETH, and
redefining it as tokens because of an unrelated derivation would silently change
when the market's rate changes.

## Where it lives

- Derived in `compile` — `packages/market-engine/src/compile.ts`
- Argued and tabulated in `packages/market-engine/src/orientation.ts`
- In the encoding, so it is in the commitment — `packages/market-engine/src/encode.ts`
- Stated on the review card — `packages/market-engine/src/review.ts`
- Mirrored on chain as `AgenRuleLib.FeeCurrency`, held to the TypeScript by
  `packages/contracts/test/agen/engine/RuleLib.vectors.t.sol`
