# v4.fun M0 — inventory of the engine as it actually is

A factual audit, read from the code in this repository and from Robinhood Chain mainnet
(chain 4663) on 2026-08-24. Every address, table, event and function named here was found
in the tree or on chain, not recalled. Where the milestone's stated assumptions did not
match what is here, the mismatch is recorded under
[Corrections to stated assumptions](#corrections-to-stated-assumptions) rather than worked
around.

Nothing in `packages/contracts` was read into, written to, or otherwise touched. No existing
test, CI gate or lint configuration was modified.

- [Deployed contracts](#deployed-contracts)
- [The canonical config schema](#the-canonical-config-schema)
- [Where configHash is computed](#where-confighash-is-computed)
- [Persistence today](#persistence-today)
- [Indexer tables](#indexer-tables)
- [Indexed events](#indexed-events)
- [What already produces identity, simulation and review](#what-already-produces-identity-simulation-and-review)
- [Live engine markets](#live-engine-markets)
- [Corrections to stated assumptions](#corrections-to-stated-assumptions)
- [Decisions](#decisions)
- [Missing](#missing)

## Deployed contracts

Two records describe the deployment and they do not cover the same set.
[`deployments/robinhood.json`](../../deployments/robinhood.json) is the richer one — it
carries runtime code hashes, sizes, creation transactions and verification status — and
[`packages/config/src/deployments.ts`](../../packages/config/src/deployments.ts) is the one
every consumer actually imports. Ten contracts appear in both, six appear only in the
TypeScript record, and one layer appears in neither. That divergence is itself a finding;
see [Missing](#missing).

### The Verdant market layer

One broadcast, 2026-08-01, blocks 25 393 021 to 25 393 023. No upgrade path: the hook's
address encodes its permissions, and the factory and its counterparties name each other in
immutables.

| Contract | Address | What it does |
| --- | --- | --- |
| `FactoryOrigin` | `0x52490ee359bcF5fE60D79fA4D5eA8bFED853f592` | Anchor the factory's address was derived from. Its one creation is spent. |
| `ModelRegistry` | `0xfC54c8fb2F5B9da90ca8227866b48a429568EA03` | The admitted fee-schedule models. `market.model` indexes into it. |
| `MarketRegistry` | `0x03f002FD5A8070D73f4f1627586968D446512A27` | Append-only record of every Verdant market. Writable by the factory only. |
| `VerdantDeployer` | `0x0B94311A18d2F3E0f38b670cF0a4927ed65420F3` | Deploys a market's token, splitter, locker and vesting. |
| `VerdantHook` | `0xf998c32CDdFA6354bd80Aab470C6ECF4d83Bb880` | The v4 hook. Low 14 bits `0x3880`; no delta-returning bit, so it cannot hold anyone's money. |
| `VerdantFactory` | `0x661A5B2A8d7DC0EaEd98B335e070478b40B92Dd9` | The one contract a creator's wallet calls. |

### Agen's generated-market layer (engine 0)

Broadcast 2026-08-12, blocks 34 794 809 to 34 794 810. A market here is Solidity generated
per creator, with a hook unique to it.

| Contract | Address | What it does |
| --- | --- | --- |
| `FactoryOrigin` | `0xC0297B2d987793dE96f568C169b1ff90C226BE27` | Anchor. Single creation spent. |
| `AgenDeployer` | `0x4C812526bF606927a887111299f94e35AE5bd77E` | Performs every market's CREATE2, for this factory only. |
| `AgenMarketRegistry` | `0x3AE1a797750ed9988ea7C2348534519E44Ed0791` | Append-only record of generated markets. `count()` was **3** at audit. |
| `AgenFactory` | `0xb0fD1387ae751A377dEC0DF46b643B634eE46acc` | The launch entry point. |
| `AgenRouter` | `0xFaf5734973329797fCD032fa80a8277E906c187A` | The only trade route that can name a trader. Recorded in the TypeScript only. |

### Agen's deterministic engine (engine 1) — the layer v4.fun sits over

Broadcast 2026-08-23, blocks 44 230 687 to 44 230 688. All five contracts are verified on
Blockscout, full match, from build-info `022570894b394905`. A market here is **a
configuration a shared hook reads**, not a contract of its own — which is precisely what
makes a Program a meaningful unit.

| Contract | Address | What it does |
| --- | --- | --- |
| `FactoryOrigin` | `0x79Fcd7E5aF04BD28AdD9AF681Fd833D8e0273cF6` | Anchor whose address the hook's initcode embeds. |
| `AgenEngineDeployer` | `0x633525243d3C2b0419dB462C9eD13B3f52f49147` | Holds token, vault and locker creation code. 21 810 bytes — the least EIP-170 margin in the repo. |
| `AgenMarketRegistry` (engine) | `0x71a284dd8Efe6aBFd240B96E861486638B0099eE` | A **second instance**, not the engine-0 one. `count()` was **2** at audit. |
| `AgenEngineHook` | `0x41BC055e9abc03fAd3A8f65da05B93F449f3F8Cc` | One hook shared by every engine market. Low 14 bits `0x38cc`. Derives `configHash` itself. |
| `AgenEngineFactory` | `0x20D5F0867C7dcFfa86f6C411aab4752E1A04b22d` | The launch entry point. Recorded with `enabled: false`. |

`enabled: false` on the factory is deliberate and does not mean broken: recording addresses
and opening the product are separate decisions in this repository, and `AGEN_ENGINE_VERSION`
is the switch. Two markets have nonetheless launched through it.

The engine's addresses are **not** in `packages/config`. They are read from the environment
only — `AGEN_ENGINE_FACTORY`, `AGEN_ENGINE_HOOK`, `AGEN_ENGINE_REGISTRY` — as
[`apps/indexer/src/addresses.ts`](../../apps/indexer/src/addresses.ts) states outright:
"these contracts are not in `@verdant/config`'s deployment record yet."

### Instant, and the seat factory

Recorded in [`packages/config/src/deployments.ts`](../../packages/config/src/deployments.ts)
only.

| Contract | Address | What it does |
| --- | --- | --- |
| `InstantFactoryOrigin` | `0xF2d8Ed8A66513c57d3c75384C4dA7b20B165B89a` | Anchor. |
| `InstantDeployer` | `0x124b731De0Cc97CcAd5960683FF4E94372B6d582` | Token, vault and locker bytecode for Instant markets. |
| `MarketRegistry` (Instant) | `0xAE8E1f39680A0fc7a164de25c1533179E853a807` | Instant's own registry instance. |
| `InstantHook` | `0xa3a48A91B52e8553a9422f7eD71497d76405B8Cc` | Low 14 bits `0x38cc`. Both delta-returning bits, which is what lets it charge at all. |
| `InstantFactory` | `0xF85b06710E2CbEf54230c92733e12824c8fCa2D6` | Launch entry point. |
| Instant treasury | `0xabfB34D1C870c7b2334E93b25B1299346209bE38` | Where the platform 0.50% accrues. An EOA. |
| `CreatorSeatFactory` | `0x1068e2Ccdba99bb9594Cd730728b0B79E5b36B3f` | Per-holder contract a market may name instead of a wallet. Permanently load-bearing. |

### Deployed but deliberately unwired

| Contract | Address | Status |
| --- | --- | --- |
| `FeeForwarderFactory` | `0x266DEbCE6d33a4b84C140541bC142c7C8b46ae63` | On chain and working; `feeForwarderFactory: null` in config. No market has ever named a forwarder. |

### Not deployed

The agent layer (`AgentLaunchFactory`, `AgentIdentityRegistry`, `AgentServiceRegistry`) and
Agen Boost (`BoostEscrowFactory`, `BoostEscrow`) are written, tested and indexed-for, but
have never been broadcast. `ADDONS[4663].agents` and `instant.boost` are both `null`. The
indexer still registers their handlers against the zero address, so that
`ponder codegen` can type event names on a build made before the deployment exists.

External, not deployed by this repo: `PoolManager` `0x8366a39cc670b4001a1121b8f6a443a643e40951`,
`PositionManager` `0x58daec3116aae6d93017baaea7749052e8a04fa7`, plus the quoter, state view,
universal router, Permit2 and the canonical CREATE2 deployer — all in
[`packages/config/src/chains.ts`](../../packages/config/src/chains.ts).

## The canonical config schema

Defined in [`packages/market-engine/src/spec.ts`](../../packages/market-engine/src/spec.ts)
as `CanonicalConfig`. This is the authoritative representation: "everything downstream reads
this. If two things about a market can disagree, one of them is not reading this."

| Field | Type | In the hash? |
| --- | --- | --- |
| `engineVersion` | `1 \| 2` | yes |
| `referenceSupply` | `bigint` | yes |
| `quoteAsset` | `QuoteAssetBinding` — `address`, `symbol`, `decimals` | address only |
| `launchedTokenSymbol` | `string` | **no** — display only |
| `feeCurrency` | `"QUOTE" \| "TOKEN"` | yes |
| `ladderAxis` | `"TIME" \| "QUOTE_VOLUME" \| null` | yes |
| `stages` | `CanonicalStage[]` — `threshold`, `buyFeePpm`, `sellFeePpm` | yes |
| `buyTiers`, `sellTiers` | `CanonicalTier[]` — `thresholdTokens`, `feePpm` | yes |
| `distribution` | `CanonicalShare[]` — `recipient`, `sharePpm` | yes |
| `maxBuyTokens`, `maxSellTokens` | `bigint \| null` | yes |
| `walletMaxBuyTokens` | `bigint \| null` (v2) | yes |
| `walletWindowSeconds` | `number` (v2) | yes |
| `epochPeriodSeconds` | `number` (v2) | yes |
| `buybackTriggerTokens` | `bigint \| null` (v2) | yes |

Invariants the compiler establishes before anything is canonical: at least one stage, stage 0
always has threshold 0, stages and tiers ascending by threshold, tier comparison always `>=`
(a `GT T` became `GTE T + 1`), distribution ordered canonically and totalling exactly
`PPM_ONE`. `feeCurrency` is **derived, never stated** — a market with size tiers must charge
in the launched token, per
[ADR-018](../decisions/018-the-engine-derives-its-fee-currency.md).

`Recipient` is a closed union of five variants — `CREATOR`, `TREASURY`, `ADDRESS`,
`LARGEST_HOLDER` (v2), `BUYBACK` (v2) — and none carries calldata, a call target or a
selector, so a recipient can never reenter or revert a swap.

The wire form is `CONFIG_ABI` (v1) and `CONFIG_V2_ABI` (v2) in
[`packages/market-engine/src/encode.ts`](../../packages/market-engine/src/encode.ts): one ABI
tuple mirroring `AgenRuleLib.Config` field for field. Integer widths are part of the contract,
not just the encoding — `threshold` is `uint128`, and when it was `uint256` here every launch
transaction was addressed to a selector that did not exist while every hash still matched.

## Where configHash is computed

In three places that are held equal to each other, and in none of them is it accepted as an
argument:

1. **TypeScript** — `configHash(config)` in
   [`packages/market-engine/src/encode.ts`](../../packages/market-engine/src/encode.ts), as
   `keccak256(encodeConfig(config))`. No domain tag, no chain, no engine in the preimage.
2. **Solidity** — `AgenEngineHook.configure` derives it from the configuration it has just
   stored and returns it. The factory supplies no hash; it checks the one it gets back.
   `RuleLib.vectors.t.sol` asserts the Solidity and the TypeScript produce identical bytes for
   every committed vector.
3. **The indexer** — [`apps/indexer/src/agen-engine.ts`](../../apps/indexer/src/agen-engine.ts)
   re-encodes the configuration out of the launch calldata through `CONFIG_ABI`, hashes it, and
   compares against the `configHash` the hook emitted. Unequal or undecodable stores `null`
   rather than an approximation.

`implementationHash` is the separate, stronger value: `keccak256` over a domain separator, the
chain id, the engine address and the config hash. Two markets sharing a `configHash` charge
the same fees anywhere; only a matching `implementationHash` says they run on the same engine
on the same chain. The domain separator exists because `implementationHash` occupies the same
registry slot that engine-0 markets use for the hash of their generated Solidity.

## Persistence today

**There is no application-layer persistent store in this repository. None. Not Postgres, not
Drizzle, not Prisma, not SQLite.** The only database is the one Ponder manages for the
indexer, and it is not usable as an application store. The code says so itself, in
[`packages/market-compiler/src/store.ts`](../../packages/market-compiler/src/store.ts):

> The repository has no general-purpose database — Ponder's store belongs to the indexer and
> holds chain observations, and putting off-chain build state in it would mix "what the chain
> said" with "what a model proposed", which is exactly the distinction the indexer's own
> schema is careful about.

What exists, precisely:

| What | Store | Schema | Where the code is |
| --- | --- | --- | --- |
| Chain observations (markets, swaps, agents, fees) | Postgres, owned and migrated by Ponder 0.17.4. Falls back to embedded PGlite on disk when `DATABASE_URL` is unset. | 21 `onchainTable` definitions | [`apps/indexer/ponder.schema.ts`](../../apps/indexer/ponder.schema.ts) |
| Instant markets, swaps, Boost | A **separate** Ponder Postgres, its own `DATABASE_URL` | 4 `onchainTable` definitions | [`apps/instant-indexer/ponder.schema.ts`](../../apps/instant-indexer/ponder.schema.ts) |
| Generation jobs / builds (off-chain, mutable) | A `Map` in memory, or a directory of JSON files | `GenerationJob`, via a `JobStore` interface | [`packages/market-compiler/src/store.ts`](../../packages/market-compiler/src/store.ts) |
| The web app's own data | **Nothing.** `apps/agen/package.json` declares no database client of any kind. | — | — |

Three properties of the Ponder store make it the wrong home for a Program registry, and they
are properties of the tool rather than of how it is configured:

1. Every table is an `onchainTable` — reorg-tracked, and rebuilt from the start block on a
   reindex. Author-authored rows would not survive one.
2. Ponder owns its own schema and migrations. There is no `drizzle.config.*`, no migrations
   directory, and no `drizzle-kit` anywhere in the workspace. In tracked source, `drizzle`
   appears only in two `tsconfig.json` `types` arrays; every other occurrence is inside
   Ponder's own dependency tree or in gitignored build output — `apps/*/.vercel/node/package-manifest.json`
   lists `drizzle-orm` because Ponder depends on it, which is not a Drizzle setup.
3. Writes happen only inside indexing functions, driven by chain events. There is no path by
   which an HTTP request could write a row.

The `JobStore` interface is the one seam deliberately left for this: "when Postgres exists for
the application layer, a third implementation goes here and nothing above it changes."

## Indexer tables

21 tables in [`apps/indexer/ponder.schema.ts`](../../apps/indexer/ponder.schema.ts), all
`onchainTable`.

**Verdant market layer** — `pool_init`, `market`, `market_contract`, `swap`, `fee_collection`,
`claim`, `vesting_release`, `holder`.

**Agent layer** (indexed but never deployed) — `agent`, `agent_contract`, `agent_service`,
`agent_revenue`, `agent_treasury_asset`, `agent_activity`.

**Agen generated and engine markets** — `agen_market`, `agen_swap`, `agen_pending_fee`,
`agen_component`.

4 more in [`apps/instant-indexer/ponder.schema.ts`](../../apps/instant-indexer/ponder.schema.ts)
— `pool_init`, `instant_market`, `instant_swap`, `boost_buyback`.

`agen_market` is the table v4.fun cares about. Both identity columns already exist on it:

- `configHash` — `t.hex()`, nullable, engine 1 only. From the hook's own derivation.
- `encodedConfig` — `t.hex()`, nullable. The canonical bytes, stored only when they hash to
  `configHash`. This is the column that makes a market's economics readable without its prompt.
- `implementationHash` — `t.hex()`, not null. From the event.
- `engineVersion` — `t.integer()`, not null. 0 for a generated market, 1 for a configuration.

Note the shared-hook consequence recorded on the schema: at engine 1 the `hook` column stopped
being an identifier, `AgenMarketRegistry.marketByHook` is last-write-wins, and nothing may
resolve an engine market through it.

There is **no** table keyed by `configHash`, and no table grouping markets by their economics.
Grouping is the question a Program answers and the indexer cannot: `agen_market` has an index
on `engineVersion` but none on `configHash`.

## Indexed events

29 handlers in the main indexer:

- **Uniswap** — `PoolManager:Initialize`, `PoolManager:Swap`.
- **Verdant** — `VerdantFactory:MarketCreated`, `VerdantToken:Transfer`,
  `VerdantToken:MetadataURIUpdated`, `FeeSplitter:Claimed`, `PositionLocker:FeesCollected`,
  `TokenVesting:Released`.
- **Agen engine 0** — `AgenFactory:MarketDeployed`.
- **Agen engine 1** — `AgenEngineFactory:EngineMarketDeployed`, `AgenEngineHook:FeeTaken`.
- **Agents** (never deployed) — 20 handlers across `AgentLaunchFactory`,
  `AgentIdentityRegistry`, `AgentMandate`, `AgentTreasury`, `AgentServiceRegistry`,
  `AgentRevenueRouter` and `AgentExecutionModule`.

10 in the Instant indexer: `PoolManager:Initialize`, `PoolManager:Swap`,
`InstantFactory:MarketCreated`, `InstantFeeVault:Accrued`, and six `BoostEscrow` events.

`EngineMarketDeployed` is the only event carrying a `configHash`. Its full signature is
`(uint256 indexed index, address indexed token, address indexed creator, PoolId poolId,
address vault, address locker, uint8 engineVersion, bytes32 configHash, bytes32
implementationHash)`. `FeeTaken` is what a swap's real rate comes from at engine 1 — the hook
sets the pool's LP fee to zero and takes its fee as a swap delta, so the `Swap` event reports
`feePpm` of 0 and is not the rate.

No event anywhere carries a Program name, an author handle, a version, or a parent. Lineage is
not observable from the chain.

## What already produces identity, simulation and review

All of it in `@verdant/market-engine`, none of it in `@verdant/sdk`. See
[Corrections](#corrections-to-stated-assumptions).

| Need | Function | Module |
| --- | --- | --- |
| Canonical config from a spec | `compile(spec, binding)` → `CompileResult` | `compile.ts` |
| Canonical config from bytes | `decodeConfig(encoded, labels)` → `CanonicalConfig` | `encode.ts` |
| Canonical bytes | `encodeConfig(config)` | `encode.ts` |
| **configHash** | `configHash(config)` | `encode.ts` |
| **implementationHash** | `implementationHash(config, identity)` | `encode.ts` |
| Calldata struct fields | `configFields`, `configFieldsV2`, `CONFIG_ABI`, `CONFIG_V2_ABI` | `encode.ts` |
| **Simulation output** | `simulate(config)` → `Simulation` | `simulate.ts` |
| **Plain-English review text** | `review(config)` → `Review` (cards and rows), `engineSummary(config)` | `review.ts` |
| Fee at a given trade | `evaluate`, `activeStageIndex`, `matchingTierIndex`, `maximumFeePpm` | `evaluate.ts` |
| Execution shape | `executionGraph(config)` | `graph.ts` |
| Exact percent/ppm arithmetic | `percentToPpm`, `ppmToPercent`, `supplyPercentToTokens`, `PPM_ONE` | `units.ts` |

`review()` is derived entirely from `CanonicalConfig`, which is what makes it trustworthy as
disclosure: it describes what will execute, not what a creator asked for.

`@verdant/sdk` owns ABIs (`abi.*`, including `agenEngineFactoryAbi`), pool and market reads,
candles, schedule maths, trade building, fees and agent reads. `@verdant/config` owns chain
definitions, deployment addresses, bounds, models and quote assets.

Differential vectors: 17 committed cases in
[`packages/market-engine/vectors`](../../packages/market-engine/vectors), each carrying
`encoded`, `configHash` and `implementationHash`. They are hashed against an engine identity
pinned in the generator — `0x000000000000000000000000000000000000c0de`, which is not a
deployed contract — so they establish agreement with the encoder, **not** with any chain.

## Live engine markets

Read from chain at block 44 929 524 on 2026-08-24. `count()` on the engine registry
`0x71a284dd8Efe6aBFd240B96E861486638B0099eE` returns **2**. These are every engine-1 market
that exists, not a sample.

| # | Symbol | Token | configHash | Launch block |
| --- | --- | --- | --- | --- |
| 0 | `CSCD` (Cascade) | `0xbe44e1e5284bC521e7fcD80833C26a537289bb39` | `0x1d0a28dc…6f8efc8a` | 44 363 849 |
| 1 | `TAX` | `0x3F9E4b9a0ebcF89D1066682b5E6ea9080913f965` | `0x7341d3ab…a41b203d` | 44 429 013 |

Both are `engineVersion` 1. Both launch transactions decode cleanly, and for both the
configuration re-encoded from calldata hashes to the `configHash` the hook emitted — so both
have provable canonical bytes. Their full records, including `encodedConfig`, are committed at
[`packages/registry/src/fixtures/mainnet-engine-markets.json`](../../packages/registry/src/fixtures/mainnet-engine-markets.json)
and are what acceptance test 1 asserts against.

The engine-0 registry `0x3AE1a797750ed9988ea7C2348534519E44Ed0791` returns `count()` of 3, but
engine-0 markets have **no** `configHash` — the column is null for them by design — so they
cannot participate in a Program.

## Corrections to stated assumptions

Five places where the milestone's premises did not match the repository.

1. **`packages/sdk` is not the source of truth for canonicalization or hashing.**
   `@verdant/market-engine` is. `configHash`, `implementationHash`, `encodeConfig`,
   `decodeConfig`, `CONFIG_ABI`, `simulate` and `review` all live there, and
   `packages/sdk/src/index.ts` neither exports them nor re-exports the engine package.
   Chain config, addresses and bounds are a third package, `@verdant/config`. The SDK does own
   ABIs. `packages/registry` therefore imports `@verdant/market-engine` directly, as directed.

2. **There is no existing Drizzle setup and no application-layer Postgres.** See
   [Persistence today](#persistence-today). Deliverable C was dropped for this reason; the gap
   is recorded below as a recommendation rather than an implementation.

3. **Only two engine-1 markets exist, not three.** Acceptance test 1 asserts against both, and
   records the count, rather than sampling three from a larger set that does not exist.
   Acceptance test 6 covers the other seventeen configuration shapes from the committed
   vectors, and is labelled vector-based rather than chain-verified because that is what it is.

4. **"Mainnet" here is Robinhood Chain mainnet, chain 4663** — an Arbitrum Orbit chain that
   settles to Ethereum — not Ethereum mainnet. Verification is Blockscout throughout;
   Etherscan does not index the chain.

5. **The engine's addresses are not in the shared config package.** They are environment-only
   (`AGEN_ENGINE_FACTORY`, `AGEN_ENGINE_HOOK`, `AGEN_ENGINE_REGISTRY`) and appear in
   `deployments/robinhood.json` but not in `packages/config/src/deployments.ts`. Anything
   resolving the engine from `@verdant/config` today gets nothing.

Two further observations, offered rather than corrected:

- **The two deployment records cover different sets.** `AgenRouter`, `CreatorSeatFactory` and
  the entire Instant stack are in the TypeScript record but absent from
  `deployments/robinhood.json`; the engine layer is in the JSON but absent from the TypeScript.
  There is no single place that lists every deployed contract.
- **The working tree was dirty at audit** — 76 modified files, many in the engine launch and
  indexer paths, including `apps/agen/src/app/lib/programmable.ts` and
  `apps/indexer/src/agen-engine.ts`. Nothing in this milestone depends on those changes, but
  M1 layered on top of uncommitted engine work would be hard to attribute.

No CI gate blocked this work. `pnpm verify:docs` resolves the links in this file;
`packages/registry` adds `build`, `typecheck` and `test` scripts that Turbo picks up by
convention, and no existing task definition, test or lint configuration was edited.

## Decisions

Recorded as they are taken, newest last.

### D1 — The registry is tolerant of which engine version exists

`packages/registry` reads the four engine-v2 rule fields — `walletMaxBuyTokens`,
`walletWindowSeconds`, `epochPeriodSeconds`, `buybackTriggerTokens` — through an optional view,
and treats an absent one exactly as the engine's own `NO_V2_RULES` treats it: no wallet limit,
no epoch, no buyback. The `Recipient` switch likewise handles all five variants although a v1
build declares only three.

**Why.** This was found the hard way. M0 was written against a working tree that carried
uncommitted engine-v2 changes, and it read those four fields directly. When the v2 work was moved
to its own branch, `packages/registry` stopped compiling on the engine-v1 base — eight type
errors — and fourteen of its tests failed at runtime with `walletWindowSeconds must be a bigint,
a number or a decimal string, got undefined`. The chain-verified identity tests were unaffected;
the failure was confined to normalization.

The general principle is the reason the fix is tolerance rather than a version pin. This package
sits downstream of a schema it does not own, and it is meant to be consumed by more than one
surface. A registry whose build depended on which engine branch was checked out would push that
dependency onto every consumer, and the failure mode is bad in both directions: pinned to v1 it
silently ignores v2 rules that change what a market charges, and pinned to v2 it will not build
until v2 ships.

**Why this is not the coercion `normalize.ts` otherwise refuses.** That file refuses to round a
rate or truncate a threshold, because a nearly-right fee merges two markets that charge
differently. Reading an *absent* wallet limit as "no wallet limit" is not that. A v1 market
genuinely has no wallet limit, so the absence is a fact and recording it preserves the economics
exactly. A field that is present and unreadable is still a refusal.

**What it does not change.** `configHash` is untouched and still comes from
`@verdant/market-engine`. On the engine-v1 base `CONFIG_ABI` does not carry the v2 fields at all,
so spelling them out as empty cannot change the canonical bytes and therefore cannot change the
identity — which `version-tolerance.test.ts` asserts, along with the general invariant that the
hash changes exactly when the bytes change. That test also records that the hash half of the
question is not exercisable on this base rather than manufacturing a case for it.

## Missing

What a Program registry needs that does not exist anywhere in this repository today.

### Blocking

1. **An application-layer persistent store.** The single largest gap, and the reason
   deliverable C was dropped. Nothing off-chain and mutable can be persisted today except as
   JSON files owned by one worker process.

   *Recommendation:* stand up one Postgres for the application layer, separate from both
   Ponder databases, and reach it with `drizzle-orm` plus `drizzle-kit` for migrations. Both
   are new runtime dependencies, which is why this is a decision to take rather than something
   to slip in — the M0 constraint forbade it. Implement it behind the existing `JobStore`
   seam so the compiler is unaffected, and keep `programs`, `program_versions`,
   `program_markets` and `program_lineage` in that database, never in Ponder's. Read chain
   facts by joining against the indexer's HTTP API, not its tables.

2. **A `configHash` index, and a Program-shaped read path.** `agen_market` stores
   `configHash` but has no index on it, and no API route groups markets by it. "Every market
   running these economics" is currently a table scan and is not exposed at all.

### Not in any event or table

3. **Authorship beyond an address.** `creator` is the only author fact on chain. Handles,
   display names and profiles exist nowhere. `ProgramAuthor.handle` and `displayName` are
   nullable for this reason.

4. **Program names and descriptions.** Deliberately outside the commitment, so they must come
   from somewhere else. `metadataURI` is per market, not per Program, and points at
   `agen.space` JSON.

5. **Lineage.** No event, table or contract records that one configuration was derived from
   another. `LineageEdge` can only be written by the surface that accepted the edit, at the
   moment it accepts it. It is unrecoverable retroactively — including for the two markets that
   already exist.

6. **A fork or revision count.** Follows from lineage being absent.

7. **The distinction between a revision and a fork.** Both produce a new `configHash`; only
   the accepting surface knows whether the author was the same person.

8. **Submission-time deduplication.** `configHash` cannot be computed for a configuration that
   has not been compiled, and two JSON submissions of the same market can differ in key order
   and numeric representation. `normalizeForDedupe` in `packages/registry` closes exactly this
   gap and is the reason it exists beside `deriveProgramIdentity` rather than inside it.

9. **Cross-chain Program identity.** `configHash` is already chain-independent, so the type
   supports it, but only chain 4663 has a deployment and `MarketRef.chainId` is unexercised.

10. **A Program-to-market backfill.** The two live markets predate the registry. Populating it
    means replaying `EngineMarketDeployed` and recovering `encodedConfig` from calldata — which
    the indexer already does, and which nothing currently persists outside its own store.
