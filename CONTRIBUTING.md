# Contributing

## Getting it running

```bash
pnpm install
pnpm contracts:deps      # pinned Solidity dependencies into packages/contracts/vendor
pnpm build
pnpm test
```

Foundry is needed for the contracts ([installation](https://book.getfoundry.sh/getting-started/installation));
Node 22 or newer and pnpm 10 for everything else.

Two things run on a clean clone with no install step at all, because they use
plain `fetch` and Node's native TypeScript stripping:

```bash
pnpm chain:probe         # every external address we depend on still has code
pnpm verify:deployment   # every published address and code hash matches the chain
```

## Working on the interface

The interface needs markets to show, and they should be markets whose numbers
have just been checked against the contracts. So the development stack *is* the
proof rig, left running:

```bash
pnpm dev:stack     # anvil, Uniswap, Verdant, six seeded markets, the indexer
```

It prints everything needed to point `apps/web` at it. The same rig without
`VERDANT_KEEP` is `pnpm proof`, which is a CI gate: it launches markets, trades
across a fee transition, collects and claims fees, and then requires the
indexer's answers to equal the contracts' own. No RPC, no database and no key.

## What a change has to clear

Everything below runs in CI. Running it first is faster than finding out.

```bash
pnpm typecheck && pnpm test && pnpm lint
pnpm verify:models          # the published model library equals the interface config
pnpm verify:deployment      # the published addresses equal the chain
cd packages/contracts && forge fmt --check && forge test && forge snapshot --check --match-contract GasTest
```

A few of those deserve explanation.

**The gas snapshot is committed on purpose.** A change to it is a change to what
the protocol costs to use, so it has to appear in a diff and be argued for rather
than discovered after a deployment. If your change moves gas, say why in the pull
request.

**`verify:models` regenerates rather than edits.** `models/registry.json` and
every `models/*/model.json` are generated from
`packages/config/src/launch-models.ts`. Editing them by hand will fail CI. Change
the TypeScript and run `pnpm verify:models --write`. The prose in
`models/*/README.md` is hand-written and yours to edit.

**Coverage has a floor of 95%** (`bash scripts/check-coverage.sh`).

## The bar for contracts

- **A bound that exists only in the interface is not a bound.** Enforce limits on
  chain and let the interface reflect them, never the other way round.
- **If a value is computed in both Solidity and TypeScript, it needs shared
  vectors**, and the expected values must come from a third, naive
  implementation. Two implementations that can agree on the same mistake is the
  bug class those vectors exist to prevent — see
  `packages/sdk/src/models/vectors/`.
- **Never `block.number`.** On this chain it is the L1 block number and advances
  roughly 119× slower than the L2 clock. Use `block.timestamp`.
- **New behaviour needs a test that fails without it.** 422 tests exist; the
  useful question about a new one is what it would catch.
- **Dependencies stay pinned** to the commits matching deployed bytecode. Do not
  bump to upstream `main`.

## The bar for documentation

This repository treats its documentation as a record rather than as marketing,
which mostly means two habits:

**Say what is not true yet.** Every model that is not live states what remains,
and CI enforces that. [SECURITY.md](SECURITY.md) has an open-gaps section that is
supposed to have things in it. A claim without a limitation next to it is usually
an incomplete claim.

**Link the check, not the conclusion.** "The position cannot be withdrawn" is
worth little on its own; the same sentence pointing at
`PositionLocker.t.sol` is worth something. If you add a claim, add the path that
backs it — `verify:models` resolves every evidence path it publishes, so a
renamed test breaks the build instead of quietly becoming a dead link.

## Architecture decisions

Choices a future reader would otherwise have to reverse-engineer go in
[`docs/decisions/`](docs/decisions/) as a numbered ADR. There are nine. If you
are changing something an ADR covers, update the ADR in the same pull request, or
add one superseding it.

## Pull requests

Small, one concern each, with a description that says what changes and why.
Green CI before review. If a change affects what a creator sees before signing a
transaction, say so explicitly — that is the highest-consequence surface in the
project and it gets read carefully.

## Reporting security issues

Not here. [Report privately](https://github.com/verdantfamily/verdant.family/security/advisories/new);
see [SECURITY.md](SECURITY.md).
