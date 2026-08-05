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
  formatEther,
  http,
  isAddress,
  parseEther,
  type Address,
} from "viem";

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
}

await main();
