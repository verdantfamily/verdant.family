/**
 * The indexing functions.
 *
 * Read `ponder.schema.ts` first; it states the two rules these handlers follow and
 * why. What is worth knowing before the code:
 *
 * ## A launch is one transaction, and its events arrive in a fixed order
 *
 * `create()` initialises the pool, mints the locked position, registers the market
 * and then emits `MarketCreated`. So the PoolManager's `Initialize` always precedes
 * `MarketCreated`, and any first buy comes after both. That order is a property of
 * the factory's code rather than a coincidence of log indices, which is what makes
 * it safe to rely on: `poolInit` is written first and read a moment later by the
 * handler that creates the market row.
 *
 * ## Four things are read from contracts rather than taken from events
 *
 * The fee splits are in the registry's record but in no log. The token's name,
 * supply and metadata live on the token, and so — on a different token — do the name,
 * symbol and decimals of whatever the market is quoted in. And the fee ladder's
 * *init time* is written by `afterInitialize`, so the two words carried by
 * `MarketConfigured` have a zero there and are not the schedule anyone trades under.
 *
 * Reading is not a weaker source than an event here: it is the contract's own
 * account of its state at a block that is already settled by the time it is indexed.
 * It costs a handful of calls once per market, which is a rare event.
 *
 * Every one of those reads passes `cache: "immutable"`, which asks Ponder for the value
 * at the latest block rather than at the block the event arrived in, and to remember it
 * forever. Two reasons, and either alone would be enough.
 *
 * The values cannot change. A supply that is minted once with no mint function, a fee
 * schedule the hook writes at initialisation and refuses to edit, a registry entry that
 * reverts with `MarketAlreadyRegistered` on a second write, an ERC-20's decimals: for all
 * of these, "at that block" and "now" are the same answer, so asking for the settled one
 * buys nothing.
 *
 * And asking for the settled one does not work. Robinhood's public RPC keeps no archive
 * state: an `eth_call` at a block more than about an hour old comes back
 * `metadata is not found, <block>`, and the handler that made it fails permanently rather
 * than transiently. An indexer that reads at event blocks can therefore never *backfill*
 * this chain from the public endpoint — it can only keep up with the tip it is already at.
 * That is not a rate limit to be waited out; it is the shape of the node.
 *
 * The one value here that is genuinely mutable is `metadataURI`, and only for a token whose
 * creator chose `metadataMutable`. Reading the current one is right anyway: every change to
 * it arrives as `MetadataURIUpdated` and is applied by the handler at the bottom of this
 * file, so the column holds the newest URI either way.
 */

import { ponder } from "ponder:registry";
import {
  claim,
  feeCollection,
  holder,
  market,
  marketContract,
  poolInit,
  swap,
  vestingRelease,
} from "ponder:schema";
import { abi } from "@verdant/sdk";
import { erc20Abi, type Address } from "viem";

import { HOOK_LOWER } from "./addresses";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/**
 * What ether calls itself, in the order the reads below return.
 *
 * v4 does not wrap: the zero address *is* ether, so an ether-quoted market has no
 * contract to ask and these three are stated rather than read. Ordering them to
 * match the ERC-20 branch is what lets both destructure into the same names.
 */
const ETHER = ["Ether", "ETH", 18] as const;

function absolute(value: bigint): bigint {
  return value < 0n ? -value : value;
}

/**
 * A stable, unique id for a row that records one log.
 *
 * Transaction hash and log index. Unique because a log index is unique within a
 * block, and stable because a reorg that replays the same log in the same
 * transaction produces the same id — which is what lets Ponder's rollback and
 * re-index converge instead of duplicating rows.
 */
function logId(event: {
  transaction: { hash: string };
  log: { logIndex: number };
}): string {
  return `${event.transaction.hash}-${event.log.logIndex}`;
}

/**
 * The pool's opening price.
 *
 * Filtered to Verdant's hook: every pool on the chain initialises through this
 * event, so without the check this table would be a record of other people's
 * markets. A pool that names this hook is a Verdant market by construction, because
 * the hook lets nobody but the factory initialise it.
 *
 * The comparison is lowercased on both sides — the configured address and the
 * decoded one are two spellings of the same thing.
 */
ponder.on("PoolManager:Initialize", async ({ event, context }) => {
  if (event.args.hooks.toLowerCase() !== HOOK_LOWER) return;

  await context.db.insert(poolInit).values({
    id: event.args.id,
    sqrtPriceX96: event.args.sqrtPriceX96,
    tick: event.args.tick,
    timestamp: Number(event.block.timestamp),
    blockNumber: event.block.number,
  });
});

ponder.on("VerdantFactory:MarketCreated", async ({ event, context }) => {
  const poolId = event.args.poolId;
  const token = event.args.token;
  const quoteAsset = event.args.quoteAsset;

  // Written moments ago, in this same transaction. Its absence would mean a market
  // whose pool was never initialised, which `create()` makes impossible — so this
  // throws instead of defaulting, because a zero opening price stored quietly is a
  // market that appears to have launched for nothing.
  const opened = await context.db.find(poolInit, { id: poolId });
  if (opened === null) {
    throw new Error(
      `market ${poolId} has no Initialize event. Either the PoolManager address or ` +
        `VERDANT_HOOK is wrong, in which case no market will ever index correctly.`,
    );
  }

  const registry = await context.client.readContract({
    abi: abi.verdantFactoryAbi,
    address: event.log.address,
    functionName: "marketRegistry",
    cache: "immutable",
  });

  // What the quote asset calls itself. Started here rather than awaited here, so
  // that it travels with the reads below instead of after them.
  //
  // An equity is a plain ERC-20 and answers for itself; ether is the zero address
  // and cannot be asked, which is the only reason this is a branch. Whichever way it
  // goes, the answer is stored — a market page that showed an amount in an equity's
  // smallest unit without its decimals would be off by eighteen orders of magnitude.
  const quoteMetadata: Promise<readonly [string, string, number]> =
    quoteAsset === ZERO_ADDRESS
      ? Promise.resolve(ETHER)
      : Promise.all([
          context.client.readContract({
            abi: erc20Abi,
            address: quoteAsset,
            functionName: "name",
            cache: "immutable",
          }),
          context.client.readContract({
            abi: erc20Abi,
            address: quoteAsset,
            functionName: "symbol",
            cache: "immutable",
          }),
          context.client.readContract({
            abi: erc20Abi,
            address: quoteAsset,
            functionName: "decimals",
            cache: "immutable",
          }),
        ]);

  const [record, config, name, symbol, decimals, totalSupply, metadataURI, metadataMutable] =
    await Promise.all([
      context.client.readContract({
        abi: abi.marketRegistryAbi,
        address: registry,
        functionName: "marketOf",
        args: [poolId],
        cache: "immutable",
      }),
      context.client.readContract({
        abi: abi.verdantHookAbi,
        address: context.contracts.VerdantHook.address,
        functionName: "configOf",
        args: [poolId],
        cache: "immutable",
      }),
      context.client.readContract({
        abi: abi.verdantTokenAbi,
        address: token,
        functionName: "name",
        cache: "immutable",
      }),
      context.client.readContract({
        abi: abi.verdantTokenAbi,
        address: token,
        functionName: "symbol",
        cache: "immutable",
      }),
      context.client.readContract({
        abi: abi.verdantTokenAbi,
        address: token,
        functionName: "decimals",
        cache: "immutable",
      }),
      context.client.readContract({
        abi: abi.verdantTokenAbi,
        address: token,
        functionName: "totalSupply",
        cache: "immutable",
      }),
      context.client.readContract({
        abi: abi.verdantTokenAbi,
        address: token,
        functionName: "metadataURI",
        cache: "immutable",
      }),
      context.client.readContract({
        abi: abi.verdantTokenAbi,
        address: token,
        functionName: "metadataMutable",
        cache: "immutable",
      }),
    ]);

  const [, initTime, stages] = config;
  const [quoteName, quoteSymbol, quoteDecimals] = await quoteMetadata;

  await context.db.insert(market).values({
    id: poolId,
    token,
    quoteAsset,
    creator: event.args.creator,
    model: event.args.model,

    name,
    symbol,
    decimals: Number(decimals),
    totalSupply,
    metadataURI,
    metadataMutable,

    quoteName,
    quoteSymbol,
    quoteDecimals: Number(quoteDecimals),

    splitter: event.args.splitter,
    locker: event.args.locker,
    vesting: event.args.vesting === ZERO_ADDRESS ? null : event.args.vesting,
    positionTokenId: event.args.positionTokenId,
    initialLiquidity: event.args.liquidity,

    creatorBps: record.creatorBps,
    protocolBps: record.protocolBps,
    reserveBps: record.reserveBps,

    stages: stages.map((stage) => ({
      startOffset: Number(stage.startOffset),
      feePpm: Number(stage.feePpm),
    })),
    initTime: Number(initTime),

    createdAt: Number(event.block.timestamp),
    createdAtBlock: event.block.number,
    createdTx: event.transaction.hash,

    initialSqrtPriceX96: opened.sqrtPriceX96,
    initialTick: opened.tick,
    sqrtPriceX96: opened.sqrtPriceX96,
    tick: opened.tick,
    liquidity: event.args.liquidity,

    swapCount: 0,
    volumeQuote: 0n,
    volumeToken: 0n,
    lastSwapAt: null,
  });

  // The address-to-market links, written here because this is the only event that
  // knows all four addresses and consulted by every child handler below.
  //
  // The quote asset is deliberately not among them. It belongs to no single market —
  // two markets can be quoted in the same equity — and this table is keyed by
  // address, so filing it here would make the second launch against an equity
  // overwrite the first one's link.
  const children: readonly { readonly address: Address; readonly kind: string }[] = [
    { address: token, kind: "token" },
    { address: event.args.splitter, kind: "splitter" },
    { address: event.args.locker, kind: "locker" },
    ...(event.args.vesting === ZERO_ADDRESS
      ? []
      : [{ address: event.args.vesting, kind: "vesting" }]),
  ];

  for (const child of children) {
    await context.db
      .insert(marketContract)
      .values({ id: child.address, poolId, kind: child.kind });
  }
});

ponder.on("PoolManager:Swap", async ({ event, context }) => {
  const existing = await context.db.find(market, { id: event.args.id });
  if (existing === null) return; // Not a Verdant pool.

  // The deltas are the *swapper's*, not the pool's, so a negative amount0 means the
  // trader paid the quote asset: a buy. currency0 is the market's quote asset —
  // ether for most, the equity for a stock-paired one — and currency1 is always the
  // launch token, which the factory enforces at creation by refusing a token that
  // does not sort above its quote asset. So this reading holds for either kind of
  // market without knowing which one it is looking at.
  //
  // Worth stating because v4's own docstring on this event says "the delta of the
  // currency0 balance of the pool", which is the opposite. The code emits
  // `delta.amount0()` from the value it then accounts against `msg.sender`
  // (PoolManager.swap), so the comment is wrong and the code is what matters. Reading
  // the comment is how this was first written, and it labelled every buy a sell.
  const buy = event.args.amount0 < 0n;
  const quoteAmount = absolute(event.args.amount0);
  const tokenAmount = absolute(event.args.amount1);

  await context.db.insert(swap).values({
    id: logId(event),
    poolId: event.args.id,
    sender: event.args.sender,
    amount0: event.args.amount0,
    amount1: event.args.amount1,
    buy,
    quoteAmount,
    tokenAmount,
    sqrtPriceX96: event.args.sqrtPriceX96,
    liquidity: event.args.liquidity,
    tick: event.args.tick,
    feePpm: event.args.fee,
    timestamp: Number(event.block.timestamp),
    blockNumber: event.block.number,
    logIndex: event.log.logIndex,
    transactionHash: event.transaction.hash,
  });

  await context.db.update(market, { id: event.args.id }).set((row) => ({
    sqrtPriceX96: event.args.sqrtPriceX96,
    tick: event.args.tick,
    liquidity: event.args.liquidity,
    swapCount: row.swapCount + 1,
    volumeQuote: row.volumeQuote + quoteAmount,
    volumeToken: row.volumeToken + tokenAmount,
    lastSwapAt: Number(event.block.timestamp),
  }));
});

ponder.on("PositionLocker:FeesCollected", async ({ event, context }) => {
  const link = await context.db.find(marketContract, { id: event.log.address });
  if (link === null) return;

  await context.db.insert(feeCollection).values({
    id: logId(event),
    poolId: link.poolId,
    locker: event.log.address,
    caller: event.args.caller,
    positionTokenId: event.args.tokenId,
    timestamp: Number(event.block.timestamp),
    blockNumber: event.block.number,
    transactionHash: event.transaction.hash,
  });
});

ponder.on("FeeSplitter:Claimed", async ({ event, context }) => {
  const link = await context.db.find(marketContract, { id: event.log.address });
  if (link === null) return;

  await context.db.insert(claim).values({
    id: logId(event),
    poolId: link.poolId,
    splitter: event.log.address,
    recipient: event.args.recipient,
    quoteAmount: event.args.quoteAmount,
    tokenAmount: event.args.tokenAmount,
    timestamp: Number(event.block.timestamp),
    blockNumber: event.block.number,
    transactionHash: event.transaction.hash,
  });
});

ponder.on("TokenVesting:Released", async ({ event, context }) => {
  const link = await context.db.find(marketContract, { id: event.log.address });
  if (link === null) return;

  await context.db.insert(vestingRelease).values({
    id: logId(event),
    poolId: link.poolId,
    vesting: event.log.address,
    beneficiary: event.args.beneficiary,
    amount: event.args.amount,
    timestamp: Number(event.block.timestamp),
    blockNumber: event.block.number,
    transactionHash: event.transaction.hash,
  });
});

/**
 * Balances, maintained from transfers.
 *
 * Mints and burns are transfers from and to the zero address, and neither is a
 * holder, so both sides are skipped rather than tracked and filtered later. A row is
 * left at zero rather than deleted: "held once, holds none now" is a different fact
 * from "never held any", and the difference costs a row.
 */
ponder.on("VerdantToken:Transfer", async ({ event, context }) => {
  const token = event.log.address;
  const { from, to, value } = event.args;

  if (from !== ZERO_ADDRESS) {
    await context.db
      .insert(holder)
      .values({ token, address: from, balance: -value })
      .onConflictDoUpdate((row) => ({ balance: row.balance - value }));
  }

  if (to !== ZERO_ADDRESS) {
    await context.db
      .insert(holder)
      .values({ token, address: to, balance: value })
      .onConflictDoUpdate((row) => ({ balance: row.balance + value }));
  }
});

/**
 * The metadata URI, when a market that allowed it changes it.
 *
 * Only mutable-metadata markets can reach this handler — the token reverts otherwise
 * — so there is no permission to re-check here. The market is found by the token's
 * address, which is what `marketContract` exists for.
 */
ponder.on("VerdantToken:MetadataURIUpdated", async ({ event, context }) => {
  const link = await context.db.find(marketContract, { id: event.log.address });
  if (link === null) return;

  await context.db
    .update(market, { id: link.poolId })
    .set({ metadataURI: event.args.newURI });
});
