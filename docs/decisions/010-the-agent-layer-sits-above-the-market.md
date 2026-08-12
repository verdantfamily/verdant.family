# ADR-010 — The agent layer sits above the market layer and binds to it, rather than wrapping it

Status: accepted. Introduces Agent Launch. Modifies no existing contract.

## Decision

An Agent Launch is two transactions against two independent layers.

1. `AgentLaunchFactory.createAgent` deploys the agent's own contracts — identity,
   mandate, treasury, revenue router, execution module — and registers the agent.
   It touches nothing in the market layer.
2. The developer calls the existing `VerdantFactory.create` directly, unchanged,
   with `feeRecipient` set to the agent's revenue router.
3. `AgentIdentityRegistry.bindMarket` records the pool id against the agent. It is
   permissionless, because it verifies rather than trusts: the binding is accepted
   only if the market's own splitter pays the agent's router.

No contract in `packages/contracts/src/` outside `src/agents/` is edited, and the
launch path that has been deployed and verified on 4663 is byte-identical after
this change.

## Why the factory does not wrap `create`

The obvious design is one transaction: `AgentLaunchFactory` calls
`VerdantFactory.create` on the developer's behalf and returns everything at once.
It is wrong, and the reason is that `create` reads `msg.sender` six times and
means something different by it each time.

```solidity
created.token   = deployer.deployToken(salt, ..., msg.sender, ...);   // token creator
bytes32 salt    = saltFor(msg.sender, params.salt);                   // salt namespace
created.vesting = _distribute(created.token, msg.sender, ...);        // allocation and vesting beneficiary
market.creator  = msg.sender;                                         // registry attribution
InitialBuy({ creator: msg.sender, ... })                              // who receives the first buy
(bool ok,) = creator.call{value: amount}("");                         // who receives the refund
```

A wrapper becomes all six. The consequences are not cosmetic:

- **Attribution collapses.** `MarketRegistry.marketsByCreator` would return every
  agent market in existence for one address — the factory — and nothing for the
  developers who launched them. `/profile` reads exactly that function.
- **The wrapper takes custody.** The creator allocation, the tokens bought by the
  first buy, and any ether refunded by `_refund` all arrive at the wrapper. A
  contract that holds user funds needs a withdrawal path, and a withdrawal path is
  the thing this repository does not have anywhere else.
- **The salt namespace is shared.** `saltFor(msg.sender, params.salt)` exists so
  that one creator cannot occupy another's address. Behind a common wrapper every
  developer draws from one namespace.

None of that is fixable inside the wrapper without changing `create`, and changing
`create` means redeploying the factory, remining the hook, and invalidating the
verification record. The market layer is worth more untouched.

## Why binding can be permissionless

`bindMarket` takes an agent id and a pool id and accepts the pair only if:

```
MarketRegistry.marketOf(poolId).splitter      exists, and
FeeSplitter(that splitter).creator()          == agent.revenueRouter
```

`FeeSplitter.creator` is the `feeRecipient` supplied at creation, held as an
`immutable`. So a binding asserts a fact that the market itself already records
and that nobody can change afterwards. A false binding is not discouraged, it is
impossible: an attacker binding somebody else's market to their own agent would
have to make that market's splitter pay their router, which was decided when the
market was created and cannot be revised.

That is why no owner, no signature and no allowlist is needed for the step, and
why a market can be bound by anyone — including a keeper — after the developer's
second transaction.

## Being the fee recipient is not enough on its own

`FeeSplitter.claim` pays `msg.sender` and takes no argument saying whom to pay.
That is deliberate — it is what stops one recipient aiming the function at
another's share — and it has a consequence for this design that was missed when
it was first written: naming a contract as `feeRecipient` only works if that
contract can make the call.

The router therefore has `claimMarketFees`, and it does not take the splitter as
a parameter. `AgentIdentityRegistry.bindMarket` calls `bindSplitter` on the
router in the same transaction that proved the splitter pays it, so:

- the router never looks a splitter up, and never reads `MarketRegistry`;
- the one external address it will ever call arrived from the contract whose word
  on the subject is a proof rather than a claim;
- there is no path by which a caller hands the router an address to call, so the
  "no arbitrary external calls" property survives.

`claimMarketFees` is permissionless, like collection and allocation, because who
pushes the button cannot change where the money goes. It writes nothing: the
claim moves value in, and `recognise` counts it afterwards on the same footing as
a service payment or a plain transfer, so there is one definition of revenue
rather than one per route.

This is the only write the agent layer makes as a consequence of reading the
market layer, and it happens after every check in `bindMarket` has passed.

## What this makes true

- A market created by an Agent Launch is an ordinary Verdant market. It has the
  same hook, the same locker, the same immutability, and the same page.
- The agent's revenue includes its market's creator fee stream by construction,
  because the splitter pays the router rather than a person.
- An agent can be created for a market that already exists, and a market can
  exist without an agent. The two layers fail independently.
- Deleting every agent contract would leave the market layer exactly as it is
  today.

## Consequences

- [x] `AgentLaunchFactory` does not import `VerdantFactory`.
- [x] `AgentIdentityRegistry` holds immutable references to `MarketRegistry` and
      reads `FeeSplitter.creator()` to verify a binding.
- [x] `AgentRevenueRouter` records its splitter through `bindSplitter`, callable
      only by the identity registry and only once, and exposes a permissionless
      `claimMarketFees`.
- [x] The launch flow in the interface is two signatures, and says so rather than
      presenting itself as atomic.
- [x] An agent's `poolId` is zero until bound. Every consumer treats "unbound" as
      a state rather than as an error.
- [x] Tests: binding succeeds for a market whose splitter pays the router; fails
      for an unknown pool, for a market paying somebody else, and when attempted
      twice.

## Rejected

- **`AgentLaunchFactory` calls `create`.** Six identities, described above.
- **Adding an `onBehalfOf` parameter to `create`.** Redeploys the factory,
  remines the hook against a new factory address (ADR-007), and reopens
  verification — to save one signature.
- **Binding by the developer only.** The check is a proof, not a permission, so
  restricting the caller adds a failure mode (a developer who never returns) and
  removes none.
- **Storing the agent id in the market's `metadataURI`.** It is a string the
  creator chooses, it is mutable unless frozen, and it would make the binding a
  claim rather than a check.
