#!/usr/bin/env node
/**
 * Checks the indexer's answers against the chain's.
 *
 * This is the point of the whole local rig. An indexer that runs without crashing
 * proves nothing: the failures that matter are the ones where it stores a plausible
 * wrong number, and the only way to catch those is to ask the contracts the same
 * questions and require the same answers.
 *
 * Three claims are checked, and they are the three that would each be a shipped bug:
 *
 *  1. **The key is right.** The pool id the indexer files a market under equals the
 *     one the SDK derives locally from the token address. If these disagreed, every
 *     market page would read an empty pool and the site would look like a chain with
 *     nothing on it.
 *
 *  2. **The derived fee is the contract's fee.** The API computes the active fee from
 *     the stored ladder using the SDK's schedule twin. The hook computes it in
 *     Solidity. Asked about the same instant, they must return the same ppm — for
 *     every market, including one that has already crossed a stage boundary.
 *
 *  3. **History is consistent with itself.** A market's swap count and volume are
 *     running totals maintained per event; the swap rows are the events. If the
 *     totals do not equal the sum of the rows, the aggregation is wrong, and that is
 *     invisible from either number alone.
 *
 * It also checks that the fee *changed*: the progressive market is traded on both
 * sides of a transition, so its two swaps must record two different rates. That is
 * the end-to-end version of V12 — the pool's stored fee never moves, so a swap
 * charged at the new rate proves the hook's override reached the trade and the
 * indexer recorded what was really paid.
 *
 * ## And the markets that are not quoted in ether
 *
 * The three claims above are asked of every market, and every one of them would pass
 * on a feed that had quietly assumed `currency0` is ether — because on most of the
 * rig's markets it is. So the last section of this file is about the one the seed
 * launches against a tokenized equity. It is checked by name rather than in the loop,
 * because "the stock-paired market is present and right" is a claim about a particular
 * market, and a loop over whatever the indexer happened to return cannot make it. If
 * that market failed to index at all, every check in the loop would still pass.
 *
 * ## Two of these markets were created by the SDK
 *
 * `scripts/indexer-proof.sh` launches two of them through `@verdant/sdk`, using the
 * same functions `apps/web` calls, and `apps/web/scripts/assert-sdk-launch.ts` checks
 * what they landed as. Nothing here treats them specially, which is the point: they
 * are held to every claim below exactly as the four Solidity-created ones are, so a
 * market the SDK built wrong would fail here as loudly as a market the factory built
 * wrong.
 *
 * Usage: node apps/indexer/scripts/assert-feed.ts
 * Environment: VERDANT_API, VERDANT_RPC, VERDANT_HOOK, VERDANT_MARKET_REGISTRY,
 *              VERDANT_MULTICALL3, VERDANT_EQUITY
 */

import { ROBINHOOD_MAINNET_ID } from "@verdant/config";
import { markets, pool, schedule } from "@verdant/sdk";
import { createPublicClient, defineChain, erc20Abi, http, type Address } from "viem";

const API = process.env.VERDANT_API ?? "http://127.0.0.1:42069";
const RPC = process.env.VERDANT_RPC ?? "http://127.0.0.1:8545";

function requireValue(name: string): string {
  const value = process.env[name];
  if (value === undefined) throw new Error(`${name} must be set`);
  return value;
}

function requireEnv(name: string): Address {
  return requireValue(name) as Address;
}

const HOOK = requireEnv("VERDANT_HOOK");
const MARKET_REGISTRY = requireEnv("VERDANT_MARKET_REGISTRY");

/**
 * The tokenized equity the rig launched its stock-paired market against.
 *
 * Required rather than optional, and the asset is asked for its own name, symbol and
 * decimals below rather than having them written here. An optional check is one that
 * gets skipped, and a literal `mNVDA` in this file would only prove that two strings
 * in this repository match each other — the claim worth making is that the indexer
 * repeated what the token says about itself.
 */
const EQUITY = requireEnv("VERDANT_EQUITY");

/**
 * How many markets the rig created, and which of them are not quoted in ether.
 *
 * Both were literals until the rig grew two SDK-launched markets, and both are
 * required rather than defaulted for the same reason the addresses above are: a
 * default is a check that silently stops discriminating. `4` written here would have
 * had to be edited to `6` anyway, and the next person to add a market would have
 * found a failure that named the wrong thing.
 *
 * The equity-quoted set is given as addresses rather than as a count, which is
 * strictly stronger: a feed that mislabelled *which* market was equity-quoted while
 * getting the total right would pass a count and fails this.
 */
const EXPECTED_MARKETS = Number(requireValue("VERDANT_EXPECTED_MARKETS"));

const EQUITY_QUOTED_TOKENS: readonly string[] = requireValue("VERDANT_EQUITY_QUOTED_TOKENS")
  .split(",")
  .map((entry) => entry.trim().toLowerCase())
  .filter((entry) => entry !== "");

/**
 * The launch token of the market quoted in that equity.
 *
 * Given, rather than found by looking for the market the indexer says is not
 * ether-quoted. Searching for it that way would take the indexer's word for the thing
 * under test: a feed that dropped the quote asset entirely would report four
 * ether-quoted markets, the search would come up empty, and the run would report a
 * missing market rather than a wrong one.
 */
const STOCK_TOKEN = requireEnv("VERDANT_STOCK_TOKEN");

/**
 * The chain, described well enough for the SDK's read layer to batch.
 *
 * `readMarket` issues one multicall rather than a dozen round trips, and viem finds
 * the batcher through the chain object. The address is passed in because the rig
 * deploys its own — anvil predeploys no Multicall3, and 4663 has the canonical one at
 * the usual place. Pointing the SDK at a rig-local batcher is what lets this check run
 * the same code the interface will, rather than a simplified stand-in for it.
 */
const chain = defineChain({
  id: ROBINHOOD_MAINNET_ID,
  name: "Verdant proof rig",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
  contracts: {
    multicall3: { address: requireEnv("VERDANT_MULTICALL3") },
  },
});

const client = createPublicClient({ chain, transport: http(RPC) });
const addresses = { hook: HOOK, marketRegistry: MARKET_REGISTRY };

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
  check(
    what,
    actual === expected,
    `expected ${String(expected)}, indexer said ${String(actual)}`,
  );
}

async function get(path: string): Promise<unknown> {
  const response = await fetch(`${API}${path}`);
  if (!response.ok) {
    throw new Error(`GET ${path} returned ${response.status}`);
  }
  return response.json();
}

interface ApiQuote {
  /** The zero address for ether, the equity's address otherwise. */
  asset: Address;
  symbol: string;
  name: string;
  decimals: number;
  isNative: boolean;
}

interface ApiMarket {
  poolId: `0x${string}`;
  token: Address;
  quote: ApiQuote;
  creator: Address;
  model: number;
  name: string;
  symbol: string;
  totalSupply: string;
  vesting: Address | null;
  splits: { creatorBps: number; protocolBps: number; reserveBps: number };
  schedule: { initTime: number; stages: readonly schedule.Stage[] };
  fee: {
    at: number;
    ppm: number;
    stageIndex: number;
    stageCount: number;
    nextTransitionAt: number | null;
    secondsToNextTransition: number | null;
  };
  activity: { swapCount: number; volumeQuote: string; volumeToken: string };
}

interface ApiSwap {
  buy: boolean;
  /** The signed deltas as v4 emitted them, kept so the derived side can be checked. */
  amount0: string;
  amount1: string;
  quoteAmount: string;
  tokenAmount: string;
  feePpm: number;
  timestamp: number;
}

interface ApiFees {
  collections: unknown[];
  claims: { recipient: Address; quoteAmount: string }[];
}

/**
 * The market that is not quoted in ether.
 *
 * Everything in the loop above is true of a feed that hardcodes `currency0` as ether,
 * because three of the rig's four markets are. These are the claims that are not, and
 * they are made against the equity itself: the rig deploys it, so it is the authority
 * on its own symbol, name and decimals, and the question worth asking is whether the
 * indexer repeated what that contract says.
 */
async function assertStockPaired(indexed: readonly ApiMarket[]): Promise<void> {
  console.log(`\nthe stock-paired market, quoted in ${EQUITY}`);

  const [equityName, equitySymbol, equityDecimals] = await client.multicall({
    allowFailure: false,
    contracts: [
      { address: EQUITY, abi: erc20Abi, functionName: "name" },
      { address: EQUITY, abi: erc20Abi, functionName: "symbol" },
      { address: EQUITY, abi: erc20Abi, functionName: "decimals" },
    ],
  });

  const stock = indexed.find(
    (entry) => entry.token.toLowerCase() === STOCK_TOKEN.toLowerCase(),
  );
  check(
    "the market the seed launched against that equity was indexed",
    stock !== undefined,
    `no market in the listing has token ${STOCK_TOKEN}`,
  );
  if (stock === undefined) return;

  console.log(`  it is ${stock.symbol} (${stock.poolId.slice(0, 10)}...)`);

  // 1. It is quoted in the equity, and describes it the way the equity describes
  //    itself. Decimals matter most: rendering an equity amount against ether's
  //    eighteen would be wrong by whatever the difference is, silently.
  check(
    "and it is not ether-quoted",
    !stock.quote.isNative,
    "the indexer reports it as quoted in ether, which is the assumption this market exists to break",
  );
  equal(
    "it is quoted in the equity the rig deployed",
    stock.quote.asset.toLowerCase(),
    EQUITY.toLowerCase(),
  );
  // Every market the rig quoted in the equity, and no others. A count would pass on a
  // feed that had swapped which market was equity-quoted; naming them does not.
  equal(
    "and the equity-quoted markets are exactly the ones the rig launched that way",
    indexed
      .filter((entry) => !entry.quote.isNative)
      .map((entry) => entry.token.toLowerCase())
      .sort()
      .join(","),
    [...EQUITY_QUOTED_TOKENS].sort().join(","),
  );
  equal("and reports the symbol that equity reports", stock.quote.symbol, equitySymbol);
  equal("and the name that equity reports", stock.quote.name, equityName);
  equal("and its decimals rather than ether's", stock.quote.decimals, equityDecimals);

  // 2. Its pool id comes from the pair. The second half of this is the check that
  //    matters: if the id were derived as though every market were ether-quoted, it
  //    would still be a well-formed pool id — just one belonging to a pool nobody
  //    ever initialised, which renders as a market with no price and no trades.
  equal(
    "its pool id is what the SDK derives from the equity and the token together",
    stock.poolId,
    pool.poolIdFor(stock.quote.asset, stock.token, HOOK),
  );
  check(
    "and is not the id it would have if its quote asset were assumed to be ether",
    stock.poolId !== pool.poolIdFor(pool.NATIVE_CURRENCY, stock.token, HOOK),
    "both derivations give the same id, so this rig cannot tell the two apart",
  );

  // 3. Its volume is the sum of its own trades, counted in the equity's smallest unit.
  const trades = (await get(`/markets/${stock.poolId}/swaps`)) as { swaps: ApiSwap[] };
  check(
    "it was traded, so there is something to sum",
    trades.swaps.length > 0,
    "no swap was recorded against it, and a sum of nothing agrees with anything",
  );
  equal(
    "and its quote volume is the sum of those trades, in the equity's own unit",
    stock.activity.volumeQuote,
    trades.swaps.reduce((total, row) => total + BigInt(row.quoteAmount), 0n).toString(),
  );

  // 4. Its fees moved, and they moved in the equity. A splitter for an equity-quoted
  //    market pays out with `transfer` rather than by sending value, which is a
  //    different code path from the one the other three markets exercise — so a claim
  //    of zero here would mean the equity side of the split silently never ran.
  const fees = (await get(`/markets/${stock.poolId}/fees`)) as ApiFees;
  check(
    "fees were collected from its locked position",
    fees.collections.length > 0,
    "nothing was collected, so nothing reached its splitter",
  );
  check(
    `and a claim paid out ${equitySymbol}, not ether`,
    !stock.quote.isNative && fees.claims.some((row) => BigInt(row.quoteAmount) > 0n),
    "every claim on the one market that is not ether-quoted was for zero",
  );
}

async function main(): Promise<void> {
  const listing = (await get("/markets")) as { at: number; markets: ApiMarket[] };

  console.log(`\nthe listing, at chain time ${listing.at}`);
  check("the indexer found markets", listing.markets.length > 0, "none indexed");

  // The rig creates a known number, one of each shape that indexes differently. A
  // different number means either a seed phase or the factory handler changed, and
  // both are worth stopping for.
  equal(
    `${EXPECTED_MARKETS} markets indexed, which is what the rig created`,
    listing.markets.length,
    EXPECTED_MARKETS,
  );

  const onChainCount = await markets.readMarketCount(client, addresses);
  equal("as many markets as the registry has", listing.markets.length, onChainCount);

  for (const entry of listing.markets) {
    console.log(`\n${entry.symbol} (${entry.poolId.slice(0, 10)}...)`);

    // 1. The key. Derived from the pair, because the quote asset is half of it: for
    // an equity-quoted market, deriving as though `currency0` were ether produces a
    // perfectly valid id for a pool that does not exist.
    equal(
      "the pool id is the one the SDK derives from the quote asset and the token",
      entry.poolId,
      pool.poolIdFor(entry.quote.asset, entry.token, HOOK),
    );

    // The chain's own record of the same market, read independently of the indexer.
    const snapshot = await markets.readMarket(client, addresses, {
      poolId: entry.poolId,
    });

    equal("token", entry.token.toLowerCase(), snapshot.market.token.toLowerCase());
    equal(
      "quote asset",
      entry.quote.asset.toLowerCase(),
      snapshot.market.quoteAsset.toLowerCase(),
    );

    // `isNative` is the API's own derivation, not a stored column, so it is worth
    // holding to the address it is derived from.
    check(
      "and calls itself ether-quoted exactly when that asset is the zero address",
      entry.quote.isNative === (entry.quote.asset === pool.NATIVE_CURRENCY),
      `isNative is ${String(entry.quote.isNative)} for quote asset ${entry.quote.asset}`,
    );

    if (entry.quote.isNative) {
      equal("an ether-quoted market names ether", entry.quote.symbol, "ETH");
      equal("with ether's own name", entry.quote.name, "Ether");
      equal("and ether's decimals", entry.quote.decimals, 18);
    }

    equal("creator", entry.creator.toLowerCase(), snapshot.market.creator.toLowerCase());
    equal("model", entry.model, snapshot.market.model);
    equal("name", entry.name, snapshot.token.name);
    equal("symbol", entry.symbol, snapshot.token.symbol);
    equal("total supply", entry.totalSupply, snapshot.token.totalSupply.toString());
    equal("creator share", entry.splits.creatorBps, snapshot.market.creatorBps);
    equal("protocol share", entry.splits.protocolBps, snapshot.market.protocolBps);
    equal("reserve share", entry.splits.reserveBps, snapshot.market.reserveBps);

    // A vesting contract exists exactly when the creator asked for one. The API says
    // null and the registry says the zero address; the SDK already turns that into
    // undefined, so the two sides of this check speak the same language.
    equal(
      "vesting contract",
      entry.vesting === null,
      snapshot.market.vesting === undefined,
    );

    // 2. The fee. Asked of the hook at the same instant the API used.
    equal("init time", entry.schedule.initTime, snapshot.schedule.initTime);
    equal("stage count", entry.fee.stageCount, snapshot.schedule.stages.length);

    const hookFee = await markets.readHookFee(
      client,
      addresses,
      entry.poolId,
      entry.fee.at,
    );
    equal("the fee the indexer derived is the fee the hook reports", entry.fee.ppm, hookFee);

    // And the same question about a future instant, which is the one a countdown is
    // really asking. A schedule that agreed only about now would still mislead
    // anybody deciding whether to wait.
    const later = entry.fee.at + 7 * 24 * 60 * 60;
    const config: schedule.ScheduleConfig = {
      model: entry.model,
      initTime: entry.schedule.initTime,
      stages: entry.schedule.stages,
    };
    const hookFeeLater = await markets.readHookFee(client, addresses, entry.poolId, later);
    equal(
      "and agrees about a week from now",
      schedule.feeAt(config, later),
      hookFeeLater,
    );

    // 3. History against its own totals.
    const trades = (await get(`/markets/${entry.poolId}/swaps`)) as {
      swaps: ApiSwap[];
    };

    equal("swap count matches the rows", entry.activity.swapCount, trades.swaps.length);

    const summedQuote = trades.swaps.reduce(
      (total, row) => total + BigInt(row.quoteAmount),
      0n,
    );
    const summedToken = trades.swaps.reduce(
      (total, row) => total + BigInt(row.tokenAmount),
      0n,
    );
    equal(
      "quote volume is the sum of the trades",
      entry.activity.volumeQuote,
      summedQuote.toString(),
    );
    equal("token volume is the sum of the trades", entry.activity.volumeToken, summedToken.toString());

    // The seed only ever buys — it pays the quote asset and receives tokens, on every
    // market, in both phases. So a swap recorded as a sell means the indexer read v4's
    // delta signs backwards, which it did until the interface displayed the result and
    // every buy on the page said "sell". Nothing above catches it: the volume checks
    // sum unsigned magnitudes, so an inverted side is invisible in every total.
    check(
      "every trade is recorded as a buy, which is all the seed does",
      trades.swaps.every((row) => row.buy),
      `${trades.swaps.filter((row) => !row.buy).length} of ${trades.swaps.length} recorded as sells`,
    );
    check(
      "and the signed delta agrees with that side",
      trades.swaps.every((row) => BigInt(row.amount0) < 0n && BigInt(row.amount1) > 0n),
      "a buy must show the trader paying currency0 and receiving currency1",
    );

    check(
      "every trade was charged the rate the schedule was on",
      trades.swaps.every((row) => row.feePpm === schedule.feeAt(config, row.timestamp)),
      trades.swaps
        .map((row) => `${row.timestamp}: charged ${row.feePpm}, schedule says ${schedule.feeAt(config, row.timestamp)}`)
        .join("; "),
    );

    // The market with a ladder is the one that proves the override reached a trade.
    if (entry.fee.stageCount > 1) {
      const rates = new Set(trades.swaps.map((row) => row.feePpm));
      check(
        "a laddered market was charged two different rates across its transition",
        rates.size > 1,
        `every trade paid ${[...rates].join(", ")} — the schedule never took effect`,
      );
      check(
        "the market has moved past its first stage",
        entry.fee.stageIndex > 0,
        `still on stage ${entry.fee.stageIndex}`,
      );

      // And has a stage still ahead of it, so the countdown an interface renders from
      // `nextTransitionAt` is exercised by the rig rather than only by production.
      check(
        "a laddered market still has a transition ahead",
        entry.fee.nextTransitionAt !== null && entry.fee.secondsToNextTransition !== null,
        "nothing left to count down to; the seed's last stage is already in force",
      );
      check(
        "and the countdown agrees with the timestamp it counts to",
        entry.fee.nextTransitionAt !== null &&
          entry.fee.secondsToNextTransition === entry.fee.nextTransitionAt - entry.fee.at,
        `${entry.fee.secondsToNextTransition} does not match ${entry.fee.nextTransitionAt} minus ${entry.fee.at}`,
      );
    }

    // Fees collected and claimed, from the settle phase.
    const fees = (await get(`/markets/${entry.poolId}/fees`)) as ApiFees;
    check("fees were collected from the locked position", fees.collections.length > 0);
    check("and a recipient claimed a share", fees.claims.length > 0);
    check(
      "the claim paid out the quote asset",
      fees.claims.some((row) => BigInt(row.quoteAmount) > 0n),
      "every claim was for zero, so the split moved nothing",
    );
  }

  await assertStockPaired(listing.markets);

  console.log(`\n${checks - failures}/${checks} checks passed`);

  if (failures > 0) {
    console.error(
      `\n${failures} check(s) failed. The indexer and the chain disagree, which means ` +
        `something the interface would show is wrong.`,
    );
    process.exit(1);
  }

  console.log("the feed agrees with the chain.\n");
}

await main();
