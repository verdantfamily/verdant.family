# Verdant

A market-creation layer on Robinhood Chain. Verdant lets someone create a token
and a Uniswap v4 market for it in one transaction, where the market's fee
behaviour is chosen from a small set of verified models, its parameters are
bounded by contracts rather than by an interface, and its liquidity is locked by
a contract that cannot be persuaded otherwise.

**Status: P1.** Foundations and the schedule primitive. No token, no factory, no
hook yet. Nothing is deployed to any chain.

## Read these first

| Document | What it is |
|---|---|
| [`docs/REVIEW.md`](docs/REVIEW.md) | Architecture review against on-chain and deployed-source evidence. Two findings change contract design; read §2 before writing any contract |
| [`docs/verification.md`](docs/verification.md) | The V1–V16 record: status, evidence, and the decision each unblocks |

Three decisions are open and block P3/P4: the `tickSpacing` constant, the
`reinforce()` redesign, and whether to adopt Uniswap's permissioned-pool pattern.
See `docs/REVIEW.md` §2.1 and §4.

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
  web/          Next.js App Router interface (P7)
  indexer/      Ponder indexer (P8; scaffold only)
packages/
  contracts/    Foundry — Solidity 0.8.26, optimizer 1_000_000
  sdk/          TypeScript twins of on-chain math, viem clients, Zod schemas
  config/       chain objects, external addresses, parameter bounds. Data only
  ui/           formatting primitives and the single TransactionButton (P9)
scripts/
  probe.ts                     pnpm chain:probe — reproduces every chain fact
  vendor-contracts-deps.sh     pnpm contracts:deps — pinned Solidity deps
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
