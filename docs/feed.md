# The market feed

How a Verdant market becomes something a browser can show, and — the question this
document exists to answer — whether the contracts emit enough to make that possible.
That question has a deadline: the factory's address is anchored and the hook's is
mined, so once they are deployed their event surface is fixed forever. Anything the
feed needs and cannot get has to be discovered now.

**The answer is that no contract change is needed.** The four things the feed cannot
learn from an event are all readable from a contract, at a block that is already
settled by the time it is indexed, and each is read once per market. The details are
in [What is read rather than emitted](#what-is-read-rather-than-emitted).

## The parts

| Part | Where | What it does |
| --- | --- | --- |
| Schedule twin | `packages/sdk/src/models` | `ScheduleLib.sol` in TypeScript: the fee at an instant, the stage, the next transition. Held to the Solidity by shared vectors. |
| Pool id twin | `packages/sdk/src/markets/pool.ts` | `PoolIdLibrary.toId` in TypeScript, so a client that knows a market's pair can address it without a lookup. Also vector-tested. |
| Read layer | `packages/sdk/src/markets/read.ts` | Direct chain reads, batched through Multicall3. What a wallet uses, and the fallback when the indexer is behind. |
| Indexer | `apps/indexer` | Ponder. Watches Verdant's events and three of Uniswap's, and serves the listings. |
| Proof | `scripts/indexer-proof.sh` | Runs all of the above against a chain it creates, and checks the answers against the contracts. |
| Write proof | `apps/web/scripts/assert-sdk-launch.ts` | Runs inside that rig: launches two markets through the SDK, the way the interface does, and checks what landed. See [The write path](#the-write-path). |

## Two rules, and what they rule out

**Store what was observed; derive the rest at read time.** The active fee, the current
stage and the countdown are functions of an immutable schedule and the clock. They are
never stored. A market row is updated only because something happened, never because
time passed — which is the only tenable choice, since nothing on chain fires when a
fee stage changes. Storing a fee would mean a column that is wrong between writes and
a background job whose failure mode is a stale number that looks fresh.

The derivation happens once, in the indexer's API, using the SDK's twin. Serving the
raw ladder over GraphQL and letting each client derive its own fee would publish the
derivation as an interface, and every consumer that got it slightly wrong would be a
market whose displayed fee disagreed with what it charged.

**Never store a number the chain did not give us.** The tempting one is a per-swap fee
*amount*: the event reports the rate charged, and multiplying by the input looks like
the fee. It is not, quite — v4 applies the rate per tick-crossing step with its own
rounding — and a figure that is nearly right is worse than none, because it will be
summed and shown as revenue. So the rate is stored, since it was reported, and what
was actually earned is read from `FeesCollected` and `Claimed`, which are events about
money moving.

## What is read rather than emitted

Five things, each read once per market at its creation block.

**The fee splits.** In `MarketRegistry`'s record but in no log. They are what a
market's fee disclosure is made of, so the indexer reads `marketOf(poolId)`.

**The token's name, symbol, supply and metadata.** On the token, which is a normal
ERC-20 about this.

**The quote asset's name, symbol and decimals.** On a different token, and read the
same way. `MarketCreated` says *which* asset a market is quoted in but nothing about
what it is called or how finely it divides, and both are needed to render a single
amount — an equity's volume shown against ether's eighteen decimals would be wrong
by whatever the difference is, silently. Ether is the one case with no contract to
ask: v4 addresses it as the zero address, so `ETH`, `Ether` and 18 are stated by the
indexer rather than read.

**The fee ladder's init time.** This one is worth stating precisely, because the
obvious approach is wrong. `MarketConfigured` carries the two packed schedule words,
but they are packed *before the pool exists* — the init time field in them is zero,
written later by `afterInitialize`. A reader assembling the schedule from
`MarketConfigured` alone would compute every stage boundary from an epoch of 1970 and
conclude that every market is permanently on its last stage. The indexer reads
`configOf(poolId)`, which returns the hook's own state after initialisation.

**The pool's opening price.** Only in the PoolManager's `Initialize`, and
unrecoverable afterwards: the first buy happens in the same transaction, so by the
time `MarketCreated` is emitted the pool has already moved off its opening tick. The
indexer stores it from that event, which is why it watches the PoolManager at all.

Reading is not a weaker source than an event. It is the contract's own account of its
state at a settled block, and it costs a handful of calls on an event that happens
once per market. What would be weaker is reassembling a value from two events and a
rule about their order.

### What is deliberately not emitted

Nothing fires when a fee stage changes, and nothing should. No transaction occurs at a
transition: time passes, and the next `beforeSwap` computes a different number. An
event would require somebody to poke the contract on a schedule, and a market whose
poke was late would charge one fee while announcing another.

## Recognising a Verdant pool

Every pool on 4663 announces its hook in `Initialize`, and a pool that names Verdant's
hook is a Verdant market by construction — the hook permits nobody but the factory to
initialise it.

Swaps are harder. The set of Verdant pool ids grows as markets are created and a log
filter cannot be extended after the fact, so the indexer watches every `Swap` the
PoolManager emits and drops the ones whose pool it has never heard of. On a chain this
size that is cheap. If it stops being cheap, the answer is a filtered configuration
per pool id — not a guess about which pools matter.

## The proof

```bash
pnpm proof             # about 35 seconds, no network
```

`pnpm proof:feed` is the same script under its older name, kept because it is what CI
and muscle memory call.

It starts an anvil, deploys a Uniswap v4 and a Verdant onto it, puts Uniswap's quoter
and Permit2 at the addresses the interface is configured with, launches **six** markets
covering the shapes that index differently, trades them, warps past a fee transition
and trades again, collects and claims the fees, indexes the whole history, and then
asks the contracts the same questions the indexer just answered.

Four of the six come from `Seed.s.sol`, in Solidity. The other two are launched through
`@verdant/sdk`, by the interface's own code, and are the subject of [the write
path](#the-write-path) below. Everything in this section is asked of all six without
distinction, which is the point: a market the SDK built wrong fails here exactly as
loudly as a market the factory built wrong.

Two of the six are quoted in a tokenized equity the seed deploys for the purpose,
because Robinhood Chain's own equities live on 4663 and a local node has none. Those
are the whole reason the rig grew one: every assertion below passes just as happily on
a feed that has quietly assumed `currency0` is ether, so long as every market it is
asked about is.

Three claims are checked per market, and each would be a shipped bug on its own:

1. **The key is right.** The pool id the indexer files a market under equals the one
   the SDK derives locally from the market's quote asset and its token. Were these to
   disagree, every market page would read an empty pool and the site would look like a
   chain with nothing on it.
2. **The derived fee is the contract's fee.** The API derives it from the stored
   ladder; the hook computes it in Solidity. Asked about the same instant — and about a
   week later, which is what a countdown is really asking — they must agree.
3. **History is consistent with itself.** A market's swap count and volume are running
   totals maintained per event; the swap rows are the events. If the totals do not equal
   the sum of the rows, the aggregation is wrong, and that is invisible from either
   number alone.

It also requires that the fee *changed*: the laddered market is traded on both sides of
a transition, so its two swaps must record two different rates. That is the end-to-end
form of V12 in [verification.md](verification.md) — the pool's stored fee never moves,
so a trade charged at the new rate proves the hook's override reached the swap and that
the indexer recorded what was really paid.

The stock-paired market is then checked by name rather than in the loop, because "it is
present and right" is a claim about a particular market and a loop over whatever the
indexer returned cannot make it: had that market failed to index at all, every check
above would still pass. The rig hands the assertions the equity's address and the
token's, and requires that the market appears under that token, is quoted in that
equity, and repeats the symbol, name and decimals the equity reports about itself; that
its pool id is what `poolIdFor(quoteAsset, token, hook)` derives and **not** what the
same derivation yields if the quote asset is assumed to be ether; that its swaps sum to
its `volumeQuote`; and that its fees were collected and then claimed for a non-zero
amount of the equity. The last one matters because a splitter holding an ERC-20 pays
out with `transfer` rather than by sending value, which is a path the ether-quoted
markets never take.

The rig also hands over the number of markets it created and the addresses of the ones
it quoted in the equity, rather than either being written into the assertions. The
second is stronger than the count it replaced: a feed that mislabelled *which* market
was equity-quoted while getting the total right would pass a count and fails a set.

### Why local rather than a fork of 4663

A fork would exercise the real Uniswap bytecode, and [the fork
suite](../packages/contracts/test/fork) already does exactly that. This proves
something different: that the indexer, the SDK and Verdant's contracts agree. That does
not depend on which build of v4 is underneath, and making it depend on a remote RPC
would make a green run depend on somebody else's uptime — the reason the fork gate had
to be made warn-only. A gate that can be skipped is not a gate, so this one was built
to need nothing: no RPC, no Postgres, no keys.

The cost of running locally is that this repository compiles `PoolManager` and
`PositionManager` over EIP-170, because `foundry.toml` optimises for runtime gas rather
than size. Hence `anvil --disable-code-size-limit`, and three rig-only contracts under
`packages/contracts/script`: `LocalUniswap.s.sol`, which deploys a v4;
`Multicall3Lite.sol`, which implements the one function viem calls when batching reads,
because anvil predeploys no Multicall3; and `MockEquity.sol`, a fixed-supply ERC-20 that
stands in for a tokenized equity, because the real ones exist only on 4663.

The size limit is disabled for those deployments only, and deliberately not for
Verdant's own: every contract Verdant deploys is under EIP-170, and if one ever crossed
the line this rig should fail rather than shrug.

### What the proof already caught

The indexer's PoolManager address was pinned to the deployed one. Against a rig with
its own Uniswap, that meant every market's creation was indexed and none of their
pools — markets with no price, no volume and no trades, which is indistinguishable from
a quiet launch. The market handler now refuses to store a market whose pool it never
saw initialise, and the address is overridable. Neither would have been written without
a run that failed.

### What the proof did not catch, and now does

Every trade was recorded on the wrong side. The indexer labelled buys as sells and
sells as buys, for every market, from the first commit — and 71 checks passed anyway.
The interface found it: the market page rendered a column of trades that all said
"sell" for a rig whose seed script does nothing but buy.

The cause is worth recording, because reading the source more carefully would not have
prevented it. v4's `Swap` event documents `amount0` as "the delta of the currency0
balance of the pool", and the code emits `delta.amount0()` — the value it then accounts
against `msg.sender`. It is the *swapper's* delta, not the pool's, so a buy carries a
negative `amount0`. The docstring says the opposite of what the code does, and the
indexer believed the docstring.

Why no check caught it: the volume assertions sum unsigned magnitudes, so an inverted
side is invisible in every total. The claim was never tested because it never occurred
to anyone to test it — it was arithmetic that looked like a definition.

Three assertions closed it. Every trade in the rig must be recorded as a buy, because
buying is all the seed does; the signed deltas must agree with that side; and, since
the ladder now ends after the rig's window rather than before it, a laddered market must
have a transition still ahead with a countdown consistent with the timestamp it counts
to. The last one exists because `nextTransitionAt` was null on every market in the rig,
so the countdown an interface renders from it was proved by nothing at all.

The rig's own readiness check was wrong in two ways as well, both found by the same run.
It waited for the *first* market to appear rather than for all of them, so the
assertions could run against a partial listing and blame the indexer for a disagreement
that was a second old. And the count it compared against was produced by `grep -c`,
which counts matching lines — the listing is one line, so it answered 1 forever. It now
waits until the indexer has as many markets as the registry says exist.

## The write path

Everything above is about reading. This is about the other direction, and until
recently there was nothing here at all: `packages/sdk` could build a launch and
`apps/web` could send one, but **no create transaction built by the SDK had ever been
broadcast anywhere**. The encoder was checked by decoding its own output back in a unit
test, which catches a transposed field and cannot catch a wrong ABI, a wrong salt
namespace, or a predicted address the token never lands on. A launch is irreversible
and its wiring is immutable, so the first SDK-built `create` should not have been on
mainnet. It is the fifth and sixth markets of the rig instead.

`apps/web/scripts/assert-sdk-launch.ts` runs inside `pnpm proof`, between the seed's
create and trade phases. It uses the interface's own code rather than a copy of it: a
`LaunchDraft` as `apps/web/src/lib/launch.ts` holds one, through that file's `derive`,
`tokenIdentity` and `launchParams`, then `launch.readTokenInitCodeHash`,
`launch.mineTokenSalt` and `launch.buildCreate` in the order
`launch-submit.tsx` calls them. A reimplementation would have proved that the proof
agrees with the SDK, which is not a claim anybody needs.

Two markets, because they fail differently. An ether-quoted launch clears the salt
constraint on its first candidate — the zero address sorts below everything — so a
broken search still looks fine. For the equity-quoted one the search *is* the launch:
the factory reverts `TokenNotAboveQuote` unless the token sorts strictly above the
quote asset, and the rig asserts that ordering rather than inferring it from the
absence of a revert.

What it then checks, by reading the chain rather than trusting the receipt: that the
token landed at the address `predictTokenAddress` named before the transaction was
sent; that the registry holds the market under the pool id the SDK derives, with the
quote asset, creator, model, name, symbol and supply the draft asked for; that the hook
has an init time for that pool id, which is the PoolManager's own statement that it
initialised exactly this key; that the locked position is held by the market's locker;
that the fee the hook charges is the fee the draft submitted, and that v4's own `Swap`
event reports that same rate on an executed trade; and that a quote taken through
`trade.quoteExactIn` equals what the swap paid out, to the wei.

### Uniswap's periphery, at the addresses the interface looks for

`EXTERNAL_ADDRESSES` in `@verdant/config` holds Robinhood mainnet's addresses for the
contracts Verdant does not deploy, and both the interface and the SDK resolve two of
them **by chain id with no override**: the trade panel reads `EXTERNAL.quoter`, and
Permit2 is a module constant in `packages/sdk/src/trade/approve.ts`. The rig runs at
chain id 4663. So unless those exact addresses answer, the app's own code path cannot
be exercised at all — every quote reverts, every allowance reads zero — and the rig
would be proving a path the interface does not take.

So the rig puts working code at both, with `cast rpc anvil_setCode`, before Verdant is
deployed and before either has any storage:

- **V4Quoter** is compiled from `vendor/v4-periphery/src/lens/V4Quoter.sol`, deployed
  against the rig's own PoolManager, and its runtime code copied to the canonical
  address. Copying runtime code is sound because Solidity immutables live in it: the
  copy is still bound to the PoolManager its constructor captured. The rig checks that
  rather than assuming it, by reading `poolManager()` back from the canonical address
  and requiring the rig's own.
- **Permit2** is not recompiled. It pins `pragma solidity 0.8.17` and needs viaIR, and
  this machine has neither that compiler nor a network to fetch it — but the permit2
  repository vendors its own deployed runtime code for exactly this situation, in
  `test/utils/DeployPermit2.sol`. That is 9 152 bytes, which is what V1 in
  [verification.md](verification.md) measured on 4663, so the rig runs the same Permit2
  the chain does. Its EIP-712 domain separator is recomputed at call time whenever the
  chain id differs from the one baked in at deployment, which here it does — so the
  separator is the correct one for that address on 4663, and the rig computes the
  expected value and requires it.

Neither is checked by `code.length > 0`, which a wrong copy would also satisfy. The
quoter answers a real `quoteExactInputSingle` on a real pool and is held to an executed
swap; Permit2 answers a real `allowance`, and then a real pair of approvals built by
`buildErc20Approval` and `buildPermit2Approval` is sent and read back through
`readPermit2Allowance` — the read the trade panel gates the swap on.

### What is not proved, and the one command that would prove it

**The Universal Router leg of `trade.buildSwap` has never been executed.** The swaps in
the rig go through `PoolSwapTest`, the same test router `Seed.s.sol` uses. The router
cannot be put on a local node: `universal-router` is not among the pinned Solidity
dependencies, so there is no source to compile, and with no network there is no way to
fetch either the repository or the bytecode deployed on 4663. Stubbing it would be
worse than the gap — a swap that "succeeded" against a contract this repository wrote
would prove that Verdant agrees with Verdant.

What *is* proved offline is the encoding. `packages/contracts/test/SwapCalldata.vectors.t.sol`
rebuilds every case in `packages/sdk/src/models/vectors/swap.json` from Uniswap's own
vendored `Actions` constants, `IV4Router.ExactInputSingleParams` and the `execute`
signature, and requires the SDK's bytes to the byte. The corpus contains a sell, so an
encoder with `SETTLE_ALL` and `TAKE_ALL` transposed fails; an equity-quoted buy, so one
that hardcoded ether fails; and an explicit deadline, so one that ignored the argument
fails. It cannot check the `V4_SWAP` command byte, which is the one constant with no
vendored source behind it.

So one thing remains, and it needs somebody with network access:

```bash
bash scripts/fork-test.sh      # or: pnpm proof:fork
```

That runs `packages/contracts/test/fork/Launch.fork.t.sol` against a fork of 4663. The
test that closes this is `test_aThirdPartyRouterChargesTheScheduledFee`: it launches a
market, warps past a stage transition, quotes the swap through the deployed `V4Quoter`,
sends the swap through the **deployed Universal Router** at
`0x8876789976dEcBfCbBbe364623C63652db8C0904`, and requires that the tokens received
equal the quote exactly, that the router's code length is the 24 546 bytes V1 recorded,
and that neither tokens nor ether are left stranded in the router. A green run there
plus the vector parity above means the bytes the interface sends are bytes the deployed
router accepts and charges correctly. **It has never been run on this machine** —
`fork-test.sh` warns and exits zero when the RPC is unreachable, which is what happens
here, so a passing local gate says nothing about it either way. V5 in
[verification.md](verification.md) stays open until it does run.

Two smaller things are also outside the rig, and worth naming rather than leaving to be
discovered:

- **Permit2's signature path.** The SDK deliberately builds `approve` transactions and
  not EIP-712 permits, so nothing here signs one. The domain separator is checked, so
  the ingredient is right; the flow is absent because the code is.
- **The deployed Uniswap's bytecode.** The rig compiles v4 from vendored source with
  this repository's optimizer settings, which produces a larger PoolManager than the one
  on 4663. That is the fork suite's job, and it does it.

## The agent layer, end to end

The agent layer is indexed by the same rig, in the same run, and the reason is the same
one that put the SDK's first `create` in it: an agent is a set of contracts whose events
are the only public record of what it did, and a feed that mis-indexes them is a feed
that lies about an autonomous thing spending money.

`packages/contracts/script/AgentSeed.s.sol` creates three agents and then drives them
until **every state-changing event in the agent layer has been emitted at least once**.
Three, because they fail differently: a provider that sells a service and earns from a
market, a payer that buys one, and a third that is revoked without ever trading, which
is the only way to reach the terminal states. It runs in two phases either side of the
rig's existing time warp, so the payer buys twice in two different spend periods — a
handler that assigned a running total rather than accumulating it passes the first phase
and fails the second.

`apps/indexer/scripts/assert-agents.ts` then asks the contracts what the indexer just
answered, in the shape of the six claims that would each be a shipped bug:

1. **Identity.** Every agent the registry counts is served, under the id the registry
   files it under, with the developer, operator, guardian, treasury, mandate, router,
   execution module, metadata URI and lifecycle state the registry reports — and the
   API's `stateName` is derived from the SDK's lifecycle mirror rather than from a
   second table of strings.
2. **Money.** Every asset's recognised, allocated and settled totals equal the router's,
   per leg; the treasury's spend, receipt and period figures equal the treasury's, asked
   about the same instant. This is the check that makes the revenue numbers on an agent
   page a statement about the chain rather than about the database.
3. **The activity feed.** Every one of the 18 activity types appears, nothing appears
   that no event produces, the ordering is the chain's, and paging one row at a time
   reassembles the same feed. Every row is also keyed by the log it came from —
   `txHash-logIndex` — which is what makes reindexing idempotent: replaying a log
   rewrites its row rather than adding a second one, so the feed cannot grow duplicates
   from a restart or a reorg. The manifest
   in `apps/indexer/src/agent-events.ts` is what makes "every type" checkable: it maps
   each event in the seven ABIs to an activity type or records why it produces none, and
   `agent-events.test.ts` fails if an ABI grows an event the manifest has not been told
   about.
4. **The rows and the counters agree.** The spend rows for an asset sum to that asset's
   spend counter, and there are as many as the counter counted. Both are maintained by
   one handler from one event, and the two checks above would each pass if that handler
   wrote one and forgot the other — leaving a payment visible in the feed that no total
   accounts for.
5. **Attribution both ways.** An agent's market is served under that agent, and a market
   no agent launched is attributed to no agent. The second is handed the human market's
   pool id by the rig rather than inferred, because "no agent claims this" is a claim
   about a particular market that a loop cannot make.
6. **Refusals.** An unknown agent is a 404 on all four of its routes, a lifecycle state
   that does not exist is a 400, and a developer with no agents gets an empty list rather
   than everybody's.

### What indexing against a real chain caught

Four bugs, none of which a unit test was ever going to find, and all of which would have
reached an interface:

- **Every new agent's metadata was empty.** The launch handler read `agentOf` from the
  event's own emitter — the launch factory — rather than from the identity registry. It
  returned nothing, so the field was blank. It was invisible for two of the three agents
  because a later `MetadataUpdated` filled it in, which is exactly the kind of bug that
  ships: it only shows on the agents nobody touched after creating them.
- **Agent markets' fees were unclaimable in the seed.** The market seed claimed every
  market's fees by calling `FeeSplitter.claim` as the creator, and an agent's creator is
  its router, so the call reverted. The fix is in `Seed.s.sol` — it claims only what it
  created — and the agent seed claims the rest through `AgentRevenueRouter.claimMarketFees`,
  which is the path a real agent's income actually takes and had never been executed
  outside a unit test.
- **The SDK asked the treasury the wrong question.** `readTreasury` called
  `spentInPeriod`, `receivedInPeriod` and `remainingInPeriod` without the timestamp they
  take, which is an encoding error on the first real call and a typecheck that passes.
- **The SDK's agent listing could never have worked.** `readAgentPage` fed `agentAt`'s
  return value into `agentOf`, believing it was an id; it is the whole `Agent` struct,
  which does not carry its own id. `packages/sdk/src/agents/read.test.ts` now encodes
  every call in every read helper against the ABI, so a wrong argument count or a wrong
  type fails offline instead of on a chain.

The last two are the same shape and worth naming: viem cannot infer the element type of
a mapped `contracts` array in a `multicall`, so the code casts, and a cast is a place
where a wrong call compiles. Every multicall in the SDK's agent reads is therefore
covered by a test that actually encodes it.

## Running the indexer

```bash
cd apps/indexer
pnpm ponder dev --schema dev
```

It reads its addresses from `packages/config/src/deployments.ts`, so until a deployment
is recorded there it needs them in the environment:

| Variable | Meaning |
| --- | --- |
| `VERDANT_FACTORY` | The factory. Its creation block bounds everything the indexer cares about. |
| `VERDANT_HOOK` | The hook, which is also how a Verdant pool is recognised. |
| `VERDANT_POOL_MANAGER` | Uniswap's PoolManager. Defaults to the one on 4663. |
| `VERDANT_START_BLOCK` | Where to start reading. Defaults to the recorded deployment block. |
| `PONDER_RPC_URL_4663` | The RPC. Defaults to Robinhood's public endpoint. |
| `DATABASE_URL` | Postgres. Omit it and Ponder uses an embedded PGlite, which is what the proof does. |
| `VERDANT_AGENT_FACTORY` | `AgentLaunchFactory`. The three agent addresses go together: set one and the other two are required. |
| `VERDANT_AGENT_IDENTITY_REGISTRY` | `AgentIdentityRegistry`. |
| `VERDANT_AGENT_SERVICE_REGISTRY` | `AgentServiceRegistry`. |
| `VERDANT_AGENT_START_BLOCK` | Where to start reading the agent layer. Defaults to `VERDANT_START_BLOCK`. |

A missing address is a refusal rather than a default, because an indexer pointed at
`undefined` starts cleanly, reports healthy, serves an empty API, and looks exactly
like a chain on which nothing has launched.

The agent layer is the one exception, and for the opposite reason: it may genuinely not
be deployed on a chain that has markets. When no agent addresses are configured the
indexer registers the agent contracts at an address nothing will ever match, indexes no
agent events, and serves the agent routes as empty — while the market feed works
exactly as before. What it does not do is tolerate *half* an agent layer: two of the
three addresses is a configuration mistake, and it refuses to start rather than index a
registry whose launches it will never see.

## The endpoints

Ponder's GraphQL and SQL-over-HTTP remain available. These exist because they are where
the derivation happens.

| Route | Returns |
| --- | --- |
| `GET /markets` | Newest first, each with its fee, stage and countdown derived at chain time. |
| `GET /markets/:id` | One market, addressed by pool id **or** token address. |
| `GET /markets/:id/swaps` | Trades, newest first, each with the rate it was charged. |
| `GET /markets/:id/fees` | Collections and claims, kept apart: money arriving at the splitter is not money paid out. |
| `GET /agents` | Newest first. Filterable by `developer`, `operator`, `state`, `active`, `launched`. |
| `GET /agents/:id` | One agent: identity, lifecycle, mandate, treasury per asset, revenue per asset, its market, its services, and its most recent activity. |
| `GET /agents/:id/activity` | Structured activity, newest first, filterable by `type`. |
| `GET /agents/:id/markets` | The market it launched, in the same shape `GET /markets` uses. |
| `GET /agents/:id/revenue` | Revenue per asset, split into recognised, allocated and settled. |

`GET /markets/:id` grew one field: `launchedByAgent`, which is `null` for a market a
person launched, and for one an agent launched carries the agent's id, its developer, its
metadata URI and its lifecycle state. It is a join rather than a copy — the market row
stores nothing about agents, so an agent being paused does not require a market to be
rewritten, and a market cannot end up claiming an attribution the registry disagrees
with.

Every response carries the chain block it was computed at, so a client can advance its
own countdown from that anchor. The clock is the chain's, not the server's — on an
Orbit chain the sequencer's clock is not the reader's (V6 in
[verification.md](verification.md)), and fees are a function of `block.timestamp`.

Amounts are decimal strings. JSON has no integer wide enough for wei, and a `number`
would silently round a supply of 10^15 tokens.

### What a market is quoted in

Every market carries a `quote` object: `{ asset, symbol, name, decimals, isNative }`.
`asset` is the pool's `currency0` — the zero address for ether, the equity's address
otherwise — and the three names beside it are what that asset says about itself.
`isNative` is derived from the address on the way out rather than stored, because a
stored copy is a second thing that can disagree with it.

The amounts named for ether are named for the quote asset instead:
`activity.volumeQuote` on a market, `quoteAmount` on a swap, and `quoteAmount` on a
claim. Only the names changed; each still means the `currency0` side of the thing it
belongs to, in that asset's own smallest unit.

There is deliberately no conversion and no ether-denominated equivalent for a
stock-paired market. Its volume is an amount of that equity, and restating it in ether
would mean inventing a price the chain never quoted — the market has no ether side to
read one from. Turning one into the other needs a second market and a decision about
which, and that is a judgement, not an observation.

## What reads it

`apps/web`, through one module: `src/lib/feed.ts`. Two things happen there and nowhere
else. The API's JSON shapes are declared once, so a change to a response breaks in one
file rather than in eight components. And every amount becomes `bigint` on the way in,
so no page can do arithmetic on a decimal string or route money through a float.

Formatting is the other half, in `@verdant/ui`. Its rule is that no conversion passes
through `number`: a supply of 10^27 wei exceeds `Number.MAX_SAFE_INTEGER` by nine orders
of magnitude, so `Number(supply)` returns a value that is close to the truth and not
equal to it — and a supply displayed as 1,000,000,000.0000001 is the kind of error
nobody reports and everybody notices. Division is done on integers and the decimal point
is inserted into the digit string afterwards. Prices carry 36 decimals internally,
because a market opening at tick 200 000 is about 2 × 10^-9 of its quote asset per
token and has no significant digits at all in 18-decimal fixed point.

Three decisions in the interface follow from what the feed does and does not promise:

**The countdown advances from the chain's clock, not the reader's.** A fee stage begins
when the timestamp passes an offset and no transaction marks it, so the countdown is the
one thing on a market page that changes without anything happening on chain. It uses the
local clock only to measure elapsed time since the component mounted, and adds that to
the chain timestamp the response carried. A reader whose laptop is four minutes fast
still sees a correct countdown. Past the transition it says the fee has changed rather
than counting up, because the number beside it is now stale.

**The listing is rendered per request, not cached as HTML.** With incremental
regeneration it was prerendered at build time, and a build has no indexer — CI does not
run one. So the build succeeded and baked "the feed is not answering" into static HTML,
which is then what the first visitors after every deploy would see.

**An unreachable feed and an empty chain are different sentences.** The feed client
throws two error types for that reason. "No markets have launched" is a claim about the
protocol; "our indexer is down" is a claim about us, and the markets are unaffected
either way because they live in contracts and can be traded through any interface.
