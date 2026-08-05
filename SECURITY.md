# Security

Verdant's contracts are immutable and hold other people's money. This document
states what they can do, what nobody can do to them, which powers exist and who
holds them, and what has not been checked. The last section is the important one.

**Verdant has not been audited.** No independent smart-contract audit and no
public security contest has been carried out on any of this code. What exists
instead is described under [What has been checked](#what-has-been-checked). Open
source makes behaviour inspectable; it does not make it safe.

## Reporting a vulnerability

Use [GitHub private vulnerability
reporting](https://github.com/verdantfamily/verdant.family/security/advisories/new).
It goes to the maintainers privately and lets us prepare a fix before anything is
public.

Please do not open a public issue or pull request for an unpatched
vulnerability, and please do not test findings against live markets on 4663 —
`pnpm proof` gives you a full local chain with six markets on it in one command,
and no live market has to be put at risk to demonstrate a bug.

There is no bug bounty. We would rather say so than imply one.

## What cannot be changed

None of this is a promise about our intentions. It is a description of what the
deployed code makes impossible, and each line names where it is enforced.

| Nobody can | Because |
| --- | --- |
| Upgrade or replace a deployed contract | There is no proxy anywhere. `FactoryOrigin` can create once. |
| Mint more of a launched token | `VerdantToken` has no mint function and no owner after construction. |
| Change a market's fee schedule | The schedule is written into `VerdantHook` at creation, keyed by pool id, with no setter. |
| Withdraw a launch position | `PositionLocker` has no transfer path and no operator. It can only collect fees, and only to the splitter. |
| Redirect a market's fees | The split is fixed in that market's `FeeSplitter` at creation. There is no setter, and Verdant cannot pull the creator's share. |
| Pause, freeze, blocklist or tax a token | None of those functions exist. |
| Make the hook take custody during a swap | The hook's address encodes `0x3880` and no `*_RETURNS_DELTA` bit. Uniswap will not call it in a way that lets it hold value. |

The last one is worth being precise about, because it is the difference between
a hook that could steal and a hook that cannot. Uniswap v4 reads a hook's
permissions from the low 14 bits of the hook's own address. Verdant's hook was
mined so those bits are exactly `beforeInitialize | afterInitialize |
beforeAddLiquidity | beforeSwap`. The delta-returning permissions are absent, so
there is no call path where the pool manager hands the hook a balance to modify.
This is checked against Uniswap's own flag constants rather than a literal in
[`Remappings.t.sol`](packages/contracts/test/Remappings.t.sol), and re-checked
against the live address on every run of `pnpm verify:deployment`.

## What can be changed, and by whom

Two powers exist. Both are disclosed here because a security document that only
lists reassurances is marketing.

**The `ModelRegistry` owner can change creation bounds and admissions.** Fee
ceilings, stage limits and which quote assets are allowed. This affects **markets
created afterwards only** — an existing market's parameters live in that market's
own contracts and are not read from the registry again.

**The protocol's fee share is fixed per market at creation**, from the bounds in
force at that moment. The treasury address for an existing market cannot be
changed by anyone, ever.

The owner and the treasury are the **same externally owned account**, not a
multisig:

```
0x1f23c28F93aE48E6346DD05Ca66ba5e2213b00b8
```

That is a single private key. If it is lost, no bounds can ever be changed again
and no protocol fees can be claimed, while every existing market keeps trading
and every creator keeps claiming their share. If it is stolen, the thief can
widen bounds and admit quote assets for *future* markets and can claim the
protocol's share of fees — and cannot touch any existing market's schedule,
liquidity, supply or creator share. Moving this to a multisig is an open item
below.

## Trust boundaries

Things Verdant depends on and does not control:

- **Uniswap v4** (`PoolManager`, `PositionManager`, `V4Quoter`, `StateView`,
  Permit2, Universal Router). Deployed by Uniswap at addresses this repository
  pins. A bug there is a bug in every Verdant market.
- **Robinhood Chain**, an Arbitrum Orbit L2. Its sequencer orders transactions.
  It can censor or reorder; it cannot forge state.
- **Tokenized equity issuers**, for Stock-Paired markets. The quote asset keeps
  its issuer's transfer and redemption controls, which Verdant cannot override.
- **The creator's own metadata URI**, which is arbitrary creator-supplied text
  and is fetched client-side precisely so that our servers never resolve it.

Things Verdant does **not** depend on: an oracle, a keeper, an off-chain signer,
a relayer, or any privileged transaction. Every fee transition is a function of
`block.timestamp`. If every Verdant server disappeared, markets would keep
trading and fees would keep being claimable directly against the contracts.

One chain-specific hazard is worth naming. On this L2, `block.number` returns
the **L1** block number and advances roughly 119× slower than the L2 clock. A
schedule written against it would be silently wrong by two orders of magnitude.
Verdant uses `block.timestamp` everywhere; the measurement is recorded as V7 in
[`docs/verification.md`](docs/verification.md).

## What has been checked

| Check | What it covers | How to run it |
| --- | --- | --- |
| Unit and integration tests | 422 contract tests across 26 files | `pnpm contracts:test` |
| | 352 TypeScript tests across the SDK, formatting and interface | `pnpm test` |
| Fuzzing | 10 000 runs per property | included above |
| Invariants | 2 invariants, 256 runs at depth 20 | included above |
| Differential tests | Every value computed in both Solidity and TypeScript is asserted against shared vectors, with expected values from a third naive implementation so a shared misconception cannot pass | `pnpm vectors:generate` |
| Gas regression | Committed snapshot, enforced in CI | `pnpm contracts:snapshot` |
| Coverage floor | 95% | `bash scripts/check-coverage.sh` |
| End-to-end proof | A real chain, Uniswap, six launches, an indexer, and the assertion that contract state and indexed data agree | `pnpm proof` |
| Fork tests | The suite against live 4663 state | `pnpm proof:fork` |
| Deployment evidence | Every published address, code hash and size against the chain | `pnpm verify:deployment` |
| Source verification | All seven contracts fully verified on Blockscout, so an explorer shows this repository's source rather than bytecode | `pnpm verify:blockscout` |
| Static analysis | Slither on every push, with every suppression argued for in [`docs/security/slither.md`](docs/security/slither.md) | `.github/workflows/security.yml` |

## Open gaps

Tracked here rather than in an issue tracker, because a security page that omits
them is not a security page.

- **No independent audit.** Stated above; repeated here because it belongs in
  the gap list.
- **Owner and treasury are one EOA.** A multisig would reduce the blast radius
  of a lost or stolen key to zero for existing markets and to "future bounds" for
  new ones.
- **The Universal Router has never been sent calldata built by this SDK.** The
  swap path is proved offline against Uniswap's own encoding constants, and the
  quoter and Permit2 paths are proved against real deployed code, but the router
  itself needs one run with network access — `pnpm proof:fork`.
- **`FeeForwarderFactory` is deployed and unwired.** It is at
  `0x266DEbCE6d33a4b84C140541bC142c7C8b46ae63`, switched off in config, and no
  market has ever named a forwarder as its fee recipient. It is published in the
  deployment record so that a contract found at that address can be read against
  source rather than guessed at.

## Scope

In scope: everything under [`packages/contracts/src/`](packages/contracts/src/),
the SDK's transaction construction, and any way the interface can be made to
build a transaction that does something other than what it displayed.

Out of scope: vendored Uniswap and OpenZeppelin code (report upstream), the
behaviour of tokenized equity issuers, chain-level sequencer behaviour, and the
market risk of any particular token. A token going to zero is not a
vulnerability.
