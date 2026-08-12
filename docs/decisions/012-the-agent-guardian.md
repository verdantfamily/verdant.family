# ADR-012 — Agent contracts have a guardian; market contracts still have nobody

Status: accepted. Records a departure from Verdant's ownerless design, its
boundary, and the threat model it answers. Extends ADR-010.

## Decision

Each agent has a `guardian`, fixed at creation, which can do exactly two things:

- `pause(agentId)` — stop the execution module accepting new actions.
- `revoke(agentId)` — stop it permanently. A revoked agent cannot be resumed by
  anyone, including the guardian.

It cannot move funds, change a mandate, change an allocation, redirect revenue,
or reach any contract in the market layer. There is no `unrevoke`, no upgrade, no
`sweep` and no `delegatecall`.

This is a real departure and it is stated rather than buried. Every market
contract in Verdant is ownerless — that is the product's central claim, and it is
unchanged: a guardian holds no power over a token, a pool, a hook, a locker, a
splitter or a vesting contract, and cannot acquire any.

## Why an agent needs one when a market does not

A market is inert. Once created it computes a fee and settles swaps; there is no
state in which somebody has to intervene, which is why nobody can.

An agent is not inert. It holds a treasury, it acts on a schedule, and the thing
proposing its actions is software that can be wrong in ways nothing on chain can
detect: a compromised runtime, a poisoned prompt, a provider that starts
returning garbage, an operator key on a laptop that is now somebody else's. The
mandate bounds the damage per action and per day. It cannot stop a bounded harm
repeating every day until the limits are exhausted.

So the choice is not "owner or no owner". It is "a stop button, or a treasury
that drains at exactly the rate its mandate permits while everyone watches".

## The boundary, precisely

What the guardian can reach:

- `AgentExecutionModule` — refuse new actions for this agent.
- `AgentIdentityRegistry` — set this agent's status to `Paused` or `Revoked`.

What it cannot reach, and why the code says so rather than the policy:

- **The treasury's balances.** There is no guardian-callable transfer. Funds move
  only through the execution module, only for a typed action, only to an address
  the mandate approved at creation. Pausing stops movement; it does not redirect
  it.
- **The mandate.** Immutable after construction. There is no setter for any
  party.
- **The revenue router's allocation.** Immutable after construction.
- **Anything in the market layer.** No agent contract holds a privileged
  reference to one. `AgentIdentityRegistry` reads `MarketRegistry` and
  `FeeSplitter`, both `view`.

## What a paused agent still does

Pausing stops *new agent actions*. It does not stop:

- the market trading;
- fees accruing to the locked position;
- `PositionLocker.collect()`, which anyone may call;
- `FeeSplitter.claim()`, which pays recipients their own shares;
- revenue arriving at the router and being allocated into buckets.

That is deliberate. A guardian who could stop money arriving would be a guardian
who could starve an agent's other recipients, including the protocol and the
developer. It can stop the agent spending; it cannot stop the agent earning.

## Threat model for the MVP

**Trusted.** The chain and its sequencer. Uniswap v4 core and the pinned
periphery. The equity tokens on the reviewed allowlist, to the extent ADR-008
already trusts them. The guardian, for availability only — it can halt an agent,
and that is the whole of its power.

**Untrusted, and assumed hostile.** The agent runtime and any model inside it.
The operator key. Service providers, including other agents. Every payer. Anyone
calling a permissionless function. Anyone reading the interface.

**What the design defends.**

| Threat | What stops it |
| --- | --- |
| Model persuaded to pay an arbitrary address | Recipient must be mandate-approved at creation |
| Model persuaded to pay an unbounded amount | `maxActionValue`, and the per-asset daily limit |
| Operator key stolen | Same two limits, plus the guardian's stop |
| Runtime spamming small payments | Minimum interval between actions, and the daily limit |
| A signed action replayed | Nonce, and `requestId` for service payments |
| A stale approval executed late | Deadline on every action |
| Guardian turns hostile | Cannot move funds or change policy; worst case is denial of service |
| Developer turns hostile after launch | Mandate and allocation are immutable; they chose them before anyone paid |
| Agent tries to mint or unlock liquidity | No mint function exists; `PositionLocker` has no withdraw path |

**What it does not defend.** A developer who configures a permissive mandate at
creation and finds a buyer for it afterwards. Every limit is public before anyone
pays, and the interface states them in plain language, but a bad configuration
chosen openly is not something this design prevents — it is something it
discloses.

## What this makes true

- The strongest thing any privileged key in this system can do to a user is stop
  an agent from spending.
- No key added by Agent Launch weakens any claim `SECURITY.md` makes about
  markets, because none of them can reach a market.
- A revoked agent is terminal, so "we paused it and quietly turned it back on" is
  not available.

## Consequences

- [x] `SECURITY.md` gains an agent section listing the guardian and both of its
      powers, alongside the existing statement that markets are ownerless.
- [x] The agent page shows the guardian address, its two powers, and the agent's
      status, without a reader having to ask.
- [x] `AgentIdentityRegistry.revoke` has no inverse. Tests assert that a revoked
      agent cannot be resumed by the guardian, the developer, the operator or the
      factory.
- [x] Every guardian-callable function emits an event; `AgentPaused` and
      `AgentRevoked` are indexed and appear in the activity feed.
- [x] Tests: a paused agent rejects every action type; revenue still arrives and
      still allocates while paused; the guardian cannot call the treasury, the
      mandate or the router.

## Rejected

- **No guardian at all.** Symmetric with the market layer and wrong for the
  reason above: an agent is an actor, and an actor with a bounded fault repeats
  it.
- **A guardian that can also move funds.** Turns every agent into a custodial
  product and makes the guardian key worth stealing. The stop button is worth
  little to an attacker; a withdrawal is worth the treasury.
- **A guardian that can edit the mandate.** Then the mandate is a suggestion, and
  the agent page cannot honestly say what an agent may do.
- **A timelocked mandate upgrade path.** Defensible, and deferred: it needs a
  governance process this product does not have yet, and shipping the mechanism
  before the process is how the process ends up being "whoever holds the key".
- **Verdant as guardian for every agent.** Concentrates the one privileged key in
  the system into a single address across all agents. The guardian is chosen per
  agent at creation, and may be the developer, a multisig, or nobody reachable.
