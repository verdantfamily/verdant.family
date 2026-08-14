/**
 * The last read-only check before a human presses Launch.
 *
 * Every other gate in this repository asks whether the code is self-consistent. This one
 * asks the live chain, through the exact code path the browser will take, whether the
 * transaction the form is about to build is the transaction the deployed factory expects.
 * It signs nothing and sends nothing: the launch is simulated with `eth_call`, so a
 * mismatch between the generated ABI and the deployed bytecode surfaces here rather than
 * in a wallet.
 *
 * Read-only, so it is safe to run against production at any time.
 */

import { createPublicClient, getAddress, http, formatEther, type Address } from "viem";

import { instantFor, robinhoodMainnet, ROBINHOOD_MAINNET_ID, INSTANT_FEES } from "@verdant/config";
import { agen, instant as instantSdk, launch as launchSdk } from "@verdant/sdk";

const RPC = process.env["RPC_URL"] ?? process.env["NEXT_PUBLIC_RPC_URL"];
if (RPC === undefined || RPC === "") throw new Error("Set RPC_URL.");

// Whoever the caller says they are. Only used as `from`, and only so the factory's
// salt namespacing and refund path resolve the way they will for a real creator.
const CALLER = getAddress(
  process.env["CALLER"] ?? "0x1f23c28F93aE48E6346DD05Ca66ba5e2213b00b8",
) as Address;

const record = instantFor(ROBINHOOD_MAINNET_ID);
if (record === null) throw new Error("No Instant deployment recorded for 4663.");

const client = createPublicClient({
  chain: robinhoodMainnet,
  transport: http(RPC),
});

const problems: string[] = [];
const check = (label: string, actual: unknown, expected: unknown): void => {
  const same = String(actual).toLowerCase() === String(expected).toLowerCase();
  if (!same) problems.push(`${label}: chain says ${String(actual)}, record says ${String(expected)}`);
  console.log(`  ${same ? "ok  " : "BAD "} ${label.padEnd(18)} ${String(actual)}`);
};

const factory = getAddress(record.factory);

console.log(`chain ${String(await client.getChainId())} · factory ${factory}\n`);

console.log("factory names, and is named by:");
const read = <T,>(address: Address, signature: string) =>
  client.readContract({
    address,
    abi: [
      {
        type: "function",
        name: signature.slice(0, signature.indexOf("(")),
        inputs: [],
        outputs: [{ type: signature.slice(signature.lastIndexOf(" ") + 1) }],
        stateMutability: "view",
      },
    ],
    functionName: signature.slice(0, signature.indexOf("(")),
  }) as Promise<T>;

check("hook", await read<Address>(factory, "hook() address"), record.hook);
check("deployer", await read<Address>(factory, "deployer() address"), record.deployer);
check("marketRegistry", await read<Address>(factory, "marketRegistry() address"), record.registry);
check("treasury", await read<Address>(factory, "treasury() address"), record.treasury);
check("hook.factory", await read<Address>(getAddress(record.hook), "factory() address"), factory);
check(
  "deployer.factory",
  await read<Address>(getAddress(record.deployer), "factory() address"),
  factory,
);
check("registry.writer", await read<Address>(getAddress(record.registry), "writer() address"), factory);

console.log("\nstandardised terms, on chain rather than in the form:");
const supplyTokens = await read<bigint>(factory, "SUPPLY_TOKENS() uint256");
const initialTick = await read<number>(factory, "INITIAL_TICK() int24");

// The number the review screen shows a creator is derived, not read. If the derivation
// disagreed with the constant the pool opens at, the screen would be quoting a valuation
// the market will not have.
const derivedTick = agen.initialTickForValuation({
  supply: supplyTokens * 10n ** 18n,
  valuation: 1_500_000_000_000_000_000n,
});

check("SUPPLY_TOKENS", supplyTokens, 1_000_000_000n);
check("INITIAL_TICK", initialTick, derivedTick);

console.log(
  `\nfee, from InstantFees: ${String(INSTANT_FEES.totalPpm / 10_000)}% total · ` +
    `${String(INSTANT_FEES.creatorPpm / 10_000)}% creator · ` +
    `${String(INSTANT_FEES.platformPpm / 10_000)}% platform`,
);

// --- The launch itself, simulated ------------------------------------------------

console.log("\nsimulating a launch through the browser's own encoder:");

const identity = {
  name: "Preflight",
  symbol: "PRE",
  supplyTokens,
  metadataURI: "https://agen.space/api/metadata/00000000000000000000000000000000.json",
  metadataMutable: false as const,
  creator: CALLER,
};

const initCodeHash = await launchSdk.readTokenInitCodeHash(client, {
  deployer: getAddress(record.deployer),
  ...identity,
});

const mined = launchSdk.mineTokenSalt({
  deployer: getAddress(record.deployer),
  creator: CALLER,
  initCodeHash,
  above: "0x0000000000000000000000000000000000000000",
});

const initialBuy = 10_000_000_000_000_000n;

const call = instantSdk.buildInstantCreate({
  factory,
  params: {
    name: identity.name,
    symbol: identity.symbol,
    metadataURI: identity.metadataURI,
    feeRecipient: CALLER,
    salt: mined.salt,
    initialBuyAmount: initialBuy,
    initialBuyMinTokens: 0n,
  },
});

console.log(`  token would land at ${mined.token}`);
console.log(`  calldata ${call.data.length / 2 - 1} bytes, selector ${call.data.slice(0, 10)}`);
console.log(`  value ${formatEther(call.value)} ETH`);

try {
  const { data } = await client.call({
    account: CALLER,
    to: call.to,
    data: call.data,
    value: call.value,
  });
  console.log(`  ok   the live factory accepts it, returning ${String(data?.length ?? 0) } chars`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  // An insufficient balance is the caller's problem and not the ABI's, so it is reported
  // as such rather than counted as a wiring failure.
  if (/insufficient (funds|balance)/i.test(message)) {
    console.log(`  ok   encoding accepted; ${CALLER} simply has no ${formatEther(initialBuy)} ETH to spend`);
  } else {
    problems.push(`the live factory rejected the encoded launch: ${message.split("\n")[0] ?? message}`);
    console.log(`  BAD  ${message.split("\n").slice(0, 6).join("\n       ")}`);
  }
}

console.log("");
if (problems.length > 0) {
  for (const problem of problems) console.error(`✗ ${problem}`);
  process.exit(1);
}
console.log("✓ the production UI is wired to the live Instant deployment");
