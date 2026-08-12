# The agent layer

What an agent is, what it can do, who can stop it, and how an off-chain runtime
drives one without ever holding a key that matters.

This is the operational companion to the decisions of record. Where they argue,
this describes. Read [ADR-010](decisions/010-the-agent-layer-sits-above-the-market.md)
for why the layer binds to a market rather than wrapping the launch,
[ADR-011](decisions/011-agents-propose-typed-actions.md) for why an agent proposes
a struct and never calldata, and [ADR-012](decisions/012-the-agent-guardian.md)
for the guardian and the threat model.

## What an agent is

Five contracts and a record, deployed in one transaction by
`AgentLaunchFactory.createAgent`. Every address is fixed at that moment.

| Contract | Holds | Can be changed by |
| --- | --- | --- |
| `AgentIdentityRegistry` | The record: developer, guardian, components, expectation, lifecycle state | Append-only. State moves along a fixed matrix; metadata URI is the developer's |
| `AgentMandate` | What the agent may spend, on what, how often, until when | Nobody. There is no setter. The guardian may revoke it, permanently |
| `AgentTreasury` | The money | Nobody. `spend` is the only exit and only the execution module may call it |
| `AgentExecutionModule` | The one action | Nobody. `operator` is immutable |
| `AgentRevenueRouter` | Income, and the four-way split | Nobody. The shares are immutable |
| `AgentServiceRegistry` | What each agent sells, and at what price | The developer, while the lifecycle permits it |

There is no proxy, no `delegatecall`, no `selfdestruct` and no upgrade path
anywhere in `src/agents/`.

## The lifecycle

```
  Created ──bindMarket──▶ MarketBound ──activate──▶ Active ◀──resume── Paused
     │                        │                       │   ──pause──▶     │
     └────────────────────────┴───────revoke──────────┴──────────────────┘
                                       ▼
                                    Revoked
```

`AgentLifecycle` is the single definition; four contracts enforce it and the SDK
mirrors it. `Active` is the only state in which a discretionary action executes.
Revenue arrives and fixed entitlements settle in **every** state, including
`Revoked` — a guardian who could stop money arriving could starve the developer
and the protocol of shares that were fixed at launch.

## Launching an agent with a market

Two transactions, deliberately. The agent layer never wraps
`VerdantFactory.create`, because `create` reads `msg.sender` six times and means
something different by it each time — the token's creator, the salt namespace,
the vesting beneficiary, the allocation recipient, the first-buy recipient and
the refund address. A wrapper would become all six.

```
1. developer → AgentLaunchFactory.createAgent(params)
                 params.expectation names the token address the launch will produce
                 → returns { agentId, mandate, treasury, router, executionModule }

2. developer → VerdantFactory.create(params)
                 params.feeRecipient = the agent's router
                 params.salt         = the salt the token address was predicted from
                 → an ordinary Verdant market, created by the developer

3. anyone    → AgentIdentityRegistry.bindMarket(agentId, poolId)
                 verifies, then binds, then hands the router its splitter

4. developer → AgentIdentityRegistry.activate(agentId)
```

The token address is knowable before step 2 because `VerdantDeployer` uses
`CREATE2` under a salt derived from the creator. `VerdantDeployer.tokenInitCodeHash`
and `VerdantFactory.saltFor` are what let a caller compute it.

### Why binding is permissionless

`bindMarket` verifies rather than trusts. It accepts a pair only if all of these
hold, read from the chain rather than from the caller:

- the pool is a market `VerdantFactory` created (`MarketRegistry.marketOf`);
- `market.creator` is the agent's developer;
- `FeeSplitter(market.splitter).creator()` is the agent's router — an immutable
  set when the market was created;
- the commitment rebuilt from the token, quote asset, model and live total supply
  equals the one the agent was created with.

A false binding is not discouraged, it is impossible. So restricting the caller
would add a failure mode — a developer who never returns — and remove none.

## What an agent can do

One thing: `AgentExecutionModule.payService(ServiceQuote)`.

There is no function in `src/agents/` that accepts `bytes` and forwards it. There
is no generic `execute(target, value, data)`. A selector allowlist was rejected
because it cannot tell `approve(spender, MAX)` from `transfer(to, 1)` without
decoding arguments, at which point the contract is parsing calldata into a struct
it could have been handed directly.

A quote cannot name a recipient, an amount, an asset or a version freely. Each is
read from `AgentServiceRegistry` and the quote's copy is compared rather than
used. So the worst a fully compromised runtime can do through this path is buy an
approved service, at its current listed price, from an approved provider, no more
often than the mandate's interval allows, until the period limit is spent.

### Every check, in the order the chain makes them

`AgentExecutionModule.payService`, then `AgentTreasury.spend`:

| # | Refused when | Error |
| --- | --- | --- |
| 1 | the caller is not the operator | `NotOperator` |
| 2 | the quote names another agent | `WrongAgent` |
| 3 | the agent is not `Active` | `AgentNotActive` |
| 4 | the mandate has been revoked | `MandateIsRevoked` |
| 5 | the mandate has expired | `MandateExpired` |
| 6 | the quote's deadline has passed | `QuoteExpired` |
| 7 | the nonce is not the next one | `NonceOutOfOrder` |
| 8 | the service is not listed | `UnknownService` |
| 9 | the named provider does not own it | `ServiceNotOwnedBy` |
| 10 | it is retired, or its agent is stopped | `ServiceInactive` |
| 11 | it has been changed since the quote was priced | `ServiceVersionStale` |
| 12 | the asset is not the one it is priced in | `ServiceAssetMismatch` |
| 13 | the amount is not exactly the listed price | `ServicePriceMismatch` |
| 14 | the quote names a payee the registry does not resolve to | `ProviderMismatch` |
| 15 | the mandate never approved that payee | `TargetNotApproved` |
| 16 | the request has already been paid | `RequestAlreadySettled` |
| 17 | the interval since the last action has not elapsed | `ActionTooSoon` |
| 18 | the guardian has paused the treasury | `TreasuryPaused` |
| 19 | the amount is zero, or the recipient is | `ZeroAmount`, `ZeroRecipient` |
| 20 | the mandate does not approve the asset | `AssetNotApproved` |
| 21 | the amount is over the per-action cap | `ActionValueExceeded` |
| 22 | it would pass the period's cap | `PeriodLimitExceeded` |
| 23 | the treasury does not hold it | `InsufficientBalance` |

`packages/sdk/src/agents/actions.ts` mirrors all of these except the first, in
this order, with these names. The SDK is a mirror and not an authority: if the
two disagree, the chain is right and the SDK has a bug.

### Replay, staleness and versioning

Four mechanisms, because they answer four different questions.

- **The nonce** is per agent and strictly increasing. A quote executes once.
- **The `requestId`** makes a *request* payable once, even across two nonces.
  Paying the same invoice twice is otherwise two perfectly valid actions.
- **The deadline** makes a quote stop being executable at all. An approval that
  sits unsubmitted for a week is a different decision by the time it lands.
- **The service version** makes a quote stop being executable if the thing it
  priced has changed, so a reprice cannot silently rewrite an approval a human
  already gave.

## Revenue

An agent has one income statement. Two things pay into it, and they arrive the
same way:

- **its market's creator fee stream**, because the developer named the router as
  `feeRecipient` when they launched;
- **service payments** from other agents.

```
trade → hook charges the schedule's fee
      → fee accrues to the locked position
      → PositionLocker.collect()            (permissionless)
      → FeeSplitter holds it, split creator/protocol
      → AgentRevenueRouter.claimMarketFees() (permissionless)
      → router.recognise(asset)              (permissionless)
      → router.allocate(asset)               (permissionless)
      → router.settle(asset, leg)            (permissionless)
```

`claimMarketFees` exists because `FeeSplitter.claim` pays `msg.sender` and takes
no argument saying whom to pay — so a contract named as `feeRecipient` has to be
able to make that call itself. It does not take the splitter as a parameter: the
registry hands the router that address during `bindMarket`, having just proved it.

Allocation is cumulative rather than per-arrival. A leg's entitlement is
`floor(lifetimeReceived * bps / 10_000)` minus what it has already been allocated,
so one payment of 1 000 and a thousand payments of 1 produce identical buckets.
Splitting each arrival as it lands would give whichever leg absorbs the rounding
remainder a systematic bias. At most three units sit unallocated as dust at any
instant, and the next allocation that makes them whole picks them up.

The four legs are operations (the agent's own treasury), buybacks, the developer
and the protocol. Buybacks must be configured at zero until that leg has a
destination; a share with nowhere to pay would strand a fraction of every payment
the agent ever receives.

The developer's and the protocol's legs are settled by permissionless calls that
do not read the identity registry at all. There is no state an agent can be put
into, by anybody, that stops the developer being paid what the split already
assigned them.

### Deriving an agent's revenue off chain

From logs alone, without any additional on-chain storage:

| Question | Source |
| --- | --- |
| Total revenue, by asset | `RevenueRecognised(asset, amount, totalReceived)` |
| How it divided | `Allocated(asset, operations, buybacks, developer, protocol)` |
| What has been paid out, by leg | `Settled(asset, leg, to, amount)` |
| Which market it came from | `MarketFeesClaimed(splitter, quote, token)`, joined to `MarketBound(agentId, poolId, token, splitter)` |
| What the agent bought | `ServicePaid(agentId, serviceId, actionHash, ...)` |
| What left the treasury | `Spent(asset, to, amount, actionHash)` |

`totalReceived`, `totalAllocated(asset, leg)`, `totalSettled(asset, leg)` and
`pending(asset, leg)` are also readable directly.

## No self-liquidity

A registered agent cannot add liquidity to a market it created. It holds for a
stronger reason than a rule about agents: `VerdantHook.beforeAddLiquidity`
requires that the mint arrive through the pinned `PositionManager` **and** that
the initiator be `VerdantFactory`. After creation that is false of everybody.

So the accurate statement is: *nobody* can add liquidity to a Verdant pool after
it is created — not the creator, not an agent, not another agent, not a passer-by
and not Verdant. An agent is refused as a member of that set rather than as a
special case, which means there is no agent-specific path to audit and no way for
one to be missed. `test/agents/AgentMarket.t.sol` asserts the refusal from the
agent's treasury, its execution module, its router, its operator, its developer,
a second agent's treasury, a trader, the guardian and the protocol treasury.

The locked position also cannot be withdrawn: it is owned by a `PositionLocker`
that has no withdraw path and no approve function.

## Who can do what

| Role | Can | Cannot |
| --- | --- | --- |
| **Developer** | Activate the agent; repoint its metadata URI; register, reprice and retire services; launch the market | Move treasury funds. Change the mandate. Change the split. Pause or revoke. Replace the operator or the guardian |
| **Operator** | Submit `payService` quotes | Everything else. Change its own policy. Grant another operator. Replace the developer or guardian. Reach the treasury directly. Modify a price list |
| **Guardian** | `pause`, `resume`, `revoke` the agent; `revoke` the mandate; pause and unpause the treasury | Move or redirect a single unit of value. Change any limit. Undo a revocation. Reach any market contract. Stop revenue arriving or entitlements settling |
| **Anybody** | Bind a market that satisfies its commitment; collect; claim market fees; recognise; allocate; settle any leg | Change where any of it goes |

The strongest thing any privileged key in this system can do to a user is stop an
agent from spending. No key added by the agent layer can reach a token, a pool, a
hook, a locker, a splitter or a vesting contract.

## How an off-chain runtime should drive an agent

The reasoning layer stays off chain, and it never holds a key that can do
anything the mandate does not already permit.

```
1. The runtime (a model, or a for loop) emits JSON describing what it wants:

   { "actionType": "PAY_SERVICE",
     "providerAgentId": "0x…",
     "serviceId": "0x…",
     "reason": "Approved market data required for the next report" }

2. The SDK rejects anything not matching the schema. The model's output is data
   throughout — never bytes, never a signature, never a destination.

3. The SDK reads the registry for the service's current payee, asset, price and
   version, and builds a `ServiceQuote` from what it found. Nothing the model
   said about money is carried into the quote.

4. `simulate(action, context)` returns every rule the quote breaks, in the
   order the chain checks them, so the first one is the error the transaction
   would actually carry.

5. A human, or a policy the human wrote, approves it.

6. The operator key sends the transaction.
```

Three rules for whoever builds that runtime:

**The model never sees a private key.** Not the developer's, not the guardian's,
not the operator's. It returns JSON to a process that holds the operator key, and
that process decides.

**The operator key is assumed hostile.** Design as if it is already stolen. What
an attacker holding it gets is: the ability to buy approved services from
approved providers at listed prices, no more often than the interval allows,
until the period limit is spent — and then nothing until the period rolls. Set
`maxActionValue`, `periodLimit` and `minActionInterval` so that this outcome is
one you can live with, because it is the outcome you are choosing.

**The guardian key is the one that matters, and it is only a stop button.** Keep
it somewhere the runtime cannot reach — a multisig, a hardware wallet, a person.
It cannot move funds, so it is not worth stealing; it can halt the agent, so
losing it means losing the ability to stop.

`reason` is carried off chain and shown in the feed. It is deliberately not
hashed into the action: a model-authored string that influenced nothing should
not be given the appearance of a commitment.

## The off-chain surface

Three layers sit above the contracts, and the division between them is the whole
design: the contracts decide, the SDK mirrors, the indexer remembers.

| Layer | Module | What it is allowed to be |
| --- | --- | --- |
| Deterministic mirror | `packages/sdk/src/agents/{identity,quote,lifecycle,allocation}.ts` | The same arithmetic as Solidity, in TypeScript, checked against shared vectors |
| Reads and builders | `packages/sdk/src/agents/{read,build,actions}.ts` | Questions asked of the chain, and unsigned transactions. It never sends one |
| Memory | `apps/indexer/src/agents.ts`, `ponder.schema.ts` | Whatever the logs said, and nothing else |
| Query | `apps/indexer/src/api/agents.ts` | A projection of the above. It is not a source of truth and holds no key |

### The four things the SDK computes rather than reads

Each of these exists because an interface needs the answer *before* a transaction, and
each is a place where a second implementation could quietly disagree with the first. So
none of them is trusted on its own: every one is generated as vectors and asserted
identical in Solidity and TypeScript.

| Mirror | Answers | Vector test |
| --- | --- | --- |
| `agentIdFor(developer, salt, chainId, registry)` | The id an agent will have, before it exists | `test/agents/AgentIdentity.vectors.t.sol` |
| `commitmentFor(developer, router, expectation)` | The commitment a launch must satisfy for `bindMarket` to accept it | same |
| `hashServiceQuote(quote)` | The action hash the execution module will derive, for replay and display | same |
| `allocate(amount, split)` | How income divides, to the wei | `test/agents/RevenueAllocationLib.vectors.t.sol` |
| `lifecycle.canTransition(from, to)` | Whether a lifecycle move is legal, without an RPC | `test/agents/AgentLifecycle.vectors.t.sol` |

The hashing vectors are produced by a generator that pads and concatenates ABI words by
hand, rather than by either implementation, so a shared misunderstanding of `abi.encode`
cannot make both sides agree on the wrong answer. A mutation table sits beside each one:
changing any single field must change the hash, which is what makes "the encoding is
right" a claim rather than a hope.

The lifecycle vectors exist for a subtler reason, and it is worth naming because it is
the failure mode a mirror actually has. Both sides already walked all twenty-five ordered
pairs exhaustively, and both were green — but each suite restated the matrix and checked
*its own* implementation against *its own* statement. A clause transposed in
`lifecycle.ts` and in that suite's list of permitted moves would have passed on both
sides and greyed out the wrong button. `vectors/lifecycle.json` is a third statement,
derived from the four rules as prose, and both suites read it.

### What the SDK deliberately cannot build

There is no `buildRotateOperator`, no `buildAmendMandate`, no `buildWithdraw` and no
`buildSetSpendLimit`. Not because they were forgotten, but because **the contracts have
no such functions** — the mandate has no setter, the operator is immutable, and `spend`
is the treasury's only exit. An SDK that offered them would be describing a protocol
that does not exist, and the first honest thing a builder learns from the surface should
be what the agent cannot be talked into.

`build.ts` validates its inputs against the same conditions the constructor enforces, in
the same order, so a mandate the chain would reject fails locally with the reason rather
than as a revert. That is a convenience and not a control: the chain checks all of it
again, and nothing in the interface can waive one.

### What the indexer stores, and what it refuses to store

Six tables, and the shape of them follows one rule: **an agent's numbers are the
contracts' numbers.** Running totals are accumulated from events and then reconciled
against the contracts on every proof run, so the database is a cache with a test that
fails when it drifts, not a second ledger.

It stores no market state. An agent's market is a `poolId` on the agent row, joined to
the market tables the feed already maintains — so an agent page renders the same market
data a market page does, and a market cannot be described two ways.

Activity is stored structured and never as a sentence: `{ type, agentId, actor, asset,
amount, … }`. The 18 types are enumerated in `apps/indexer/src/agent-events.ts`, which
maps every event in the seven agent ABIs to a type or records why it produces none. That
file is a manifest rather than a convenience: `agent-events.test.ts` reads the ABIs and
fails when one grows an event nobody decided about, which is the failure mode a feed has
when a contract is upgraded and the indexer is not.

The wording belongs to the interface. An indexer that stored "Claimed 0.14 ETH" would
have made a formatting decision, a rounding decision and a language decision in the
place they are hardest to change.

## Recovering from a compromise

| What happened | What to do | What it costs |
| --- | --- | --- |
| Operator key stolen | `guardian.pause(agentId)`, or `treasury.pause()` | The agent stops acting. Revenue keeps arriving, entitlements keep settling |
| Operator key stolen and you want it over | `guardian.revoke(agentId)` | Terminal. Nothing executes again, ever. The treasury keeps its balance and the developer and protocol legs stay claimable |
| Runtime returning nonsense | Pause, fix, resume | Nothing permanent |
| A provider turned hostile | The developer cannot remove a target — the mandate is immutable. Pause, or revoke | This is the cost of an immutable mandate, and it is disclosed before anybody buys |
| Guardian key stolen | Nothing. The worst it can do is halt the agent | Denial of service |
| Developer key stolen | Metadata can be repointed and services repriced. Funds cannot be moved. The guardian can revoke | Reputational, not custodial |

**There is no operator rotation, and no mandate amendment.** Both were considered
and deferred: a mandate that can be widened after people have bought the token is
a promise rather than a term, and rotating the operator needs a governance
process this product does not have yet. The recovery for a compromised operator
is to stop the agent and launch another. That is a real limitation, stated here
rather than discovered later.

## Known limitations of V0

- **One market per agent.** `bindMarket` is once and terminal. An agent that
  wants a second market is a second agent.
- **No operator rotation.** Above.
- **No mandate amendment.** Above.
- **Buybacks are unimplemented.** The leg exists in the split schema and must be
  configured at zero. `AgentRevenueRouter`'s constructor enforces that.
- **The only action is buying a service.** No trading, no portfolio management,
  no agent-to-agent anything beyond a priced service call.
- **Fee-on-transfer and rebasing tokens are unsupported.** Both the treasury and
  the router derive what has arrived from balances, and report zero rather than
  reverting when the arithmetic would underflow.
- **The mandate's target list is capped** at 32, and the asset list at 8. Both are
  linear scans at construction.
- **A permissive mandate chosen openly is not prevented.** Every limit is public
  before anybody pays. A bad configuration is disclosed, not blocked.

## Where the tests are

| File | What it establishes |
| --- | --- |
| `test/agents/AgentMarket.t.sol` | The whole flow against a real `VerdantFactory`, real `PoolManager` and real `PositionManager`: attribution, creator semantics, the revenue path end to end, no self-liquidity, two agents not sharing anything, and markets without agents unaffected |
| `test/agents/AgentReentrancy.t.sol` | That "effects before interactions" holds in both contracts that pay out, executed rather than asserted |
| `test/agents/AgentExecutionModule.t.sol` | Every refusal in the table above |
| `test/agents/AgentTreasury.t.sol` | The limits, the periods, and that `spend` is the only exit |
| `test/agents/AgentIdentityRegistry.t.sol` | That a binding is a proof, and the lifecycle matrix |
| `test/agents/AgentInvariants.t.sol` | What must hold in every state, under fuzzed sequences |
| `test/agents/RevenueAllocationLib.vectors.t.sol` | That the Solidity and the TypeScript divide money identically, against shared vectors |
| `test/agents/AgentIdentity.vectors.t.sol` | That the two implementations of an agent's id, its market commitment and a service quote's hash produce the same bytes, against vectors written word by word in neither of them |
| `test/agents/AgentLifecycle.vectors.t.sol` | That the two implementations of the lifecycle answer all twenty-five pairs and all five predicates identically, against a third statement of the rules |
| `apps/indexer/scripts/assert-agents.ts` | That the indexed agent layer agrees with the contracts, on a real chain, after every agent event has been emitted. See [feed.md](feed.md) |

### A suite that stopped running

`AgentIdentity.vectors.t.sol` silently disappeared from a green run. `forge fmt` rewrote
the file, and on the next `forge test` its seven differential assertions — the ones
holding the SDK's agent id, market commitment and quote hash to the Solidity — were no
longer discovered. The artefact was still in `out/`, the file was still on disk,
`--match-contract` on its name reported "no tests found in project", and the run said 39
suites and 620 passing. `forge clean` restored it at 40 and 627.

That is the worst failure a test can have: an assertion that stops running looks exactly
like one that passes, and the only evidence is a total nobody reads closely.
`scripts/check-test-discovery.sh` now runs before `forge test`, locally and in CI. It
compares the test contracts in the tree against what `forge test --list` would run and
fails on any difference, so a suite can be deleted on purpose but not lost by accident.
| `test/fork/Agent.fork.t.sol` | The same as `AgentMarket.t.sol`, against the bytecode deployed on chain 4663. Needs an RPC; excluded from the default profile |
