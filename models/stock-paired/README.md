# Stock-Paired

Classic, quoted in a tokenized equity instead of ether. Pair a token against
NVIDIA, Apple, the S&P 500 or silver.

**Status: live on Robinhood Chain (4663).** The machine-readable record is
[`model.json`](model.json).

## What changes, and what does not

Only the quote side. The token, the locked position, the immutable schedule, the
splitter and the append-only registry entry are the ones Classic uses — the same
contracts, the same code path, the same tests. The quote asset is a parameter of
the launch rather than a different kind of market, which is argued in
[ADR-008](../../docs/decisions/008-the-quote-asset-is-a-parameter.md).

Two consequences follow from that being a parameter:

**The launched token is always `currency1`.** Uniswap orders a pool's two
currencies by address. Verdant mines the token's salt so that it always sorts
above the quote asset, which means "token per quote" means the same thing in
every Verdant market regardless of what it is quoted in. Without that, half the
markets would price upside-down and every consumer would need to know which.

**Fees arrive in the quote asset.** The fee is charged on the currency going into
the pool, so a buy pays in the equity token and a sell pays in the launched
token. A creator earns NVDA, not ether.

## The allowlist is not a formality

Only assets on a reviewed allowlist can be a quote side, enforced by
`ModelRegistry` on chain rather than by the interface. An arbitrary ERC-20 as a
quote asset is a market that can be rug-pulled from underneath by the quote
asset's issuer, and a launchpad that accepts any address is offering that as a
feature.

The allowlist holds first-party Robinhood equity tokens. Verdant can add to it
for markets created afterwards; it can never change the quote asset of a market
that already exists, because the quote asset is part of the pool's identity.

## What it does not promise

The risks Classic carries all apply. These are the ones that only exist here:

- **The launched token is not a share.** It is not redeemable for the quote
  asset and carries no rights in the underlying company, fund or security.
- **The quote asset keeps its issuer's terms**, including any transfer or
  redemption controls. Verdant does not control them and cannot override them.
- **A quote asset that becomes illiquid** makes the market it prices hard to
  exit, independently of that market's own liquidity.
- **Equities close and pools do not.** A price can gap across a weekend while
  the pool trades continuously through it.
- **The first buy is funded in the quote asset**, so a creator must already hold
  the equity token. Nothing routes ether into it for them.

## The evidence

| Claim | Where it is checked |
| --- | --- |
| An equity-quoted launch lands as described | [`VerdantLaunch.t.sol`](../../packages/contracts/test/VerdantLaunch.t.sol) |
| Only allowlisted assets are accepted as a quote side | [`ModelRegistry.t.sol`](../../packages/contracts/test/ModelRegistry.t.sol) |
| The launched token always sorts as `currency1` | [`PoolId.vectors.t.sol`](../../packages/contracts/test/PoolId.vectors.t.sol) |
| A real chain agrees | `pnpm proof`, which launches one of each every run |
