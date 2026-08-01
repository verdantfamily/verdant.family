# ADR-005 — Fee splits belong to the splitter, and `creatorBps` is derived

Status: accepted. Supersedes §19.1 (the splits block) and §5.2.

## Decision

Three things, and the third is the one that matters:

1. **`VerdantHook` never reads a split.** Not `creatorBps`, not `protocolBps`,
   not `reserveBps`; not in `beforeSwap`, not in `afterInitialize`, not anywhere
   in its lifetime. The hook owns the fee *schedule*. `FeeSplitter` owns the
   *split*, holding it as immutable clone arguments.
2. **`reserveBps` is 0 in v1** and returns with Evergreen.
3. **`creatorBps` is not an input.** It is `10_000 - protocolBps - reserveBps`.
   Nobody supplies it, nothing stores it as an independent value, and the sum is
   asserted by the factory on the derived figure rather than validated across
   three supplied ones.

## What went wrong, precisely

§19.1 stated that every split must sum to exactly 10 000, and independently
capped `creatorBps` at 8 000, `protocolBps` at 2 000 and `reserveBps` at
1 000–8 000. Those constraints are not jointly satisfiable:

- For Fixed and Progressive, where `reserveBps` is pinned to 0 by the model
  bounds, the only split reaching 10 000 is exactly 8 000 / 2 000. Every other
  choice a creator could make would have been rejected.
- The register's own stated defaults — creator 5 000, protocol 1 000, reserve
  2 000 — come to 8 000, not 10 000. The defaults were invalid under the rule
  printed three lines above them.

There was a test asserting the caps were satisfiable. It asked whether the three
maxima could reach the total (18 000 ≥ 10 000, yes) and whether the three minima
could stay under it (1 000 ≤ 10 000, yes). Both passed, and neither was the
question. The replacement in `packages/sdk/src/config.test.ts` asks the question
the derivation raises instead: whether the derived share is well defined for
every model at every reachable setting. It is, and it is exactly 0 at Evergreen's
extreme — 2 000 protocol plus 8 000 reserve — which is a legitimate market where
everything the creator would have taken is reinforced into the locked position.
One basis point more on either cap and the derivation underflows.

## Why the hook must not hold them

`protocolBps` is set by `ModelRegistry`, whose owner may change it for *future*
markets. `VerdantHook` is immutable and address-mined. Putting a
registry-governed bound inside a contract that can never be changed guarantees
that the two disagree the first time a bound moves; the arithmetic contradiction
above is what that disagreement looks like when it is caught early, and it was
caught by luck rather than by design.

**No guarantee is lost by moving the check.** The claim worth preserving is
"every Verdant market's splits were validated against the registry's bounds at
creation". `beforeInitialize` already refuses to let any pool with this hook be
initialised unless `sender` is the factory, and the factory address is an
immutable of the hook. So a market exists only if the factory made it, and the
factory validates the splits. The check moves; the guarantee does not.

## Follow-on: Evergreen is disabled in v1

Recorded here because it follows from this decision rather than from a new one.

`reserveBps` being 0 in v1 means `VerdantFactory` asks the registry
`creationAllowed(model, stageCount, 0)`. Evergreen's bounds put a floor of 1 000 on
the reserve share — that floor is what distinguishes the model — so the answer for
Evergreen is always false, and every launch of it is refused.

The parameter register shipped with all three models enabled anyway, and no test
caught it because nothing in the suite created a market of that model. An interface
reads `enabled` to decide what to offer, so it would have advertised a model whose
every launch reverts. The register now sets `evergreen.enabled: false`, and
`BoundsParity.t.sol` asserts the general rule that produced the contradiction: an
enabled model must be creatable with the reserve share the factory actually passes.
Re-enabling it therefore requires `reinforce()`, which is the correct ordering.

## Consequences

- [x] `beforeInitialize` and `configure` validate the model discriminant, the
      stage count and the schedule. No split validation, and no split fields in
      the stored config or in the data the factory hands over.
- [x] Two acceptance tests from the P3.1 brief are struck and move to P5, where
      the factory lands: "splits not summing to 10 000" and "`reserveBps` > 0 on
      a non-evergreen model". Both are factory properties now.
- [x] The packing budget is unaffected. The three shares were never in
      `ScheduleLib`'s two-word encoding — the header is model, stage count and
      initTime, and the stages are offset plus fee — so no bit arithmetic changed
      and the table in `ScheduleLib`'s doc comment stands as written. The gas
      snapshot is unchanged for the same reason.
- [x] `packages/config`: `BOUNDS.splits.creatorBps` is removed entirely,
      `MAX_PROTOCOL_BPS = 2_000` is exported for the contracts that enforce it,
      `reserveBps` keeps its Evergreen range and loses its meaningless default,
      and the derivation is documented where the removed field used to be.
- [x] `packages/config/generated/bounds.json` regenerated; `minCreatorBps` and
      `maxCreatorBps` are gone. No Solidity read them, so `BoundsParity.t.sol` is
      unaffected, and the CI diff-free gate passes.
- [x] Two places that still name `creatorBps` were checked rather than
      renamed. `MarketRegistry.Market.creatorBps` stays: the registry is a record
      of what happened, and the derived share is worth persisting so a reader does
      not have to re-derive it from a protocol setting that may since have moved.
      It is a snapshot of an output, not a bound on an input, and the struct's own
      comment already says the sum is the factory's invariant.
- [x] `MODELS[*].unlockedParameters` did **not** stay. All three models listed
      `creatorBps` as a parameter the model unlocks, and that list is rendered as
      the create flow's controls (§3.1 step 3), so it promised the creator a
      control that cannot exist. Removed from all three, and two tests now hold
      the disclosure to the mechanism: no model may list `creatorBps`, and only
      Evergreen may list `reserveBps` — which is asserted against
      `MODEL_BOUNDS[model].reserveBps.max > 0` rather than against the string, so
      the copy and the bound cannot drift apart.
- [ ] P5: the factory asserts `creator + protocol + reserve == 10_000` on the
      derived value, enforces `protocolBps <= MAX_PROTOCOL_BPS` against the
      registry's snapshot, and passes the three shares to `FeeSplitter` as
      immutable clone arguments.

## Rejected alternatives

**Raise `maxCreatorBps` to 10 000 and fix the defaults.** Patches the arithmetic
and keeps the duplication, so the next bound that moves produces the next
contradiction.

**Let the three shares sum to at most 10 000 and leave the remainder in the
position.** Strands value. Fees are already out of the position by the time the
splitter sees them, so an undistributed remainder has no consumer unless one is
defined — and that consumer is `reserveBps` under another name. "Retained by the
LP" cannot mean anything when the locked position is the only LP and its fees
flow straight back to the splitter; retention would only defer.

**Add a fourth explicit `lpRetainedBps` field.** Same objection, with an extra
field to store and validate.
