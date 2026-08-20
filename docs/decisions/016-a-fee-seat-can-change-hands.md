# 016 — A fee seat can change hands; a fee vault cannot

**Status:** accepted
**Extends:** [015](015-boost-is-a-fee-recipient-not-a-fee-change.md)

## Decision

A community takeover can be given the market's creator fee by having the market **name a
`CreatorSeat` as its `feeRecipient` at launch**, and by nothing else.

No deployed contract changes. Not `InstantHook`, not `InstantFactory`, not `InstantDeployer`,
not `MarketRegistry`, not `InstantFeeVault`, not one existing market. Two new contracts are
added, `CreatorSeat` and `CreatorSeatFactory`, and neither is referenced by anything already
on chain.

The consequence is stated first because it cannot be softened: **a market that named a wallet
at launch can never have its fee recipient changed.** Every Instant market created before this
is in that category, permanently. `$AAA`
(`0x6C58D6F67f728A74158E31FA1B6b497967e4786F`) is the case that prompted this, and it is not
fixable — its vault `0x966A3Ae218981E033ceCE157f8C7C5EEc97a3911` pays the EOA
`0xDA340205e15eb6b86fA2072Bba7484c67065Fe67` for as long as the market trades.

The seat is transferable in two ways. The occupant can hand it over themselves (`offer` /
`take`). Agen, as the factory's steward, can name a successor after an off-chain CTO check
(`propose`); the successor takes the seat after a fourteen-day delay the occupant can still
`veto`. Agen cannot skip the delay, cannot take the seat itself, and cannot act on a seat
whose occupant has called `renounceArbitration`.

Holders do not vote. A keeper cannot move it. The factory's own address is not the steward.

## Reasoning

### The vault is right to be immutable, so the mutability goes above it

`InstantFeeVault.creator` is an `immutable` with no setter, no owner, no sweep and no upgrade
path (`src/InstantFeeVault.sol:82`, and the contract's own header at `:13-14`). That is not an
oversight to be corrected. A fee destination a third party can rewrite is a fee destination a
compromised third party can steal, and every trader in a market is relying on the fee going
where the market said it would.

So the vault keeps paying exactly one address forever. The change is that the address can be a
contract with an occupant rather than a wallet with a key. Handing the seat over alters who
the ether reaches and nothing about the market, the pool, the token, the liquidity lock, or
what any existing contract does.

This is the same shape as [015](015-boost-is-a-fee-recipient-not-a-fee-change.md), and
deliberately so: the fee recipient is the one lever a launch can pull, and both Boost and
takeovers are things you do by choosing what to name rather than by changing the machinery.

### Boost cannot serve this purpose

`BoostEscrow.owner` is also `immutable` (`src/BoostEscrow.sol:188`), and an escrow's address is
CREATE2-derived with the owner as the salt (`src/BoostEscrowFactory.sol:129-131`), so "an
escrow can only ever pay the owner it was deployed for". Boost makes a creator's fee *buy the
token back*. It does not make the fee *change hands*. A market naming an escrow is as stuck as
a market naming a wallet, for a different reason.

A market therefore names a seat **or** an escrow, not both. Composing them — a seat that owns
an escrow — is coherent and is left for later, because it means reasoning about a handover of
a stream that is partly committed to buybacks, and that deserves its own decision.

### Why Agen may propose, and why that is not the same as Agen may take

The case that prompted this work is a creator who is gone. Occupant-only handover cannot
serve that case, and pretending otherwise just moves the deadlock from the vault onto the
seat. The process Agen actually runs — a community DMs on X, Agen checks, Agen names a
wallet — needs an on-chain act that names a successor without the old key.

The bounds on that act are the product:

- **Agen proposes; the successor accepts.** A mistyped address is an open invitation, not a
  lock-out, which is the same reason `take` exists on the occupant path.
- **Fourteen days, restarting if the named address changes.** A delay the steward can skip,
  or a delay that does not restart when the proposal is replaced, is a delay in name only.
  Evidence: `test/CreatorSeat.t.sol::test_theSuccessorCannotAcceptBeforeTheDelay` and
  `::test_replacingAProposalRestartsTheDelay`.
- **The occupant can veto with no delay of their own.** A live creator who still holds the
  key should not have to wait out Agen's clock to keep their fees. That is what stops a
  convincing impostor from being paid out of a review that happened on X. Evidence:
  `::test_aLiveCreatorCanVetoAProposal`.
- **A founder can turn the path off forever** with `renounceArbitration`. A later occupant
  inherits the refusal. Evidence: `::test_renouncingArbitrationStopsTheStewardForever` and
  `::test_aLaterOccupantInheritsARenounce`.

What was rejected, and why it stays rejected:

- **Agen may reassign immediately.** Then a compromised steward key drains every seated
  market in one block, and a live creator has no window. The DM-and-check process cannot
  catch that.
- **Holders vote.** A snapshot of an ERC-20 balance is a snapshot of who could buy the most
  of it this block. A vote here is a purchase.
- **Inactivity releases the seat.** That still needs somebody to name the successor, which
  is the steward, with a different clock in front. The fourteen-day veto is the clock that
  actually matches the process (Agen already decided; the creator gets a chance to object).

The remaining trust is real and is the cost of the feature: a compromised steward key plus
fourteen days of a creator not looking is enough. That is named rather than engineered
around, and it is why renounce exists.

The steward lives on the factory, not on each seat, so rotating Agen's key is one
two-step handover and not a visit to every market. Evidence:
`::test_rotatingTheStewardUpdatesEverySeat`.

### Why the handover takes two transactions

`offer` names a successor; `take` is the successor accepting. One call would be simpler and
would also make a mistyped address permanent — the vault pays the seat forever, the seat pays
whatever `beneficiary` says, and a `beneficiary` nobody holds the key to is the same dead end
the seat exists to prevent, reached by the transaction meant to avoid it. Requiring the
successor to sign proves the address is live before it becomes the only one that matters.

Evidence: `test/CreatorSeat.t.sol::test_anOccupantThatRefusesEtherBlocksOnlyItself` — a
recipient that rejects ether reverts its own collect atomically, leaves the fee in the vault
rather than stranded in the seat, and is recoverable in full by handing the seat on.

### Why one seat per launch rather than one per creator

`FeeForwarderFactory` and `BoostEscrowFactory` both key on the owner alone, because what they
change is how a creator's fees are *delivered*, which is the same answer for every market that
creator launches. A seat changes who the fees *belong to*, and that answer is per token. One
seat per creator would make a handover an all-or-nothing transfer of a creator's entire
catalogue — not a takeover of anything, and a trap for whoever signed it.

So the salt is the opener and a label (`src/CreatorSeatFactory.sol:_salt`), and a launch uses a
fresh label. A creator who reuses a label deliberately shares one seat across those markets
and hands them over together, which is theirs to choose.

Evidence: `test/CreatorSeat.t.sol::test_oneLabelPerLaunchKeepsHandoversApart`.

### What the derivation proves

`seatOf(opener, label)` is a pure function of the factory, the seat's compiled bytecode and
those two arguments, so a seat cannot be forged. What it cannot tell you is who occupies the
seat now — `beneficiary` is mutable and a handover leaves the address unchanged, which is the
entire purpose. `opener` is the address that opened the seat and never a claim about who it
currently pays.

Evidence: `test/CreatorSeat.t.sol::test_aSeatCannotBeForged` and
`::test_isGenuineStillHoldsAfterTheSeatChangesHands`.

## What remains

Neither contract is broadcast, and this decision does not deploy them. What is still open:

- **Not deployed.** `CreatorSeatFactory` has no address in
  `packages/config/src/deployments.ts`, the same deliberate split this repository already makes
  for `INSTANT_LAUNCHABLE` and for Boost: having the code and turning the surface on are two
  decisions.
- **Not wired into the launch flow.** Naming a seat is a choice a creator has to be offered,
  which means the Instant draft, the review screen and the two-transaction launch path all
  have to say what a seat is and what it means that the recipient can change.
- **Disclosure is unresolved.** A market whose fee recipient can change hands is materially
  different from one whose recipient cannot, and a market whose recipient can be proposed
  against by Agen is different again. A trader reading the market page should be told which
  they are looking at, including whether arbitration has been renounced. A seat is visible
  on chain but only to somebody who knows to look.
- **The steward key is operational trust.** Whoever holds the factory's `steward` can start
  a fourteen-day clock on every seated market that has not renounced. That key should be a
  multisig, and rotating it is a two-step handover on the factory (`offerSteward` /
  `acceptSteward`), not a redeploy.
- **Unclaimed fees follow the seat.** A handover carries whatever has accrued and not been
  claimed, because the vault keeps no record of who was seated when a swap paid it and there is
  therefore nothing to split on. Pinned by
  `test/CreatorSeat.t.sol::test_unclaimedFeesFollowTheSeatRatherThanTheOccupantWhoEarnedThem`,
  and worth stating to a creator before they sign, not after.
- **Composition with Boost is undesigned.** See above.
