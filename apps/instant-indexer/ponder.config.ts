/**
 * What the Instant indexer watches, and where it starts.
 *
 * Two contracts, which is the whole configuration: Instant's factory, and the PoolManager
 * every v4 pool emits through. There is no hook entry because Instant's hook is a constant
 * of the deployment and emits nothing this feed reads, and no per-market contracts because
 * a market's token, vault and locker are named in the factory's own event.
 *
 * ## Both start at Instant's factory
 *
 * Including the PoolManager, which is the point of this service existing separately.
 * Nothing Instant cares about can predate the block its factory was created in — not a
 * pool it opened, not a swap in one — so the PoolManager's much longer history is picked
 * up from there rather than from Verdant's start block ten million blocks earlier. In the
 * shared indexer that same PoolManager subscription had to begin at Verdant's block,
 * because Verdant's markets are older, and every deploy paid for the whole span again.
 */

import { abi } from "@verdant/sdk";
import { createConfig } from "ponder";

import { CHAIN_ID, INSTANT, POOL_MANAGER, RPC_URL } from "./src/addresses";

export default createConfig({
  chains: {
    robinhood: { id: CHAIN_ID, rpc: RPC_URL },
  },
  contracts: {
    /**
     * Instant's factory, which launches standard markets.
     *
     * One event carries everything only the launch transaction knows: `MarketCreated`
     * names the token, the creator, the vault, the locker and the locked position. The
     * rest — the fee field, the tick spacing and the opening price — comes from the
     * `poolInit` row the PoolManager's `Initialize` wrote moments earlier in the same
     * transaction, because a registry stores the pool id and not the key that hashes to
     * it.
     */
    InstantFactory: {
      abi: abi.instantFactoryAbi,
      chain: "robinhood",
      address: INSTANT.factory,
      startBlock: INSTANT.startBlock,
    },

    /**
     * Uniswap's singleton, filtered to the two events that have handlers here.
     *
     * Naming them stops the rest being fetched at all rather than fetched and discarded.
     * Ponder caches every log it syncs, so an unfiltered subscription would pay storage
     * for `ModifyLiquidity` on every pool on the chain — rows written, cached and never
     * read.
     *
     * `Swap` cannot be narrowed further. It carries its pool as an indexed argument, but
     * the set of Instant pool ids is only known as markets are created and a log filter
     * cannot be extended after the fact, so swaps arrive for every pool on the chain and
     * the handler drops the ones it does not recognise.
     */
    PoolManager: {
      abi: abi.poolManagerAbi,
      chain: "robinhood",
      address: POOL_MANAGER,
      startBlock: INSTANT.startBlock,
      filter: [{ event: "Initialize", args: {} }, { event: "Swap", args: {} }],
    },
  },
});
