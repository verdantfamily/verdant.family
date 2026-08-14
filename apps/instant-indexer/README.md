# @verdant/instant-indexer

The feed for Instant markets. A second Ponder app beside `@verdant/indexer`, against a
second Postgres, watching two contracts: `InstantFactory` and Uniswap's `PoolManager`.

## Why this is not part of `@verdant/indexer`

The tables could have lived there — they did, briefly, and touched nothing of Verdant's or
Agen's. The problem is the deploy, not the schema.

Ponder identifies an app by a hash of its configuration and code, and `railway.toml` starts
every deployment with `--schema "$RAILWAY_DEPLOYMENT_ID"`. So each deploy indexes into a
fresh empty schema from its start block — on *any* deploy, not only one that changed a
table. Combined with `overlapSeconds = 0` and a health check on `/health`, which answers as
soon as the process is listening rather than when the backfill finishes, every deploy of
that service leaves a window where the feed is up and its data is incomplete. While Instant
shared it, an Instant-only change spent that window on the Programmable feed.

Separating them means an Instant deploy reaches Instant and nothing else. It also makes the
backfill trivial: this app watches the PoolManager from Instant's factory block rather than
Verdant's, because nothing Instant cares about can predate its own factory — about ten
million blocks later on 4663.

The cost is that both apps subscribe to the PoolManager and Ponder's log cache
(`ponder_sync`) is per-database, so those logs are fetched twice.

This does not fix the deploy window for Programmable, which still re-indexes on each of its
own deploys. That fix is `--views-schema` with a `/ready` health check and overlap enabled,
and it belongs in `railway.toml` rather than in either indexer.

## What it serves

Under `/instant`, which is kept even though nothing else is served here — the app already
asks for that prefix, and it keeps the two feeds distinguishable in a log or a proxy rule.

- `/instant/markets` and `/instant/markets/:id`
- `/instant/markets/:id/swaps`
- `/instant/markets/:id/stats`
- `/instant/markets/:id/candles`

`:id` is a pool id or a token address; both work, because the interface addresses an Instant
market by its token while everything internal carries a pool id.

No route reports a fee. `InstantHook` overrides the pool's LP fee to zero and takes its
1.50% from the ether leg, so the rate v4 reports is zero and publishing it would invite a
reader to conclude Instant is free. The real rate is a constant of the deployment
(`InstantFees`) and the page states it once. See ADR-014.

## Configuration

Addresses come from the `instant` record in `@verdant/config`, so a deploy of this and a
deploy of the app cannot disagree about which Instant they are following. The environment
overrides it, which is what lets the proof rig run against a local anvil.

| Variable | Meaning |
| --- | --- |
| `DATABASE_URL` | Its own Postgres. Without it Ponder uses PGlite on disk. |
| `PONDER_RPC_URL_4663` | The chain. Falls back to the public endpoint. |
| `INSTANT_FACTORY`, `INSTANT_REGISTRY` | Override the record. Both or neither. |
| `INSTANT_START_BLOCK` | Override the record's `deployedAtBlock`. |
| `VERDANT_POOL_MANAGER` | Uniswap's singleton, for a rig that deployed its own. |

The app reads this service through `AGEN_INSTANT_FEED_URL`, which has no fallback to
`AGEN_FEED_URL`: the two indexers hold different tables, so pointing one at the other would
not degrade, it would 404 every request while looking configured.

## Proving it

```sh
bash scripts/instant-proof.sh
```

Starts anvil, deploys a Uniswap v4 and the real Instant deployment script onto it, launches
and trades two markets, runs this indexer over the whole history, and then asks the chain
the same questions the feed answers and requires the same numbers. An indexer that runs
without crashing proves nothing; the failures that matter are the plausible wrong ones.
