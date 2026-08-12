# ADR-011 — An agent proposes a typed action; it never supplies calldata

Status: accepted. Defines the execution model for Agent Launch. Extends ADR-010.

## Decision

The only thing an agent can put on chain is a value of a struct this repository
defines. There is no function anywhere in `src/agents/` that accepts `bytes
calldata` and forwards it, and no path by which a language model, a keeper or a
developer can cause the treasury to make a call the code does not already
describe.

Each supported action is a distinct struct with a distinct handler:

```solidity
enum AgentActionType { PayService, PayDeveloper, PayProtocol }
```

Phase 1 supports those three. `ExecuteBuyback` and `AllocateRevenue` arrive later
with their own limits, and the enum is deliberately not reserved ahead of them —
an unused variant is a variant nobody tested.

The mandate is the authority. The SDK validates and simulates the same action
before a human is asked to sign it, and that simulation is advisory in the strict
sense: nothing on chain reads it, and a disagreement between the two is resolved
by the chain rejecting the action.

## Why not a generic executor

A generic `execute(address target, uint256 value, bytes calldata data)` guarded
by a target allowlist looks equivalent and is not. Three things go wrong.

**The allowlist stops describing the action.** `approve(spender, type(uint256).max)`
and `transfer(recipient, 1)` are both calls to an approved token. A guard on the
destination cannot distinguish "pay this provider two units" from "grant this
provider everything, forever", because the difference is in the calldata it was
told not to inspect.

**Selector allowlists move the problem rather than solving it.** Permitting
`transfer(address,uint256)` still permits every recipient and every amount unless
the arguments are decoded — at which point the contract is parsing calldata into
a struct it could have been handed directly, with a decoder that is now part of
the trusted computing base.

**The reason cannot be recorded.** A structured action carries its `serviceId`,
its `requestId` and its deadline, so the activity feed can say *what was bought*
rather than *that a transfer happened*. Reconstructing intent from calldata after
the fact is the thing that makes on-chain activity unreadable.

## Where the model sits

The runtime — OpenAI, Anthropic, a local model, or a `for` loop — returns JSON:

```json
{
  "actionType": "PAY_SERVICE",
  "providerAgentId": "0x...",
  "serviceId": "market-data-v1",
  "asset": "0x...",
  "amount": "2500000",
  "reason": "Approved market data required for the next report"
}
```

The SDK parses it, rejects anything not matching the schema, and encodes the
struct. The model's output is data throughout; it is never bytes, never a
signature, and never a destination the SDK did not already know.

The `reason` field is carried off chain and shown in the feed. It is not hashed
into the action, because a model-authored string that influenced nothing should
not be given the appearance of a commitment.

## Replay, expiry, and why both

Every action carries a `nonce` and a `deadline`, and `PayService` additionally
carries a `requestId`.

- The nonce is per agent and strictly increasing. It makes an action executable
  once.
- The deadline makes an action stop being executable at all. An approved action
  that sits unsigned for a week is a different decision by the time it lands, and
  the mandate should refuse it rather than let a human's stale approval bind a
  treasury.
- The `requestId` ties a payment to the specific service request it settles, so
  the same request cannot be paid twice under two nonces.

## What this makes true

- The set of things an agent can do is enumerable by reading one enum, and the
  set of things it can do *to* an address is enumerable by reading one struct.
- A compromised runtime — a jailbroken model, a poisoned prompt, a hostile
  operator — can propose only actions of these shapes, to approved targets,
  within limits, and cannot propose anything else however it is instructed.
- The activity feed is generated from typed events rather than from decoded
  calldata, so it is complete by construction.

## Consequences

- [x] `AgentExecutionModule` exposes one entry point per action type. There is no
      fallback, no `receive`, no `delegatecall`, and no function taking `bytes`.
- [x] `AgentTreasury` moves value only when called by the bound execution module,
      and only through `safeTransfer` to an address the mandate approved.
- [x] The SDK's `validateAgentAction` mirrors every mandate check, and its
      failures use the same reason codes the contract emits, so a rejection reads
      identically off chain and on.
- [x] Simulation returns `valid: false` with the violated rules named. The
      interface never presents an action as safe on the strength of a model's
      opinion.
- [x] Tests: each action type executes; each mandate check rejects with its own
      error; a replayed nonce, a reused `requestId` and an expired deadline all
      fail.

## Rejected

- **A generic executor with a target allowlist.** Cannot tell an approval from a
  payment.
- **A generic executor with target and selector allowlists.** Needs an argument
  decoder to be safe, which is the struct with extra steps and a larger trusted
  surface.
- **Signing typed actions off chain with an operator key (EIP-712) and relaying
  them.** Adds a signature scheme, a key to steal and a relayer to trust, in
  exchange for saving the operator one transaction. Phase 2 may revisit it for
  session keys; the MVP does not need it.
- **Letting the model emit calldata and validating it in the SDK.** The SDK is
  not the authority. Anything the SDK can be persuaded to encode, the chain would
  accept.
