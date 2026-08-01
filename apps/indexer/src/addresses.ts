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
  deploymentFor,
  robinhoodMainnet,
} from "@verdant/config";
import type { Address } from "viem";

const deployment = deploymentFor(ROBINHOOD_MAINNET_ID);

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
