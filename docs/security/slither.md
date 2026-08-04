# Slither

Static analysis runs on every push and every pull request
([`.github/workflows/security.yml`](../../.github/workflows/security.yml)). The
job fails on a high-severity finding, and results are uploaded as SARIF so they
are readable in the repository's Security tab rather than only in a log.

Configuration is [`packages/contracts/slither.config.json`](../../packages/contracts/slither.config.json).
Vendored Uniswap and OpenZeppelin code is filtered out: findings there belong
upstream, and a report where our own results are outnumbered by somebody else's
is a report nobody reads.

This page is the triage record. A suppression without a written reason is
indistinguishable from a suppression that hides a bug, so every one of them is
listed here with the argument for it.

## High severity

### `arbitrary-send-eth` — `VerdantFactory._refund`

**Dismissed. False positive.**

> `VerdantFactory._refund(Currency,address,uint256)` sends eth to arbitrary user

The detector flags any `.call{value:}` whose destination is not a constant. The
destination here is the caller, and three things establish that:

1. **`creator` is only ever `msg.sender`.** `_refund` is `private` with one call
   site, which passes `buy.creator`. That field is populated from
   `market.creator`, and the only assignment to it anywhere in the contract is
   `market.creator = msg.sender`. No caller-supplied address reaches it.
2. **The amount is the caller's own money.** It is `buy.amountIn - spent` — the
   part of the ether they sent with this call that the pool did not take on their
   first buy.
3. **The factory holds no balance to steal.** It declares no `receive` and no
   `fallback`, so ether cannot be sent to it outside a call, and nothing
   accumulates between calls for a later caller to redirect.

A bare `.call` is used deliberately rather than `transfer`, because a creator may
be a contract whose `receive` costs more than the 2 300 gas stipend. That choice
is a liveness decision and is commented at the call site.

Suppressed with a targeted `// slither-disable-next-line arbitrary-send-eth` on
that one line. The detector stays enabled everywhere else.

## Low and informational

### `reentrancy-events` — five functions

**Acknowledged, not suppressed.**

Reported for `PositionLocker.collect`, `VerdantHook.afterInitialize`,
`FeeForwarder.pull` and `FeeForwarder._sweep` (twice).

This detector fires when an event is emitted after an external call, meaning a
reentrant call could observe events in an order that does not match the order
operations completed. It is about event ordering, not about state: none of these
functions have state that a reentrant call could corrupt, and the value-moving
ones are pull-based against balances checked at the moment of the call.

Left visible rather than filtered. It is a real ordering property, it costs
nothing to keep in the report, and an off-chain consumer that assumes strict
event ordering under reentrancy would want to know.

## Reproducing this locally

```bash
pip install slither-analyzer
pnpm contracts:deps
cd packages/contracts && slither . --config-file slither.config.json
```

Static analysis is not an audit, and Verdant has not had one. See
[SECURITY.md](../../SECURITY.md#open-gaps).
