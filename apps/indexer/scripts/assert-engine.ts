#!/usr/bin/env node
/**
 * Checks the engine-v1 half of the feed against the chain's own account of it.
 *
 * ## Why this file had to exist before anything could launch
 *
 * `ponder.on("AgenEngineFactory:EngineMarketDeployed")` had never executed. Not in a test, not
 * on a rig, not anywhere — the handler was written, reviewed and typechecked against a chain
 * that had no engine markets on it. That is the one shape of bug this whole rig exists for: an
 * indexer given a factory that never emits produces no rows and no errors, reports healthy, and
 * serves an empty API. It is indistinguishable from a chain where nothing happened.
 *
 * So every claim below is made against the chain rather than against the indexer's own
 * consistency. The market's identity is checked against the launch event and the registry, the
 * fee on every trade against the hook's `FeeTaken`, the amounts against the PoolManager's
 * `Swap`, and the total against the vault's own balance sheet. An indexer that agreed with
 * itself and disagreed with all four would fail here on every line.
 *
 * ## The fee is the interesting one
 *
 * An engine market's fee is invisible in Uniswap's `Swap` event. The hook sets the pool's LP fee
 * to zero and takes Agen's as a swap delta, so the pool honestly reports charging nothing — and
 * a feed reading only Uniswap shows every engine trade as free. This asserts both halves of
 * that: the pool really did report zero, *and* the indexer really did record the rate the hook
 * emitted. Either assertion alone would pass on the broken version.
 *
 * ## What it is held to
 *
 * `AGEN_ENGINE_PROOF_OUTPUT` names the file the launch phase of
 * `apps/agen/src/app/lib/engine-chain-proof.test.ts` wrote, which is the market's identity as
 * the app understood it at launch. Nothing here trusts it as an authority: it supplies the pool
 * id and the transaction hashes to *look up*, and every value is then compared against a read of
 * the chain. What it does prove, being written by the app, is that the app and the indexer are
 * describing the same market.
 *
 * Usage: node apps/indexer/scripts/assert-engine.ts
 * Environment: VERDANT_API, VERDANT_RPC, VERDANT_POOL_MANAGER, AGEN_ENGINE_HOOK,
 *              AGEN_ENGINE_REGISTRY, AGEN_ENGINE_PROOF_OUTPUT
 */

import { readFileSync } from "node:fs";

import { ROBINHOOD_MAINNET_ID } from "@verdant/config";
import { configHash, decodeConfig, encodeConfig } from "@verdant/market-engine";
import { abi } from "@verdant/sdk";
import {
  createPublicClient,
  defineChain,
  erc20Abi,
  getAbiItem,
  http,
  keccak256,
  type Address,
  type Hex,
} from "viem";

const API = process.env.VERDANT_API ?? "http://127.0.0.1:42069";
const RPC = process.env.VERDANT_RPC ?? "http://127.0.0.1:8555";

function requireValue(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") throw new Error(`${name} must be set`);
  return value.trim();
}

function requireEnv(name: string): Address {
  return requireValue(name) as Address;
}

const POOL_MANAGER = requireEnv("VERDANT_POOL_MANAGER");
const ENGINE_HOOK = requireEnv("AGEN_ENGINE_HOOK");
const ENGINE_REGISTRY = requireEnv("AGEN_ENGINE_REGISTRY");

const NATIVE = "0x0000000000000000000000000000000000000000";

// --- what the launch phase recorded ----------------------------------------

interface ProofTrade {
  readonly kind: "buy" | "sell";
  /** `pool` for the rig's bare router, `router` for `AgenRouter` — the product's own route. */
  readonly via: "pool" | "router";
  readonly txHash: Hex;
  readonly blockNumber: string;
  readonly feePpm: number;
  readonly feeAmount: string;
  readonly grossQuoteAmount: string;
  readonly grossTokenAmount: string;
  readonly quoteAmount: string;
  readonly tokenAmount: string;
  readonly poolReportedFeePpm: number;
  readonly sender: Address;
}

interface Proof {
  readonly jobId: string;
  readonly creator: Address;
  readonly token: Address;
  readonly poolId: Hex;
  readonly vault: Address;
  readonly hook: Address;
  readonly quoteAsset: Address;
  readonly configHash: Hex;
  readonly implementationHash: Hex;
  readonly encodedConfig: Hex;
  readonly marketIndex: string;
  readonly launchTx: Hex;
  readonly launchBlock: string;
  readonly lpFee: number;
  readonly tickSpacing: number;
  readonly vaultCurrency: Address;
  readonly vaultTotalAccrued: string;
  readonly router: Address;
  readonly trades: readonly ProofTrade[];
}

const proof = JSON.parse(readFileSync(requireValue("AGEN_ENGINE_PROOF_OUTPUT"), "utf8")) as Proof;

// --- what the API returns --------------------------------------------------

interface ApiEngineMarket {
  poolId: Hex;
  index: number;
  token: Address;
  hook: Address;
  creator: Address;
  quoteAsset: Address;
  fee: number;
  tickSpacing: number;
  name: string;
  symbol: string;
  decimals: number;
  totalSupply: string;
  specificationHash: Hex;
  implementationHash: Hex;
  engine: {
    version: number;
    hash: Hex;
    config: Hex | null;
    vault: Address;
    feeCurrency: Address;
  };
  locker: Address;
  supplyLocked: string;
  createdAtBlock: string;
  createdTx: Hex;
  price: string;
  launchPrice: string;
  swapCount: number;
  volumeQuote: string;
  volumeToken: string;
  components?: readonly { address: Address; role: string; codeHash: Hex }[];
}

interface ApiEngineSwap {
  id: string;
  sender: Address;
  buy: boolean;
  quoteAmount: string;
  tokenAmount: string;
  price: string;
  feePpm: number;
  feeAmount: string | null;
  timestamp: number;
  transactionHash: Hex;
}

const chain = defineChain({
  id: ROBINHOOD_MAINNET_ID,
  name: "Agen engine proof rig",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});

const client = createPublicClient({ chain, transport: http(RPC) });

let failures = 0;
let checks = 0;

function check(what: string, condition: boolean, detail?: string): void {
  checks++;
  if (condition) {
    console.log(`  ok   ${what}`);
    return;
  }
  failures++;
  console.error(`  FAIL ${what}${detail === undefined ? "" : `: ${detail}`}`);
}

function equal(what: string, actual: unknown, expected: unknown): void {
  check(what, actual === expected, `expected ${String(expected)}, the feed said ${String(actual)}`);
}

/** Addresses and hashes compared without regard to case, which JSON does not normalise. */
function same(what: string, actual: string | null | undefined, expected: string): void {
  check(
    what,
    (actual ?? "").toLowerCase() === expected.toLowerCase(),
    `expected ${expected}, the feed said ${String(actual)}`,
  );
}

async function get(path: string): Promise<unknown> {
  const response = await fetch(`${API}${path}`);
  if (!response.ok) throw new Error(`GET ${path} returned ${String(response.status)}`);
  return response.json();
}

// --- the chain's own account of this market --------------------------------

const FEE_TAKEN = getAbiItem({ abi: abi.agenEngineHookAbi, name: "FeeTaken" });
const SWAP = getAbiItem({ abi: abi.poolManagerAbi, name: "Swap" });

async function main(): Promise<void> {
  console.log(`\nthe engine market ${proof.poolId}`);
  console.log(`  launched in ${proof.launchTx} at block ${proof.launchBlock}\n`);

  const from = BigInt(proof.launchBlock);

  /*
   * The hook's own fee events, and the pool's own swaps, read from the chain.
   *
   * These are the authority for everything below. Reading them here rather than taking the
   * launch phase's word for them means this script would catch a proof file that had drifted
   * from the chain as readily as an indexer that had.
   */
  const [feeLogs, swapLogs] = await Promise.all([
    client.getLogs({
      address: ENGINE_HOOK,
      event: FEE_TAKEN,
      args: { poolId: proof.poolId },
      fromBlock: from,
      toBlock: "latest",
    }),
    client.getLogs({
      address: POOL_MANAGER,
      event: SWAP,
      args: { id: proof.poolId },
      fromBlock: from,
      toBlock: "latest",
    }),
  ]);

  // How many trades the launch phase made, rather than a number written here: the rig trades
  // through two different routers and a count in this file would have to be edited in step.
  const expectedTrades = proof.trades.length;

  console.log("what the chain says");
  equal(`the hook charged this market ${String(expectedTrades)} times`, feeLogs.length, expectedTrades);
  equal(`the pool recorded ${String(expectedTrades)} swaps`, swapLogs.length, expectedTrades);

  if (feeLogs.length !== expectedTrades || swapLogs.length !== expectedTrades) {
    console.error(
      "\nthe chain does not have the trades this proof is about, so there is nothing to hold " +
        "the indexer to. The launch phase did not complete against this chain.",
    );
    process.exit(1);
  }

  /*
   * At least one trade took the route a real trade takes.
   *
   * Everything below would pass on a rig that only ever swapped through a bare test router,
   * which is what it did until `AgenRouter` was added to the launch phase — and `AgenRouter` is
   * the contract the token page's trade panel calls. Checked against the chain's own `sender`
   * rather than against the proof's label, so a mislabelled trade fails here.
   */
  const throughRouter = swapLogs.filter(
    (log) => (log.args.sender ?? "").toLowerCase() === proof.router.toLowerCase(),
  );
  check(
    "some of those swaps came through AgenRouter, which is what the product calls",
    throughRouter.length >= 2,
    `${String(throughRouter.length)} of ${String(swapLogs.length)} name ${proof.router}`,
  );

  /*
   * The claim that makes the fee handler load-bearing.
   *
   * Every engine swap's `fee` field is zero, because the hook zeroes the pool's LP fee and
   * takes its own as a delta. So an indexer inferring the rate from Uniswap has exactly one
   * answer available to it — nothing — and any non-zero rate in the feed came from `FeeTaken`.
   */
  for (const log of swapLogs) {
    equal(
      `the pool reported no fee on ${log.transactionHash.slice(0, 10)} (so the rate cannot be inferred)`,
      log.args.fee,
      0,
    );
  }

  // Paired by transaction, which is how the indexer has to pair them too, and flattened into
  // a shape with no optional fields — viem types every event argument as possibly absent, and
  // an assertion written against `undefined` would compare two nothings and pass.
  const chainTrades = feeLogs.map((fee) => {
    const swap = swapLogs.find((entry) => entry.transactionHash === fee.transactionHash);
    if (swap === undefined) {
      throw new Error(`no Swap event accompanies the FeeTaken in ${String(fee.transactionHash)}`);
    }

    const trade = {
      txHash: fee.transactionHash,
      isBuy: fee.args.isBuy,
      feePpm: fee.args.feePpm,
      feeAmount: fee.args.feeAmount,
      grossQuoteAmount: fee.args.grossQuoteAmount,
      amount0: swap.args.amount0,
      amount1: swap.args.amount1,
      sender: swap.args.sender,
    };

    for (const [field, value] of Object.entries(trade)) {
      if (value === undefined || value === null) {
        throw new Error(`the events in ${String(fee.transactionHash)} carry no ${field}`);
      }
    }

    return trade as { [K in keyof typeof trade]-?: NonNullable<(typeof trade)[K]> };
  });

  // --- the market, as the launch event and the chain describe it ----------

  const [registryRecord, feeCurrencyKind, onchainSupply, name, symbol, decimals, accrued] =
    await Promise.all([
      client.readContract({
        abi: abi.agenMarketRegistryAbi,
        address: ENGINE_REGISTRY,
        functionName: "marketByToken",
        args: [proof.token],
      }),
      client.readContract({
        abi: abi.agenEngineHookAbi,
        address: ENGINE_HOOK,
        functionName: "feeCurrencyOf",
        args: [proof.poolId],
      }),
      client.readContract({ abi: erc20Abi, address: proof.token, functionName: "totalSupply" }),
      client.readContract({ abi: erc20Abi, address: proof.token, functionName: "name" }),
      client.readContract({ abi: erc20Abi, address: proof.token, functionName: "symbol" }),
      client.readContract({ abi: erc20Abi, address: proof.token, functionName: "decimals" }),
      client.readContract({
        abi: abi.agenEngineVaultAbi,
        address: proof.vault,
        functionName: "totalAccrued",
      }),
    ]);

  // Zero is `FeeCurrency.Quote`, which for this market is native ether. Resolved on chain
  // rather than assumed, because it is what the indexer claims to have resolved.
  const expectedFeeCurrency = feeCurrencyKind === 0 ? registryRecord.quoteAsset : proof.token;

  // --- the listing --------------------------------------------------------

  console.log("\nthe listing at /agen/markets");

  const listing = (await get("/agen/markets?limit=200")) as {
    markets: readonly ApiEngineMarket[];
    total: number;
  };

  const listed = listing.markets.find(
    (entry) => entry.poolId.toLowerCase() === proof.poolId.toLowerCase(),
  );

  if (listed === undefined) {
    console.error(
      `  FAIL the launched engine market is not in the listing at all.\n\n` +
        `  ${String(listing.markets.length)} market(s) are, and none of them is ${proof.poolId}.\n` +
        `  The engine market handler did not run for this launch. Either AGEN_ENGINE_FACTORY is\n` +
        `  not the factory that emitted EngineMarketDeployed, or the engine start block is past\n` +
        `  block ${proof.launchBlock}, or the handler is not registered at all.`,
    );
    process.exit(1);
  }

  check("the launched engine market is in the listing", true);
  equal("it is an engine-1 market, and says so rather than being guessed at", listed.engine.version, 1);
  same("its token is the one the factory deployed", listed.token, proof.token);
  same("its pool is the one the factory opened", listed.poolId, proof.poolId);
  same("its quote asset is native ether", listed.quoteAsset, NATIVE);
  same("its quote asset is what the registry recorded", listed.quoteAsset, registryRecord.quoteAsset);
  same("its creator is the wallet that launched it", listed.creator, proof.creator);
  same("its creator is what the registry recorded", listed.creator, registryRecord.creator);
  same("its hook is the shared engine hook", listed.hook, ENGINE_HOOK);
  equal("its index is the registry's", String(listed.index), proof.marketIndex);

  // From the pool's own Initialize event, which is the half of the launch that comes from
  // Uniswap rather than from Agen. Wrong here would mean a market with no price.
  equal("its pool fee is the dynamic-fee flag", listed.fee, proof.lpFee);
  equal("its tick spacing is Agen's grid", listed.tickSpacing, proof.tickSpacing);
  check("it has an opening price", Number(listed.launchPrice) > 0, `launchPrice ${listed.launchPrice}`);
  check("it has a current price", Number(listed.price) > 0, `price ${listed.price}`);

  console.log("\nthe commitments and the configuration");
  same("its configuration hash is the one the creator approved", listed.engine.hash, proof.configHash);
  same(
    "its implementation hash is the one the factory recomputed",
    listed.implementationHash,
    proof.implementationHash,
  );
  same(
    "its specification hash is the registry's",
    listed.specificationHash,
    registryRecord.specificationHash,
  );

  /*
   * The configuration bytes, which are the reason an engine market is legible without its
   * prompt. The indexer decodes them from the launch calldata and refuses to store them unless
   * they hash to the commitment the hook derived — so bytes here have been proved, and this
   * checks the proof rather than repeating it.
   */
  const stored = listed.engine.config;
  check("its configuration was decoded from the launch calldata", stored !== null);

  if (stored !== null) {
    same("those bytes are byte-for-byte what the app encoded", stored, proof.encodedConfig);
    same("those bytes hash to the market's commitment", keccak256(stored), proof.configHash);

    // Legible, not merely present: the engine's own decoder reads it back and re-encodes to the
    // same bytes, which is what a market page and a verifier both depend on.
    const decoded = decodeConfig(stored, {
      launchedTokenSymbol: listed.symbol,
      quoteAssetSymbol: "ETH",
      quoteAssetDecimals: 18,
    });
    same("the engine can read those bytes back", encodeConfig(decoded), stored);
    same("and derives the same commitment from them", configHash(decoded), proof.configHash);
  }

  console.log("\nthe vault and the fee currency");
  same("its vault is the one the launch event named", listed.engine.vault, proof.vault);
  same("its fee currency is what the hook derived", listed.engine.feeCurrency, expectedFeeCurrency);
  same("which for an untiered market is the quote asset", listed.engine.feeCurrency, NATIVE);

  console.log("\nthe token, as the token describes itself");
  equal("its name", listed.name, name);
  equal("its symbol", listed.symbol, symbol);
  equal("its decimals", listed.decimals, decimals);
  equal("its total supply", listed.totalSupply, onchainSupply.toString());
  equal("the whole supply is locked, which is what an engine launch does", listed.supplyLocked, onchainSupply.toString());

  console.log("\nthe launch transaction");
  same("it is filed under the transaction that created it", listed.createdTx, proof.launchTx);
  equal("in the block that transaction landed in", listed.createdAtBlock, proof.launchBlock);

  // --- the market page's own route ----------------------------------------

  console.log("\nthe market at /agen/markets/:id");

  const detail = (await get(`/agen/markets/${proof.poolId}`)) as ApiEngineMarket;
  same("the pool id resolves to this market", detail.poolId, proof.poolId);

  const byToken = (await get(`/agen/markets/${proof.token}`)) as ApiEngineMarket;
  same("and so does the token address", byToken.poolId, proof.poolId);

  const components = detail.components ?? [];
  check(
    "the market's components include its vault",
    components.some((entry) => entry.address.toLowerCase() === proof.vault.toLowerCase()),
    `${String(components.length)} component(s): ${components.map((entry) => entry.address).join(", ")}`,
  );

  // --- the trades ---------------------------------------------------------

  console.log("\nthe trades at /agen/markets/:id/swaps");

  const swaps = (await get(`/agen/markets/${proof.poolId}/swaps?limit=50`)) as {
    poolId: Hex;
    swaps: readonly ApiEngineSwap[];
  };

  equal("every trade is in the feed", swaps.swaps.length, expectedTrades);

  for (const trade of chainTrades) {
    // Named by route as well as by side, since there are two of each and a failure that said
    // only "the buy" would not say which one.
    const route =
      trade.sender.toLowerCase() === proof.router.toLowerCase() ? "the routed" : "the bare";
    const label = `${route} ${trade.isBuy ? "buy" : "sell"}`;
    const indexed = swaps.swaps.find(
      (entry) => entry.transactionHash.toLowerCase() === trade.txHash.toLowerCase(),
    );

    if (indexed === undefined) {
      check(`${label} is in the feed`, false, `no row for ${trade.txHash}`);
      continue;
    }

    check(`${label} is in the feed`, true);
    equal(`${label} is on the right side`, indexed.buy, trade.isBuy);
    same(`${label}'s sender is the account that called the pool`, indexed.sender, trade.sender);

    // The legs, from the pool's own deltas. `amount0` is the quote asset because native ether
    // sorts below every token, which is what makes this pairing unambiguous.
    const quote = trade.amount0 < 0n ? -trade.amount0 : trade.amount0;
    const token = trade.amount1 < 0n ? -trade.amount1 : trade.amount1;
    equal(`${label}'s quote leg`, indexed.quoteAmount, quote.toString());
    equal(`${label}'s token leg`, indexed.tokenAmount, token.toString());

    /*
     * The rate, from the hook rather than from the pool.
     *
     * The pool said zero — checked above, on chain — so a feed that matched `FeeTaken` here is
     * a feed that ran the `AgenEngineHook:FeeTaken` handler and attached its numbers to the
     * right swap row. This is the assertion that fails when that handler is not reached.
     */
    equal(`${label}'s fee rate is the one the hook charged`, indexed.feePpm, trade.feePpm);
    equal(
      `${label}'s fee amount is what the hook took`,
      indexed.feeAmount,
      trade.feeAmount.toString(),
    );
    check(
      `${label}'s rate is not the pool's zero`,
      indexed.feePpm > 0,
      `the feed reports ${String(indexed.feePpm)} ppm`,
    );

    /*
     * And the rate is the rate *of these amounts*, not a number carried alongside them.
     *
     * The fee is taken from the leg denominated in the fee currency — the quote leg for this
     * market — by integer division. Recomputing it from the gross the hook measured catches a
     * feed that had paired a real rate with another trade's amounts.
     */
    const effective = (trade.grossQuoteAmount * BigInt(indexed.feePpm)) / 1_000_000n;
    equal(
      `${label}'s fee is that rate applied to its own gross`,
      indexed.feeAmount,
      effective.toString(),
    );
  }

  console.log("\nthe totals");

  const indexedQuote = swaps.swaps.reduce((total, entry) => total + BigInt(entry.quoteAmount), 0n);
  const indexedToken = swaps.swaps.reduce((total, entry) => total + BigInt(entry.tokenAmount), 0n);
  const indexedFees = swaps.swaps.reduce(
    (total, entry) => total + BigInt(entry.feeAmount ?? "0"),
    0n,
  );

  equal("the market's swap count is the number of swaps", detail.swapCount, swaps.swaps.length);
  equal("its quote volume is the sum of its trades", detail.volumeQuote, indexedQuote.toString());
  equal("its token volume is the sum of its trades", detail.volumeToken, indexedToken.toString());

  /*
   * The strongest of these, and the reason the vault is read at all: the fees the feed reports
   * add up to money that actually moved. A feed reporting plausible rates against amounts
   * nobody was charged would pass every assertion above and fail this one.
   */
  equal(
    "the fees the feed reports are the fees the vault holds",
    indexedFees.toString(),
    accrued.toString(),
  );
  equal("which is what the launch phase measured", accrued.toString(), proof.vaultTotalAccrued);

  console.log(
    `\n${String(checks - failures)} of ${String(checks)} checks passed against the chain.`,
  );

  if (failures > 0) {
    console.error(`\n${String(failures)} check(s) failed. The engine feed is not correct.`);
    process.exit(1);
  }

  console.log("the engine feed agrees with the contracts.\n");
}

await main();
