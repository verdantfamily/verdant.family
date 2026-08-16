/**
 * A cleared build, launched onto a chain, and then traded.
 *
 * Everything upstream of this stops one step short of the thing a creator actually gets. The
 * pipeline does deploy each market and run its behaviour tests through the real `AgenFactory`,
 * but it does so against *probe* addresses: a stand-in creator, a stand-in fee receiver, local
 * infrastructure. The launch a creator signs is assembled a second time, from the same
 * deployment but with their own address mixed into every salt and the hook re-mined from
 * creation code that contains the addresses that produces.
 *
 * That second assembly is the only part of Agen nothing had ever executed. `prepareLaunch` is
 * explicit that it can fail where the build could not — the token has to sort above the quote
 * asset, and whether it does depends on the creator — and a failure there lands on someone who
 * has waited twenty minutes and connected a wallet. "It assembled once with different
 * addresses" is not evidence about the addresses that matter.
 *
 * So this takes builds off the volume as they are, forks the live chain so the factory, the
 * router and the pool manager are the deployed ones rather than fixtures, and asks for the
 * whole of it: the transaction the wallet would be given, sent; the components landing at the
 * addresses the manifest promised, which is the CREATE2 prediction being right about real
 * creation code; and a buy going through the market afterwards, because a market that deploys
 * and cannot trade has not launched in any sense a creator would accept.
 *
 * Skips rather than fails when the chain is unreachable or there are no builds on the volume.
 * Neither says anything about the code, and a proof that cannot tell the difference between
 * "this is broken" and "you are on a train" gets ignored, which is worse than not having it.
 */

import { execFile, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

import type { GenerationJob } from "@verdant/market-compiler";
import { agen } from "@verdant/sdk";
import { createPublicClient, createWalletClient, erc20Abi, http, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AGEN_ADDRESSES, AGEN_ROUTER, chain } from "./chain";
import { LaunchError, prepareLaunch } from "./launch";

const run = promisify(execFile);

/** The public endpoint, or a private one where the shell has said so. Matches `ForkRpc`. */
const UPSTREAM = process.env["ROBINHOOD_RPC_URL"] ?? "https://rpc.mainnet.chain.robinhood.com";

/** Anvil's first two accounts: the creator, and a fee receiver that is not the creator. */
const CREATOR_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const FEE_RECEIVER: Address = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

const GENERATED_ROOT = resolve(process.cwd(), "../../generated");

/** Off the default port, so a proof never talks to a dev chain somebody is using. */
const PORT = 8549;
const LOCAL = `http://127.0.0.1:${String(PORT)}`;

const creator = privateKeyToAccount(CREATOR_KEY);
const local = { ...chain, rpcUrls: { default: { http: [LOCAL] } } };

const publicClient = createPublicClient({ chain: local, transport: http(LOCAL) });
const wallet = createWalletClient({ account: creator, chain: local, transport: http(LOCAL) });

let anvil: ChildProcess | null = null;

/**
 * The creator's nonce, counted here rather than asked for.
 *
 * Every send below is sequential, so the count is knowable; asking the node instead means
 * asking a forked node under load, and a stale answer does not fail cleanly. It re-sends a
 * transaction that has already been mined, and a re-sent launch reverts `AlreadyDeployed`
 * against a component with nothing wrong with it.
 */
let nonce = 0;

/** One transaction, sent and mined, with a wait long enough for a forked node under load. */
async function send(call: {
  readonly to: Address;
  readonly data: `0x${string}`;
  readonly value: bigint;
}) {
  const hash = await wallet.sendTransaction({ ...call, nonce: nonce++ });
  return publicClient.waitForTransactionReceipt({ hash, timeout: 180_000 });
}

/** Whether the upstream chain answers, and answers for the chain the addresses are recorded on. */
async function upstreamIsReachable(): Promise<boolean> {
  const { stdout } = await run("cast", ["chain-id", "--rpc-url", UPSTREAM], {
    timeout: 15_000,
  }).catch(() => ({ stdout: "" }));

  return stdout.trim() === String(chain.id);
}

/**
 * One cleared build per market, newest first.
 *
 * Read off the volume rather than fixed by id, so this follows what the compiler is producing
 * now instead of a market that happened to build in August. Builds from before the deployment
 * specification are skipped: they carry no manifest, `prepareLaunch` refuses them by design,
 * and including them would prove only that the refusal works.
 */
async function clearedBuilds(): Promise<readonly GenerationJob[]> {
  const directory = resolve(GENERATED_ROOT, "_jobs");
  const files = await readdir(directory).catch(() => [] as string[]);

  const jobs: GenerationJob[] = [];
  for (const file of files) {
    if (!file.endsWith(".json")) continue;

    const job = await readFile(resolve(directory, file), "utf8")
      .then((raw) => JSON.parse(raw) as GenerationJob)
      .catch(() => null);

    if (job === null || job.stage !== "deployment_ready" || job.manifest === null) continue;

    // The compiled bundle has to still be there; jobs outlive their artefacts.
    const built = await readFile(resolve(GENERATED_ROOT, job.id, "artifacts", "build.json"), "utf8")
      .then(() => true)
      .catch(() => false);
    if (built) jobs.push(job);
  }

  jobs.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));

  const newestPerMarket = new Map<string, GenerationJob>();
  for (const job of jobs) if (!newestPerMarket.has(job.symbol)) newestPerMarket.set(job.symbol, job);

  // One market at a time, when a failure needs separating from the markets around it:
  // AGEN_LAUNCH_ONLY=STREAK,FLOW. A launch that only fails with company is a different bug
  // from one that fails alone, and telling them apart is most of the diagnosis.
  const only = (process.env["AGEN_LAUNCH_ONLY"] ?? "")
    .split(",")
    .map((symbol) => symbol.trim())
    .filter((symbol) => symbol !== "");

  return [...newestPerMarket.values()].filter(
    (job) => only.length === 0 || only.includes(job.symbol),
  );
}

/**
 * The block the fork is pinned to, so the proof is reading one state of the chain.
 *
 * Unpinned, anvil re-fetches from the upstream node as the chain moves and every account a
 * launch touches is another request against a public endpoint that rate-limits. Twelve markets
 * in, the node was slow enough that waiting for a receipt timed out — which is not a fact about
 * a market, and worse, left the account's nonce in a state that made the *next* launch
 * re-broadcast a transaction that had already been mined. That surfaced as `AlreadyDeployed`
 * against a component that was perfectly fine, three markets away from the actual problem.
 */
async function pinnedBlock(): Promise<string> {
  const { stdout } = await run("cast", ["block-number", "--rpc-url", UPSTREAM]);
  return String(Math.max(1, Number(stdout.trim()) - 8));
}

async function startFork(): Promise<void> {
  anvil = spawn(
    "anvil",
    [
      "--fork-url",
      UPSTREAM,
      "--fork-block-number",
      await pinnedBlock(),
      "--port",
      String(PORT),
      "--silent",
      "--accounts",
      "4",
      // Twelve markets is a few thousand state reads, and the upstream node is public.
      "--no-rate-limit",
    ],
    { stdio: "ignore" },
  );

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const id = await publicClient.getChainId().catch(() => null);
    if (id !== null) return;
    await new Promise((wake) => setTimeout(wake, 500));
  }

  throw new Error(`anvil did not come up on ${LOCAL} within a minute`);
}

let builds: readonly GenerationJob[] = [];
let reachable = false;

beforeAll(async () => {
  reachable = await upstreamIsReachable();
  if (!reachable) return;

  builds = await clearedBuilds();
  if (builds.length === 0) return;

  await startFork();

  // The fork has to actually carry the contracts the addresses are recorded for. Forking a
  // chain that answers but has no factory on it would fail every launch below for a reason
  // that has nothing to do with a launch.
  expect(AGEN_ADDRESSES.ok, "no Agen deployment recorded for this chain").toBe(true);
  if (!AGEN_ADDRESSES.ok) return;

  const factory = await publicClient.getCode({ address: AGEN_ADDRESSES.addresses.factory });
  expect(factory, "no AgenFactory on the forked chain").toBeDefined();

  nonce = await publicClient.getTransactionCount({ address: creator.address });
}, 120_000);

afterAll(() => {
  anvil?.kill();
  anvil = null;
});

describe("a cleared build reaching a chain", () => {
  it("launches, lands where the manifest said, and trades", async () => {
    if (!reachable) {
      console.warn(`[launch] ${UPSTREAM} is not answering for chain ${String(chain.id)}; skipped`);
      return;
    }
    if (builds.length === 0) {
      console.warn("[launch] no cleared build with a manifest on the volume; skipped");
      return;
    }

    const failures: string[] = [];
    const refused: string[] = [];
    let launches = 0;

    for (const job of builds) {
      const outcome = await launched(job).catch((error: Error) =>
        // A build Agen declines to launch, in terms that say why, is doing its job — a volume
        // holds builds older than the launch path and refusing them is correct. A build that
        // fails any other way is a market a creator would have lost.
        error instanceof LaunchError ? { refusal: error.message } : error.message,
      );

      if (outcome === null) launches++;
      else if (typeof outcome === "string") failures.push(`${job.symbol}: ${outcome}`);
      else refused.push(`${job.symbol}: ${outcome.refusal}`);
    }

    console.log(
      `[launch] ${String(launches)} of ${String(builds.length)} builds launched and traded on a ` +
        `fork of chain ${String(chain.id)}` +
        (refused.length === 0 ? "" : `\n  refused: ${refused.join("\n  refused: ")}`),
    );

    expect(failures).toEqual([]);
    // A run where everything was refused proves nothing, and would otherwise read as a pass.
    expect(launches).toBeGreaterThan(0);
  }, 900_000);
});

/**
 * One market, launched and traded. Returns null when it worked, or what went wrong.
 *
 * Every market on the volume goes through in one test rather than one each, because the fork
 * is the expensive part and a market launched on a chain that already has other markets on it
 * is the more honest arrangement anyway.
 */
async function launched(job: GenerationJob): Promise<string | null> {
  const prepared = await prepareLaunch({
    jobId: job.id,
    creator: creator.address,
    feeReceiver: FEE_RECEIVER,
  });

  // Recorded before it is sent, so a market that collides with an earlier one can be
  // attributed to it rather than guessed at.
  console.log(
    `[launch] ${job.symbol} (${job.id}) token ${prepared.market.token} hook ` +
      `${prepared.market.hook} across ${String(prepared.market.contracts)} contracts`,
  );

  const receipt = await send({
    to: prepared.transaction.to,
    data: prepared.transaction.data,
    value: BigInt(prepared.transaction.value),
  });
  if (receipt.status !== "success") return `the launch transaction reverted (${receipt.transactionHash})`;

  // The addresses the creator was shown before they signed. Nothing lands here unless the
  // salts, the creation code and the hook's mined address were all right about themselves.
  for (const [what, address] of [
    ["token", prepared.market.token],
    ["hook", prepared.market.hook],
  ] as const) {
    const code = await publicClient.getCode({ address });
    if (code === undefined || code === "0x") {
      return `nothing was deployed at the ${what} address the launch promised (${address})`;
    }
  }

  if (AGEN_ROUTER === null) return null;

  // And it trades. A market that deploys and cannot be bought has not launched.
  const buy = agen.buildAgenBuy({
    router: AGEN_ROUTER,
    poolKey: {
      currency0: "0x0000000000000000000000000000000000000000",
      currency1: prepared.market.token,
      fee: job.manifest?.lpFee ?? 0,
      tickSpacing: agen.AGEN_TICK_SPACING,
      hooks: prepared.market.hook,
    },
    amountIn: 10n ** 16n,
    minAmountOut: 0n,
  });

  const bought = await send({ to: buy.to, data: buy.data, value: buy.value }).catch(
    (error: Error) => error.message,
  );

  if (typeof bought === "string") return `the market deployed but a buy could not be sent: ${bought}`;
  if (bought.status !== "success") return `the market deployed and then a buy reverted`;

  const balance = await publicClient.readContract({
    address: prepared.market.token,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [creator.address],
  });

  if (balance === 0n) return "a buy succeeded and left the buyer with no tokens";

  return null;
}
