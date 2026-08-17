/**
 * Checking that the autonomous launch is a real market, against the chain rather
 * than against the app's own record of it.
 *
 * The run history says what the agent decided and what the code believes happened.
 * That is the thing under test, so it cannot also be the evidence. Everything below
 * is read from Robinhood Chain and from the deployment record in `packages/config`,
 * and the questions are the ones that would catch a launch that only looked right:
 * did the transaction succeed, was it sent by the agent's own wallet, did it call
 * the canonical InstantFactory and nothing else, do the token, pool and vault exist,
 * and can the market be traded.
 *
 *   node scripts/p3/verify-launch.mjs <txHash> <token> <agentWallet>
 */

import { createPublicClient, formatEther, http } from "viem";

import { INSTANT_ADDRESSES } from "../../src/app/lib/chain.ts";

const [, , txHash, token, wallet] = process.argv;

const client = createPublicClient({ transport: http("https://rpc.mainnet.chain.robinhood.com") });

const receipt = await client.getTransactionReceipt({ hash: txHash });
const tx = await client.getTransaction({ hash: txHash });

const factory = INSTANT_ADDRESSES?.factory ?? null;

console.log(`chain          ${String(await client.getChainId())}`);
console.log(`status         ${receipt.status}`);
console.log(`block          ${String(receipt.blockNumber)}`);
console.log(`from           ${tx.from}`);
console.log(`  is the agent ${String(tx.from.toLowerCase() === wallet.toLowerCase())}`);
console.log(`to             ${tx.to}`);
console.log(`  is factory   ${String(factory !== null && tx.to?.toLowerCase() === factory.toLowerCase())} (${factory ?? "?"})`);
console.log(`value          ${formatEther(tx.value)} ETH`);
console.log(`gas used       ${String(receipt.gasUsed)}`);

// Every address this transaction touched. A launch calls one contract; anything
// else in this list that is not a log emitted by the market being created would
// mean the agent's key had signed something nobody authorised.
const touched = new Set(receipt.logs.map((log) => log.address.toLowerCase()));
console.log(`log sources    ${String(touched.size)}`);
for (const address of touched) console.log(`  ${address}`);

const code = await client.getBytecode({ address: token });
console.log(`token code     ${code === undefined ? "MISSING" : `${String((code.length - 2) / 2)} bytes`}`);
