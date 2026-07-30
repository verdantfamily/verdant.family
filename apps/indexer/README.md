# @verdant/indexer

Ponder indexer. **Scaffold only at P0** — Ponder itself is added in P8, because a
Ponder config cannot be written before the factory address exists and a start
block is known.

What is already decided, and why it is recorded here rather than discovered later:

## Index PoolManager, not PositionManager

Index `ModifyLiquidity` from the **PoolManager**. Do not reach for a
PositionManager-level liquidity event: current Uniswap `main` emits
`ModifyPosition(poolId, msgSender, tickLower, tickUpper, liquidityDelta, salt)`,
but **the PositionManager deployed on 4663 does not emit it at all** — the
deployment predates that change. Building against the upstream ABI would produce
an indexer that silently never fires. See `docs/verification.md`.

## Derived state is derived, never stored as truth

The indexer stores only what it observed. Anything computable from immutable
configuration — the active fee, the current stage, trait badges — is computed at
read time by `@verdant/sdk` from the same code path the contracts use. Two
implementations of the fee schedule that can disagree is precisely the bug class
the differential vectors exist to prevent.

## Open questions before P8

- **V10** — Ponder's cold-sync time and reorg behaviour on 4663 are unmeasured.
  The fallback is Envio, or direct `viem` log polling with a small Postgres
  schema.
- **V16** — practical reorg depth on this chain is unknown. The finality depth
  starts at 32 blocks and must be justified by measurement, not by analogy to
  Ethereum: this is an Arbitrum Orbit chain with a sequencer, so the failure mode
  is different.
