# Architecture

Fourteen contracts, no proxies, and one transaction that has to either do all of
it or none of it.

This document is the map. The reasoning behind individual choices lives in
[`docs/decisions/`](docs/decisions/), which is where to go when the question is
"why on earth is it done that way".

## The shape of a launch

```mermaid
flowchart TB
    creator["Creator"] -->|"create(), payable"| factory["VerdantFactory"]

    factory -->|"reads bounds"| models["ModelRegistry"]
    factory -->|"deploys"| deployer["VerdantDeployer"]
    deployer --> token["VerdantToken<br/>fixed supply"]
    deployer --> splitter["FeeSplitter<br/>shares fixed at creation"]
    deployer --> locker["PositionLocker<br/>no withdraw path"]

    factory -->|"initialize + add liquidity"| pool["Uniswap v4 pool"]
    factory -->|"writes the schedule"| hook["VerdantHook"]
    factory -->|"transfers the position"| locker
    factory -->|"appends the record"| markets["MarketRegistry"]
    factory -->|"first buy, same tx"| pool

    pool -->|"asks the fee on every swap"| hook
    pool -->|"fees accrue to"| locker
    locker -->|"collect(), permissionless"| splitter
    splitter -->|"pull"| creator
    splitter -->|"pull"| treasury["Treasury"]
```

Everything above happens inside one call. If any part reverts, all of it does,
so there is no reachable state where a token exists without its pool or a pool
exists without its liquidity locked.

## The contracts

**Deployed once, shared by every market.**

| Contract | What it is for |
| --- | --- |
| [`FactoryOrigin`](packages/contracts/src/FactoryOrigin.sol) | Creates the factory exactly once, at an address derived from itself. It is why the factory's address can be an anchor rather than a configuration value — [ADR-007](docs/decisions/007-the-factory-address-is-anchored.md). |
| [`VerdantFactory`](packages/contracts/src/VerdantFactory.sol) | The whole launch, atomically. The only contract a creator calls. |
| [`VerdantHook`](packages/contracts/src/VerdantHook.sol) | Answers Uniswap's question "what does this swap cost", per pool, from an immutable schedule. Implements `IHooks` directly rather than extending `BaseHook` — [ADR-004](docs/decisions/004-ihooks-not-basehook.md). |
| [`VerdantDeployer`](packages/contracts/src/VerdantDeployer.sol) | Holds the bytecode of the per-market contracts, so the factory can stay under the size limit while still deploying them itself. |
| [`ModelRegistry`](packages/contracts/src/ModelRegistry.sol) | The bounds a new market must satisfy, and which quote assets are admissible. Read at creation, never again. |
| [`MarketRegistry`](packages/contracts/src/MarketRegistry.sol) | Append-only. The canonical answer to "is this a Verdant market, and what was it created as". |

**Deployed per market, by the launch itself.**

| Contract | What it is for |
| --- | --- |
| [`VerdantToken`](packages/contracts/src/VerdantToken.sol) | Fixed supply, ERC-20 with permit, and nothing else. No mint, no owner, no tax, no blocklist, no pause. |
| [`FeeSplitter`](packages/contracts/src/FeeSplitter.sol) | Holds the creator/protocol split, fixed at creation, and pays each party only on their own pull. |
| [`PositionLocker`](packages/contracts/src/PositionLocker.sol) | Owns the launch position forever. Its only outbound path sends collected fees to the splitter. |
| [`TokenVesting`](packages/contracts/src/TokenVesting.sol) | Linear release after a cliff, for one beneficiary, where a creator allocation is vested. |

**Libraries.**

| Library | What it is for |
| --- | --- |
| [`ScheduleLib`](packages/contracts/src/libraries/ScheduleLib.sol) | A fee schedule of up to eight stages, packed into two storage words, with the validation and evaluation that go with it. |
| [`LaunchBounds`](packages/contracts/src/libraries/LaunchBounds.sol) | The creation-time bound constants. |
| [`VerdantConstants`](packages/contracts/src/libraries/VerdantConstants.sol) | Protocol-wide constants that are frozen by definition. |

**Deployed, and deliberately not wired up.**
[`FeeForwarder`](packages/contracts/src/FeeForwarder.sol) and
[`FeeForwarderFactory`](packages/contracts/src/FeeForwarderFactory.sol) would let
a creator's fees be pushed by anyone rather than claimed by the creator. The
factory exists on chain; the switch in config is off. See
[SECURITY.md](SECURITY.md#open-gaps).

## The agent layer

**Written, tested, and not deployed.** Agent Launch adds an owner, a treasury and
a spending policy on top of a market, without changing anything above. It is a
separate directory, `packages/contracts/src/agents/`, and no contract in it is
imported by any contract outside it.

The relationship runs one way: the agent layer reads the market layer and the
market layer has never heard of it. A launch is two transactions — create the
agent, then call the existing, unmodified `VerdantFactory.create` with
`feeRecipient` set to the agent's revenue router — and a third permissionless call
proves the two belong together by reading the market's own splitter.
[ADR-010](docs/decisions/010-the-agent-layer-sits-above-the-market.md) records why
wrapping `create` was rejected: it reads `msg.sender` six times and means
something different by it each time.

| Contract | What it is for |
| --- | --- |
| [`AgentLaunchFactory`](packages/contracts/src/agents/AgentLaunchFactory.sol) | Deploys one agent's contracts in one transaction. Does not touch the market layer. |
| [`AgentIdentityRegistry`](packages/contracts/src/agents/AgentIdentityRegistry.sol) | Append-only record of every agent, and the only agent contract that reads a market. `bindMarket` is permissionless because it verifies rather than trusts. |
| [`AgentMandate`](packages/contracts/src/agents/AgentMandate.sol) | What an agent may spend, of what, to whom, how often and until when. Written once, at construction, with no setter for anyone. |
| [`AgentTreasury`](packages/contracts/src/agents/AgentTreasury.sol) | Where the money sits. One way out, callable only by the execution module, with per-asset period accounting. |
| [`AgentRevenueRouter`](packages/contracts/src/agents/AgentRevenueRouter.sol) | Where revenue arrives and how it divides between four legs. Receiving, allocating and settling are separate calls that fail independently. |
| [`AgentExecutionModule`](packages/contracts/src/agents/AgentExecutionModule.sol) | The only path from a proposed action to money moving. Three typed entry points, no function taking `bytes`. |
| [`AgentServiceRegistry`](packages/contracts/src/agents/AgentServiceRegistry.sol) | What each agent sells. The only mutable part of an agent, and it cannot widen a permission. |
| [`AgentDeployer`](packages/contracts/src/agents/AgentDeployer.sol), [`AgentExecutionDeployer`](packages/contracts/src/agents/AgentExecutionDeployer.sol) | Hold the agent contracts' creation code, for the same size reason `VerdantDeployer` exists. |
| [`RevenueAllocationLib`](packages/contracts/src/agents/RevenueAllocationLib.sol) | How revenue divides. Cumulative rather than per-arrival, so the split does not depend on how the money came in. Twinned with `packages/sdk/src/agents/allocation.ts`. |
| [`AgentActionLib`](packages/contracts/src/agents/AgentActionLib.sol) | The typed actions an agent may propose. An agent never supplies calldata — [ADR-011](docs/decisions/011-agents-propose-typed-actions.md). |

The one asymmetry with the rest of the protocol is a guardian that can stop an
agent and do nothing else. It is described in [SECURITY.md](SECURITY.md) and
argued in [ADR-012](docs/decisions/012-the-agent-guardian.md) rather than left to
be discovered.

## Four properties the design is built around

**Bounds live in contracts, not in the interface.** Every limit is enforced on
chain and re-validated by the hook. `packages/config/src/bounds.ts` is the single
source those bounds are transcribed from, and the SDK re-reads the on-chain
values at runtime and warns on drift. A bound that exists only in the interface
is not a bound; it is a suggestion to anyone who can send a transaction.

**The preview is the transaction.** Anything shown before signing is computed by
the code path that will execute. Where a value is computed in both Solidity and
TypeScript, the two are held to shared vectors whose expected values come from a
third, naive implementation — so a misconception shared by the two
implementations under test cannot pass. Two implementations that can disagree is
the entire bug class those vectors exist to prevent.

**The hook never holds value.** Mined for `0x3880` and no delta-returning bit.
It cannot take custody during a swap because Uniswap will not call it in a way
that allows it. See [SECURITY.md](SECURITY.md#what-cannot-be-changed).

**Never `block.number`.** On this chain it returns the L1 block number, which
advances about 119× slower than the L2 clock. All timing is `block.timestamp`.

## Off chain

Three things read the chain and none of them can affect it.

| Part | Role |
| --- | --- |
| [`packages/sdk`](packages/sdk) | TypeScript twins of the on-chain math, generated ABIs, and the read and write helpers the interface uses. |
| [`apps/indexer`](apps/indexer) | A Ponder indexer and the API the interface reads for market lists, charts, holders and trades. |
| [`apps/web`](apps/web) | The interface. Explore, market pages, launch forms and in-app documentation. |

The indexer is a convenience, not a dependency of correctness. `pnpm proof`
stands up a chain, launches six markets, trades across a fee transition,
collects and claims, and then requires the indexer's answers to equal the
contracts' own — because a launchpad whose displayed numbers come from a
database is only as trustworthy as the assertion that the database agrees with
the chain. With no feed reachable the interface still builds and renders, and it
says the feed is unavailable, which is deliberately a different statement from
saying that no markets exist.

## Reproducing the deployment

```bash
pnpm contracts:deps      # pinned Solidity dependencies
pnpm contracts:build     # solc 0.8.26, optimizer 1_000_000 runs, cancun
pnpm verify:deployment   # published hashes against the chain's own codeHash
```

Dependencies are pinned to the commits matching the bytecode already deployed on
4663, established by a byte-for-byte source diff rather than by tracking
upstream `main`, which has since diverged.
