# ADR-001 — `tickSpacing` is 200, not 60

**Status:** accepted. Unblocks P3.
**Supersedes:** `Implementation Architecture v0.1` §19.1 (parameter register),
and the range presets in §7.2 and §8.3.
**Raised by:** `docs/REVIEW.md` §4.1.

## Decision

`TICK_SPACING = 200` for every Verdant pool. It is a constant, not a parameter,
and `VerdantHook.beforeInitialize` re-asserts it so a pool with any other spacing
cannot be created through the hook at all.

Full-range positions therefore use ticks **−887200 / +887200**, not ±887220.

## Reasoning

### The chain's own convention is 200

In a 300 000-block window on 4663 containing 1 566 v4 `Initialize` events,
`tickSpacing` 200 appeared 1 212 times against 52 for 60 — a 23:1 preference (see
`docs/verification.md` V4 for the probe). Verdant is not obliged to follow local
convention, but diverging from it silently, on a value that gets frozen at audit,
is not a decision anyone made on purpose. That is what this ADR exists to fix.

Tooling convention is the practical half of this. Routers, analytics, and
position UIs on this chain are being exercised daily against spacing 200 and
rarely against 60. That is not a correctness argument — it is a "which
configuration has more hours on it" argument, which for a venue that cannot be
migrated after launch is worth something.

### There is no discoverability or slot-occupancy argument either way

Worth stating explicitly, because it is the argument one would expect to matter
and it does not. In v4 the `PoolKey` includes the hook address, so a Verdant pool
for a given token pair is a distinct pool from any other pool for that pair — no
"slot" is occupied or contested, and nothing about spacing affects whether the
pool can be found. The real reasons are gas and convention.

### Gas: fewer initialized-tick crossings per swap

A launch market moves price in multiples, not percentages: the first days of a
progressive market routinely traverse a large part of the range. Every
initialized tick crossed inside a swap costs the swap loop an iteration and a
tick-bitmap read. Wider spacing means fewer initialized ticks exist in any given
price interval, so a large move crosses materially fewer of them.

This is the same argument that makes 200 the standard choice for volatile pairs
in v3 and v4, and Verdant's markets are the volatile case by construction.

### The granularity given up is irrelevant at Verdant's range widths

One tick step at spacing 200 is `1.0001^200 = 1.0202`, so 2.02% per step, against
`1.0001^60 = 1.0060`, 0.60% per step. Verdant creates wide ranges in both modes:
Bootstrap places a token-only position above spot, and Seeded places a wide
two-sided range. In neither case is a 2% granularity a constraint on expressing
the intended range — the range boundaries are approximate by nature, chosen from
presets, and a 2% rounding on a boundary that is itself a judgement call is not a
loss of precision that anyone can act on.

Where it would matter is a narrow, deliberately-tuned position — which Verdant
does not offer and does not intend to.

## Consequences

Arithmetic first, since several of these follow from it:

| quantity | at spacing 60 | at spacing 200 |
|---|---|---|
| `MAX_TICK` (v4 constant) | 887 272 | 887 272 |
| largest usable multiple | 887 220 | **887 200** |
| granularity per tick step | 0.6018% | **2.0200%** |

`887272 / 200 = 4436.36`, so `4436 x 200 = 887200` is the largest multiple of 200
that lies strictly inside the v4 bound. `887200 % 200 == 0` and `887200 < 887272`.

Changes required:

- [x] `packages/config`: `TICK_SPACING = 200`, `MIN_USABLE_TICK = -887200`,
      `MAX_USABLE_TICK = 887200`. These are the only definitions; nothing else in
      the repo may hardcode a tick spacing or a usable-tick bound.
- [x] `packages/config`: remove `TICK_BOUNDS` at spacing 60 (±887220).
- [x] A test asserting both usable ticks are multiples of `TICK_SPACING` and lie
      strictly inside ±887272 — the arithmetic above, mechanised.
- [x] A lint check that no other file introduces a tick literal, so this ADR
      cannot be half-applied.
- [ ] P3: `VerdantHook.beforeInitialize` asserts `key.tickSpacing == 200` and
      reverts otherwise.
- [ ] P3/P7: range presets recomputed against the new alignment.
- [ ] P7: the Zod tick-alignment rule takes its modulus from config.

## Alternatives rejected

**Keep 60.** Finer control over a Seeded range's boundaries, and it is what the
architecture document says. Rejected because the precision has no use at
Verdant's range widths while the swap-gas cost is paid by every trader on every
swap that crosses a tick, forever. Trading a permanent cost for an unusable
capability is the wrong direction.

**Make it configurable per market.** Rejected on two grounds. It breaks the
uniformity the hook asserts — `beforeInitialize` checking a constant is a
one-line invariant an auditor can verify by reading it, whereas checking a
per-market stored value is a stateful property that has to be traced. And it
gives creators a parameter they have no basis for choosing, which is exactly the
kind of decision Verdant exists to make on their behalf.

**Defer until after the hook is mined.** Not viable: the hook re-asserts the
constant, so the value is frozen at the same moment the hook address is. Deciding
after mining means deciding by accident.
