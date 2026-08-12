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

### `arbitrary-send-eth` — `AgentRevenueRouter.settle`

**Dismissed. False positive.**

> `AgentRevenueRouter.settle(address,uint256)` sends eth to arbitrary user

Same detector, same shape, different reason. The destination is
`destinationOf(leg)`, which returns one of three `immutable`s fixed at
construction — the agent's treasury, its developer, or the protocol treasury. It
is not arbitrary and cannot become arbitrary:

1. **There is no setter.** None of the three has one, for the developer, the
   agent, or the guardian. `AgentRevenueRouter` declares no function that writes
   any of them after the constructor.
2. **`leg` is bounded before it is used.** `settle` rejects `leg >= 4` before
   resolving a destination, and `destinationOf` reverts `UnknownLeg` on anything
   else, so the three cases are exhaustive.
3. **The amount is what that leg is owed.** `allocated - settled` for the leg,
   and `_settled` is written before the transfer.

The bare `.call` rather than `transfer` is deliberate for the reason
`FeeSplitter.claim` gives, and here it is load-bearing rather than defensive: one
of the three destinations is `AgentTreasury`, a contract, and a 2 300 gas stipend
would make the operations leg unpayable.

Suppressed with a targeted `// slither-disable-next-line arbitrary-send-eth`.

## Medium

### `divide-before-multiply` — `RevenueAllocationLib.entitlement`

**Dismissed. Deliberate, and proven exact.**

> `RevenueAllocationLib.entitlement(uint256,uint16)` performs a multiplication on
> the result of a division

The detector is right that the code divides first. It is wrong that precision is
lost, and the reason the code is written this way is the reason the finding
exists at all.

The definition of a leg's share is `received * bps / 10_000`. Evaluated directly,
that reverts on overflow once `received` passes `2^256 / 10_000` — which would
turn an arithmetic edge into a router that can never allocate that asset again.
So the library splits `received` into `whole * 10_000 + remainder` and evaluates
`whole * bps + (remainder * bps) / 10_000`, in which neither product can overflow.

The two forms are equal rather than approximately equal, because `whole` and
`remainder` together carry every bit of `received`. That claim is not left to this
paragraph: `packages/sdk/src/agents/vectors/allocation.json` carries the naive
form's answer at 4 716 totals across 159 allocations, computed in
arbitrary-precision arithmetic by a generator that does not import either
implementation, and both
[`RevenueAllocationLib.vectors.t.sol`](../../packages/contracts/test/agents/RevenueAllocationLib.vectors.t.sol)
and the SDK's own suite assert against it — including at `type(uint256).max`,
where the naive form cannot be evaluated on chain at all.

Suppressed with a targeted `// slither-disable-next-line divide-before-multiply`.

### `incorrect-equality` — eight comparisons in the agent layer

**Acknowledged, not suppressed.**

Every one is a comparison against zero used as a sentinel: `lastActionAt == 0`
meaning "this agent has never acted", `startedAt == 0` meaning "this asset's
period has never begun", `amount == 0` meaning "there is nothing to do", and
`agentId == bytes32(0)` meaning "no such record".

The detector exists for strict equality against a *balance* or a *timestamp*,
where an attacker can arrange the exact value. None of these are that: they
distinguish an unwritten storage slot from a written one, and the distinction is
load-bearing — treating "never acted" as "acted at the epoch" would make a mandate
with a long interval unusable exactly once, and treating "period never started" as
"period started in 1970" would give every agent's first action a stale period.

Left visible. Suppressing eight lines to remove a detector's default opinion about
zero would be a worse trade than the noise.

### `uninitialized-local` — `AgentRevenueRouter.allocate.delta`

**Acknowledged, not suppressed.**

`uint256[4] memory delta` is a fixed-size memory array, which Solidity
zero-initialises. There is nothing to write that is not already there, and
assigning four zeros to say so would be code that exists to satisfy a detector.

### `unused-return` — `AgentLaunchFactory._register`

**Acknowledged, not suppressed.**

`AgentIdentityRegistry.register` returns `(agentId, index)`. The factory uses the
first — it asserts the registry derived the same id the components were built
with — and ignores the second, which is a position in creation order that nothing
at launch time needs. Slither reports the tuple as ignored because one element is.

## Low and informational

### `reentrancy-events` — seven functions

**Acknowledged, not suppressed.**

Reported for `PositionLocker.collect`, `VerdantHook.afterInitialize`,
`FeeForwarder.pull`, `FeeForwarder._sweep` (twice), and in the agent layer for
`AgentLaunchFactory.createAgent` and `_register`, where the launch event is
emitted after four deployments and a registry write.

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
