/**
 * Engine-v1 markets, as the chain reports them.
 *
 * ## Why this is a second handler and not a branch in the first
 *
 * Because the two launch paths emit different events from different factories, and the whole
 * point of indexing them separately is that a consumer can tell them apart without guessing.
 * `AgenFactory:MarketDeployed` announces a generated contract; `AgenEngineFactory:
 * EngineMarketDeployed` announces a configuration. They land in the same table because
 * everything downstream of the launch — the pool, the locked liquidity, the swap stream, the
 * price — really is the same, and they are distinguished by `engineVersion`, which is written
 * here and never inferred.
 *
 * ## The hook is not a market key, and this is where that matters most
 *
 * At engine 0 a hook belonged to one market, so `marketByHook` was a lookup. At engine 1 one
 * hook serves every market ever launched, so the same call returns whichever one registered
 * last. Nothing in this file resolves a market through the hook, and nothing downstream may
 * either: the identity is the pool id, as it is for every other market in this schema.
 *
 * ## Where the market's economics come from
 *
 * From the launch transaction's own calldata, verified against the hook's derivation of it.
 *
 * That needs justifying, because reading calldata is unusual for an indexer. The alternative
 * was to record the identity only — `configHash` and a handful of addresses — and leave a
 * consumer to ask the hook one question at a time: `feePpmFor` at a size, then another size,
 * then guess where the boundaries are. That reconstructs a fee schedule by probing it, which is
 * exactly the kind of second opinion about economics this architecture exists to remove.
 *
 * So the manifest is decoded from the transaction that carried it and the configuration inside
 * it is kept whole. It is not trusted on sight: the bytes are re-encoded canonically, hashed,
 * and compared with the `configHash` the hook computed from what it actually stored. Equal
 * means these bytes are this market's rules, provably. Unequal — or undecodable — means they
 * are stored as null, because a configuration that does not match its commitment is not a
 * slightly-wrong answer, it is a different market.
 */

import { ponder } from "ponder:registry";
import { and, desc, eq, lt } from "ponder";
import { agenComponent, agenMarket, agenPendingFee, agenSwap, poolInit } from "ponder:schema";
import { abi } from "@verdant/sdk";
import { CONFIG_ABI } from "@verdant/market-engine";
import { decodeFunctionData, encodeAbiParameters, erc20Abi, keccak256, type Hex } from "viem";

import { AGEN_ENGINE } from "./addresses";

/** The shape the swap handler hands to `claimPendingFee`. Mirrors `agen.ts`'s `SwapHandler`. */
type SwapHandlerContext = Parameters<Parameters<typeof ponder.on<"PoolManager:Swap">>[1]>[0];

/** The two currencies a programmable fee can be taken in. Mirrors `AgenRuleLib.FeeCurrency`. */
const FEE_CURRENCY_QUOTE = 0;

/**
 * The canonical configuration bytes for this launch, or null if they cannot be proved.
 *
 * Proved means: decoded from the launch calldata, re-encoded through the same encoder the
 * commitment is defined by, and hashed to the value the hook derived from its own storage. Any
 * step failing returns null rather than a best effort — see the note at the top of the file.
 *
 * Failure is expected in one ordinary case and one adversarial one. Ordinary: a launch sent
 * through a router or a multicall, where `deployMarket` is nested inside calldata this cannot
 * decode. Adversarial: nothing, because a mismatch is refused rather than recorded. Either way
 * the market indexes with its identity intact and its rules readable from the hook.
 */
function configOf(input: Hex, expected: Hex): Hex | null {
  let encoded: Hex;

  try {
    const { functionName, args } = decodeFunctionData({
      abi: abi.agenEngineFactoryAbi,
      data: input,
    });

    if (functionName !== "deployMarket") return null;

    /*
     * Re-encoded through the engine's own tuple, not sliced out of the calldata.
     *
     * Two reasons, and the first is fatal on its own: a byte range lifted from a larger ABI
     * payload carries the offsets of its position inside the manifest, so it is not the
     * encoding of a configuration and would never hash correctly. The second is that
     * `CONFIG_ABI` is the definition `configHash` is taken over, so encoding through it makes
     * this byte-identical to `encodeConfig` by construction rather than by coincidence.
     */
    encoded = encodeAbiParameters(CONFIG_ABI, [args[0].config]);
  } catch {
    return null;
  }

  // `configHash` is `keccak256` of the canonical encoding and nothing else — no domain tag, no
  // chain, no engine — which is why this check needs no decoder and no knowledge of the schema.
  // If these bytes hash to what the hook derived from its own storage, they are what it stored.
  return keccak256(encoded) === expected ? encoded : null;
}

ponder.on("AgenEngineFactory:EngineMarketDeployed", async ({ event, context }) => {
  const poolId = event.args.poolId;
  const token = event.args.token;

  // Opened moments ago in this same transaction, as at engine 0. Thrown rather than defaulted
  // for the same reason: a market with no fee and no price is indistinguishable from a working
  // index until somebody tries to trade it.
  const opened = await context.db.find(poolInit, { id: poolId });
  if (opened === null) {
    throw new Error(
      `engine market ${poolId} has no Initialize event. The PoolManager address is wrong, in ` +
        `which case no engine market will ever index correctly.`,
    );
  }

  const record = await context.client.readContract({
    abi: abi.agenMarketRegistryAbi,
    address: AGEN_ENGINE.registry,
    functionName: "marketByToken",
    args: [token],
  });

  const components = await context.client.readContract({
    abi: abi.agenMarketRegistryAbi,
    address: AGEN_ENGINE.registry,
    functionName: "componentsAt",
    args: [event.args.index],
  });

  /*
   * Which currency the fee is taken in, resolved to an address here rather than left as an enum.
   *
   * Read from the hook because the hook derived it — the configuration says whether the market
   * has size tiers and the hook turns that into a currency, per ADR-018. Resolving the enum to
   * an address means a consumer reading this table does not have to know the rule, and cannot
   * get it wrong.
   */
  const feeCurrencyKind = await context.client.readContract({
    abi: abi.agenEngineHookAbi,
    address: AGEN_ENGINE.hook,
    functionName: "feeCurrencyOf",
    args: [poolId],
  });

  /*
   * The first of the three locked positions.
   *
   * Read from the locker rather than taken from the event, because `EngineMarketDeployed` does
   * not carry it — the factory's stack had opinions and the event kept the fields a verifier
   * needs to identify the market. The locker holds it in an immutable, so this is the same
   * number, from the contract whose whole purpose is that it can never change.
   */
  const firstTokenId = await context.client.readContract({
    abi: abi.agenPositionLockerAbi,
    address: event.args.locker,
    functionName: "firstTokenId",
    cache: "immutable",
  });

  const [name, symbol, decimals, totalSupply] = await Promise.all([
    context.client.readContract({
      abi: erc20Abi,
      address: token,
      functionName: "name",
      cache: "immutable",
    }),
    context.client.readContract({
      abi: erc20Abi,
      address: token,
      functionName: "symbol",
      cache: "immutable",
    }),
    context.client.readContract({
      abi: erc20Abi,
      address: token,
      functionName: "decimals",
      cache: "immutable",
    }),
    context.client.readContract({
      abi: erc20Abi,
      address: token,
      functionName: "totalSupply",
    }),
  ]);

  await context.db.insert(agenMarket).values({
    id: poolId,
    marketIndex: Number(event.args.index),
    token,
    // The shared engine. Recorded because it is true and because "every market on this engine"
    // is a real question; never used to resolve one. See the column's own note.
    hook: AGEN_ENGINE.hook,
    creator: event.args.creator,
    quoteAsset: record.quoteAsset,

    fee: opened.fee,
    tickSpacing: opened.tickSpacing,

    specificationHash: record.specificationHash,
    implementationHash: event.args.implementationHash,
    metadataURI: record.metadataURI,

    engineVersion: event.args.engineVersion,
    configHash: event.args.configHash,
    encodedConfig: configOf(event.transaction.input, event.args.configHash),
    vault: event.args.vault,
    feeCurrency: feeCurrencyKind === FEE_CURRENCY_QUOTE ? record.quoteAsset : token,

    name,
    symbol,
    decimals,
    totalSupply,

    locker: event.args.locker,
    firstPositionId: firstTokenId,
    /*
     * The whole minted supply, because that is what an engine launch locks.
     *
     * `AgenEngineFactory._openLiquidity` puts its entire token balance into the three bands and
     * reverts if there is none, so there is no held-back allocation to subtract. What it does
     * return to the creator is the rounding dust from converting a token amount into whole
     * units of liquidity — a few base units against a billion tokens — so this figure is high
     * by an amount that does not survive being displayed. It is recorded as the supply rather
     * than as a measurement, and the event does not carry the exact number.
     */
    supplyLocked: totalSupply,

    createdAt: Number(event.block.timestamp),
    createdAtBlock: event.block.number,
    createdTx: event.transaction.hash,

    initialSqrtPriceX96: opened.sqrtPriceX96,
    initialTick: opened.tick,
    sqrtPriceX96: opened.sqrtPriceX96,
    tick: opened.tick,
    liquidity: 0n,

    swapCount: 0,
    volumeQuote: 0n,
    volumeToken: 0n,
    lastSwapAt: null,
  });

  // The vault is among these, under `ROLE_VAULT`, which is how a market page finds the account
  // its fees accumulate in without this table having to be the authority on roles.
  for (const component of components) {
    await context.db.insert(agenComponent).values({
      id: component.addr,
      poolId,
      role: component.role,
      codeHash: component.codeHash,
    });
  }
});

/**
 * The fee an engine market actually charged, which the Swap event cannot report.
 *
 * ## Why this handler has to exist
 *
 * Uniswap's `Swap` carries a `fee` field, and for a generated Agen market that field is the
 * whole story: the hook overrides the pool's fee per swap, so what the pool reports charging is
 * what the trade paid. An engine market works differently. The hook sets the pool's LP fee to
 * zero and takes Agen's fee as a swap delta instead, which means the Swap event honestly
 * reports zero — and a feed reading only Uniswap would show every engine trade as free.
 *
 * So the rate is read from the hook's own `FeeTaken`, which is emitted in the same transaction
 * and carries the numbers the hook decided from: the gross amounts it measured, the rate those
 * amounts selected, and the fee it took.
 *
 * ## Why it updates a row rather than writing one
 *
 * The swap row already exists — usually. `PoolManager:Swap` is what creates it, and it has the
 * price, the tick and the liquidity that `FeeTaken` does not. Writing a second row would double
 * every engine trade in every feed that counts them.
 *
 * ## The ordering, which is not fixed, and which this used to get wrong
 *
 * This handler assumed the swap always came first: "the hook emits after the pool". That is
 * true for half of all trades and false for the other half. The hook charges in `beforeSwap`
 * when the fee comes out of the currency the trader specified, and in `afterSwap` when it comes
 * out of the other leg — so for an ordinary buy, where the trader names the ether they are
 * spending, `FeeTaken` is emitted *before* the pool's `Swap` and there is nothing to update
 * yet. The old code found nothing, returned, and dropped the fee. Every buy on every engine
 * market read as free while every sell was correct, in the API and on the market page.
 *
 * Both orders are handled now: a fee that arrives first is parked in `agenPendingFee` and
 * claimed by `claimPendingFee` when the swap lands.
 *
 * ## Telling one order from the other
 *
 * By the amounts, which is exact rather than heuristic. `FeeTaken` carries the gross legs the
 * hook measured. Charged in `afterSwap`, those are the legs the pool just reported, so they
 * equal the swap row's own. Charged in `beforeSwap`, the gross is the trader's specified amount
 * *before* the fee came out of it, so it cannot equal a leg of any swap that has already
 * happened.
 *
 * That matters in a transaction with several swaps on one pool. Position alone is ambiguous
 * there — a dust trade too small to owe a base unit emits no `FeeTaken` at all, so counting
 * events would misalign every pair after it — and comparing amounts is not.
 *
 * ## Where the shared hook does not matter
 *
 * This is the one handler keyed off the shared hook address, and it is safe because the event
 * says which pool it belongs to. Nothing here resolves a market *from* the hook.
 */
ponder.on("AgenEngineHook:FeeTaken", async ({ event, context }) => {
  /*
   * The nearest swap on this pool already indexed in this transaction.
   *
   * Nearest rather than "any with no fee yet": a swap's own `Swap` and its own `FeeTaken` are
   * adjacent in the pool's sequence, because v4 runs one swap call at a time and cannot begin
   * another between a pool event and the hook callback that follows it.
   */
  const rows = await context.db.sql
    .select({
      id: agenSwap.id,
      quoteAmount: agenSwap.quoteAmount,
      tokenAmount: agenSwap.tokenAmount,
      programmableFeePpm: agenSwap.programmableFeePpm,
    })
    .from(agenSwap)
    .where(
      and(
        eq(agenSwap.transactionHash, event.transaction.hash),
        eq(agenSwap.poolId, event.args.poolId),
        lt(agenSwap.logIndex, event.log.logIndex),
      ),
    )
    .orderBy(desc(agenSwap.logIndex))
    .limit(1);

  const row = rows[0];

  const chargedAfterTheSwap =
    row !== undefined &&
    row.programmableFeePpm === null &&
    row.quoteAmount === event.args.grossQuoteAmount &&
    row.tokenAmount === event.args.grossTokenAmount;

  if (chargedAfterTheSwap) {
    await context.db.update(agenSwap, { id: row.id }).set({
      programmableFeePpm: event.args.feePpm,
      feeAmount: event.args.feeAmount,
    });
    return;
  }

  /*
   * Parked for the swap that has not been indexed yet.
   *
   * Which is the `beforeSwap` case, and also the case where this pool's swaps are not being
   * followed at all — a market whose first trades predate the engine start block. The row is
   * harmless then: nothing claims it, and `claimPendingFee` is the only reader.
   */
  await context.db.insert(agenPendingFee).values({
    id: `${event.transaction.hash}-${String(event.log.logIndex)}`,
    poolId: event.args.poolId,
    transactionHash: event.transaction.hash,
    logIndex: event.log.logIndex,
    feePpm: event.args.feePpm,
    feeAmount: event.args.feeAmount,
  });
});

/**
 * The fee for a swap that was charged before the pool announced it.
 *
 * Called by the swap handler immediately after it writes a row, which is the other half of the
 * join described above. Returns what to record, or null when this swap paid no programmable fee
 * — which is every generated market's swap, and an engine swap too small to owe a base unit.
 *
 * The pending row is deleted as it is claimed, so each fee is attached exactly once and a
 * `agenPendingFee` table that is not empty at rest means a fee was emitted for a swap this
 * indexer never indexed.
 */
export async function claimPendingFee(
  { event, context }: Pick<SwapHandlerContext, "event" | "context">,
  poolId: Hex,
): Promise<{ programmableFeePpm: number; feeAmount: bigint } | null> {
  const pending = await context.db.sql
    .select({
      id: agenPendingFee.id,
      feePpm: agenPendingFee.feePpm,
      feeAmount: agenPendingFee.feeAmount,
    })
    .from(agenPendingFee)
    .where(
      and(
        eq(agenPendingFee.transactionHash, event.transaction.hash),
        eq(agenPendingFee.poolId, poolId),
        lt(agenPendingFee.logIndex, event.log.logIndex),
      ),
    )
    .orderBy(desc(agenPendingFee.logIndex))
    .limit(1);

  const fee = pending[0];
  if (fee === undefined) return null;

  await context.db.delete(agenPendingFee, { id: fee.id });

  return { programmableFeePpm: fee.feePpm, feeAmount: fee.feeAmount };
}
