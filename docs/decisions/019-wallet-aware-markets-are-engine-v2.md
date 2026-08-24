# ADR-019 — Wallet-aware markets are engine v2, and they are routed

Status: **in progress.** The featured prompt compiles, reviews, and is executable
on a newly deployed v2 stack. Nothing here changes a live v1 market. Extends
ADR-018 (a launched market is never reinterpreted under rules written after it)
and contradicts, deliberately, the reasoning quoted in
`EngineHook.isolation.t.sol`.

The three prompts, verbatim:

> Every hour the largest holder receives 50% of the fees. The remaining 50% is
> used for buyback which is triggered after every large sell. Do not let anyone
> buy more than 2% of the supply in the first 12hrs of trading.

Engine v1 refuses all three, for one reason each: it has no trader identity, no
knowledge of balances, and no ability to hold or spend a balance. None of those
is an oversight, and two of them are load-bearing.

## Decision

These become engine v2 — a new hook, factory, registry and token deployed
alongside v1, not a change to anything already launched. Four separate decisions:

**1. A market that uses a per-wallet rule refuses unrouted swaps.** Engine v2's
hook reverts a swap that did not arrive through `AgenRouter` *if and only if* the
market's configuration contains a wallet-scoped rule. Markets without one stay
reachable directly at the `PoolManager`, exactly as v1 is.

**2. "The largest holder" means the largest time-weighted holder who came
forward.** The token notifies the hook on transfer; the hook accrues
balance × time per address; at the end of an epoch the pot is claimed by an
address whose accrued weight the contract can check against its own accounting,
inside a challenge window during which anyone with more weight takes it.

**3. "Every hour" is an epoch, rolled lazily.** No keeper and no cron. Fees are
credited to `epoch = (block.timestamp - initTime) / period`, and an epoch becomes
claimable when the clock has passed it. Nobody has to call anything for time to
pass.

**4. A buyback is armed by the trade that triggers it and executed by a later,
separate transaction.** Never inside the swap that armed it, permissionless to
execute, bounded per epoch, and carrying a minimum-out.

## Why per-wallet means routed

Engine v1's hook takes `address` and `bytes calldata` for sender and hook data
and reads neither. That is asserted, not incidental:

> The engine must not depend on being reached through `AgenRouter`. A hook whose
> correctness relies on its callers is a hook with a hole, and the whole reason
> engine v1 has no wallet primitives is that trader identity cannot be trusted
> here.
> — `packages/contracts/test/agen/engine/EngineHook.isolation.t.sol`

The infrastructure to know a trader already exists and is used by engine-0:
`AgenRouter` puts `msg.sender` into hook data, and `AgenRouted._requireTrader`
refuses any swap that did not come through the router. So identity is available.
The question is what it is worth.

`_traderOr` — trust the router, fall back to the caller — is worthless for a
limit. A cap of 2% of supply per wallet, with unrouted swaps allowed, is defeated
by a four-line contract that swaps directly and forwards the tokens, and it can
be deployed once and used by everybody. A limit that is one contract away from
not existing should not be described to a creator as a limit.

So the choice is `_requireTrader` or nothing, and `_requireTrader` has a real
cost: the market is only tradable through Agen's router. Aggregators, other
front-ends and arbitrage bots that go straight to the `PoolManager` cannot trade
it. For a market whose creator asked for a per-wallet cap that is arguably the
point — an unroutable buyer is exactly the buyer being limited — but it makes the
market less liquid, and it must be stated on the review screen rather than
discovered.

Scoping it to markets that use a wallet rule keeps the cost proportional. A v2
market with only ladders and tiers behaves like a v1 market and stays open.

**The limit is still per address, not per person.** Ten wallets buy ten times the
cap. This is not solvable on-chain without an identity system, and engine v2 will
not pretend otherwise: the review card has to say "per wallet", never "per
person", and the refusal text for "do not let anyone" has to explain the
difference rather than accept the prompt silently.

## Why the largest holder cannot be read

`VerdantToken` is deliberately inert:

> **No transfer hook, no fee on transfer, no rebasing, no ERC-777 or ERC-1363
> callbacks.** A transfer of `n` moves exactly `n`, notifies nobody, and reenters
> nothing.
> — `packages/contracts/src/VerdantToken.sol`

So today nothing on chain knows who holds what. Two problems follow, and they
have different answers.

**Knowing balances at all.** Engine v2 needs a new token type that calls the hook
on transfer. That is new reentrancy surface pointing at the hook — the exact
property the current token's header is proud of not having — so the callback must
be balance-accounting only: no external calls, no swaps, no payouts, and a strict
`onlyToken` guard. Every existing v1 market keeps the inert token; the registry
pins its `codeHash`, so this cannot leak backwards.

**Finding the maximum.** There is no cheap on-chain maximum over an unbounded set.
Iterating holders is unbounded gas. A running maximum is wrong the moment the
current holder sells, because nothing knows who is second. A bounded top-N
leaderboard maintained on every transfer is O(N) writes per transfer on a
notification path that already costs more than a plain transfer.

So the maximum is not computed — it is **claimed and challenged**. The contract
already knows every address's accrued weight from its own accounting, so it can
verify any specific claim in constant time; it just cannot enumerate. At epoch
end anyone calls `claimEpoch(epoch, holder)`; the contract records the best
weight seen; anyone with more takes it during the challenge window; after the
window the best claimant is paid. The largest holder is the party most motivated
to call, and if nobody calls, the pot rolls forward rather than being lost.

**Why time-weighted.** Paying whoever holds most at the instant an epoch ends is
a prompt to buy at 59 minutes and sell at 61. The exploit is not hypothetical, it
is the dominant strategy, and it costs the creator the fees they meant as a
loyalty reward. Weighting by balance × time held over the epoch makes the reward
proportional to what the creator was actually trying to pay for, and it is cheap:
two accumulator updates on each side of a transfer.

Even weighted, this pays whales by construction. The prompt asked for that, and
the review card should say "the largest holder" in the creator's own words while
being explicit that it means the largest, not the most loyal, and that the cost is
paid by every trader in fees.

## Why the buyback is deferred

Engine v1's hook never holds a balance. It mints the fee as an ERC-6909 claim
directly to the market's vault and the vault is the only thing with a withdrawal
path. A buyback needs the opposite: a balance to spend, and a swap to spend it in.

It cannot happen inside the swap that triggers it. Three reasons, any one of them
sufficient. It would re-enter the same pool from inside its own `afterSwap`,
mid-settlement. It would make the trader who happened to place the large sell pay
the gas for an operation that is nothing to do with them, on a trade they were
already paying the top fee rate on. And its price impact would land on that same
trade, so the sell that triggered the buyback would be partially filled against
it — the market would be trading with itself, at a price it moved.

Deferred and permissionless has its own cost: the buyback is public, its size is
known, and whoever executes it can sandwich it. That is bounded rather than
solved — a maximum per epoch, a minimum-out, and no reward for executing beyond
the ordinary MEV of a public transaction. It is worth being blunt that a
predictable buyback is a worse deal for the market than an unpredictable one, and
that this is inherent to doing it on chain without a trusted keeper.

**What the bought tokens do** has to be answered, because "buyback" does not say.
Burning needs a burnable token, which v2's new token type can be. Anything else —
to the vault, to liquidity — is not a buyback, and if the creator meant one of
those the prompt should be interpreted as that instead.

## Consequences

Contracts, all new, none replacing anything deployed:

- [x] `AgenEngineHookV2` — v1's rules plus wallet accounting, epoch pots, the
      claim/challenge, and the armed-buyback state. Same permission bits as v1
      (`0x38CC`); transfer notify is not a v4 callback.
- [x] `VerdantNotifyingToken` — transfer notification and burn. New `codeHash` in
      the registry; v1 markets unaffected.
- [ ] `AgenEngineVaultV2` — not built. The v1 vault still credits a single total;
      epoch buckets live on `AgenLargestHolderPot` after it pulls.
- [x] `AgenBuybackPot` — armed state, bounded execution, minimum-out.
- [x] `AgenEngineFactoryV2`, a new `AgenMarketRegistry` instance, a new deployer.
      Same pattern as `DeployAgenEngine.s.sol`.
- [x] `AgenRuleLibV2`: `engineVersion != 2` refused, and a `CONFIG_V2_DOMAIN`
      distinct from `CONFIG_V1_DOMAIN` so a v1 commitment can never be replayed
      against v2.

`packages/market-engine`, which is where a creator's words become a commitment:

- [x] `spec.ts` — a wallet-scoped protection with a window, a
      `LARGEST_HOLDER` recipient kind with a period, and a buyback rule.
- [x] `compile.ts` — refuse the combinations that cannot hold: a buyback with no
      fee to fund it, a largest-holder share on a market whose token is the inert
      one, a wallet cap above the per-trade ceiling.
- [x] `encode.ts` — new tuple, therefore a new `configHash` layout. This is why it
      is a version and not a feature.
- [x] `review.ts` — cards for all three, each carrying its cost: routed-only,
      per-wallet-not-per-person, sandwichable buyback.
- [ ] `simulate.ts` — boundary cases at the window's edge and the epoch's.
- [ ] `orientation.ts` — whether a wallet cap measured in tokens forces the fee
      currency the way a size tier does (ADR-018's table, re-derived).

App and indexer:

- [ ] The interpreter's schema and prompt, so these stop being refusals.
- [ ] `engine-outcome.tsx` — the refusal copy for the parts still refused, which
      now includes "per person".
- [ ] Indexer handlers and addresses for a second engine layer, plus the new
      events: epoch rolled, payout claimed, challenge won, buyback armed and
      executed.
- [ ] `deployments/robinhood.json`, Blockscout verification, `docs/verification.md`
      probes for the claim/challenge and the buyback bound.

External audit, specifically the token-to-hook callback and the buyback. The rest
is arithmetic on state the hook owns; those two are the parts that move value
based on something outside the swap.

## What was rejected

**Adding this to engine v1.** The hook has no owner, no setter and no upgrade
path, which is the property the product is sold on. ADR-018 already settled the
general case: a market already launched is never reinterpreted under rules
written after it.

**`_traderOr` instead of `_requireTrader`.** Covered above: a cap that a
four-line contract defeats is not a cap, and shipping it would be worse than the
refusal, because a refusal is honest.

**A keeper for the hourly payout.** It works and it is what most protocols do. It
also introduces something that can stop being called, and somebody who has to
keep calling it — an owner in everything but name. Lazy epochs need nobody.

**Instant-balance largest holder.** The boundary trade is the dominant strategy.

**An on-chain leaderboard.** O(N) writes on every transfer of every holder, to
serve one payout an hour.

**Buyback inside the triggering swap.** Reentrancy into a mid-settlement pool, an
unrelated trader paying the gas, and the trigger trade filling against its own
buyback.

**Interpreting "do not let anyone" as a per-trade ceiling and launching it.** This
is what the engine would do if the wallet rule were dropped as unsupported: it
would produce a market that looks like it satisfies the prompt and does not. The
current refusal already says a market missing a rule you asked for is not a
smaller version of what you wanted, and that applies most to the rules that are
nearly expressible.

## Sequencing

Engine v1 is mid-launch and has not yet had its first production BUY and SELL. v2
is a new immutable deployment with an audit in front of it. Nothing here starts
before v1 is proven live, and the nearest launchable version of the prompt above —
a permanent 2%-of-supply buy ceiling, punitive buy fees for the first 12 hours,
a 10% rate on large sells, and half the fees routed to an address the creator
controls — is expressible on v1 today.
