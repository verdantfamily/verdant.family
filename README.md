# Verdant

A market-creation layer on Robinhood Chain. Verdant lets someone create a token
and a Uniswap v4 market for it in one transaction, where the market's fee
behaviour is chosen from a small set of verified models, its parameters are
bounded by contracts rather than by an interface, and its liquidity is locked by
a contract that cannot be persuaded otherwise.

**Status: deployed and trading on Robinhood Chain (4663).** The protocol was broadcast on
2026-08-01 in blocks 25 393 021 to 25 393 023, markets have been created through the
interface, and fees have been earned and claimed by a creator. Every address is recorded
in [`packages/config/src/deployments.ts`](packages/config/src/deployments.ts), which is the
only durable record of which deployment is the live one:

| Contract | Address |
|---|---|
| VerdantFactory | `0x661A5B2A8d7DC0EaEd98B335e070478b40B92Dd9` |
| VerdantHook | `0xf998c32CDdFA6354bd80Aab470C6ECF4d83Bb880` |
| ModelRegistry | `0xfC54c8fb2F5B9da90ca8227866b48a429568EA03` |
| MarketRegistry | `0x03f002FD5A8070D73f4f1627586968D446512A27` |
| VerdantDeployer | `0x0B94311A18d2F3E0f38b670cF0a4927ed65420F3` |

There is no upgrade path and there is not meant to be one. The hook's address encodes its
permissions, and the factory, both registries and the deployer name each other in
immutables — so replacing the protocol means a new record beside the old one, and the
markets created under the old one keep trading.

### What is not done

- **The contracts are not verified on Blockscout.** Their source is here and reproducible,
  but an explorer will show bytecode until step 7 of the runbook is carried out.
- **Evergreen is a design, not a market.** `ModelRegistry` carries it; the factory will not
  create one. Its card says so rather than offering a button.
- **`FeeForwarderFactory`** is deployed at `0x266DEbCE6d33a4b84C140541bC142c7C8b46ae63` and
  deliberately not wired up. It would let a creator's fees be delivered by anyone instead of
  claimed by them; the switch is one line of config, and it is off. No market has ever named
  a forwarder as its fee recipient.

## Read these first

| Document | What it is |
|---|---|
| [`docs/deployment.md`](docs/deployment.md) | The runbook. What to decide, what to run, and what to verify before telling anyone an address |
| [`docs/verification.md`](docs/verification.md) | The V1–V16 record: every chain fact, its evidence, and the decision it unblocks |
| [`docs/feed.md`](docs/feed.md) | How market data is derived, and the proof that the indexer agrees with the contracts |
| [`docs/interface.md`](docs/interface.md) | The interface: its routes, its design tokens, and how a launch form becomes a call |
| [`docs/decisions/`](docs/decisions/) | ADR-001 to ADR-008. Every architectural choice a future reader would otherwise have to reverse-engineer |
| [`docs/REVIEW.md`](docs/REVIEW.md) | The architecture review this design answers to |

## What exists

`ScheduleLib` — the fee schedule, in two storage words — and its TypeScript twin.
Both are asserted against one shared corpus of 515 configurations and 11 435
probes whose expected values come from a third, naive reference implementation in
the generator, so a shared misconception in the two implementations under test
cannot pass. Reading the fee on the swap path costs **7 186 gas and one storage
slot** for a schedule of four stages or fewer; see
[`packages/contracts/README.md`](packages/contracts/README.md) for the full table.

## Layout

```
apps/
  web/          the interface: explore, market pages, launch forms, docs
                (docs/interface.md)
  landing/      one static page, deployable anywhere, depends on nothing
                (apps/landing/README.md)
  indexer/      Ponder indexer and the API the interface reads (docs/feed.md)
packages/
  contracts/    Foundry — Solidity 0.8.26, optimizer 1_000_000
  sdk/          TypeScript twins of on-chain math, generated ABIs, the read layer
  config/       chain objects, external addresses, parameter bounds. Data only
  ui/           formatting: integers to strings, never through a float
scripts/
  probe.ts                     pnpm chain:probe — reproduces every chain fact
  vendor-contracts-deps.sh     pnpm contracts:deps — pinned Solidity deps
  indexer-proof.sh             pnpm proof — a chain, six launches (two of them
                               through the SDK), an indexer, and the assertion
                               that they all agree
  fork-test.sh                 pnpm proof:fork — the fork suite against live 4663
docs/
```

## Getting started

```bash
pnpm install
pnpm contracts:deps      # fetch pinned Solidity deps into packages/contracts/vendor
pnpm build
pnpm test
pnpm chain:probe         # read-only; verifies every external address still has code
```

`pnpm chain:probe` needs no install step at all — it uses plain `fetch` and
Node's native TypeScript stripping, so it runs on a fresh clone.

### Running the interface

The interface needs markets to show, and the markets it is developed against should be
ones whose numbers have just been checked against the contracts. So the development
stack is the proof rig, left running:

```bash
pnpm dev:stack     # anvil, Uniswap, Verdant, six seeded markets, the indexer
```

Once the assertions pass it prints everything needed to point the interface at it —
the pool ids of the two markets it launched through the SDK, and the full set of
variables, because nothing is recorded in `packages/config/src/deployments.ts` yet and
the interface refuses to spend gas against addresses it has not got:

```bash
VERDANT_FEED_URL=http://127.0.0.1:42069 \
NEXT_PUBLIC_CHAIN_ID=4663 \
NEXT_PUBLIC_RPC_URL=http://127.0.0.1:8555 \
NEXT_PUBLIC_VERDANT_FACTORY=0x… \
NEXT_PUBLIC_VERDANT_HOOK=0x… \
NEXT_PUBLIC_VERDANT_DEPLOYER=0x… \
NEXT_PUBLIC_VERDANT_MODEL_REGISTRY=0x… \
NEXT_PUBLIC_VERDANT_MARKET_REGISTRY=0x… \
  pnpm --filter @verdant/web dev
```

Uniswap's quoter and Permit2 need no variables: the rig puts working code at the
addresses `@verdant/config` already names, so the interface's own code path is the one
being exercised. The Universal Router is *not* there and cannot be, so the trade
panel's swap button fails on the rig even though its quote and its approvals do not.
See [docs/feed.md](docs/feed.md#what-is-not-proved-and-the-one-command-that-would-prove-it).

The same rig without `VERDANT_KEEP` is the CI gate — `pnpm proof` — which launches
markets, trades across a fee transition, collects and claims fees, and then requires the
indexer's answers to equal the contracts' own. Neither needs an RPC, a database, or a
key.

With no feed reachable the interface still builds and renders. It says the feed is
unavailable, which is deliberately a different statement from saying no markets exist.

## The SDK, and what has been proved about it

`packages/sdk` holds the twins of on-chain math, the generated ABIs, the read layer,
and — since there is no `packages/sdk/README.md` — this is where its state is written
down.

**Proved, on a real chain, by `pnpm proof`.** The write path builds a launch that
works: `readTokenInitCodeHash`, `mineTokenSalt`, `predictTokenAddress`,
`buildCreate`/`encodeCreate`, and then `quoteExactIn` through a real `V4Quoter` and
`readPermit2Allowance`/`buildErc20Approval`/`buildPermit2Approval` through the real
Permit2. Two markets are launched every run — one ether-quoted, one quoted in a
tokenized equity — using the same functions `apps/web` calls in the same order, and the
chain is then asked whether the market that landed is the market the SDK described. The
predicted token address, the pool key, the registry record, the locked position's owner
and the fee the pool charges are all checked against reads rather than against the
receipt. Before this existed, no create transaction built by the SDK had been broadcast
anywhere.

**Proved offline, by the vector suite.** `trade.buildSwap`'s bytes equal what Uniswap's
own vendored `Actions` constants and `IV4Router.ExactInputSingleParams` produce, over a
corpus that includes a sell, an equity-quoted buy and an explicit deadline
(`packages/contracts/test/SwapCalldata.vectors.t.sol`). The schedule and pool-id twins
are held to the Solidity by their own shared corpora.

**Not proved.** The deployed Universal Router has never been sent calldata this SDK
produced. That needs one run with network access — `pnpm proof:fork` — and until it
happens the trade button should not be trusted with real money. The reason, and exactly
what that run asserts, is in
[docs/feed.md](docs/feed.md#what-is-not-proved-and-the-one-command-that-would-prove-it).

## Principles that constrain the code

These are not aspirations; each one is enforced somewhere and the enforcement
point is named.

**Bounds live in contracts, not in the interface.** Every limit is enforced
on-chain and re-validated by the hook. `packages/config/src/bounds.ts` is the
single source those bounds are transcribed from, and the SDK re-reads the
on-chain values at runtime and warns on drift. A bound that exists only in the UI
is not a bound.

**The preview is the transaction.** Anything shown before signing is computed by
the same code path that will execute. Where a value is computed both in Solidity
and in TypeScript, the two are tested against shared vectors — see
`packages/sdk/src/models/vectors/`. Two implementations that can disagree is the
bug class those vectors exist to prevent.

**The hook never holds value.** Verdant's hook is mined for exactly
`0x3880` — `beforeInitialize | afterInitialize | beforeAddLiquidity |
beforeSwap` — and no `*_RETURNS_DELTA` bit. It cannot take custody during a swap
because it lacks the permission to. `packages/contracts/test/Remappings.t.sol`
asserts this against Uniswap's own flag constants rather than against a literal.

**Never `block.number`.** On this chain `block.number` returns the **L1** block
number, measured advancing ≈119× slower than the L2 clock. All timing uses
`block.timestamp`. See `docs/verification.md` V7.

**Dependencies are pinned to deployed bytecode.** The Solidity dependencies are
pinned to the exact commits matching what is deployed on chain 4663, established
by a byte-for-byte source diff — not to upstream `main`, which has since
diverged. See `packages/contracts/README.md`.

## Chains

| | id | RPC | explorer |
|---|---|---|---|
| Robinhood Chain | 4663 | `rpc.mainnet.chain.robinhood.com` | `robinhoodchain.blockscout.com` |
| Robinhood Testnet | 46630 | `rpc.testnet.chain.robinhood.com` | `explorer.testnet.chain.robinhood.com` |

Arbitrum Orbit (Nitro), settling to Ethereum with blob DA. Gas is ETH. Uniswap v4
is deployed at identical addresses on both chains despite 46630 being absent from
Uniswap's published deployments page.

## Licence

MIT, for all of it — the contracts as much as the interface. See [`LICENSE`](LICENSE).

That is a deliberate choice rather than a default. Most protocols put BUSL-1.1 on their
contracts so that nobody can redeploy them as a competitor for a few years, and these
contracts carried exactly that until this repository was made public. Under MIT anyone may
take the factory, the hook and the schedule library and run their own launchpad with them,
and that is allowed.

The Solidity dependencies are not distributed here. `packages/contracts/vendor/` is fetched
at pinned commits by `pnpm contracts:deps` and each of those projects carries its own
licence; [`NOTICE`](NOTICE) records what is somebody else's.
