# ADR-003 — Uniswap's Permissioned Pools standard is not adopted

**Status:** accepted. Unblocks P3.
**Affects:** `Implementation Architecture v0.1` §9.5 — confirms the existing
design rather than changing it.
**Raised by:** `docs/REVIEW.md` §4.2, which flagged the standard as canonical prior
art that might make §9.5's bespoke liquidity restriction unnecessary.

## What the standard actually is

Not a liquidity-restriction utility. It is a **compliance framework for
transfer-restricted assets** — tokenised securities and similar — and it is built
accordingly:

- a wrapper contract (the **Permissions Adapter**) that holds the underlying token
  and issues a pool-tradeable representation of it;
- an **issuer-managed allowlist**, consulted on every swap and every liquidity
  addition;
- a separate **Permissioned Position Manager**;
- **non-transferable** position NFTs;
- an **adapter admin** with the power to call `unwindPosition` and close an LP's
  position.

## Decision

Reject it. Verdant implements its liquidity restriction as its own check in
`beforeAddLiquidity`, per §9.5.

## Reasoning

### The admin unwind power alone disqualifies it

Verdant's entire disclosure position (§6.2, decision D5) is that **no party,
including Verdant, can reach a live market**. That claim is the product. Adopting a
framework whose adapter admin can unwind an LP's position would import exactly the
lever we publicly state does not exist.

There is no version of this that is fine because we would not use the power. A
capability that exists is a capability that must be disclosed, can be compelled,
and will be found by anyone reading the code. The honest choices are to have the
lever and say so, or not to have it. Verdant has already chosen the second.

### It is a large mechanism for a small requirement

Verdant's requirement, stated completely: *only one immutable address may add
liquidity to a Verdant pool.* That is a single equality check against an immutable.

Adopting the standard to express it brings a wrapper token layer, a second
position manager, a factory-based adapter verification step, and a per-swap
allowlist consultation — each of which is a component to deploy, verify, audit,
index, and explain, and each of which is a place a market can fail for a reason
unrelated to anything a creator did.

### Its threat model is not ours

The standard restricts **who may hold and trade** an asset, and is designed for an
issuer who must retain intervention powers to satisfy a regulator. Verdant
restricts **who may add liquidity**, and is designed for a creator who wants to
demonstrate that nobody can intervene. Those are close enough to look
interchangeable in a summary and opposite in their consequences.

## What is taken from it

The standard had to solve the same problem as V11: when liquidity arrives through
a position manager, the hook's `sender` is the position manager, not the actual
liquidity provider — so how does the hook learn who is really adding liquidity?

That is a genuinely hard question with a known-good answer somewhere, and there is
no reason to invent one. `docs/verification.md` V11 records the technique and
Verdant's recommended mechanism. The technique is borrowed; none of the allowlist,
wrapper, or admin machinery is.

## Consequences

- [x] §9.5's bespoke restriction stands. No change to the design.
- [ ] P3 implements the `beforeAddLiquidity` check per V11's recommendation.
- [ ] The rejection is stated in the public documentation where Verdant explains
      why its pools are closed venues, so that "why not use the standard?" has a
      written answer.

## Alternatives rejected

**Adopt it wholesale.** Rejected: the admin unwind power contradicts D5.

**Fork it and remove the admin powers.** Superficially attractive — keep the
standard's structure, drop the lever. Rejected because what would remain is the
wrapper layer, the second position manager, and the verification step, all still
present, minus the compliance capability that justifies their existence. It would
be a large mechanism carried for its shape rather than its function, and it would
no longer be the standard, so it would not even carry the benefit of being
recognisable prior art.

**Adopt it only for the LP-identity resolution.** This is, in effect, what we are
doing — but by borrowing the technique rather than the dependency. Taking the
package to get one mechanism would mean auditing all of it.
