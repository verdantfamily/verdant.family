/**
 * What the indexer watches, and where it starts.
 *
 * The addresses come from `src/addresses.ts`, which explains why they are resolved
 * from a deployment record with an environment override and why a missing one is a
 * refusal rather than a default.
 *
 * ## Verdant's own events, and three of Uniswap's
 *
 * Verdant emits everything about a market's creation and its money — who made it,
 * what it is, where the fees went. It deliberately emits nothing when a fee stage
 * changes, because nothing happens on chain at a transition: time passes and
 * `beforeSwap` computes a different number. So the fee ladder is stored once and
 * every later question about it is answered by `@verdant/sdk`'s schedule twin.
 *
 * Price, volume and the fee actually charged come from the PoolManager. Its `Swap`
 * event carries the fee, which for a Verdant pool is the hook's per-swap override
 * rather than the pool's stored fee — the same distinction that makes `slot0.lpFee`
 * useless here (V12 in docs/verification.md).
 */

import { abi } from "@verdant/sdk";
import { createConfig, factory } from "ponder";
import { getAbiItem } from "viem";

import {
  AGEN,
  AGENTS,
  CHAIN_ID,
  FACTORY,
  HOOK,
  POOL_MANAGER,
  RPC_URL,
  START_BLOCK,
} from "./src/addresses";

/**
 * A market's own contracts are created by the factory, so their addresses are only
 * knowable from its events. `MarketCreated` carries all four.
 */
const marketCreated = getAbiItem({
  abi: abi.verdantFactoryAbi,
  name: "MarketCreated",
});

/** The child-contract pattern, written once because it is used four times. */
function createdByFactory(parameter: "token" | "splitter" | "locker" | "vesting") {
  return factory({ address: FACTORY, event: marketCreated, parameter });
}

/**
 * `AgentLaunched`, which carries all four of an agent's contracts.
 *
 * The event is on the launch factory rather than the identity registry, because the
 * registry never sees the addresses as a set — the factory deploys them and then
 * registers them. `AgentRegistered` names only the treasury.
 */
const agentLaunched = getAbiItem({
  abi: abi.agentLaunchFactoryAbi,
  name: "AgentLaunched",
});

function createdByAgentLaunch(
  parameter: "mandate" | "treasury" | "router" | "executionModule",
) {
  return factory({ address: AGENTS.launchFactory, event: agentLaunched, parameter });
}

/**
 * The Agen agent layer.
 *
 * Registered whether or not it is deployed, with the zero address standing in when it
 * is not. `src/addresses.ts` explains why: `ponder codegen` derives the valid event
 * names from this configuration, so a conditionally-registered contract would make
 * every agent handler a type error on any build where the layer is absent — handlers
 * nobody could typecheck until after a deployment. A contract at the zero address emits
 * nothing, so the cost is a filter that never matches.
 *
 * ## Four contracts per agent, discovered from one event
 *
 * An agent's mandate, treasury, execution module and revenue router are deployed when
 * it is created, so their addresses are only knowable from `AgentLaunched` — the same
 * situation a market's token, splitter and locker are in, and the same answer.
 *
 * The difference is that their events mostly do not carry an agent id.
 * `AgentTreasury.Spent` says which asset went where, and the only thing tying it to an
 * agent is which treasury emitted it. So the handlers resolve that through the
 * `agentContract` link table, which `AgentLaunched` fills in.
 */
const agentContracts = {
  AgentLaunchFactory: {
    abi: abi.agentLaunchFactoryAbi,
    chain: "robinhood" as const,
    address: AGENTS.launchFactory,
    startBlock: AGENTS.startBlock,
  },

  AgentIdentityRegistry: {
    abi: abi.agentIdentityRegistryAbi,
    chain: "robinhood" as const,
    address: AGENTS.identityRegistry,
    startBlock: AGENTS.startBlock,
  },

  AgentServiceRegistry: {
    abi: abi.agentServiceRegistryAbi,
    chain: "robinhood" as const,
    address: AGENTS.serviceRegistry,
    startBlock: AGENTS.startBlock,
  },

  AgentMandate: {
    abi: abi.agentMandateAbi,
    chain: "robinhood" as const,
    address: createdByAgentLaunch("mandate"),
    startBlock: AGENTS.startBlock,
  },

  AgentTreasury: {
    abi: abi.agentTreasuryAbi,
    chain: "robinhood" as const,
    address: createdByAgentLaunch("treasury"),
    startBlock: AGENTS.startBlock,
  },

  AgentExecutionModule: {
    abi: abi.agentExecutionModuleAbi,
    chain: "robinhood" as const,
    address: createdByAgentLaunch("executionModule"),
    startBlock: AGENTS.startBlock,
  },

  AgentRevenueRouter: {
    abi: abi.agentRevenueRouterAbi,
    chain: "robinhood" as const,
    address: createdByAgentLaunch("router"),
    startBlock: AGENTS.startBlock,
  },
};

export default createConfig({
  chains: {
    robinhood: { id: CHAIN_ID, rpc: RPC_URL },
  },
  contracts: {
    ...agentContracts,

    VerdantFactory: {
      abi: abi.verdantFactoryAbi,
      chain: "robinhood",
      address: FACTORY,
      startBlock: START_BLOCK,
    },

    VerdantHook: {
      abi: abi.verdantHookAbi,
      chain: "robinhood",
      address: HOOK,
      startBlock: START_BLOCK,
    },

    // Not Verdant's, and not filtered by pool: the set of Verdant pool ids is
    // discovered as markets are created, and a log filter cannot be extended after
    // the fact. So every pool's swaps arrive and the handler drops the ones whose
    // pool it has never heard of. On a chain this size that is cheap; if it stops
    // being cheap, the answer is a filtered configuration per pool id rather than a
    // guess about which pools matter.
    //
    // It stopped being cheap, and this filter is the first half of the answer.
    //
    // Ponder caches every log it syncs, so an unfiltered subscription to the
    // singleton PoolManager was paying storage for `ModifyLiquidity` on every pool
    // on the chain — an event with no handler here, whose rows were written, cached
    // and never read. Naming the two events that do have handlers stops them being
    // fetched at all, rather than fetching and discarding them.
    //
    // The second half — filtering `Swap` down to Verdant's own pools — is not
    // expressible here. `Swap` carries its pool as an indexed argument, but the set
    // of Verdant pool ids is only known as markets are created, and Ponder's
    // `factory()` resolves child *addresses* for the `address` field; it cannot
    // supply a growing list of topic values. So swaps still arrive for every pool
    // and `PoolManager:Swap` still drops the ones it does not recognise.
    PoolManager: {
      abi: abi.poolManagerAbi,
      chain: "robinhood",
      address: POOL_MANAGER,
      startBlock: START_BLOCK,
      filter: [{ event: "Initialize", args: {} }, { event: "Swap", args: {} }],
    },

    /**
     * Agen's factory, which launches generated markets.
     *
     * One event carries everything: `MarketDeployed` names the token, the hook, the
     * pool, the locker and the locked supply, in the transaction the market first
     * appears in. Everything else about the market is read from the registry at that
     * block, which is cheaper than following a second stream to learn the same facts.
     *
     * Registered whether or not it is deployed, with the zero address standing in.
     * `src/addresses.ts` explains why: `ponder codegen` derives the valid event names
     * from this configuration, so a conditionally-registered contract makes its own
     * handler a type error on every build predating the deployment.
     */
    AgenFactory: {
      abi: abi.agenFactoryAbi,
      chain: "robinhood",
      address: AGEN.factory,
      startBlock: AGEN.startBlock,
    },

    VerdantToken: {
      abi: abi.verdantTokenAbi,
      chain: "robinhood",
      address: createdByFactory("token"),
      startBlock: START_BLOCK,
    },

    FeeSplitter: {
      abi: abi.feeSplitterAbi,
      chain: "robinhood",
      address: createdByFactory("splitter"),
      startBlock: START_BLOCK,
    },

    PositionLocker: {
      abi: abi.positionLockerAbi,
      chain: "robinhood",
      address: createdByFactory("locker"),
      startBlock: START_BLOCK,
    },

    // A market with no vesting reports `address(0)` in this parameter, so the zero
    // address joins this set. Harmless — nothing emits from it — and preferable to
    // filtering the stream on a sentinel that would then have to agree with the
    // factory's own idea of "no vesting".
    TokenVesting: {
      abi: abi.tokenVestingAbi,
      chain: "robinhood",
      address: createdByFactory("vesting"),
      startBlock: START_BLOCK,
    },
  },
});
