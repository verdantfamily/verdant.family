# Deploying Verdant to Robinhood mainnet

A Verdant deployment cannot be corrected. The hook's address is mined and v4 reads its
permissions from that address on every call; the factory, both registries and the
deployer name each other in immutables; the anchor can create exactly once. There is no
owner who can rewire anything and no upgrade path, which is the property the protocol is
sold on and also the reason a mistake here is not patched but abandoned — a fresh
deployment at fresh addresses, with any markets created in the meantime stranded on a
factory nobody uses.

So this is written as a checklist, in order, with the reason each step exists. Do not
skip a step because the previous one looked fine.

## 1. Decide the two addresses that cannot be changed later

**The treasury.** `FeeSplitter` takes it as an immutable at market creation, so every
market ever launched pays this address the protocol's share for as long as it trades. A
market created against the wrong treasury cannot be repointed.

**The registry owner.** This is the one live privilege in the system. It can change the
bounds and the protocol share *for markets created afterwards* — it cannot touch a live
market, which is what the immutables are for. It should be a Safe, not an EOA; canonical
Safe factories are deployed on 4663 (see V15 in [verification.md](verification.md)). The
verifier warns if this address has no code, and that warning is worth acting on rather
than acknowledging.

Neither is derivable from anything on chain, so neither can be checked by any amount of
internal consistency. They are checked against what you say you meant, in step 5.

## 2. Pre-flight

Run from the repository root. All of these must be clean before anything is broadcast.

```bash
pnpm install
pnpm test                      # the TypeScript packages
pnpm bounds:emit && git diff --exit-code -- packages/config/generated/bounds.json
cd packages/contracts
forge test                     # the full suite, no network
bash ../../scripts/fork-test.sh # the fork suite; needs network
```

Read the fork output rather than the exit status. The script deliberately passes when the
RPC is unreachable, because a CI gate that fails on someone else's outage gets ignored —
but that tolerance means a run that proved nothing looks like a run that passed. It says
so in a warning when that happens.

The fork run is the one that matters most: it launches a market against the Uniswap
actually deployed on 4663, and it is the only thing that has ever confirmed that
`IMsgSender.msgSender()` on the deployed PositionManager reports what the liquidity
guard depends on. It also prints the two gas figures — a launch is ~3.28M and the most
expensive launch the bounds permit is ~4.10M, against a 32M per-transaction cap.

If the fork suite fails on the `code.length` assertions, Uniswap has been redeployed on
4663 and the pinned addresses in `packages/config/src/chains.ts` need revisiting before
anything else happens.

## 3. Fund the operator, and understand what its nonce does not matter for

The operator is an ordinary account; it needs enough ETH for six contract creations plus
the hook mining is free (it happens off chain, in the script). Nothing about its
transaction count matters: the factory's address comes from `FactoryOrigin`, which
computes it from its own address and its own first-creation nonce, so the deployment does
not depend on the operator having a particular nonce and the sequence is identical to the
one CI runs (ADR-007).

## 4. Simulate, read the address book, then broadcast

Simulate first. This touches real chain state and produces the exact addresses the
broadcast will produce, without sending anything:

```bash
cd packages/contracts

export POOL_MANAGER=0x8366a39CC670B4001A1121B8F6A443A643e40951
export POSITION_MANAGER=0x58daec3116aae6D93017bAAea7749052E8a04fA7
export TREASURY=0x...            # step 1
export REGISTRY_OWNER=0x...      # step 1, a Safe

forge script script/Deploy.s.sol --rpc-url robinhood --sender 0xYOUR_OPERATOR
```

Read the printed address book. Then broadcast:

```bash
forge script script/Deploy.s.sol --rpc-url robinhood --broadcast \
  --sender 0xYOUR_OPERATOR --interactives 1
```

Set `REGISTRY_OWNER` explicitly even though it has a default. The default is the
deploying key, which would leave the register owned by whatever laptop ran the script.

## 5. Verify before telling anyone the addresses

The deployment asserts its own wiring as it goes, but those assertions run inside the
transaction that creates the contracts, against values the same script computed. Pointed
at the wrong PositionManager, it would deploy a perfectly self-consistent protocol wired
to the wrong contract and report success.

The verifier starts from the other end: given only the factory, it takes every
counterparty from what the factory itself says, then asks each of those contracts who
*they* think the factory is. It also compares the deployed register against
`bounds.json`, checks the hook's address carries exactly `0x3880`, and checks the two
intents from step 1.

It checks the admitted quote assets by name, one at a time, which is worth understanding
because nothing else would catch a failure there. The set is seeded in `ModelRegistry`'s
constructor and never again; a deployment seeded from a stale `bounds.json` refuses every
stock-paired launch with `QuoteAssetNotAdmitted` while passing every other check in this
file. On 4663 the verifier also warns when an admitted address has no code, which is how a
typo in the reviewed list surfaces before somebody tries to launch against it.

Once step 6 has recorded the addresses, this reads them from there:

```bash
bash scripts/verify-mainnet.sh
```

Before that, or to check some other deployment, name them:

```bash
FACTORY=0x... \
ORIGIN=0x... \
EXPECTED_TREASURY=0x... \
EXPECTED_REGISTRY_OWNER=0x... \
forge script script/Verify.s.sol --rpc-url robinhood
```

It broadcasts nothing and needs no key. Read every line. `FAIL` means discard the
deployment and start again at step 4 — there is nothing to repair. Warnings are things
that were not checked, or were checked and are merely unwise; both deserve a decision
rather than a glance.

## 6. Record the addresses

Put them in `packages/config/src/deployments.ts`, which is where every other package
reads them from. The deploy script prints them in the order that file wants.

Commit that with the transaction hashes in the message. This is the only durable record
of which deployment is the live one — a second, abandoned deployment is
indistinguishable from the real one by inspection, since both pass every internal check.

## 7. Verify the source on Blockscout

Etherscan does not index 4663; verification is Blockscout only. The hook arrives through
the canonical CREATE2 deployer rather than from the operator, so it is verified by
address like the others:

```bash
forge verify-contract --chain-id 4663 --verifier blockscout \
  --verifier-url https://blockscout.mainnet.chain.robinhood.com/api \
  0xHOOK src/VerdantHook.sol:VerdantHook \
  --constructor-args $(cast abi-encode "c(address,address,address)" \
    $POOL_MANAGER $FACTORY $POSITION_MANAGER)
```

Repeat for `VerdantFactory`, `VerdantDeployer`, `MarketRegistry`, `ModelRegistry` and
`FactoryOrigin` with their own constructor arguments. Unverified source on an immutable
contract is a request to be trusted rather than read.

## 8. Launch one market, deliberately

The first market on a new deployment is a test whether it is called one or not, so make
it one on purpose: minimum supply, a single-stage Fixed schedule, no creator allocation,
and a treasury you control. Then buy a small amount, wait for a fee stage if the schedule
has one, call `collect()` on the locker, and claim from the splitter.

That exercises the whole path — creation, the hook's fee, the locked position, the split,
the pull — against the live deployment, for the price of a few hundredths of an ETH. The
fork suite already does exactly this, so a difference here means something about mainnet
differs from a fork of it, which is worth knowing before a stranger's money is involved.

## 9. The feed, which is a server rather than a contract

Everything above is immutable and finished. The indexer is neither: it is a process that
holds a Postgres database and follows the chain, and the site is a set of server components
that ask it questions. Vercel cannot host that — it has no long-running process and no
database — so the two live in different places, and `railway.toml` in the repository root is
the whole of the indexer's deployment.

```bash
railway up --service indexer        # from the repository root, not apps/indexer
railway logs --service indexer      # the backfill's progress, and its rate limiting
```

`DATABASE_URL` is the only variable that matters and Railway sets it, by reference to the
Postgres service in the same project. Ponder reads it and uses Postgres; with it unset it
falls back to PGlite in `apps/indexer/.ponder`, which is a single-writer file and the reason
a second indexer on one machine kills the first. Nothing else is configured, because the
chain, the factory, the hook and the block to start from all come from the deployment record
in `packages/config` — a feed and a site that disagreed about which Verdant they follow
would be worse than no feed.

Then Vercel's `VERDANT_FEED_URL` is set to the service's public URL.

### The public RPC cannot carry the feed, and this is measurable

Robinhood's own documentation says the public endpoint is not for indexing. What that means
in numbers, taken from the deployed service:

- The chain produces **10.25 blocks a second** — it is an Orbit L2 with sub-second blocks.
- The indexer ingests **11.6 blocks a second** through the public endpoint, most of its
  requests spent on 429s and backoff.

A margin of 1.3 blocks a second is not a margin. A gap of 200,000 blocks closes in two days
at that rate, and any dip in throughput below 10.25 means it never closes at all — the feed
would fall permanently further behind the chain it is following.

There is a second, harder limit. The public node keeps no archive state: an `eth_call` at a
block more than roughly an hour old returns `metadata is not found, <block>`. The indexing
functions work around this by reading write-once values at `latest` (see the comment at the
top of `apps/indexer/src/index.ts`), which is sound because those values cannot change — but
it is a workaround, and it forecloses anything that genuinely needs history.

So a provider key is not an optimisation here, it is a requirement. Robinhood recommends
Alchemy, `https://robinhood-mainnet.g.alchemy.com/v2/<key>`, and Dwellir, Alchemy, QuickNode,
dRPC, Blockdaemon and Validation Cloud all serve chain 4663 with archive access. Set it and
nothing else changes:

```bash
railway variable set PONDER_RPC_URL_4663=https://robinhood-mainnet.g.alchemy.com/v2/KEY --service indexer
```

One provider was tried and rejected: NodeFlare's keyless endpoint answers correctly from a
laptop, including archive reads, but Cloudflare returns 403 to Railway's egress addresses. An
RPC that works where you test it and not where it runs is worse than one that is merely slow,
so check a candidate from the deployment rather than from your machine.

## 10. The site

```bash
vercel deploy --prod          # from the repository root, with the root linked to the project
```

Two settings make that work, and both are easy to lose an hour to. The Vercel project's Root
Directory is `apps/web`, not `.`: the Next builder looks for `next` in the package.json it
finds there, and pointed at the repository root it finds a workspace with no framework and
refuses. Deploying from the root anyway is deliberate — the upload has to contain the whole
workspace, because `apps/web` alone is not installable.

And `apps/web/vercel.json` builds the three workspace packages before Next. They resolve
through `exports` to a `dist`, so `transpilePackages` does not save them from needing to be
compiled first; `^...` is pnpm for "this package's dependencies, without this package".

`vercel build && vercel deploy --prebuilt` from `apps/web` does not work, and the error it
gives is misleading. Next traces its serverless bundles against the workspace root, so the
output references `node_modules/.pnpm/...` paths that exist above `apps/web` and therefore
above what a deploy from `apps/web` uploads. It reports the first one as a missing file rather
than as a missing directory tree.

## If something is wrong afterwards

There is no recovery path and that is deliberate. The response to a mis-deployment is a
new deployment: a new `FactoryOrigin`, a newly mined hook, new registries, and
`packages/config/src/deployments.ts` updated to point at them. The old contracts stay on
chain forever, working exactly as their bytecode says, which is why step 6 exists — the
record of which one is real lives in this repository, not on the chain.
