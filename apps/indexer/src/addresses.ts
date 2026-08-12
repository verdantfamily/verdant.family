/**
 * Which deployment this indexer is following.
 *
 * One module because two places need the answer and they must not be able to
 * disagree: `ponder.config.ts` uses it to decide what to watch, and the indexing
 * functions use it to decide which pools are Verdant's. A hook address that differed
 * between the two would produce an indexer that follows a market's creation and then
 * ignores its trades.
 *
 * `@verdant/config`'s `DEPLOYMENTS` is the source, and the environment overrides it.
 * The override is what lets this same indexer run against a local anvil fork with a
 * freshly deployed protocol, which is how the feed gets tested before the real
 * addresses exist — and, once they do, how a change to it can be tested without
 * touching mainnet.
 */

import {
  EXTERNAL_ADDRESSES,
  ROBINHOOD_MAINNET_ID,
  agenFor,
  agentsFor,
  deploymentFor,
  robinhoodMainnet,
} from "@verdant/config";
import type { Address } from "viem";

const deployment = deploymentFor(ROBINHOOD_MAINNET_ID);
const agentLayer = agentsFor(ROBINHOOD_MAINNET_ID);
const agenLayer = agenFor(ROBINHOOD_MAINNET_ID);

/**
 * An address from the environment, or from the deployment record, or a refusal.
 *
 * Throwing is the point. Ponder given no address indexes no logs, reports healthy
 * and serves an empty API — the failure that looks like a chain with nothing on it.
 */
function required(variable: string, fallback: Address | undefined): Address {
  const value = process.env[variable] ?? fallback;
  if (value === undefined) {
    throw new Error(
      `${variable} is not set, and Verdant is not recorded as deployed on chain ` +
        `${ROBINHOOD_MAINNET_ID}. Set it, or fill in packages/config/src/deployments.ts ` +
        `after a deployment. Refusing to start an indexer with nothing to index.`,
    );
  }
  return value as Address;
}

export const CHAIN_ID = ROBINHOOD_MAINNET_ID;

export const FACTORY = required("VERDANT_FACTORY", deployment?.factory);

/**
 * The hook, which is also how a Verdant pool is recognised.
 *
 * Every pool on the chain announces its hook in the PoolManager's `Initialize`, and
 * a pool whose hook is this address is a Verdant market by construction — the hook
 * only permits the factory to initialise it.
 */
export const HOOK = required("VERDANT_HOOK", deployment?.hook);

/**
 * The block the factory was created in.
 *
 * Nothing Verdant cares about can predate it, including any swap in a Verdant pool,
 * so this is also where the PoolManager's much longer history is picked up from.
 */
/**
 * Uniswap's PoolManager, which is where price, volume and the fee charged come from.
 *
 * Overridable for the same reason the rest are, and it was not until the local proof
 * ran: with this pinned to the deployed address, a rig with its own Uniswap indexed
 * every market's creation and none of their pools, because the pool events were coming
 * from a contract the indexer was not watching. The market handler now refuses that
 * state loudly instead of storing markets with no price — but only because a run
 * against a rig exposed it.
 */
export const POOL_MANAGER = required(
  "VERDANT_POOL_MANAGER",
  EXTERNAL_ADDRESSES.poolManager as Address,
);

export const START_BLOCK = Number(
  process.env.VERDANT_START_BLOCK ?? deployment?.deployedAtBlock ?? 0,
);

export const RPC_URL =
  process.env.PONDER_RPC_URL_4663 ?? robinhoodMainnet.rpcUrls.default.http[0];

/** Lowercased once, because address comparisons happen per event. */
export const HOOK_LOWER = HOOK.toLowerCase();

// --- the agent layer ------------------------------------------------------
//
// Optional, and that is the difference from everything above. The market layer must be
// present or this indexer has nothing to do, so a missing factory is a refusal. The
// agent layer is an addon that has not been broadcast, so a missing one is a
// deployment state rather than a misconfiguration.
//
// It is still described here when it is absent, with the zero address standing in, and
// the agent contracts are still registered in `ponder.config.ts`. That looks wasteful
// and is deliberate: `ponder codegen` derives the set of valid event names from the
// configuration, so a conditionally-registered contract makes
// `ponder.on("AgentTreasury:Spent", …)` a type error on any build where the layer is
// absent. Handlers that only compile once a deployment exists are handlers nobody can
// typecheck before deploying, which is the wrong way round.
//
// A contract at the zero address emits nothing, so the cost is a log filter that never
// matches, and `/agents` correctly serves an empty list.
//
// All three addresses or none. `AgentLaunchFactory` deploys the two registries in its
// own constructor, so a partial override describes a deployment that cannot exist, and
// taking two from the environment and one from a record would silently mix
// deployments.

const NOT_DEPLOYED = "0x0000000000000000000000000000000000000000" as Address;

interface AgentLayer {
  /** False when nothing is deployed and the addresses below are the zero address. */
  readonly deployed: boolean;
  readonly launchFactory: Address;
  readonly identityRegistry: Address;
  readonly serviceRegistry: Address;
  readonly startBlock: number;
}

function resolveAgentLayer(): AgentLayer {
  const fromEnv = [
    process.env.VERDANT_AGENT_FACTORY,
    process.env.VERDANT_AGENT_IDENTITY_REGISTRY,
    process.env.VERDANT_AGENT_SERVICE_REGISTRY,
  ];

  const supplied = fromEnv.filter((value) => value !== undefined).length;

  if (supplied !== 0 && supplied !== 3) {
    throw new Error(
      `the agent layer needs all three of VERDANT_AGENT_FACTORY, ` +
        `VERDANT_AGENT_IDENTITY_REGISTRY and VERDANT_AGENT_SERVICE_REGISTRY, or none. ` +
        `${supplied} were set. The factory deploys both registries in its constructor, ` +
        `so a partial set describes a deployment that does not exist.`,
    );
  }

  if (supplied === 3) {
    const [launchFactory, identityRegistry, serviceRegistry] = fromEnv as [
      string,
      string,
      string,
    ];

    return {
      deployed: true,
      launchFactory: launchFactory as Address,
      identityRegistry: identityRegistry as Address,
      serviceRegistry: serviceRegistry as Address,
      startBlock: Number(
        process.env.VERDANT_AGENT_START_BLOCK ??
          process.env.VERDANT_START_BLOCK ??
          0,
      ),
    };
  }

  if (agentLayer === null) {
    return {
      deployed: false,
      launchFactory: NOT_DEPLOYED,
      identityRegistry: NOT_DEPLOYED,
      serviceRegistry: NOT_DEPLOYED,
      startBlock: START_BLOCK,
    };
  }

  return {
    deployed: true,
    launchFactory: agentLayer.launchFactory,
    identityRegistry: agentLayer.identityRegistry,
    serviceRegistry: agentLayer.serviceRegistry,
    startBlock: Number(
      process.env.VERDANT_AGENT_START_BLOCK ?? agentLayer.deployedAtBlock,
    ),
  };
}

export const AGENTS = resolveAgentLayer();

// --- Agen's launch layer ---------------------------------------------------
//
// Optional for the same reason the agent layer is, and registered whether or not it
// exists for the same reason: `ponder codegen` derives the valid event names from the
// configuration, so a conditionally-registered factory would make its handler a type
// error on every build made before the deployment. A contract at the zero address
// emits nothing, so the cost is a filter that never matches.
//
// Both addresses or neither. The registry holds the factory in an immutable and the
// factory's constructor checks that the registry names it back, so a pair taken from
// two different deployments describes something that cannot exist on chain.

interface AgenLayer {
  /** False when nothing is deployed and the addresses below are the zero address. */
  readonly deployed: boolean;
  readonly factory: Address;
  readonly registry: Address;
  readonly startBlock: number;
}

function resolveAgenLayer(): AgenLayer {
  const fromEnv = [process.env.AGEN_FACTORY, process.env.AGEN_REGISTRY];
  const supplied = fromEnv.filter((value) => value !== undefined).length;

  if (supplied !== 0 && supplied !== 2) {
    throw new Error(
      `Agen needs both AGEN_FACTORY and AGEN_REGISTRY, or neither. ${supplied} was ` +
        `set. The two are bound to each other in immutables, so a half-set pair ` +
        `describes a deployment that does not exist.`,
    );
  }

  if (supplied === 2) {
    const [factory, registry] = fromEnv as [string, string];
    return {
      deployed: true,
      factory: factory as Address,
      registry: registry as Address,
      startBlock: Number(
        process.env.AGEN_START_BLOCK ?? process.env.VERDANT_START_BLOCK ?? 0,
      ),
    };
  }

  if (agenLayer === null) {
    return {
      deployed: false,
      factory: NOT_DEPLOYED,
      registry: NOT_DEPLOYED,
      startBlock: START_BLOCK,
    };
  }

  return {
    deployed: true,
    factory: agenLayer.factory,
    registry: agenLayer.registry,
    startBlock: Number(process.env.AGEN_START_BLOCK ?? agenLayer.deployedAtBlock),
  };
}

export const AGEN = resolveAgenLayer();
