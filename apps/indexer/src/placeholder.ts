import { EXTERNAL_ADDRESSES, ROBINHOOD_MAINNET_ID } from "@verdant/config";

/**
 * P0 placeholder proving the config package resolves here too. Replaced by
 * ponder.config.ts and ponder.schema.ts in P8.
 *
 * The addresses below are the only ones knowable at P0 — Verdant's own
 * contracts do not exist yet, so there is no factory address and no start block,
 * which is exactly why the Ponder config cannot be written now.
 */
export const INDEXER_TARGETS = {
  chainId: ROBINHOOD_MAINNET_ID,
  poolManager: EXTERNAL_ADDRESSES.poolManager,
  positionManager: EXTERNAL_ADDRESSES.positionManager,
} as const;
