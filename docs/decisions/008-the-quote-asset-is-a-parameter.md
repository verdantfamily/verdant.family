# ADR-008 — A market's quote asset is a parameter, and the launch token is always `currency1`

Status: accepted. Extends ADR-003 (which currencies a Verdant pool may name).

## Decision

`VerdantFactory.CreateParams` carries a `quoteAsset`. `address(0)` means ether and
opens the market Verdant has always been able to open; any other address is an
ERC-20 that `ModelRegistry` has admitted, which opens a market priced in that
asset — on Robinhood, a tokenized equity.

Two things hold for every Verdant market regardless of which one it is:

- The launch token is `currency1` and the quote asset is `currency0`. Buying is
  always `zeroForOne: true`.
- The hook holds no value and its permission bits are unchanged. Admitting an
  ERC-20 quote asset changes what a pool is priced in, not what the hook may do.

The factory enforces the ordering by reverting `TokenNotAboveQuote` unless the
token's address sorts strictly above the quote asset's. Creators reach that
ordering by mining the token's CREATE2 salt off chain, which is why
`VerdantDeployer` publishes `tokenInitCodeHash()`.

## The problem

A v4 `PoolKey` sorts its two currencies by address, so which side a launch token
lands on is decided by the address it happens to get. Verdant's first design
resolved that by asserting the quote side was ether: `beforeInitialize` rejected
any key whose `currency0` was not `address(0)`, and ether sorts below everything,
so the launch token was `currency1` by arithmetic rather than by choice.

That assertion is also what made a stock-paired market impossible. It is written
into a hook that is immutable and address-mined, and a launchpad on Robinhood
that cannot price a market in NVDA is missing the thing that distinguishes the
chain it is deployed on. The equities there are first-party assets with real
holders, not bridged wrappers.

## Why the token stays on `currency1`

The ordering could have been left to fall out of the addresses, with each market
recording which side it landed on. It is worth being precise about what that
would cost, because the invariant looks like bookkeeping and is not.

`zeroForOne` is the direction of a swap. If a launch token can be either currency,
then "is this a buy?" stops being a fact about the swap and becomes a question
that must be answered per market, in every place that reasons about direction:
the fee schedule's notion of a buy, the indexer's price and volume arithmetic, the
chart, the trade panel, the quoter call, and any future directional fee. Each of
those grows a branch, and each branch is a place where a market can be displayed
inverted — a price of `1/p` looks plausible enough to ship.

Mining a salt costs the creator a few milliseconds in a browser and buys the
whole system one fewer axis of variation. The factory checks the result rather
than trusting it, so the guarantee does not depend on the miner being correct.

## Why the quote asset is an allowlist

An ERC-20 on the quote side is not the inert counterparty ether is. A
fee-on-transfer token makes the amount `FeeSplitter` receives smaller than the
amount it was told about, so its accounting over-promises and the last claimant
cannot be paid. A rebasing token moves balances under it between claims. A token
with a callback in `transfer` hands control to somebody else's code inside a claim.
Any of those turns a market's fee path into something Verdant cannot honour, and
because a market's wiring is immutable there is no way to correct it afterwards.

So `ModelRegistry` owns a set of admitted quote assets, seeded at deployment from
the reviewed list in `packages/config/src/quote-assets.ts` and thereafter
maintained by the same owner that maintains the bounds. `quoteAllowed(address(0))`
is unconditionally true: ether needs no review. Admission is not an endorsement of
the asset's price, only a statement that its transfer semantics are the plain ones
the splitter assumes.

This is a narrower power than it appears. The registry gates which markets can be
*created*; it cannot reach a market that exists, whose quote asset is an immutable
constructor argument in its splitter and a field in its `PoolKey`. Withdrawing an
asset stops new launches and leaves live markets trading.

## What had to become quote-neutral

- **`FeeSplitter`** takes the quote asset and pays out in it. When the quote is
  ether it forwards value; otherwise it transfers the ERC-20. Its `receive()`
  reverts `NativeNotAccepted` when the quote is not ether, because a splitter with
  no path to pay ether out must not be able to hold any.
- **`PositionLocker`** takes both currencies and settles the pair, rather than
  hard-coding `address(0)` as the currency to take alongside the token.
- **`MarketRegistry`** records the quote asset per market, so every consumer can
  read it rather than assume it, and rejects a market that names its own token as
  its quote.
- **`VerdantHook`** lost the `Currency0NotNative` check and gained nothing. It
  never held value and still does not; its address is still mined for `0x3880`.
  The hook is the reason this change is small: money it cannot touch is money that
  cannot be mishandled when its denomination changes.

## Consequences

- [x] `quoteAsset` in `CreateParams`, in `MarketRegistry.Market`, and in the
      `MarketCreated` and `MarketRegistered` events.
- [x] `ModelRegistry.quoteAllowed`, `admittedQuoteAssets`, `setQuoteAsset`, seeded
      by `Deploy.s.sol` from `bounds.json`, with a parity test against the
      TypeScript list.
- [x] `VerdantDeployer.tokenInitCodeHash()`, and `launch.mineTokenSalt` in the SDK
      alongside `predictTokenAddress`.
- [x] `pool.poolKeyFor(quoteAsset, token, hook)` in the SDK, with vectors that a
      Foundry test reads, including a case where the same token quoted two ways is
      two distinct pools and a case where an inverted pair is a different pool id.
- [x] End-to-end contract tests for an equity-quoted launch: the pool opens quoted
      in the equity, the creator needs none of it, a buy paid in the equity is
      charged the scheduled fee, and both recipients claim the equity.
- [x] The indexer stores the quote asset and reports amounts in it; the interface
      labels every price and volume with the quote asset's symbol.

## Rejected

- **Wrap ether so every pool is ERC-20/ERC-20.** Uniform, and it gives up the
  thing v4 added: native ether pools with no wrapping step and no WETH allowance
  in the way of a first buy. It also puts a token Verdant does not control on the
  quote side of every market for the sake of symmetry.
- **Let the ordering fall out of the addresses.** Costed above. The saving is a
  salt search; the price is a per-market direction flag threaded through every
  consumer of a price.
- **An arbitrary creator-supplied quote asset.** The failure modes are not
  hypothetical and not recoverable: fee-on-transfer breaks the splitter's
  arithmetic, and a transfer callback puts foreign code inside a claim.
- **Admission in the hook rather than the registry.** The hook is immutable, so
  the list could never change, and the hook would have to read state it otherwise
  has no reason to know. `beforeInitialize` already restricts pool creation to the
  factory, so checking admission in the factory loses no guarantee — the same
  argument ADR-005 makes about splits.
- **A market-level flag recording which side the token landed on.** Storage and a
  branch, in exchange for not mining a salt.
