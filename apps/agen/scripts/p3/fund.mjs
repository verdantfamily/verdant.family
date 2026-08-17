/**
 * Send a small amount of real ETH from the owner wallet to an agent wallet.
 *
 * Used only to set up the mainnet acceptance runs. Refuses anything above a tenth
 * of an ETH, because the whole point of these runs is that a mistake in them is
 * cheap, and a fat-fingered amount is the mistake most worth making impossible.
 *
 *   node scripts/p3/fund.mjs <to> <eth>
 */

import { readFileSync } from "node:fs";

import { createPublicClient, createWalletClient, formatEther, http, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { robinhoodMainnet } from "@verdant/config";

const [, , to, eth = "0.002"] = process.argv;
if (to === undefined) throw new Error("Usage: fund.mjs <to> <eth>");

const amount = parseEther(eth);
if (amount > parseEther("0.1")) throw new Error("Refusing to send more than 0.1 ETH from a script.");

const account = privateKeyToAccount(readFileSync("/tmp/agen-p3/owner.key", "utf8").trim());
const transport = http("https://rpc.mainnet.chain.robinhood.com");
const publicClient = createPublicClient({ chain: robinhoodMainnet, transport });
const wallet = createWalletClient({ account, chain: robinhoodMainnet, transport });

console.log("chain     ", await publicClient.getChainId());
console.log("from      ", account.address, formatEther(await publicClient.getBalance({ address: account.address })));
console.log("to        ", to, formatEther(await publicClient.getBalance({ address: to })));

const hash = await wallet.sendTransaction({ to, value: amount });
console.log("sent      ", eth, "ETH, tx", hash);

const receipt = await publicClient.waitForTransactionReceipt({ hash });
console.log("status    ", receipt.status, "block", receipt.blockNumber);
console.log("to now    ", formatEther(await publicClient.getBalance({ address: to })));
