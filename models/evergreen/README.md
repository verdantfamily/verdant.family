# Evergreen

A share of every fee is set aside and can be added back to the locked position
as liquidity by anyone, forever.

**Status: design. This model cannot be created.** `ModelRegistry` carries it and
the factory will not build one. Its card in the interface says so instead of
offering a button, and this file exists so that the idea is on the record rather
than in a roadmap.

## The mechanism

Any valid fee schedule, plus a mandatory reserve share of collected fees.

When fees are collected, the reserve share is withheld from the split and
accumulates in both currencies. Anyone may then call `reinforce()`, which
converts the accumulated reserve into additional liquidity in the same locked
position. No swap is performed — the call adds what it has, in the ratio the
pool's current price implies, and the position it adds to is the one that can
never be withdrawn.

The reserve is unclaimable. Not by the creator, not by the protocol, not by the
caller of `reinforce()`. The only thing that can be done with it is turn it into
liquidity that nobody can remove.

Why `reinforce()` computes its liquidity delta caller-side, and why that makes
the call slippage-bearing, is
[ADR-002](../../docs/decisions/002-reinforce-liquidity-delta.md).

## What remains

The reserve share and the reinforce path exist in `VerdantHook`. What is missing
is not code:

- the model is disabled in `ModelRegistry`, so the factory rejects it;
- it has no acceptance record, meaning nobody has signed off that the mechanism
  behaves as described under adversarial conditions;
- the reinforcement path has unit tests but no proof against a live pool.

A model reaches `ready` when all three are resolved. Until then this document is
a description of an intention, and the interface treats it as one.

## What it would not promise

- **Reinforcement is not automatic.** It needs someone to call it, which anyone
  may do and nobody is obliged to do. A market whose reinforcement is never
  called accumulates a reserve that simply sits there.
- **Deeper liquidity is not a better market.** It implies nothing about price.
- **Adding liquidity depends on the price at the moment of the call**, so the
  reserve converts on terms nobody chooses in advance.
