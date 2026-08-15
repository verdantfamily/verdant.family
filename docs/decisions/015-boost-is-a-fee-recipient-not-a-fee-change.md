# 015 — Agen Boost is a fee recipient, not a fee change

**Status:** accepted
**Extends:** [014](014-instant-is-a-preset-not-a-model.md)

## Decision

Agen Boost — a creator's 1.00% spent buying their own token back and sending it to
`0x000000000000000000000000000000000000dEaD` — is implemented as a contract that a market
**names as its `feeRecipient` at launch**, and by nothing else.

No deployed contract changes. Not `InstantHook`, not `InstantFactory`, not `InstantDeployer`,
not `MarketRegistry`, not `InstantFeeVault`, not one existing market. Two new contracts are
added, `BoostEscrow` and `BoostEscrowFactory`, and neither is referenced by anything already on
chain.

The consequence is stated first because it is the part that cannot be softened: **a market that
named a wallet at launch can never be Boosted.** Every Instant market created before Boost was
deployed is in that category, permanently.

## Reasoning

### The fee is one amount in one place, and it is already committed

`InstantHook._collect` (`src/InstantHook.sol:330-352`) does not split anything. It takes
`InstantFees.split(etherLeg).total` — the whole 1.50% — and mints a single ERC-6909 claim to the
market's vault:

```solidity
(,, fee) = InstantFees.split(etherLeg);
poolManager.mint(address(vault), key.currency0.toId(), fee);
vault.credit(etherLeg);
```

The 1.00%/0.50% distinction does not exist until `InstantFeeVault.credit` writes two ledgers one
call later (`src/InstantFeeVault.sol:170-188`). So there is exactly one pooled 1.50% per market,
which is the quantity Boost wants — and by the time it is divided it is committed to two payees
that cannot be changed.

### Four immutables make the Instant stack all-or-nothing

1. `InstantFeeVault.creator` and `.treasury` — immutable, no setter, no owner, no proxy
   (`src/InstantFeeVault.sol:82,85`).
2. `InstantHook._vaults[poolId]` — write-once; `register` reverts `AlreadyRegistered`
   (`src/InstantHook.sol:187`).
3. `InstantHook.factory` — immutable (`src/InstantHook.sol:110`), so a new factory cannot
   register with the existing hook.
4. `MarketRegistry.writer` and `InstantDeployer.factory` — immutable
   (`src/MarketRegistry.sol:76`, `src/InstantDeployer.sol:51`).

A new factory therefore implies a new deployer, a new registry **and** a new hook — and a new
hook is a new address, which is a new `PoolId`, which is new pools. There is no partial redeploy
of Instant. This is ADR-014's own position restated from the other direction.

### The one seam that was always there

`InstantFactory.create` passes a caller-supplied address straight into the vault
(`src/InstantFactory.sol:354`):

```solidity
created.vault = address(deployer.deployVault(salt, address(hook), poolManager, params.feeRecipient, treasury));
```

`params.feeRecipient` becomes the vault's immutable `creator`, and `claimCreator()` is
**permissionless and takes no argument** (`src/InstantFeeVault.sol:199-207`) — so anybody may
push a market's fees to that address and nobody may redirect them. A market that names a
contract therefore has its future creator fees delivered into that contract, forever, with no
privileged address anywhere in the swap path.

This is `FeeForwarder`'s argument (`src/FeeForwarder.sol:21-31`) applied to Instant. That
contract's header already states it: *"the address a splitter pays is whatever the creator named
at launch, and if they name this contract then `msg.sender` is a contract anybody may call."*

### Why existing markets are out, and why that is not a migration to run later

All six markets live on 4663 at the time of writing name EOAs — verified by `cast code`
returning empty for every one of `vault.creator()`. Their recipients are immutable, the hook's
vault mapping is write-once, and chain 4663 is pre-Prague (the latest block header carries no
`requestsHash`), so EIP-7702 cannot retrofit code onto an address that is already an EOA.

There is no mechanism. Presenting Boost on those markets as a promise, enforced by nothing,
would devalue the badge on every market where it *is* code.

### Agen's 0.50% is routed by being the treasury, which costs one redeployment

`InstantFactory.treasury` is immutable (`src/InstantFactory.sol:158`) and every vault snapshots it
at creation, so the platform share has exactly one enforceable route: **be that address.**
`BoostTreasury` is that address.

There is no second option. The live factory's treasury is
`0xabfB34D1C870c7b2334E93b25B1299346209bE38`, which `cast code` shows is an EOA — as
`SECURITY.md:164` records — and chain 4663 is pre-Prague, so no code can be attached to it. Every
market that factory has created or will create pays its 0.50% there for life.

So capturing the platform stream costs one Instant redeployment. It costs **only** that: the
Instant contracts need no source change, because `DeployInstant.s.sol:170` already takes `TREASURY`
from the environment. The same bytecode with a different constructor argument.

The ordering is the part that cannot be got wrong, and `script/DeployInstantBoost.s.sol` exists so
that it cannot be: **one script, six contracts, `TREASURY` produced rather than accepted as an
input.** A two-script sequence with the treasury passed by hand was written first and thrown away —
it required knowing the Instant factory's address before deploying it, which turned the runbook into
a placeholder somebody has to fill in correctly on the one occasion it matters.

Two facts make the single pass acyclic, and both are worth stating because each removed a prediction:

1. `FactoryOrigin` publishes its own first creation's address from its constructor (ADR-007), so the
   Instant factory's address is *readable* before anything else exists.
2. A `BoostEscrow` reads its market's platform route from that market's **own vault** rather than
   being told it in a constructor, so `BoostEscrowFactory` does not name the treasury.

Which leaves one direction and one order: `origin → deployer, registry → escrow factory → treasury →
hook → factory`. Nothing is computed from a nonce — `DeployInstant`'s own header explains why that
would be the wrong tool, since a contract's nonce counts creations and an account's counts
transactions, so an offset correct under `forge test` is wrong under `--broadcast`.

The second fact also turned out to be better design than the constructor immutable it replaced: one
escrow can now serve markets from different Instant deployments and be right about each, instead of
assuming every market it holds came from the same stack.

`test/DeployInstantBoost.t.sol` asserts the factory pays the treasury the same run produced, that an
injected `TREASURY` is ignored, and that a market launched through the result routes the whole 1.50%.

`BoostEscrow.contribute` survives as what it always honestly was — a discretionary top-up from
outside both fee streams, tracked in `agenContributed` and reported apart from `platformRouted`.
A routed fee is a guarantee and a donation is a choice, and the interface must not word them alike.

## Consequences

- [x] `BoostEscrow` (one per creator, CREATE2 on the owner), `BoostEscrowFactory`, and
      `BoostTreasury` (one per Instant deployment) added. Three contracts, no changes to any
      Instant source file.
- [x] **Both fee streams are captured, and by different routes.** The creator's 1.00% because
      `feeRecipient` is a per-launch argument; the platform's 0.50% because `BoostTreasury` *is*
      the factory's `treasury`. The trader still pays exactly 1.50% and Boost adds no fee — only
      the destination of the two existing shares moves.
- [x] **`platformBoosted` is per market and the interface must read it.** A market from an Instant
      deployment that pays an ordinary address recycles 1.00%, not 1.50%. `boostTotalLine` derives
      the figure from state; `boost.test.ts` asserts the copy says 1.00% for such a market and
      never contains a hardcoded 1.50%.
- [x] Boost starts **off**; `enableBoost`/`disableBoost` are owner-only; `lockBoostForever` is
      one-way with no counterpart.
- [x] **Both toggles settle both streams before they flip either flag.** A vault pays out a lump
      that cannot be attributed to either side of a cutoff, so the cutoff is the toggle
      transaction itself. `enableBoost` claims while both flags are still off, so earlier fees stay
      the creator's and Agen's; `disableBoost` claims while both are still on, so fees earned under
      Boost stay committed on both sides. The second half matters as much as the first: if
      disabling handed Agen back the platform fees accrued under Boost, "all 1.50% was recycled"
      would be false in retrospect for trades that had already happened.
- [x] **The treasury's flag is a mirror, not a read.** `BoostTreasury.receive` must never revert —
      the vault's `treasury` is an immutable, so a throwing receive would strand a market's
      platform fees forever — so it books from storage and calls nothing. The escrow keeps the
      mirror in step in the same transaction, immediately after its own flag.
- [x] **Only the market's own genuine escrow can move the platform flag.** `msg.sender ==
      vault.creator()` alone would let the creator of an *ordinary* market flip their own flag and
      pull Agen's half percent to themselves, so `BoostTreasury` also requires the caller to be an
      escrow `BoostEscrowFactory` derived. `test_aWalletCannotDivertThePlatformFee` pins it.
- [x] **Agen cannot toggle Boost.** Agen gives up its share by deploying an Instant whose treasury
      is `BoostTreasury`; after that the decision is the creator's alone, which is the only
      arrangement under which "Agen also gives up its fee" is a property of the market rather than
      of Agen's continued goodwill.
- [x] The creator's side is **per market** (`Market.creatorPending`), not one pooled balance, so
      a profile listing a row per market has a figure per row.
- [x] `boost(token, minTokensOut)` is permissionless. The pool is derived from
      `instantFactory.poolKeyFor(token)`, the sink is a `constant`, and `minTokensOut` is floored
      against the pool's own `sqrtPriceX96` net of the hook's 1.50% — so a caller can tighten the
      bound and never loosen it.
- [x] `MIN_BOOST_WEI` (0.001 ether) and `BOOST_INTERVAL` (30 minutes) are enforced on chain, not
      only in the keeper.
- [x] **The fee-on-buyback tail converges rather than dying immediately.** A buyback pays the
      market's own 1.50%, and with both streams captured the whole 1.50% returns as budget — so
      the decay is about 1/66 a round rather than 1/100, and a second and third cycle really run.
      The ratio is what bounds it, not the threshold. `BoostEscrow.t.sol` drives a tail to
      exhaustion and asserts the round count.
- [x] **The sink is not a burn.** `VerdantToken` has no `burn` (asserted against the compiled ABI
      in `VerdantToken.t.sol:160`, and `burn(uint256)` reverts with empty data on chain), so
      `totalSupply()` never decreases. Circulating supply is `totalSupply - deadBalance`, served
      by the indexer and stated in the interface.
- [x] **Boost volume is separated from organic.** A buyback reaches the pool through
      `AgenRouter` exactly as a trader's buy does, so `Swap.sender` is the router for both and
      cannot distinguish them. The escrow's own `BoostExecuted` can. The indexer follows escrows
      through Ponder's factory pattern on `EscrowDeployed`, and serves `volumeQuote`,
      `boostVolumeQuote` and `organicVolumeQuote`. Rankings use organic.
- [x] The launch form offers Boost-capability, **on by default**, because the decision is
      irreversible in one direction only: naming a wallet forecloses Boost permanently, while
      naming an escrow costs nothing when Boost is off.
- [x] `packages/config` records `instant.boost` as `null` until broadcast. Null hides the surface
      entirely rather than rendering a switch that cannot be thrown.

## What was rejected

**A `BoostController` the vaults consult.** There is nothing to make consult anything: a vault
that reads a controller is different `InstantDeployer` bytecode, which forces a new factory,
hook and registry — and it puts a mutable Agen-controlled address in the middle of a path whose
entire design argument is that it has no privileged address. This is the option ADR-014 is
written against.

**A watermark on `creatorAccrued` instead of settling on toggle.** Comparing accrual watermarks
leaves a window in which fees earned while Boost was on have not yet been claimed, and a creator
who disables in that window takes them. Settling atomically with the toggle has no such window.

**Excluding buybacks from the hook's fee.** Would need a sender allowlist in the hook, therefore
a new hook, therefore new pools — a full-stack redeploy to save 1.5% on a buyback that is
honestly a trade and should honestly pay the market's fee.

**A pooled owner balance.** Cheaper in gas and wrong in the interface: a single figure either
appears on every row of a creator's profile, reading as several times the money that exists, or
needs a row of its own corresponding to no market.

**Leaving Agen's 0.50% as a manual `contribute()` after the fact.** What the first cut of this ADR
accepted, and wrong: a periodic transfer from a treasury EOA is a promise, and a product whose
headline number depends on Agen continuing to keep it should not state that number. Being the
treasury costs one redeployment of unchanged bytecode and makes the claim structural.

**Making `BoostTreasury` settable, or giving it an owner, so the live stack could adopt it.** There
is no such mechanism — `InstantFactory.treasury` is immutable — and inventing one would put a
mutable Agen-controlled address in the fee path, which is the arrangement ADR-014 exists to refuse.

**Reading the escrow's flag from `BoostTreasury.receive` instead of mirroring it.** One source of
truth would be tidier and would risk a market's platform fees permanently: `receive` is reached by
a bare call from a vault whose recipient is immutable, so anything that can revert there is
unrecoverable.
