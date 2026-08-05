#!/usr/bin/env node
/**
 * What the trade panel asks the chain for, and what the chain says back.
 *
 * A twin of `diagnose-launch.ts`, written for the same class of report: buying and
 * selling "do not work", with no error anybody can quote. That has several possible
 * causes and they are told apart from outside the browser — the quoter reverts, the
 * router reverts, the account cannot pay, or the wallet cannot handle the chain. This
 * prints the first three so the fourth is a conclusion rather than a guess.
 *
 * It signs nothing and sends nothing. Every call below is a simulation or a read.
 *
 * Usage:  node apps/web/scripts/diagnose-trade.ts
 * Environment: VERDANT_MARKET (pool id or token address, default the newest market),
 *              VERDANT_FROM (the address to simulate from), VERDANT_RPC,
 *              VERDANT_SPEND (ether to spend on a buy, default 0.0005),
 *              VERDANT_FEED (the indexer, for reading the market)
 */

import {
  EXTERNAL_ADDRESSES,
  ROBINHOOD_MAINNET_ID,
  deploymentFor,
  type VerdantDeployment,
} from "@verdant/config";
import { pool, trade } from "@verdant/sdk";
import {
  createPublicClient,
  erc20Abi,
  formatEther,
  formatUnits,
  http,
  isAddress,
  parseEther,
  type Address,
  type Hex,
} from "viem";

/**
 * What the quoter was actually told, as opposed to what it says.
 *
 * `V4Quoter` catches the pool's revert and re-throws it wrapped in
 * `UnexpectedRevertBytes(bytes)`, so every failure arrives under one selector —
 * `0x6190b2b0` — with the real reason as an argument nobody unwraps. An interface that
 * prints the outer error is guessing, which is how "a trade larger than the pool's
 * liquidity is the usual reason" ends up under a failure that has nothing to do with
 * liquidity.
 *
 * The inner bytes are their own selector and arguments, so this pulls them out and looks
 * them up in the same table `find-selector.mjs` builds.
 */
function unwrap(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);

  // viem prints the raw data it received; the inner call's revert is inside it.
  const wrapped = /0x6190b2b0([0-9a-f]*)/i.exec(text);
  if (wrapped?.[1] === undefined) return text.split("\n")[0] ?? text;

  const payload = wrapped[1];
  // abi.encode(bytes): offset, length, then the bytes themselves, right-padded.
  const length = Number.parseInt(payload.slice(64, 128), 16);
  if (!Number.isFinite(length) || length === 0) {
    return "the pool reverted with no reason at all";
  }

  const inner = `0x${payload.slice(128, 128 + length * 2)}` as Hex;
  return `inner revert ${inner.slice(0, 10)}  (full: ${inner})`;
}

function mainnetDeployment(): VerdantDeployment {
  const found = deploymentFor(ROBINHOOD_MAINNET_ID);
  if (found === null) throw new Error("Robinhood mainnet has no recorded deployment");
  return found;
}

const deployment = mainnetDeployment();

const RPC = process.env["VERDANT_RPC"]?.trim() ?? "https://rpc.mainnet.chain.robinhood.com";
const FEED =
  process.env["VERDANT_FEED"]?.trim() ?? "https://indexer-production-2c72.up.railway.app";

const from = process.env["VERDANT_FROM"]?.trim();
if (from === undefined || !isAddress(from)) {
  throw new Error("VERDANT_FROM must be the address to simulate the trade from");
}
const trader = from as Address;

const spend = parseEther(process.env["VERDANT_SPEND"]?.trim() ?? "0.0005");

const client = createPublicClient({ transport: http(RPC) });

interface FeedMarket {
  readonly poolId: `0x${string}`;
  readonly token: `0x${string}`;
  readonly symbol: string;
  readonly quote: { readonly asset: `0x${string}`; readonly symbol: string };
  readonly fee: { readonly ppm: number };
  readonly liquidity: string;
}

async function readMarket(): Promise<FeedMarket> {
  const wanted = process.env["VERDANT_MARKET"]?.trim();
  if (wanted !== undefined && wanted !== "") {
    const response = await fetch(`${FEED}/markets/${wanted}`);
    if (!response.ok) throw new Error(`the feed answered ${response.status} for ${wanted}`);
    return (await response.json()) as FeedMarket;
  }

  const response = await fetch(`${FEED}/markets?limit=1`);
  if (!response.ok) throw new Error(`the feed answered ${response.status}`);
  const body = (await response.json()) as { markets: readonly FeedMarket[] };
  const [first] = body.markets;
  if (first === undefined) throw new Error("the feed knows of no markets");
  return first;
}

async function main(): Promise<void> {
  const chainId = await client.getChainId();
  const balance = await client.getBalance({ address: trader });
  const block = await client.getBlock();
  const market = await readMarket();

  console.log("\nthe chain, and the account the trade would come from");
  console.log(`  chain id                 ${chainId}`);
  console.log(`  head                     ${block.number}`);
  console.log(`  ${trader}`);
  console.log(`  balance                  ${formatEther(balance)} ETH`);

  console.log("\nthe market");
  console.log(`  ${market.symbol}  ${market.token}`);
  console.log(`  pool                     ${market.poolId}`);
  console.log(`  quoted in                ${market.quote.symbol} (${market.quote.asset})`);
  console.log(`  fee now                  ${market.fee.ppm / 10_000}%`);
  console.log(`  liquidity                ${market.liquidity}`);

  const poolKey = pool.poolKeyFor(market.quote.asset, market.token, deployment.hook);
  console.log("\nthe pool key the interface builds");
  console.log(`  currency0                ${poolKey.currency0}`);
  console.log(`  currency1                ${poolKey.currency1}`);
  console.log(`  fee                      ${poolKey.fee}`);
  console.log(`  tickSpacing              ${poolKey.tickSpacing}`);
  console.log(`  hooks                    ${poolKey.hooks}`);

  // --- the quote, which is what decides whether the panel offers a trade at all ---

  console.log("\nwhat the quoter says about buying");
  let amountOut: bigint;
  try {
    const answer = await trade.quoteExactIn(client, {
      quoter: EXTERNAL_ADDRESSES.v4Quoter as Address,
      poolKey,
      zeroForOne: true,
      exactAmount: spend,
    });
    amountOut = answer.amountOut;
    console.log(`  spending                 ${formatEther(spend)} ETH`);
    console.log(`  quoteExactInputSingle    ${amountOut} ${market.symbol} base units`);
  } catch (error) {
    console.log(`  quoteExactInputSingle    REVERTS: ${(error as Error).message.split("\n")[0]}`);
    console.log(
      "\nthe panel never offers a trade it has no quote for, so this is the whole failure.\n",
    );
    return;
  }

  if (amountOut === 0n) {
    console.log("\nthe quote is zero, so there is nothing to buy at this size.\n");
    return;
  }

  // --- the swap itself, from the address that would send it ---

  const call = trade.buildSwap({
    router: EXTERNAL_ADDRESSES.universalRouter as Address,
    poolKey,
    zeroForOne: true,
    amountIn: spend,
    // The floor the panel would set at one per cent, which is its default.
    minAmountOut: (amountOut * 9_900n) / 10_000n,
    recipient: trader,
  });

  console.log("\nthe transaction the wallet is handed");
  console.log(`  to                       ${call.to}`);
  console.log(`  value                    ${formatEther(call.value)} ETH`);
  console.log(`  calldata                 ${(call.data.length - 2) / 2} bytes`);

  console.log("\nwhat the chain says");
  try {
    await client.call({ account: trader, to: call.to, data: call.data, value: call.value });
    console.log("  eth_call                 succeeds: the swap does not revert");
  } catch (error) {
    console.log(`  eth_call                 REVERTS: ${(error as Error).message.split("\n")[0]}`);
    console.log("\nthis is ours to fix, not the wallet's.\n");
    return;
  }

  try {
    const gas = await client.estimateGas({
      account: trader,
      to: call.to,
      data: call.data,
      value: call.value,
    });
    const fee = gas * (block.baseFeePerGas ?? 0n);
    console.log(`  eth_estimateGas          ${gas}`);
    console.log(`  at the current base fee  ~${formatEther(fee)} ETH`);
    console.log(
      `  the account can pay      ${balance >= fee + call.value ? "yes" : `NO: it holds ${formatEther(balance)} ETH`}`,
    );
    console.log(
      "\nthe chain accepts this swap and prices it. A wallet that cannot sign it is\n" +
        "failing on its own side.\n",
    );
  } catch (error) {
    console.log(`  eth_estimateGas          FAILED: ${(error as Error).message.split("\n")[0]}`);
  }

  await sell(market, poolKey);
}

/**
 * The other direction, which is the one being reported as broken.
 *
 * Selling is not the mirror of buying on a market that opened one-sided. The locked
 * position holds only the token above the launch tick, so the ether a sell is paid in is
 * whatever previous buyers put in — and a sale larger than that has nothing to be filled
 * against however much of the token the seller holds.
 */
async function sell(market: FeedMarket, poolKey: ReturnType<typeof pool.poolKeyFor>) {
  const held = await client.readContract({
    address: market.token,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [trader],
  });

  console.log("\nwhat the quoter says about selling");
  console.log(`  the account holds        ${formatUnits(held, 18)} ${market.symbol}`);

  if (held === 0n) {
    console.log("  nothing to sell from this address.\n");
    return;
  }

  /*
   * A ladder in absolute tokens rather than in shares of the balance.
   *
   * Shares were the wrong unit: on a market that has taken one small first buy, one per
   * cent of a creator's allocation is already far more than the pool could ever pay for,
   * so every rung failed and the ladder said nothing about where the edge is. What
   * matters is the smallest size that works, because that is the number a seller needs.
   */
  const whole = 10n ** 18n;
  const sizes = [
    1_000n * whole,
    10_000n * whole,
    100_000n * whole,
    250_000n * whole,
    500_000n * whole,
    1_000_000n * whole,
    held,
  ];

  for (const amount of sizes) {
    if (amount === 0n || amount > held) continue;
    const share = (amount * 10_000n) / held;

    try {
      const answer = await trade.quoteExactIn(client, {
        quoter: EXTERNAL_ADDRESSES.v4Quoter as Address,
        poolKey,
        // Selling the launch token, which is always currency1.
        zeroForOne: false,
        exactAmount: amount,
      });
      console.log(
        `  ${formatUnits(amount, 18).padStart(22)} (${(Number(share) / 100).toFixed(2)}%)  ->  ${formatEther(answer.amountOut)} ETH`,
      );
    } catch (error) {
      console.log(
        `  ${formatUnits(amount, 18).padStart(22)} (${(Number(share) / 100).toFixed(2)}%)  ->  REVERTS: ${unwrap(error)}`,
      );
    }
  }

  console.log("");
}

await main();
