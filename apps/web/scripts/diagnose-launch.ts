#!/usr/bin/env node
/**
 * What a wallet is asked to sign for a classic launch, and what the chain says about it.
 *
 * Written for one question: a wallet reported "there was an error attempting to sign
 * the transaction" and gave no reason. That failure has three plausible causes and
 * they are told apart from outside the wallet — the transaction reverts, the account
 * cannot pay for it, or the wallet itself cannot handle the chain. This prints the
 * evidence for the first two so that the third is a conclusion rather than a guess.
 *
 * It signs nothing and sends nothing. Every call below is `eth_call`,
 * `eth_estimateGas` or a read.
 *
 * Usage:  node apps/web/scripts/diagnose-launch.ts
 * Environment: VERDANT_FROM (the address to simulate from), VERDANT_RPC,
 *              VERDANT_BUY (ether, default 0.001)
 */

import {
  EXTERNAL_ADDRESSES,
  ROBINHOOD_MAINNET_ID,
  deploymentFor,
  type VerdantDeployment,
} from "@verdant/config";
import { launch } from "@verdant/sdk";
import {
  createPublicClient,
  formatEther,
  http,
  isAddress,
  parseEther,
  type Address,
} from "viem";

import { derive, emptyDraft, launchParams, tokenIdentity, validate } from "../src/lib/launch.ts";

function mainnetDeployment(): VerdantDeployment {
  const found = deploymentFor(ROBINHOOD_MAINNET_ID);
  if (found === null) throw new Error("Robinhood mainnet has no recorded deployment");
  return found;
}

const deployment = mainnetDeployment();

const RPC = process.env["VERDANT_RPC"]?.trim() ?? "https://rpc.mainnet.chain.robinhood.com";

const from = process.env["VERDANT_FROM"]?.trim();
if (from === undefined || !isAddress(from)) {
  throw new Error("VERDANT_FROM must be the address to simulate the launch from");
}
const creator = from as Address;

const buy = parseEther(process.env["VERDANT_BUY"]?.trim() ?? "0.001");

const client = createPublicClient({ transport: http(RPC) });

/**
 * `ArbGasInfo.getGasAccountingParams`, whose third value is the per-transaction gas
 * ceiling. An estimate above it is a transaction no wallet can send, and a wallet
 * that hits it has nothing sensible to report.
 */
const ARB_GAS_INFO = "0x000000000000000000000000000000000000006C" as const;

async function main(): Promise<void> {
  const chainId = await client.getChainId();
  const balance = await client.getBalance({ address: creator });
  const block = await client.getBlock();

  console.log("\nthe chain, and the account the launch would come from");
  console.log(`  chain id                 ${chainId}`);
  console.log(`  head                     ${block.number}`);
  console.log(`  base fee                 ${block.baseFeePerGas ?? 0n} wei`);
  console.log(`  ${creator}`);
  console.log(`  balance                  ${formatEther(balance)} ETH`);

  const [, , maxTxGas] = await client.readContract({
    address: ARB_GAS_INFO,
    abi: [
      {
        type: "function",
        name: "getGasAccountingParams",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }],
      },
    ] as const,
    functionName: "getGasAccountingParams",
  });
  console.log(`  per-transaction gas cap  ${maxTxGas}`);

  // The form's own draft, with the two fields a creator must fill and a first buy.
  const draft = {
    ...emptyDraft(),
    name: "Diagnostic",
    symbol: "DIAG",
    metadataUrl: "ipfs://verdant-diagnostic",
    initialBuy: formatEther(buy),
  };

  const derived = derive(draft);
  const blockers = validate(draft).filter((issue) => issue.blocking);
  console.log("\nthe draft, as the form would hold it");
  console.log(`  quote asset              ${derived.quoteLabel} (${derived.quoteAsset})`);
  console.log(`  first buy                ${formatEther(buy)} ETH`);
  console.log(
    `  the form would submit    ${blockers.length === 0 ? "yes" : `no: ${blockers.map((issue) => issue.message).join("; ")}`}`,
  );

  const identity = tokenIdentity(draft, derived, creator);
  if (identity === null) throw new Error("the draft has no token identity");

  const initCodeHash = await launch.readTokenInitCodeHash(client, {
    ...identity,
    deployer: deployment.verdantDeployer,
  });
  const mined = launch.mineTokenSalt({
    deployer: deployment.verdantDeployer,
    creator,
    initCodeHash,
    above: derived.quoteAsset,
  });

  const params = launchParams(draft, derived, { creator, salt: mined.salt });
  if (params === null) throw new Error("the draft produced no launch parameters");

  const call = launch.buildCreate({ factory: deployment.factory, params });

  console.log("\nthe transaction the wallet is handed");
  console.log(`  to                       ${call.to}`);
  console.log(`  value                    ${formatEther(call.value)} ETH`);
  console.log(`  calldata                 ${(call.data.length - 2) / 2} bytes`);
  console.log(`  predicted token          ${mined.token}`);

  // The page's own pre-flight, from the same address, so a revert here is the
  // contract's named error rather than the wallet's silence.
  console.log("\nwhat the chain says");
  try {
    await client.call({ account: creator, to: call.to, data: call.data, value: call.value });
    console.log("  eth_call                 succeeds: the launch does not revert");
  } catch (error) {
    console.log(`  eth_call                 REVERTS: ${(error as Error).message.split("\n")[0]}`);
    console.log("\nthis is ours to fix, not the wallet's.");
    return;
  }

  try {
    const gas = await client.estimateGas({
      account: creator,
      to: call.to,
      data: call.data,
      value: call.value,
    });
    const fee = gas * (block.baseFeePerGas ?? 0n);
    console.log(`  eth_estimateGas          ${gas}`);
    console.log(`  within the chain's cap    ${gas <= maxTxGas ? "yes" : "NO"}`);
    console.log(`  at the current base fee  ~${formatEther(fee)} ETH`);
    console.log(
      `  the account can pay      ${balance >= fee + call.value ? "yes" : `NO: it holds ${formatEther(balance)} ETH`}`,
    );

    console.log(
      "\nthe chain accepts this transaction and prices it. A wallet that cannot sign it\n" +
        "is failing on its own side, and the fix is to hand it a gas limit rather than\n" +
        "make it find one.\n",
    );
  } catch (error) {
    console.log(`  eth_estimateGas          FAILED: ${(error as Error).message.split("\n")[0]}`);
  }

  console.log(`  quoter, for the trade panel  ${EXTERNAL_ADDRESSES.v4Quoter}`);
}

await main();
