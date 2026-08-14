/**
 * Which Instant deployment this indexer is following.
 *
 * The Instant half of `apps/indexer/src/addresses.ts`, kept in the same shape and for the
 * same reasons: `@verdant/config`'s record is the source, the environment overrides it,
 * and a missing address is a refusal rather than a default. An indexer given nothing to
 * index reports healthy and serves an empty list, which is the failure that looks exactly
 * like a chain where nobody has launched anything.
 *
 * ## Why this is a different service
 *
 * Ponder names an app by a hash of its configuration and code, and Railway gives each
 * deployment its own schema, so every deploy of an indexer re-indexes from its start block
 * into empty tables. While Instant shared a service with Verdant and Agen, that meant an
 * Instant-only change re-indexed the Programmable feed and left it incomplete until the
 * backfill finished. Separating them makes the blast radius of an Instant change end at
 * Instant.
 *
 * It also makes the backfill trivial. Nothing Instant cares about predates its factory, so
 * this indexer starts at the factory's block rather than at Verdant's — around ten million
 * blocks later.
 */

import { EXTERNAL_ADDRESSES, ROBINHOOD_MAINNET_ID, instantFor, robinhoodMainnet } from "@verdant/config";
import type { Address } from "viem";

const instantLayer = instantFor(ROBINHOOD_MAINNET_ID);

const NOT_DEPLOYED = "0x0000000000000000000000000000000000000000" as Address;

export const CHAIN_ID = ROBINHOOD_MAINNET_ID;

export const RPC_URL =
  process.env.PONDER_RPC_URL_4663 ?? robinhoodMainnet.rpcUrls.default.http[0];

/**
 * Uniswap's PoolManager, which is where price and volume come from.
 *
 * Overridable, and the override is not hypothetical: `scripts/instant-proof.sh` deploys a
 * Uniswap of its own onto anvil, and without this the indexer would watch the mainnet
 * address on a node where nothing lives there and index every market with no pool.
 */
export const POOL_MANAGER = (process.env.VERDANT_POOL_MANAGER ??
  EXTERNAL_ADDRESSES.poolManager) as Address;

interface InstantLayer {
  /** False when nothing is deployed and the addresses below are the zero address. */
  readonly deployed: boolean;
  readonly factory: Address;
  /** Instant's own registry, not Verdant's. See ADR-014. */
  readonly registry: Address;
  readonly startBlock: number;
}

/**
 * Instant's addresses, from the environment or from the deployment record.
 *
 * Registered even when absent, with the zero address standing in, because `ponder codegen`
 * derives the set of valid event names from the configuration: a conditionally-registered
 * factory would make `ponder.on("InstantFactory:MarketCreated", …)` a type error on any
 * build predating the deployment. A contract at the zero address emits nothing, so the
 * cost is a log filter that never matches.
 *
 * Both addresses or neither. `MarketRegistry.writer` is an immutable naming the factory
 * and the factory's constructor checks that the registry names it back, so one from each
 * of two deployments describes something that cannot exist on chain.
 */
function resolveInstantLayer(): InstantLayer {
  const fromEnv = [process.env.INSTANT_FACTORY, process.env.INSTANT_REGISTRY];
  const supplied = fromEnv.filter((value) => value !== undefined).length;

  if (supplied !== 0 && supplied !== 2) {
    throw new Error(
      `Instant needs both INSTANT_FACTORY and INSTANT_REGISTRY, or neither. ${supplied} ` +
        `was set. The two are bound to each other in immutables, so a half-set pair ` +
        `describes a deployment that does not exist.`,
    );
  }

  if (supplied === 2) {
    const [factory, registry] = fromEnv as [string, string];
    return {
      deployed: true,
      factory: factory as Address,
      registry: registry as Address,
      startBlock: Number(process.env.INSTANT_START_BLOCK ?? 0),
    };
  }

  if (instantLayer === null) {
    return {
      deployed: false,
      factory: NOT_DEPLOYED,
      registry: NOT_DEPLOYED,
      startBlock: 0,
    };
  }

  return {
    deployed: true,
    factory: instantLayer.factory,
    registry: instantLayer.registry,
    startBlock: Number(process.env.INSTANT_START_BLOCK ?? instantLayer.deployedAtBlock),
  };
}

export const INSTANT = resolveInstantLayer();
