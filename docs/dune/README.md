# Getting Agen onto Dune

How agen.space becomes a named launchpad in Robinhood Chain analytics rather than a share
of somebody's Unclassified bucket — and, the narrower question that prompted this, how it
appears in [the robinhood trenches](https://dune.com/adam_tehc/the-robinhood-trenches).

The short answer is that nothing needs to be built. Our activity is already on Dune, in
`robinhood.logs` and in `dex.trades`; what is missing is a name attached to it. Three
things attach it, in increasing order of how much they depend on other people:

1. **Publish the numbers ourselves.** The queries in `queries/` run today against raw logs
   and need no permission from anyone. This is the fallback and the proof.
2. **Submit our contracts for decoding**, so `agen_robinhood.*` tables exist and any
   analyst can find us by name instead of by address. One form, roughly a day.
3. **Get into other people's dashboards**, which for the trenches specifically means one
   address in one registry. `outreach.md` is the message; it asks for one line of SQL.

None of the three blocks the others. Do 1 and 2 the same day, send 3 immediately after.

## What is already true

Verified on chain on 2026-08-18, not taken from the deployment record:

| Fact | Value |
| --- | --- |
| Chain | Robinhood Chain, id `4663`, indexed by Dune as the `robinhood` schema |
| InstantFactory | `0xF85b06710E2CbEf54230c92733e12824c8fCa2D6` — 32 `MarketCreated` logs, one per launch |
| InstantHook | `0xa3a48A91B52e8553a9422f7eD71497d76405B8Cc` — `FeeTaken` on every swap |
| InstantDeployer | `0x124b731De0Cc97CcAd5960683FF4E94372B6d582` — the deploying contract of **every** Agen token |
| MarketRegistry | `0xAE8E1f39680A0fc7a164de25c1533179E853a807` |
| Uniswap v4 PoolManager | `0x8366a39cc670b4001a1121b8f6a443a643e40951` — shared, already covered by Dune |
| First block | `36378954` |
| Explorer | Blockscout; factory, hook, deployer, registry and the launched tokens are **verified** |

The one fact that matters more than the others: **every token the platform has launched
was deployed by the same contract.** The trenches dashboard classifies a token by its
deploying contract, so Agen is one row in that registry, not a list that grows with every
launch. That is why the ask in `outreach.md` is small enough to be granted.

Two contracts per market are *not* verified on Blockscout — the fee vaults and the
position lockers — because verification is backfilled per launch. `scripts/verify-instant.sh`
in `packages/contracts` submits them. Worth running before the Dune submission, since Dune
auto-fetches an ABI when the explorer has one and otherwise needs it pasted.

## 1. Submit the contracts for decoding

Form: <https://dune.com/contracts/new>. Blockchain `robinhood`, project name `agen`,
contract name as in the source, ABI from `abi/` in this directory. `contracts.csv` holds
the same seven rows for batch submission, which Dune allows for larger sets through their
Discord — the UI is preferred because it validates.

The flags are the part worth getting right:

| Contract | Instances | Flags |
| --- | --- | --- |
| `InstantFactory` | one | none |
| `InstantHook` | one | none |
| `MarketRegistry` | one | none |
| `InstantDeployer` | one | none — no events, but it is the attribution key, so name it |
| `InstantFeeVault` | one per market | **created by a factory** |
| `VerdantToken` | one per market | **created by a factory** |
| `PositionLocker` | one per market | **created by a factory** |

The last three are created by `InstantDeployer` via CREATE2, which is a contract and not
an EOA, so Dune's factory decoding covers every past and future instance from a single
submission. Do not tick "several instances" as well: that is bytecode matching, a
different mechanism, and for these it would add nothing.

Standard ERC-20 transfers and approvals are already covered chain-wide, so `VerdantToken`
is submitted only for `MetadataURIUpdated`.

## 2. The queries

They read raw logs and depend on nothing but the two contract addresses and the event
hashes, each of which was checked against a real log rather than derived on paper.

| File | Answers |
| --- | --- |
| `queries/01-launches.sql` | tokens launched per day, cumulative, distinct creators |
| `queries/02-volume-and-fees.sql` | volume in ETH, trades, buy/sell split, fee revenue — from the hook, exact |
| `queries/03-fees-from-vaults.sql` | the creator / platform split as the vaults recorded it; the audit of 02 |
| `queries/04-launchpad-registry.sql` | the "these tokens are agen.space" mapping, in two forms |
| `queries/05-token-leaderboard.sql` | per-token volume, trades, fees, creator, age |
| `queries/06-usd-volume-from-dex-trades.sql` | dollar volume via `dex.trades`, for comparability with other launchpads |

Event hashes, verified against on-chain logs:

| Event | topic0 |
| --- | --- |
| `MarketCreated(bytes32,address,address,address,address,uint256,uint128)` | `0xfa6c34fa05477e064a6e4e145862c55b70dfa10c7b9c63f7bcbfb0d1b1baa6bd` |
| `FeeTaken(bytes32,bool,uint256,uint256)` | `0x6db99c89e7a1431b600f2a091622e384cb8d1dd77acd42d234af103d6d1a24a0` |
| `Accrued(uint256,uint256,uint256)` | `0x08a1072afb388d5a429e5b35717dca12bcc4c7ac42d97954f9452977280c8268` |
| `MarketRegistered(bytes32,address)` (hook) | `0x3275e37df747e74e41d61bd15118ec07cce2d70a430d3a8a87a69f206c3811df` |
| `MarketRegistered(bytes32,address,address,uint8,uint256)` (registry) | `0xff38f2857b2e585addc089bb9e11af3ae81a93c22361a36ec531591552e8f567` |
| `Claimed(address,uint256)` | `0xd8138f8a3f377c5259ca548e70e4c2de94f129f5a11036a15b69513cba2b426a` |

These have not been executed against Dune — there is no API key in this repo, and the
editor is the cheapest place to catch a column name that has moved. Run each once, then
save them into a dashboard named for the platform.

### Why the hook and not the Swap event

Our hook sets `beforeSwapReturnDelta` and `afterSwapReturnDelta`, which means a Uniswap v4
`Swap` event can report amounts that understate what actually moved. Dune's Robinhood v4
tables are built from swap **call traces** for exactly this reason, so `dex.trades` should
be right — but the hook's own `FeeTaken` is the figure the contract acted on, and it is
also where the fee comes from, so it is what `02` uses. Where the two disagree materially,
the hook is right, and the discrepancy is worth reporting to Dune rather than quietly
absorbing.

## 3. What the numbers should say

The site publishes the same figures at `agen.space/metrics`, from the same events by way of
the indexer, so the two are checkable against each other — which is the point, and which is
why the check was run before any of this was written. Decoding the logs at exactly the byte
offsets the SQL uses, over the whole chain, against the indexer, on 2026-08-18:

| Figure | From the logs | From the indexer | |
| --- | --- | --- | --- |
| Launches | 32 | 32 markets | agrees |
| Trades | 3,126 `FeeTaken` | 3,126 | agrees |
| Ether leg | 101.670647 ETH | `fees.etherLeg` 101.670647 | agrees to the wei |
| Fees total | 1.525060 ETH | `fees.total` 1.525060 | agrees to the wei |
| Creator share | 1.016706 ETH (2/3) | `fees.creator` 1.016706 | agrees to the wei |
| Platform share | 0.508353 ETH (1/3) | `fees.platform` 0.508353 | agrees to the wei |
| Fee as share of the leg | 1.5000% | 1.50% by construction | agrees |

One difference is real and worth knowing before someone calls it a bug: the site's headline
volume is the pool's swap amount, `100.873351` ETH here, while `02-volume-and-fees.sql`
sums the **ether leg the fee was charged on**, `101.670647` ETH — about 0.8% higher. Both
are defensible and neither is wrong; the ether leg is used here because it is the figure
the contract itself acted on, and because it makes volume and revenue come from one event
rather than two sources that have to be reconciled.

## Beyond this

- **Spellbook.** A contribution to `duneanalytics/spellbook` would put the attribution in
  the canonical models rather than in one analyst's registry, so every dashboard picks it
  up without being asked. Robinhood's DEX models already exist there
  (`dbt_subprojects/dex/models/trades/robinhood/`), which is the pattern to follow.
- **The other aggregators.** The same launch and fee events feed the DEX Screener adapter
  already built for `api.agen.space`; GeckoTerminal and DefiLlama read the same shape.
  Being listed in three places from one event surface is the argument for keeping that
  surface stable.
