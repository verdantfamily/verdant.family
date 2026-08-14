# ADR-014 — Instant is a preset over Classic, on Uniswap v4 only

Status: accepted. Extends ADR-008 (a market's quote asset is a parameter) and
ADR-009 (the first buy is part of the launch).

## Decision

Agen offers a launch called **Instant**. It sends `VerdantFactory.create` with every
field except six fixed in the interface:

| Field | Value | Why it is not a question |
| --- | --- | --- |
| `model` | `fixed` | Instant is the launch without a fee schedule |
| `stages` | one, at `BOUNDS.schedule.feePpm.default` | one fee, for the life of the market |
| `quoteAsset` | `address(0)` | ether, and v4 does not wrap |
| `supplyTokens` | `BOUNDS.token.defaultTotalSupplyTokens` | below |
| `creatorAllocationBps` | `0` | the whole supply goes into the pool |
| `vestingCliff` / `vestingDuration` | `0` | there is nothing withheld to vest |
| `metadataMutable` | `false` | the token then has no privileged function at all |
| `initialTick` | derived | from a fixed opening valuation and that supply |

The creator supplies a logo, a name and a ticker — all three required — and optionally a
description, a fee receiver, a first buy, and links to X, a website and Telegram. That is
the whole form.

**Supply is not asked for**, for the reason the opening valuation is not asked for either.
A token that has never traded has no price to discover, so a supply typed into a form is
the default or a guess, and two markets whose creators guessed differently cannot be
compared on a page that lists both. Every Instant market is a billion tokens opening at
the same valuation, which is what makes a market cap on the explore page mean one thing.

**Instant is not added to `packages/config/src/launch-models.ts`.** It is not a new
launch model in the sense that file means, and the two lists are deliberately different
things:

- `launch-models.ts` is the protocol's catalogue — a *shape of market*, with a `status`
  that describes whether contracts exist to execute it. Instant introduces no new shape.
  Every Instant market is a `classic` market with the `fixed` fee model, indistinguishable
  on chain from one launched through `apps/web`, indexed by the same handler into the same
  `market` row.
- Agen's chooser at `/launch` is a product surface. It offers Instant, Programmable v4 and
  Evergreen, which are three things a creator can pick between in that interface.

Adding `instant` to the protocol catalogue would put a second name on one market shape and
would generate a `models/instant/` document describing contracts that are `models/classic/`.
The `status` field would then have to say `ready` about a model that does not exist, which
is precisely the dishonesty that field was added to prevent.

## The metadata slot holds a document, not a picture

A token carries one string of at most 256 bytes. The first cut put the image URL in it,
which meant the description and the links were collected and then dropped — nothing in
Agen stores anything about a market created through `VerdantFactory`, and `apps/web`'s
blob store is not deployed here.

So `metadataURI` points at a small JSON document holding the name, symbol, description,
image and links, written to the same volume as the build jobs and content-addressed the
way the images already are. Immutability matters more for this than for an image: the URI
is written at creation with `metadataMutable` false, so a mutable address in that slot
would be a promise the interface could break later.

The order this forces is worth stating, because it is not obvious: the document's address
is a constructor argument of the token, so it must exist **before** the salt can be mined
against it, and the salt decides the address the launch lands on. Both happen when the
confirmation card opens, so a failure to prepare surfaces before a wallet does.

## Why Uniswap v4 only, and why there is no AMM picker

The obvious feature request is to let a creator choose between Uniswap v3 and v4. It was
specified, investigated and dropped, and this is the record of why so it is not
re-specified from scratch.

**v3 is present on 4663.** `docs/verification.md` §V3 records
`SwapRouter02.WETH9()` and `NonfungiblePositionManager.WETH9()` agreeing on the canonical
WETH, which means both are deployed and answering. The addresses are in
`robinhood-launchpad/docs/CHAIN-RECON.md`: factory
`0x1f7d7550B1b028f7571E69A784071F0205FD2EfA`, position manager
`0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3`, router
`0xCaf681a66D020601342297493863E78C959E5cb2`. So "v3 does not exist here" is not the
reason.

**The reason is the fee.** A v3 pool charges one of the tiers its factory has enabled, and
on 4663 those are 0.01%, 0.05%, 0.30% and 1.00% — the same recon records
`feeAmountTickSpacing` returning zero for anything else. Only that factory's owner
(`0x2BAD8182C09F50c8318d769245beA52C32Be46CD`, which is not us) can call
`enableFeeAmount`, so **1.00% is the ceiling on a v3 market's fee and it cannot be
raised.** A v3 Instant market would therefore charge a different fee from a v4 one, and
the number on the launch screen would depend on a radio button rather than on the product.

The three ways round it are all worse:

- **A surcharge in an Agen router.** Bypassed by anyone swapping on Uniswap's own
  interface, through an aggregator, or directly against the pool. A fee the interface
  states and the market does not enforce is a misstatement, not a fee.
- **A tax in the ERC-20.** Rejected on sight. The token is the thing that must stay
  boring; see `VerdantToken` having no transfer hook at all.
- **Quoting the v3 number honestly beside the v4 one.** Coherent, but it makes the first
  decision in the simplest launch on the site a comparison of two fee schedules, which is
  the opposite of what Instant is for.

v4's fee is set by the hook through `updateDynamicLPFee` and returned from `beforeSwap`
with `OVERRIDE_FEE_FLAG`, so it is charged by the pool on every swap regardless of who
routed it. That is the property Instant needs, and only v4 has it.

## The fee is 1.50%, split 1.00% to the creator and 0.50% to Agen

Superseding the section below, which described a 1.00% fee divided by a register setting.
Every Instant trade costs **1.50%**, of which **1.00% of the trade** is the creator's and
**0.50% of the trade** is the platform's. None of the three is configurable, by a creator
or by anybody: they are constants of the Instant hook, and changing one means deploying a
different hook.

**Both shares are taken from the trade, not divided out of the fee.** This is forced
rather than preferred. The platform's cut is 0.50/1.50 of the fee, which is one third,
and one third is not a whole number of basis points — the nearest, 3 333 bps, pays
0.49995% and 1.00005%. An encoding that cannot state the specification is the wrong
encoding, so the shares are held in ppm of the trade, where 15 000, 10 000 and 5 000 are
all exact. `InstantFees.split` then rounds the total and the platform's share down and
derives the creator's by subtraction, so the two always sum to exactly what the trader
paid and the remaining wei falls to the creator rather than to the protocol.

This also puts the split permanently out of `ModelRegistry`'s reach — 3 333 is above the
immutable `maxProtocolBps` of 2 000 — and that is the point rather than an obstacle. The
register divides one pot on a snapshotted ratio, which is right for a market whose fee
accrues to a locked position in two currencies. Instant's fee is taken by the hook, in
one currency, on a ratio the register cannot express. So the review screen states a
constant: reading `protocolBps` there would display a number that does not govern the
market being created, which is a worse failure than the stale constant the live read was
added to avoid.

**The pool's LP fee is zero.** The 1.50% is the whole charge. A non-zero LP fee alongside
the hook's would be a second charge on the same trade, and "a trade costs 1.50% and
nothing else" would quietly be false. It also means the locked position accrues nothing,
so `PositionLocker.collect()` is a no-op for an Instant market and the profile's claim
screen needs a different path for them than the collect-then-claim one it uses today.

`test/agen/AgenCustody.t.sol` and its two fixtures are the working reference for the
mechanism — `poolManager.take` paired with a returned delta, and the exact-output case
where the fee rides on `deltaUnspecified`. The Instant hook differs from that fixture in
exactly two ways: it charges no LP fee on top, and it takes from the ether leg in both
directions rather than from the input, which is what makes a sell pay in ether and needs
`afterSwapReturnDelta` as well.

## The liquidity is one locked position, and there is no Instant curve

Instant mints **a single one-sided position holding the entire supply**, from
`MIN_USABLE_TICK` up to the opening tick, and locks it permanently. This is
`VerdantFactory._mintLockedPosition` unchanged — not a new mechanism — and because the
pool opens at the top of that range and buys can only push price down into it, one
constant-`L` position across the whole reachable range is arithmetically `x*y=k`. Ordinary
Uniswap price discovery, no bonding curve, no migration, no graduation step.

**A custom aggressive curve was built and then rejected.** `InstantCurve.sol` implemented
a tunable `g` in `X(M) = V₀·(M/V₀)^g`, where constant product is `g = 0.5` and lower values
make depth fall behind the market so a fixed buy keeps moving the price. It shipped as a
geometric ladder of sixteen locked positions; measured on a real pool at `g = 0.35`, a
$1 000 buy moved a $10k market by +78% against +40% for constant product, and a $50k
market by +42% against +17%.

It was rejected on product grounds, not technical ones. Instant is meant to be the
*simplest* launch on the site and to behave like an ordinary Uniswap market — a curve
whose stated purpose is making a token easier to push is a different product, and one
nobody asked Instant to be. Three concrete costs came with it: sixteen mints per launch
instead of one; a **deep tail** holding 46% of supply that acts as a market-cap ceiling,
because a curve normalised this way only ever consumes `g/(1-g)` of the supply; and a
bespoke liquidity mechanism to audit where a proven one already existed.

The whole of it is deleted rather than left dormant behind a flag. It was never wired into
a factory, so nothing depended on it, and a curve that exists in the tree is a curve
somebody eventually turns on.

**What Instant keeps from that work is the fee architecture, which is orthogonal.** The
ETH-only hook, vault and split below were deliberately built with no dependency on the
curve, and they stand unchanged.

### The opening valuation is the only knob, and it stays at 1.5 ether

Asked later whether the impact profile could be tuned toward Pump.fun's without bringing
the ladder back, the answer turned out to be that there is exactly one number to turn and
it should not be turned.

A one-sided position spanning the whole reachable range and holding the entire supply is
`x·y = k` whose ether side is entirely virtual at launch, and that virtual reserve equals
the opening market cap. So `M = x²/M₀`, a buy of `ΔE` multiplies the cap by
`(1 + ΔE/√(M·M₀))²`, and **the opening valuation is the only parameter in the system**.
Supply cancels: minting ten billion rather than one billion changes every price by ten and
changes no impact at all. `test/InstantDepth.t.sol` measures this against a real pool at
six openings and five valuations and asserts the closed form at every point, so a proposed
opening tick can be chosen on paper and confirmed rather than searched for.

**Pump.fun is deeper than Instant, not shallower.** It is the same constant product with
virtual reserves — 30 SOL against 1.073B virtual tokens — giving an effective `M₀` of
`k/supply` = 32.19 SOL, roughly $4.8k. Instant's 1.5 ether is roughly $2.8k. A $1 000 buy
takes a $10k Pump.fun coin to about $13.0k and a $10k Instant market to $14.0k. Instant is
already the more aggressive of the two, and "make it more like Pump.fun" argues for a
*deeper* opening rather than a shallower one.

Reaching $10k → $19k would need an opening near $660, and that is refused for the same
reason the ladder was: on one curve, one number sets both. At that opening a $1 000 first
buy takes **59.8%** of the supply, against 25.7% today and ~19% on Pump.fun — and Instant's
first buy is atomic inside the launch transaction, so a shallow opening is a sniping
surface by construction. Pump.fun's 30 SOL exists precisely to stop that; their own
documentation calls it artificial depth that prevents the first buyer taking everything for
pennies. Capping `initialBuyAmount` would bound the creator's own share and does nothing
about the next block, so it is not a substitute.

## What the fee actually is, and why the screen reads it from the chain

Superseded by the section above; kept because the reasoning about the register is still
correct for every market that is not Instant.

At the time of writing, read from the deployed register at
`0xfC54c8fb2F5B9da90ca8227866b48a429568EA03`:

```
protocolBps      1000
maxProtocolBps   2000
creationPaused   false
creationAllowed(fixed, 1 stage, 0 reserve)  true
```

With the default pool fee of 10 000 ppm, that is **1.00% charged on every trade, of which
the creator takes 0.90% and the protocol 0.10%.**

The review screen computes those two percentages from a live read of
`ModelRegistry.protocolBps()` rather than from a constant, because the register's owner
may set it for future markets at any time and each market snapshots it at creation. A
percentage written into the interface would be a number the screen believed and the chain
had moved on from, discovered by the one creator it was wrong for.

**A 1.00% creator share with a 0.50% protocol share cannot be offered on this
deployment.** It needs `protocolBps` of 3 333, and `maxProtocolBps` is an `immutable`
seeded at 2 000, so `setProtocolBps` reverts above it. Offering it would mean a second
deployment of the whole set — register, market registry, deployer, a re-mined hook and a
factory.

At the time that was written it settled the question, because a deployment is a decision
about the protocol and not about a form. The section below overturns the premise rather
than the reasoning: a new deployment is now required anyway, for the fee *currency*, and
a set being deployed for a good reason can be seeded with whatever cap is wanted while
nobody has to argue for the deployment itself.

## The creator's share is paid in ether, which the live hook cannot do

**Decision: Instant pays the creator's whole share in ether, and does not launch until a
hook exists that can do that. `INSTANT_LAUNCHABLE` is false and the form says so.**

The fee on a Verdant market is an ordinary Uniswap LP fee, and Uniswap takes it from the
currency going *into* the pool. A buy is ether in, so the fee is ether. A sell is the
launched token in, so the fee is the launched token. Both accrue to the locked position,
`collect()` sweeps both into the splitter, and each party claims a share of each. On
roughly balanced volume a creator's 0.90% arrives as about 0.45% ether and 0.45% of a
token they never asked to hold.

That is a coherent design — it is what `models/classic` documents and warns about — and it
is not what Instant says. Instant's whole claim is that it is the simple one, and "your
fee, in ether" is part of being simple.

It cannot be fixed above the contracts. `VerdantHook.beforeSwap` takes `SwapParams` as an
unnamed argument and returns only a fee rate, so it does not know a swap's direction; and
its permissions are

```394:395:packages/contracts/src/VerdantHook.sol
            beforeSwapReturnDelta: false,
            afterSwapReturnDelta: false,
```

Without those two a hook cannot take any currency other than the swap's input — the file's
own comment calls this what makes it "unable to hold anybody's money". A hook's
permissions are encoded in its address, so they cannot be granted later: it is a different
hook, at a different address. And `VerdantFactory` holds its hook in an immutable while
`VerdantHook` holds its factory in one, so a new hook is a new factory.

### What the replacement has to do

Take the fee from the **ether leg in both directions**, which needs both permission bits
and both callbacks, because ether is on a different side of each swap:

- **Buy** (`zeroForOne`, ether in): ether is the input, so the cut comes off before the
  swap. `beforeSwap` returns a `BeforeSwapDelta` on the specified currency and the hook
  takes that much ether.
- **Sell** (ether out): ether is the output, so there is nothing to take until the swap has
  run. `afterSwap` returns a delta on the unspecified currency and the hook takes its cut
  of the ether leaving the pool.

The pool's LP fee becomes zero, so the locked position stops accruing anything and the
hook is the only thing charging. The hook forwards what it takes to the market's existing
`FeeSplitter`, which already divides creator from protocol and already pays by pull — so
the split, the caps and the claim path are unchanged, and only the currency and the
collection route are new.

### What this costs, and what it is worth

A new hook mined to its permission bits, a new factory anchored to it through
`FactoryOrigin`, a fresh registry set, a redeployment, and review before any of it holds
money. It also supersedes the "no new deployment" reasoning in the fee section above: the
protocol share of 1.00% / 0.50% remains out of reach on the *current* register, but a new
deployment is now happening for a different and better reason, and can seed
`maxProtocolBps` accordingly.

Instant is held rather than shipped in the meantime. Shipping first and migrating later
would leave a cohort of markets whose fee behaviour permanently contradicts the page that
sold them, and a market's economics are fixed at creation — there is no migration for the
ones already created.

## What Instant does not fix on chain

Nothing stops somebody calling `VerdantFactory.create` directly with the `fixed` model and
a different fee. `ModelBounds` carries `enabled`, `minStages`, `maxStages` and
`reserveBps`, and no fee floor or ceiling, so "an Instant market charges 1%" is a property
of this interface rather than of the chain.

This is accepted rather than fixed, because the alternative is a fee bound in
`ModelRegistry` — a change to a deployed contract's meaning for the sake of a preset. The
consequence is that every surface showing an Instant market must show the fee it actually
charges, read from the hook, rather than the fee the model nominally has.

## The first buy carries no floor

`initialBuyMinTokens` is zero, for the reason ADR-009 gives: the pool does not exist until
this transaction and the buy happens inside it, so no trade can come between the opening
price and this one. The bound a floor would add is against a partial fill, which the
factory already refunds in the same call.

`create` takes no deadline, and none is added here. The opening price is derived from the
creator's own supply and a fixed valuation rather than from market state, so a transaction
included late fills exactly as one included immediately.

## Instant is indexed by its own service, against its own database

Instant's tables and routes were first added to `apps/indexer` beside Verdant's and Agen's,
additively and without touching either. That worked, and it was still the wrong shape, for
a reason that has nothing to do with the tables.

Ponder identifies an app by a hash of its configuration and code, and `railway.toml` starts
each deployment with `--schema "$RAILWAY_DEPLOYMENT_ID"`. So *every* deploy of that service
indexes into a fresh empty schema from `VERDANT_START_BLOCK` — not only a schema change,
but any deploy at all. With `overlapSeconds = 0` and a health check on `/health`, which
answers as soon as the process is listening rather than when the backfill is done, that
leaves a window on each deploy where the feed is up and the data behind it is incomplete.
While Instant shared the service, an Instant-only change spent that window on the
Programmable feed.

So `apps/instant-indexer` is a second Ponder app with a second Postgres. The indexing logic
moved unchanged; what changed is what a deploy of it can reach.

Three things follow.

The backfill becomes trivial. This app watches Uniswap's PoolManager from *Instant's*
factory block rather than Verdant's, because nothing Instant cares about can predate its
own factory — around ten million blocks later on this chain.

`apps/indexer` returns to exactly its pre-Instant state, byte for byte, which is a stronger
claim than "the additions were additive" and is checkable with `git diff`.

And the isolation stops being a property of a `where` clause. The Programmable routes do
not exist on this host, so nothing has to keep them from serving Instant's rows.

What it costs: both apps subscribe to the PoolManager, and Ponder's RPC cache lives in a
`ponder_sync` schema that is per-database, so those logs are fetched twice. That is cheap
while Instant starts near the tip and grows with it.

This does not fix the deploy window for Programmable, which still re-indexes on each of its
own deploys. The fix for that is Ponder's `--views-schema` with a `/ready` health check and
overlap enabled, and it is a change to `railway.toml` rather than to any indexer.

## Consequences

- [x] `/launch` becomes a chooser of three models. Programmable moves to
      `/launch/programmable`, and `/launch` still renders the flow when `?build=` or
      `?prompt=` is present, so links and in-flight builds keep working and `flow.tsx`
      needs no edit.
- [x] `apps/agen/src/app/lib/instant.ts` holds the draft, its validation and the factory
      arguments. Bounds come from `@verdant/config`; none are restated.
- [x] `VERDANT_ADDRESSES` in `apps/agen/src/app/lib/chain.ts`, resolved from the
      deployment record with no environment override.
- [x] `lib/metadata.ts` and `/api/metadata` store the document, rebuilding it field by
      field rather than persisting what was posted, and refusing any link that is not
      `http(s)`. It is served back from this origin, so what goes into it is checked.
- [x] Confirmation is a card over the form rather than a second page — the picture, the
      name, the ticker and the links, and one green button. It is the only green control
      in the interface, because it is the only irreversible one.
- [x] That card states the split from `INSTANT_FEES`. It briefly read
      `ModelRegistry.protocolBps()` live instead; see "the fee is 1.50%" below for why a
      register read is now the wrong answer rather than the careful one.
- [x] `InstantFees.sol` holds the three constants and the split arithmetic, with
      `INSTANT_FEES` in `@verdant/config` mirroring them and the parity test in
      `packages/sdk/src/config.test.ts` reading them back out of the Solidity.
- [x] Success is parsed from `MarketCreated` and the token's own `Transfer` logs. No field
      on it comes from what was requested.
- [x] `apps/agen` gains a vitest setup and `instant.test.ts`.
- [x] `INSTANT_LAUNCHABLE` is false. `validate` returns the hold ahead of everything else,
      the chooser card is marked, and the form states it. The form stays reachable and
      usable so the design can be reviewed; only the launch is refused.
- [x] The profile has a fee-claim section, reading the creator's markets from
      `marketsByCreator` on chain and simulating the collection so the figure shown is
      what a claim would pay rather than the splitter's current balance.
- [ ] The ether-only hook, a factory anchored to it, and a deployment. Until then Instant
      does not launch. The hook consumes `InstantFees`, sets the pool's LP fee to zero,
      and needs `beforeSwapReturnDelta` and `afterSwapReturnDelta` both. The registry set
      it is deployed with should seed `maxProtocolBps` for whatever Programmable wants;
      Instant no longer depends on that value.
- [ ] Two sinks for the hook to pay: the creator's ether and the platform treasury's,
      accrued per market and claimed by pull. `FeeSplitter` cannot be reused unchanged —
      it divides one pot on `protocolBps`, and the whole reason for `InstantFees` is that
      this split is not a ratio of the pot.
- [ ] Instant markets are indexed already, but `apps/agen` cannot yet display or trade
      them: `buildStoreSource()` reads build jobs, and the trade panel speaks to
      `AgenRouter`. A Verdant `MarketSource` and a Universal Router trade path are still
      to be written.
- [x] `apps/instant-indexer`, a second Ponder app against a second Postgres, with
      `AGEN_INSTANT_FEED_URL` naming it and no fallback to `AGEN_FEED_URL` — the two hold
      different tables, so pointing one at the other 404s every request while looking
      configured. `scripts/railway-start.sh` branches on the service name for the third
      time. See "Instant is indexed by its own service" above.

## Rejected

- **A v3 option.** Costed above. The fee ceiling is 1.00% and the factory's owner is not
  us, so the two AMMs cannot offer the same product.
- **`instant` in `launch-models.ts`.** A second name for `classic` + `fixed`, and a
  generated document describing another model's contracts.
- **A second Verdant deployment *for the sake of* the 1.00% / 0.50% split.** Rejected on
  its own, and then overtaken: the ether-only fee requires a deployment regardless, so the
  cap is now a parameter of one that is happening anyway rather than a reason for one.
- **A fee bound in `ModelRegistry`**, to make the 1% contractual. It changes a deployed
  contract's meaning for the sake of a preset.
- **Shipping Instant on the current hook and migrating later.** A market's economics are
  fixed at creation, so there is no migration — only a permanent cohort whose fees
  contradict the page that sold them.
- **Converting the token side to ether on claim**, either through a forwarder named as the
  fee recipient or as a second transaction in the interface. Both leave the creator
  holding only ether, and neither is the same thing: each is a market sell of the
  creator's own token, with price impact on their own pool and the pool's fee paid a
  second time. "Your fee, in ether" should be true because of how the fee is taken, not
  because the interface sells something for you afterwards.
- **A segmented "connected wallet / custom address" control** for the fee receiver. The
  launch panel already solves this with one input whose placeholder is the connected
  address, and a second pattern for the same decision is a second thing to keep consistent.
