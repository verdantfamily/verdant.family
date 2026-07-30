#!/usr/bin/env node
/**
 * pnpm chain:probe
 *
 * Reproduces every chain fact recorded in docs/verification.md. Read-only: no
 * key is loaded and no transaction is sent.
 *
 * This exists as committed code rather than as a paragraph in a document because
 * chain facts expire. If Robinhood redeploys, moves an address, or upgrades
 * ArbOS, this script is how we find out — and its output is the evidence anyone
 * reviewing the architecture is entitled to ask for.
 *
 * Deliberately dependency-free: plain fetch and Node's native TypeScript
 * stripping, so it runs on a clean clone before `pnpm install`.
 *
 * Exits non-zero if any address that must have code does not.
 */

interface ChainTarget {
  readonly label: string;
  readonly chainId: number;
  readonly rpc: string;
}

const CHAINS: readonly ChainTarget[] = [
  {
    label: "mainnet",
    chainId: 4663,
    rpc: "https://rpc.mainnet.chain.robinhood.com",
  },
  {
    label: "testnet",
    chainId: 46630,
    rpc: "https://rpc.testnet.chain.robinhood.com",
  },
];

/**
 * `required` means: Verdant's design depends on this having code on this chain.
 * A missing required address is a build-stopping fact, not a warning.
 */
interface AddressTarget {
  readonly name: string;
  readonly address: string;
  readonly required: readonly ("mainnet" | "testnet")[];
  readonly note?: string;
}

const ADDRESSES: readonly AddressTarget[] = [
  {
    name: "CREATE2 deployer",
    address: "0x4e59b44847b379578588920cA78FbF26c0B4956C",
    required: ["mainnet", "testnet"],
    note: "V2 — canonical deterministic deployer; hook mining targets it",
  },
  {
    name: "PoolManager",
    address: "0x8366a39cc670b4001a1121b8f6a443a643e40951",
    required: ["mainnet", "testnet"],
  },
  {
    name: "PositionManager",
    address: "0x58daec3116aae6d93017baaea7749052e8a04fa7",
    required: ["mainnet", "testnet"],
  },
  {
    name: "PositionDescriptor",
    address: "0x9639443158e8c5efa35bd45287bf2effd3d8dc06",
    required: ["mainnet", "testnet"],
  },
  {
    name: "V4Quoter",
    address: "0x8dc178efb8111bb0973dd9d722ebeff267c98f94",
    required: ["mainnet", "testnet"],
  },
  {
    name: "StateView",
    address: "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b",
    required: ["mainnet", "testnet"],
  },
  {
    name: "ReservesLens",
    address: "0x0000001b173C3bbF3984D417d8614E3eed34865B",
    required: ["mainnet", "testnet"],
  },
  {
    name: "Universal Router",
    address: "0x8876789976decbfcbbbe364623c63652db8c0904",
    required: ["mainnet", "testnet"],
  },
  {
    name: "Permit2",
    address: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
    required: ["mainnet", "testnet"],
  },
  {
    name: "Multicall3",
    address: "0xcA11bde05977b3631167028862bE2a173976CA11",
    required: ["mainnet", "testnet"],
  },
  {
    name: "WETH (mainnet)",
    address: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
    required: ["mainnet"],
    note: "V3 — unused by v1 markets (D4 pairs against native ETH)",
  },
  {
    name: "WETH (testnet)",
    address: "0x7943e237c7F95DA44E0301572D358911207852Fa",
    required: ["testnet"],
  },
];

/** ArbSys is an Arbitrum precompile at a fixed address on every Orbit chain. */
const ARB_SYS = "0x0000000000000000000000000000000000000064";
const SELECTOR_ARB_OS_VERSION = "0x051038f2"; // arbOSVersion()
const SELECTOR_ARB_BLOCK_NUMBER = "0xa3b1b31d"; // arbBlockNumber()

let rpcId = 0;

async function rpc<T>(url: string, method: string, params: unknown[]): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    throw new Error(`${method}: HTTP ${response.status}`);
  }
  const body = (await response.json()) as {
    result?: T;
    error?: { code: number; message: string };
  };
  if (body.error) {
    throw new Error(`${method}: ${body.error.message} (${body.error.code})`);
  }
  if (body.result === undefined) {
    throw new Error(`${method}: empty result`);
  }
  return body.result;
}

function codeSize(hex: string): number {
  return hex === "0x" ? 0 : (hex.length - 2) / 2;
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

function padStart(value: string, width: number): string {
  return value.length >= width ? value : " ".repeat(width - value.length) + value;
}

interface ChainReport {
  readonly target: ChainTarget;
  readonly chainIdOnWire: number;
  readonly clientVersion: string;
  readonly blockNumber: bigint;
  readonly l1BlockNumber: bigint | null;
  readonly timestamp: bigint;
  readonly baseFeePerGas: bigint | null;
  readonly gasLimit: bigint;
  readonly arbBlockNumber: bigint | null;
  readonly arbOsVersion: bigint | null;
  readonly codeSizes: ReadonlyMap<string, number>;
}

async function probeChain(target: ChainTarget): Promise<ChainReport> {
  const [chainIdHex, clientVersion, blockNumberHex] = await Promise.all([
    rpc<string>(target.rpc, "eth_chainId", []),
    rpc<string>(target.rpc, "web3_clientVersion", []),
    rpc<string>(target.rpc, "eth_blockNumber", []),
  ]);

  const header = await rpc<{
    number: string;
    timestamp: string;
    gasLimit: string;
    baseFeePerGas?: string;
    l1BlockNumber?: string;
  }>(target.rpc, "eth_getBlockByNumber", ["latest", false]);

  // Precompile reads are best-effort: a chain that answers everything else but
  // not ArbSys is still usable, and we would rather report a gap than crash.
  const arbCall = async (selector: string): Promise<bigint | null> => {
    try {
      const result = await rpc<string>(target.rpc, "eth_call", [
        { to: ARB_SYS, data: selector },
        "latest",
      ]);
      return BigInt(result);
    } catch {
      return null;
    }
  };

  const [arbBlockNumber, arbOsVersion] = await Promise.all([
    arbCall(SELECTOR_ARB_BLOCK_NUMBER),
    arbCall(SELECTOR_ARB_OS_VERSION),
  ]);

  const codeSizes = new Map<string, number>();
  for (const entry of ADDRESSES) {
    const code = await rpc<string>(target.rpc, "eth_getCode", [
      entry.address,
      "latest",
    ]);
    codeSizes.set(entry.address, codeSize(code));
  }

  return {
    target,
    chainIdOnWire: Number(BigInt(chainIdHex)),
    clientVersion,
    blockNumber: BigInt(blockNumberHex),
    l1BlockNumber:
      header.l1BlockNumber === undefined ? null : BigInt(header.l1BlockNumber),
    timestamp: BigInt(header.timestamp),
    baseFeePerGas:
      header.baseFeePerGas === undefined ? null : BigInt(header.baseFeePerGas),
    gasLimit: BigInt(header.gasLimit),
    arbBlockNumber,
    arbOsVersion,
    codeSizes,
  };
}

function reportChain(report: ChainReport): string[] {
  const problems: string[] = [];
  const t = report.target;

  console.log(`\n${t.label}  —  ${t.rpc}`);
  console.log("-".repeat(78));

  const idMatches = report.chainIdOnWire === t.chainId;
  console.log(
    `  chain id            ${report.chainIdOnWire}${idMatches ? "" : `  MISMATCH, expected ${t.chainId}`}`,
  );
  if (!idMatches) {
    problems.push(
      `${t.label}: chain id is ${report.chainIdOnWire}, expected ${t.chainId}`,
    );
  }

  console.log(`  client              ${report.clientVersion}`);
  console.log(`  L2 block            ${report.blockNumber.toLocaleString("en-US")}`);

  if (report.l1BlockNumber !== null) {
    // V7: block.number inside the EVM returns THIS, not the L2 height. The two
    // are close enough in magnitude that mistaking them yields a schedule that
    // looks plausible and advances ~120x too slowly.
    console.log(
      `  l1BlockNumber       ${report.l1BlockNumber.toLocaleString("en-US")}   <- what block.number returns`,
    );
  }
  if (report.arbBlockNumber !== null) {
    console.log(
      `  arbBlockNumber()    ${report.arbBlockNumber.toLocaleString("en-US")}`,
    );
  }
  if (report.arbOsVersion !== null) {
    console.log(`  arbOSVersion()      ${report.arbOsVersion}`);
  }

  console.log(
    `  timestamp           ${report.timestamp} (${new Date(Number(report.timestamp) * 1000).toISOString()})`,
  );
  if (report.baseFeePerGas !== null) {
    const gwei = Number(report.baseFeePerGas) / 1e9;
    console.log(`  baseFeePerGas       ${gwei.toFixed(6)} gwei`);
  }
  console.log(
    `  header gasLimit     ${report.gasLimit.toLocaleString("en-US")}  (nominal on Orbit; not the tx limit)`,
  );

  console.log("");
  console.log(`  ${pad("contract", 22)}${pad("address", 44)}${padStart("bytes", 8)}`);
  for (const entry of ADDRESSES) {
    const size = report.codeSizes.get(entry.address) ?? 0;
    const isRequired = entry.required.includes(
      t.label as "mainnet" | "testnet",
    );
    let status: string;
    if (size > 0) {
      status = padStart(size.toLocaleString("en-US"), 8);
    } else if (isRequired) {
      status = padStart("MISSING", 8);
      problems.push(`${t.label}: ${entry.name} (${entry.address}) has no code`);
    } else {
      // Absent and not expected here: this is the negative control that proves
      // the two RPC endpoints are distinct chains rather than one node.
      status = padStart("-", 8);
    }
    console.log(`  ${pad(entry.name, 22)}${pad(entry.address, 44)}${status}`);
  }

  return problems;
}

async function main(): Promise<void> {
  console.log("Verdant chain probe — read-only. See docs/verification.md.");

  const reports: ChainReport[] = [];
  const problems: string[] = [];

  for (const target of CHAINS) {
    try {
      reports.push(await probeChain(target));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`\n${target.label}  —  UNREACHABLE: ${message}`);
      problems.push(`${target.label}: unreachable (${message})`);
    }
  }

  for (const report of reports) {
    problems.push(...reportChain(report));
  }

  // Cross-chain check: identical bytecode length at identical addresses is the
  // signature of deterministic deployment of the same artifacts, and is the
  // evidence behind V1 (v4 is real on testnet, despite Uniswap's docs).
  if (reports.length === 2) {
    const [a, b] = reports as [ChainReport, ChainReport];
    console.log("\ncross-chain bytecode comparison");
    console.log("-".repeat(78));
    let mismatches = 0;
    for (const entry of ADDRESSES) {
      const sizeA = a.codeSizes.get(entry.address) ?? 0;
      const sizeB = b.codeSizes.get(entry.address) ?? 0;
      if (sizeA > 0 && sizeB > 0 && sizeA !== sizeB) {
        console.log(
          `  DIFFERS  ${pad(entry.name, 22)} ${a.target.label} ${sizeA} vs ${b.target.label} ${sizeB}`,
        );
        mismatches += 1;
      }
    }
    if (mismatches === 0) {
      console.log(
        "  every address present on both chains has identical code size",
      );
    }
  }

  console.log("");
  if (problems.length > 0) {
    console.error(`FAIL — ${problems.length} problem(s):`);
    for (const problem of problems) {
      console.error(`  - ${problem}`);
    }
    process.exit(1);
  }
  console.log("OK — every required address has code on every chain that needs it.");
}

await main();
