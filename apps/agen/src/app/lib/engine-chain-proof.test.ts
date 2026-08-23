/**
 * One engine-v1 market, launched and traded on a real chain, read back through the app.
 *
 * ## Why this exists alongside `engine-journey.test.ts`
 *
 * That file proves the app's stages are joined, with the receipt synthesised and the registry
 * stubbed — which is the right division of labour for a unit test and leaves one question open.
 * Every layer was correct about its own half and nothing had ever run the whole thing against a
 * chain: in particular `ponder.on("AgenEngineFactory:EngineMarketDeployed")` had never executed
 * anywhere, so an indexer that dropped every engine market would have looked exactly like the
 * one in the repository. A handler with no events is indistinguishable from a chain with no
 * markets.
 *
 * So this is the same journey with nothing stubbed. It runs in two phases, because the middle
 * of it is somebody else's job:
 *
 *   **launch** — compile the configuration, sign the approval with a real key, ask the server
 *   for the real calldata, broadcast it to the real `AgenEngineFactory`, register the receipt
 *   through the app's own decoder, then buy and sell against the real `PoolManager`. Writes
 *   what the chain said to a file.
 *
 *   *(the rig starts the indexer here, and `apps/indexer/scripts/assert-engine.ts` holds it to
 *   what that file says)*
 *
 *   **assert** — read the market back through `marketSource()`, which is what the listing and
 *   the market page call, against the live indexer.
 *
 * ## It only runs inside the rig
 *
 * `scripts/indexer-proof.sh` sets `AGEN_ENGINE_PROOF=1` and everything below it. Absent, this
 * file skips: it needs an anvil with a Uniswap on it, a deployed engine and a funded key, and a
 * version of this that invented those would be testing the thing it exists to catch. The rig
 * requires the output file afterwards, so a phase that skipped when it was asked to run cannot
 * pass quietly.
 *
 * Nothing here is a mock. The one thing it does not use is a wallet UI, because a signature
 * from a private key over `engineApprovalMessage` is byte for byte what a wallet produces.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";

import { AGEN_LAUNCH } from "@verdant/config";
import { engineApprovalMessage } from "@verdant/market-compiler";
import { compile, configHash, encodeConfig, implementationHash } from "@verdant/market-engine";
import type { AgenMarketSpec } from "@verdant/market-engine";
import { abi } from "@verdant/sdk";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeAbiParameters,
  getAddress,
  http,
  keccak256,
  parseEther,
  parseEventLogs,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";

// --- when this runs --------------------------------------------------------

const ENABLED = process.env["AGEN_ENGINE_PROOF"] === "1";
const PHASE = process.env["AGEN_ENGINE_PROOF_PHASE"] ?? "";
const LAUNCHING = ENABLED && PHASE === "launch";
const ASSERTING = ENABLED && PHASE === "assert";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value === "") {
    throw new Error(
      `${name} is not set. This file only runs under scripts/indexer-proof.sh, which sets it.`,
    );
  }
  return value;
}

const NATIVE = "0x0000000000000000000000000000000000000000" as Address;

/**
 * Where the two phases meet, and what the indexer's assertions are held to.
 *
 * A file rather than a fixture, because the phases are separate processes with the indexer's
 * whole backfill between them — and because every number in it came off the chain. The
 * assertions downstream compare the indexer against *this*, so no part of the proof gets to
 * check the indexer against a value the proof chose.
 */
interface Trade {
  readonly kind: "buy" | "sell";
  /**
   * Which route the trade took.
   *
   * `pool` is `PoolSwapTest`, the rig's bare router and the one every engine contract test
   * swaps through. `router` is `AgenRouter`, which is the route an actual trade on agen.space
   * takes — one per chain, named in the deployment record, and the only contract that can tell
   * a hook who is trading.
   *
   * Both, because they fail differently. The bare router proves the pool, the hook and the
   * indexer; the product's router additionally proves its own settlement survives a hook that
   * takes a delta out of the trade. A rig that only ran one of them could not say which layer
   * was wrong.
   */
  readonly via: "pool" | "router";
  readonly txHash: Hex;
  readonly blockNumber: string;
  /** From the hook's own `FeeTaken`: the rate the engine chose, and what it took. */
  readonly feePpm: number;
  readonly feeAmount: string;
  readonly grossQuoteAmount: string;
  readonly grossTokenAmount: string;
  /** From the PoolManager's `Swap`: what moved, and what the pool said it charged. */
  readonly quoteAmount: string;
  readonly tokenAmount: string;
  readonly poolReportedFeePpm: number;
  /** Whoever called the PoolManager, which is the router rather than the trader. */
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
  readonly openingBuyPpm: number;
  readonly openingSellPpm: number;
  readonly vaultCurrency: Address;
  readonly vaultTotalAccrued: string;
  /** `AgenRouter`, so the assertions can tell a product trade from a bare one by its sender. */
  readonly router: Address;
  readonly trades: readonly Trade[];
}

// --- the market this proof launches ----------------------------------------

const SUPPLY = AGEN_LAUNCH.supplyTokens * 10n ** 18n;

/**
 * Native ETH, one rate forever, one recipient. What the gate asks for, and what a creator gets
 * by describing the simplest market that can exist.
 *
 * The two rates differ deliberately. A market charging the same on both sides would let a buy
 * assertion pass against a sell's fee, and the property under test downstream is that each
 * trade's *own* rate survives the trip to a page.
 */
function spec(): AgenMarketSpec {
  return {
    engineVersion: 1,
    baseRate: { buy: "1", sell: "2" },
    ladder: null,
    sizeTiers: [],
    distribution: [{ recipient: { kind: "CREATOR" }, share: "100" }],
    protections: [],
  };
}

/** v4's own bounds, which a swap has to name and neither side of this decides. */
const MIN_SQRT_PRICE = 4_295_128_739n;
const MAX_SQRT_PRICE = 1_461_446_703_485_210_103_287_273_052_203_988_822_378_723_970_342n;

/** The dynamic-fee flag, and Agen's grid. Both the factory's; both checked against it below. */
const DYNAMIC_FEE = 0x800000;
const TICK_SPACING = 200;

const POOL_KEY_TUPLE = [
  {
    type: "tuple",
    components: [
      { name: "currency0", type: "address" },
      { name: "currency1", type: "address" },
      { name: "fee", type: "uint24" },
      { name: "tickSpacing", type: "int24" },
      { name: "hooks", type: "address" },
    ],
  },
] as const;

/** `PoolSwapTest`, the rig's router — the same one every engine contract test swaps through. */
const SWAP_ROUTER_ABI = [
  {
    type: "function",
    name: "swap",
    stateMutability: "payable",
    inputs: [
      {
        name: "key",
        type: "tuple",
        components: [
          { name: "currency0", type: "address" },
          { name: "currency1", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "tickSpacing", type: "int24" },
          { name: "hooks", type: "address" },
        ],
      },
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "zeroForOne", type: "bool" },
          { name: "amountSpecified", type: "int256" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
      {
        name: "testSettings",
        type: "tuple",
        components: [
          { name: "takeClaims", type: "bool" },
          { name: "settleUsingBurn", type: "bool" },
        ],
      },
      { name: "hookData", type: "bytes" },
    ],
    outputs: [{ name: "delta", type: "int256" }],
  },
] as const;

/**
 * `AgenRouter`, which is the route a trade on agen.space takes.
 *
 * Exact input only, and the trader is `msg.sender` rather than a parameter — there is no way to
 * ask to be credited as somebody else. Native input has to arrive as exactly `msg.value`; an
 * ERC-20 input is pulled from the trader straight to the PoolManager, so a sell needs a plain
 * allowance to this contract.
 */
const AGEN_ROUTER_ABI = [
  {
    type: "function",
    name: "swap",
    stateMutability: "payable",
    inputs: [
      {
        name: "key",
        type: "tuple",
        components: [
          { name: "currency0", type: "address" },
          { name: "currency1", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "tickSpacing", type: "int24" },
          { name: "hooks", type: "address" },
        ],
      },
      { name: "zeroForOne", type: "bool" },
      { name: "amountIn", type: "uint128" },
      { name: "minAmountOut", type: "uint128" },
      { name: "extra", type: "bytes" },
    ],
    outputs: [{ name: "amountOut", type: "uint256" }],
  },
] as const;

const ERC20_ABI = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "value", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

// --- the app, loaded only when this is actually running ---------------------
//
// Dynamic, so that a normal `vitest run` — which has none of the environment these modules
// resolve their addresses from — does not load them at all.

const app = ENABLED
  ? {
      builds: await import("./builds"),
      launch: await import("./engine-launch"),
      launched: await import("./launched"),
      markets: await import("./markets"),
    }
  : null;

describe.skipIf(!LAUNCHING)("an engine-v1 market, launched and traded on a real chain", () => {
  const rpc = LAUNCHING ? required("NEXT_PUBLIC_RPC_URL") : "";
  const chainId = LAUNCHING ? Number(required("NEXT_PUBLIC_CHAIN_ID")) : 0;
  const hook = LAUNCHING ? getAddress(required("AGEN_ENGINE_HOOK")) : NATIVE;
  const factory = LAUNCHING ? getAddress(required("AGEN_ENGINE_FACTORY")) : NATIVE;
  const registry = LAUNCHING ? getAddress(required("AGEN_ENGINE_REGISTRY")) : NATIVE;
  const swapRouter = LAUNCHING ? getAddress(required("AGEN_ENGINE_PROOF_SWAP_ROUTER")) : NATIVE;
  const agenRouter = LAUNCHING ? getAddress(required("AGEN_ENGINE_PROOF_AGEN_ROUTER")) : NATIVE;
  const output = LAUNCHING ? required("AGEN_ENGINE_PROOF_OUTPUT") : "";

  /*
   * Not the account that deployed anything.
   *
   * The creator is `msg.sender` on the launch, and the market is attributed from it in three
   * places: the vault's creator leg, the registry's record and the event the app decodes. A rig
   * whose creator was also its deployer could not tell a correct attribution from one that had
   * quietly defaulted to whoever was broadcasting.
   */
  const creator = privateKeyToAccount(
    (LAUNCHING ? required("AGEN_ENGINE_PROOF_KEY") : `0x${"11".repeat(32)}`) as Hex,
  );

  /*
   * Built on first use rather than at collection.
   *
   * `describe.skipIf` skips the tests and still runs the suite body, so a client constructed
   * here would be constructed on every ordinary `vitest run` — with no chain id and no RPC,
   * which throws during collection and reports this file as failing rather than as skipped.
   */
  function connect() {
    const chain = defineChain({
      id: chainId,
      name: "the proof rig",
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [rpc] } },
    });

    return {
      reader: createPublicClient({ chain, transport: http(rpc) }),
      // The account and the chain are bound here rather than passed per call, which is also
      // what keeps every `writeContract` below free of them.
      wallet: createWalletClient({ account: creator, chain, transport: http(rpc) }),
    };
  }

  let clients: ReturnType<typeof connect> | null = null;

  function rig(): ReturnType<typeof connect> {
    clients ??= connect();
    return clients;
  }

  // A uuid, because `launched.ts` builds a path from it and checks the shape rather than
  // trusting it. Fixed rather than random, so a second run against a chain that already has
  // this market collides loudly instead of quietly launching another one.
  const jobId = "eee11111-1111-4111-8111-111111111111";

  const compiled = compile(spec(), {
    referenceSupply: SUPPLY,
    quoteAsset: { address: NATIVE, symbol: "ETH", decimals: 18 },
    launchedTokenSymbol: "PROOF",
  });

  if (LAUNCHING && !compiled.ok) {
    throw new Error(
      `the proof's own market does not compile: ${compiled.problems.map((p) => p.code).join(", ")}`,
    );
  }

  const config = compiled.ok ? compiled.config : null;
  const encodedConfig = config === null ? ("0x" as Hex) : encodeConfig(config);
  const commitment = config === null ? ("0x" as Hex) : configHash(config);
  const identity =
    config === null
      ? ("0x" as Hex)
      : implementationHash(config, { chainId, engine: hook, engineVersion: 1 });

  /** Carried between stages, so a failure names the stage rather than the fixture. */
  const state: {
    calldata?: Hex;
    launchTx?: Hex;
    token?: Address;
    poolId?: Hex;
    vault?: Address;
    marketIndex?: bigint;
    launchBlock?: bigint;
    trades: Trade[];
  } = { trades: [] };

  function poolKey(token: Address) {
    return {
      currency0: NATIVE,
      currency1: token,
      fee: DYNAMIC_FEE,
      tickSpacing: TICK_SPACING,
      hooks: hook,
    } as const;
  }

  function launchedToken(): Address {
    const token = state.token;
    if (token === undefined) throw new Error("no market was registered");
    return token;
  }

  /**
   * What the chain says one trade cost, from the two events that both describe it.
   *
   * `FeeTaken` is the hook's own account of the rate it chose and the amount it took. `Swap` is
   * the pool's, and its `fee` field is recorded here precisely because it is *zero* on an engine
   * market: the hook zeroes the LP fee and takes Agen's as a delta. An indexer inferring the
   * rate from Uniswap would report every one of these trades as free, and the assertions
   * downstream compare against both numbers to prove it does not.
   */
  async function recordTrade(
    kind: "buy" | "sell",
    via: "pool" | "router",
    hash: Hex,
  ): Promise<Trade> {
    const receipt = await rig().reader.waitForTransactionReceipt({ hash });
    expect(receipt.status, `the ${kind} reverted on chain`).toBe("success");

    const fees = parseEventLogs({
      abi: abi.agenEngineHookAbi,
      eventName: "FeeTaken",
      logs: receipt.logs,
    });
    expect(fees.length, `the ${kind} emitted no FeeTaken, so the hook charged nothing`).toBe(1);

    const swaps = parseEventLogs({
      abi: abi.poolManagerAbi,
      eventName: "Swap",
      logs: receipt.logs,
    }).filter((entry) => entry.args.id === state.poolId);
    expect(swaps.length, `the ${kind} did not swap this market's pool`).toBe(1);

    const fee = fees[0]!.args;
    const swap = swaps[0]!.args;

    expect(fee.poolId).toBe(state.poolId);
    expect(fee.isBuy).toBe(kind === "buy");
    expect(fee.feePpm, `the ${kind} was charged nothing`).toBeGreaterThan(0);

    return {
      kind,
      via,
      txHash: hash,
      blockNumber: receipt.blockNumber.toString(),
      feePpm: fee.feePpm,
      feeAmount: fee.feeAmount.toString(),
      grossQuoteAmount: fee.grossQuoteAmount.toString(),
      grossTokenAmount: fee.grossTokenAmount.toString(),
      quoteAmount: (swap.amount0 < 0n ? -swap.amount0 : swap.amount0).toString(),
      tokenAmount: (swap.amount1 < 0n ? -swap.amount1 : swap.amount1).toString(),
      poolReportedFeePpm: swap.fee,
      sender: swap.sender,
    };
  }

  it("has a build the server will prepare a launch for", async () => {
    await app!.builds.jobStore().write({
      id: jobId,
      engineVersion: 1,
      stage: "deployment_ready",
      name: "Proof",
      symbol: "PROOF",
      prompt: "Launch Proof, ticker PROOF, 1% to buy and 2% to sell, all to me.",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      approval: null,
      manifest: null,
      specification: null,
      plan: null,
      sources: [],
      tests: [],
      testOutcomes: [],
      gateFindings: [],
      intent: null,
      semanticCoverage: null,
      simulation: null,
      compilationAttempts: 0,
      testAttempts: 0,
      harnessAttempts: 0,
      failure: null,
      engine: {
        encodedConfig,
        configHash: commitment,
        implementationHash: identity,
        summary: {
          headline: "A market charging 1% to buy and 2% to sell.",
          ruleCount: 1,
          hasPhases: false,
          openingBuyPpm: 10_000,
          openingSellPpm: 20_000,
        },
        review: { cards: [], rows: [] },
        preparation: { supply: SUPPLY.toString() },
      },
    } as never);

    const stored = await app!.builds.jobStore().read(jobId);
    expect(stored?.stage).toBe("deployment_ready");
  });

  it("accepts the creator's approval of exactly these rules", async () => {
    const message = engineApprovalMessage({
      jobId,
      engineVersion: 1,
      configHash: commitment,
      implementationHash: identity,
      creator: creator.address,
    });

    const approved = await app!.builds.approveBuild({
      jobId,
      creator: creator.address,
      signature: await creator.signMessage({ message }),
    });

    expect(approved.ok, `approval was refused: ${approved.error ?? ""}`).toBe(true);
  });

  it("prepares calldata for the deployed factory", async () => {
    const prepared = await app!.launch.prepareEngineLaunch({
      jobId,
      creator: creator.address,
      feeReceiver: creator.address,
    });

    expect(prepared.to).toBe(factory);
    expect(prepared.chainId).toBe(chainId);
    expect(prepared.implementationHash).toBe(identity);
    expect(prepared.configHash).toBe(commitment);
    expect(prepared.quoteIsNative).toBe(true);

    state.calldata = prepared.data;
  });

  it("lands that calldata on the real factory", async () => {
    const data = state.calldata;
    if (data === undefined) throw new Error("no calldata was prepared");

    // No value. An engine launch mints its supply and puts all of it into the three bands, so
    // the quote side of the opening position is empty and the creator pays only gas.
    const hash = await rig().wallet.sendTransaction({ to: factory, data, value: 0n });
    const receipt = await rig().reader.waitForTransactionReceipt({ hash });

    expect(receipt.status, "the launch transaction reverted on chain").toBe("success");

    state.launchTx = hash;
    state.launchBlock = receipt.blockNumber;
  });

  /*
   * The stage the whole gate is about, on the app's side of it.
   *
   * `recordLaunch` is the shipped decoder, given a receipt nobody synthesised. Before the fixes
   * it refused every engine launch outright — it only knew engine 0's event — so a creator's
   * market existed on chain and nowhere in the product that made it.
   */
  it("registers the launch from the real receipt", async () => {
    const hash = state.launchTx;
    if (hash === undefined) throw new Error("nothing was launched");

    const record = await app!.launched.recordLaunch(jobId, hash);

    expect(record.engineVersion).toBe(1);
    expect(record.implementationHash).toBe(identity);
    expect(record.configHash).toBe(commitment);
    expect(record.creator.toLowerCase()).toBe(creator.address.toLowerCase());
    expect(record.hook.toLowerCase()).toBe(hook.toLowerCase());
    expect(record.token).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(record.vault, "the launch recorded no vault").toBeDefined();

    state.token = getAddress(record.token);
    state.poolId = record.poolId as Hex;
    state.vault = getAddress(record.vault!);

    // Persisted, which is what every later read depends on.
    const stored = await app!.launched.readLaunch(jobId);
    expect(stored?.poolId).toBe(record.poolId);
  });

  it("agrees with the registry about which market this is", async () => {
    const token = launchedToken();

    const record = await rig().reader.readContract({
      abi: abi.agenMarketRegistryAbi,
      address: registry,
      functionName: "marketByToken",
      args: [token],
    });

    expect(record.token.toLowerCase()).toBe(token.toLowerCase());
    expect(record.poolId).toBe(state.poolId);
    expect(record.creator.toLowerCase()).toBe(creator.address.toLowerCase());
    expect(record.quoteAsset.toLowerCase()).toBe(NATIVE);

    // The last index in the registry is this market's, which is how the indexer reads its
    // components. Taken from the registry rather than assumed to be zero: the rig may have
    // launched others before this one.
    const count = await rig().reader.readContract({
      abi: abi.agenMarketRegistryAbi,
      address: registry,
      functionName: "count",
    });
    state.marketIndex = count - 1n;
  });

  /*
   * The pool key, proved rather than assumed.
   *
   * Everything below swaps against this key, and a key that hashed to a different pool would
   * trade some other market — or nothing — while every assertion here still passed. v4's pool
   * id is the hash of the whole key, so equality with the id the factory emitted is proof that
   * the fee flag, the tick spacing and the hook in it are the market's own.
   */
  it("computes the market's own pool key", () => {
    const derived = keccak256(encodeAbiParameters(POOL_KEY_TUPLE, [poolKey(launchedToken())]));
    expect(derived, "the pool key this proof trades against is not the market's").toBe(
      state.poolId,
    );
  });

  it("buys, and the hook charges the buy rate", async () => {
    // Well inside the opening band, so this is an ordinary trade rather than a test of what
    // happens when one buy crosses the whole first position.
    const spend = parseEther("0.05");

    const hash = await rig().wallet.writeContract({
      abi: SWAP_ROUTER_ABI,
      address: swapRouter,
      functionName: "swap",
      args: [
        poolKey(launchedToken()),
        { zeroForOne: true, amountSpecified: -spend, sqrtPriceLimitX96: MIN_SQRT_PRICE + 1n },
        { takeClaims: false, settleUsingBurn: false },
        "0x",
      ],
      value: spend,
    });

    state.trades.push(await recordTrade("buy", "pool", hash));
  });

  it("sells, and the hook charges the sell rate", async () => {
    const token = launchedToken();

    const held = await rig().reader.readContract({
      abi: ERC20_ABI,
      address: token,
      functionName: "balanceOf",
      args: [creator.address],
    });
    expect(held, "the buy delivered no tokens, so there is nothing to sell").toBeGreaterThan(0n);

    await rig().reader.waitForTransactionReceipt({
      hash: await rig().wallet.writeContract({
        abi: ERC20_ABI,
        address: token,
        functionName: "approve",
        args: [swapRouter, held],
      }),
    });

    const hash = await rig().wallet.writeContract({
      abi: SWAP_ROUTER_ABI,
      address: swapRouter,
      functionName: "swap",
      args: [
        poolKey(token),
        {
          zeroForOne: false,
          amountSpecified: -(held / 2n),
          sqrtPriceLimitX96: MAX_SQRT_PRICE - 1n,
        },
        { takeClaims: false, settleUsingBurn: false },
        "0x",
      ],
    });

    state.trades.push(await recordTrade("sell", "pool", hash));
  });

  /*
   * The same two trades again, through the contract a real trade goes through.
   *
   * Everything above proves the pool, the hook and the indexer. It says nothing about
   * `AgenRouter`, which is what the token page's trade panel calls — and until this ran, no
   * engine market had ever been traded through it on any chain.
   *
   * The specific risk it closes is settlement. The router settles the input *before* the swap
   * and then takes the output and any unspent input back out, all inside one lock; the engine
   * hook takes its fee as an additional delta in the middle of that. A router that computed its
   * own expected balances would revert here, or settle the wrong amount, on a pool that trades
   * perfectly well through a bare router.
   */
  it("buys again, through AgenRouter, which is what the product calls", async () => {
    const spend = parseEther("0.02");

    const hash = await rig().wallet.writeContract({
      abi: AGEN_ROUTER_ABI,
      address: agenRouter,
      functionName: "swap",
      // `minAmountOut` of zero: this is a one-sided pool nobody else is trading, so there is no
      // slippage to protect against and a floor here would only be asserting the price.
      args: [poolKey(launchedToken()), true, spend, 0n, "0x"],
      value: spend,
    });

    state.trades.push(await recordTrade("buy", "router", hash));
  });

  it("sells again, through AgenRouter", async () => {
    const token = launchedToken();

    const held = await rig().reader.readContract({
      abi: ERC20_ABI,
      address: token,
      functionName: "balanceOf",
      args: [creator.address],
    });
    expect(held, "there is nothing left to sell through the router").toBeGreaterThan(0n);

    // A plain allowance to the router, which is what the trade panel asks for. The router pulls
    // the input straight to the PoolManager, so nothing is ever held here to be drained.
    await rig().reader.waitForTransactionReceipt({
      hash: await rig().wallet.writeContract({
        abi: ERC20_ABI,
        address: token,
        functionName: "approve",
        args: [agenRouter, held],
      }),
    });

    const hash = await rig().wallet.writeContract({
      abi: AGEN_ROUTER_ABI,
      address: agenRouter,
      functionName: "swap",
      args: [poolKey(token), false, held / 2n, 0n, "0x"],
    });

    state.trades.push(await recordTrade("sell", "router", hash));
  });

  it("charged the rates the engine derived, on every route", () => {
    expect(state.trades.length, "four trades were expected").toBe(4);

    for (const trade of state.trades) {
      const expected = trade.kind === "buy" ? 10_000 : 20_000;
      expect(trade.feePpm, `the ${trade.via} ${trade.kind} was charged the wrong rate`).toBe(
        expected,
      );

      // The fee is a flat proportion of the leg it is taken from, by integer division — so this
      // is exact rather than approximate, and a fee taken from the wrong leg fails it.
      expect(BigInt(trade.feeAmount)).toBe(
        (BigInt(trade.grossQuoteAmount) * BigInt(trade.feePpm)) / 1_000_000n,
      );
    }
  });

  /*
   * That the product's own route was really the route.
   *
   * The PoolManager reports whoever called it, so a trade through `AgenRouter` names the router
   * and a trade through the rig's bare one names that. Without this the two pairs above could
   * both have gone the same way and the router would be untested while everything passed.
   */
  it("took the product's route for two of them, and the bare one for two", () => {
    const viaRouter = state.trades.filter((trade) => trade.via === "router");
    const viaPool = state.trades.filter((trade) => trade.via === "pool");

    expect(viaRouter.length).toBe(2);
    expect(viaPool.length).toBe(2);

    for (const trade of viaRouter) {
      expect(trade.sender.toLowerCase(), `the ${trade.kind} did not go through AgenRouter`).toBe(
        agenRouter.toLowerCase(),
      );
    }
    for (const trade of viaPool) {
      expect(trade.sender.toLowerCase()).toBe(swapRouter.toLowerCase());
    }
  });

  it("collected every fee into the market's own vault", async () => {
    const vault = state.vault;
    if (vault === undefined) throw new Error("no vault was recorded");

    const [currency, accrued] = await Promise.all([
      rig().reader.readContract({
        abi: abi.agenEngineVaultAbi,
        address: vault,
        functionName: "currency",
      }),
      rig().reader.readContract({
        abi: abi.agenEngineVaultAbi,
        address: vault,
        functionName: "totalAccrued",
      }),
    ]);

    // Native, because this market has no size tiers. ADR-018 moves it to the launched token
    // when it does, and the tiered half of that is proved by the contract suite.
    expect(currency.toLowerCase()).toBe(NATIVE);
    expect(accrued).toBe(state.trades.reduce((total, trade) => total + BigInt(trade.feeAmount), 0n));
  });

  /** Everything the indexer's assertions and the app's second phase are held to. */
  it("records what the chain said", () => {
    const { token, poolId, vault, launchTx, launchBlock, marketIndex } = state;

    if (
      token === undefined ||
      poolId === undefined ||
      vault === undefined ||
      launchTx === undefined ||
      launchBlock === undefined ||
      marketIndex === undefined
    ) {
      throw new Error("the launch did not complete, so there is nothing to record");
    }

    expect(state.trades.length, "not every trade completed").toBe(4);

    const proof: Proof = {
      jobId,
      creator: creator.address,
      token,
      poolId,
      vault,
      hook,
      quoteAsset: NATIVE,
      configHash: commitment,
      implementationHash: identity,
      encodedConfig,
      marketIndex: marketIndex.toString(),
      launchTx,
      launchBlock: launchBlock.toString(),
      lpFee: DYNAMIC_FEE,
      tickSpacing: TICK_SPACING,
      openingBuyPpm: 10_000,
      openingSellPpm: 20_000,
      vaultCurrency: NATIVE,
      vaultTotalAccrued: state.trades
        .reduce((total, trade) => total + BigInt(trade.feeAmount), 0n)
        .toString(),
      router: agenRouter,
      trades: state.trades,
    };

    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, `${JSON.stringify(proof, null, 2)}\n`);
  });
});

// --- phase two: the app, against the live indexer ---------------------------

describe.skipIf(!ASSERTING)("the launched market, read back through the app", () => {
  const output = ASSERTING ? required("AGEN_ENGINE_PROOF_OUTPUT") : "";

  let proof: Proof;

  it("has a launch to read, and an indexer to read it from", async () => {
    proof = JSON.parse(await readFile(output, "utf8")) as Proof;

    expect(proof.trades.length, "the launch phase did not record four trades").toBe(4);

    // Without this every trade assertion below would be passing on an empty answer, because
    // `feed.ts` treats an unconfigured indexer as "no history" rather than as an error.
    expect(process.env["AGEN_FEED_URL"]?.trim() ?? "", "the app has no indexer to read").not.toBe(
      "",
    );
  });

  /*
   * The listing, through the function the shelves call.
   *
   * `trading` is the load-bearing part. `phase` is "live" as soon as a launch record exists,
   * deliberately, so it cannot tell a registry read that went to the engine's registry from one
   * that went to engine 0's and found nothing. A price can.
   */
  it("appears on the listing, with figures from its own registry", async () => {
    const listed = await app!.markets.marketSource().list();
    const found = listed.find((entry) => entry.id === proof.jobId);

    expect(found, "the launched engine market is not on the listing").toBeDefined();
    expect(found?.phase).toBe("live");
    expect(found?.tokenAddress?.toLowerCase()).toBe(proof.token.toLowerCase());
    expect(found?.creator?.toLowerCase()).toBe(proof.creator.toLowerCase());
    expect(found?.trading, "the market has no figures, so its registry was not read").toBeDefined();
    expect(found?.trading?.price).toBeGreaterThan(0);
    expect(found?.trading?.marketCap).toBeGreaterThan(0);
    expect(found?.trading?.liquidity).toBeGreaterThan(0);
  });

  it("resolves on its own market page, with both commitments intact", async () => {
    const detail = await app!.markets.marketSource().read(proof.jobId);

    if (detail === null || detail.kind !== "programmable" || detail.engineVersion !== 1) {
      throw new Error("the market page did not resolve as an engine-v1 market");
    }

    expect(detail.phase).toBe("live");
    expect(detail.poolId).toBe(proof.poolId);
    expect(detail.configHash).toBe(proof.configHash);
    expect(detail.implementationHash).toBe(proof.implementationHash);
    expect(detail.tokenAddress?.toLowerCase()).toBe(proof.token.toLowerCase());
    // The engine's own derivation of the opening rates, which is what the page states.
    expect(detail.openingBuyPpm).toBe(proof.openingBuyPpm);
    expect(detail.openingSellPpm).toBe(proof.openingSellPpm);
    // The pool, read through the app's own chain module rather than through the indexer.
    expect(detail.lpFee).toBe(proof.lpFee);
    expect(detail.trading?.price).toBeGreaterThan(0);
  });

  /*
   * The fix this stage exists to hold: `buildStoreSource().trades` returned `[]` for every
   * programmable market. The page said "No trades yet" about a market with two trades in it,
   * and no test anywhere could have caught it — the indexer had never indexed an engine swap.
   */
  it("shows every real trade, with the fee the hook actually took", async () => {
    const trades = await app!.markets.marketSource().trades(proof.jobId);

    expect(trades.length, "the trade list is empty or short for a market that has traded").toBe(
      proof.trades.length,
    );

    for (const expected of proof.trades) {
      const shown = trades.find(
        (trade) => trade.txHash.toLowerCase() === expected.txHash.toLowerCase(),
      );

      const label = `the ${expected.via} ${expected.kind}`;
      expect(shown, `${label} is missing from the trade list`).toBeDefined();
      expect(shown?.side).toBe(expected.kind);

      /*
       * From `FeeTaken`, which is the only place these numbers exist.
       *
       * The pool's own Swap event reported zero on every one of these trades — measured off the
       * chain in the launch phase and restated here — so a rate on this row is a rate read from
       * the hook. An indexer inferring it from Uniswap would put a dash on the page instead.
       */
      expect(expected.poolReportedFeePpm, `${label}'s pool fee should be zero`).toBe(0);
      expect(shown?.feePpm, `${label} shows the wrong rate`).toBe(expected.feePpm);
      expect(shown?.trader.toLowerCase()).toBe(expected.sender.toLowerCase());

      // The legs, as whole units of each side. Non-zero on both, which is what distinguishes a
      // rendered trade from a row the page cannot describe.
      expect(shown?.amountEth).toBeGreaterThan(0);
      expect(shown?.tokens).toBeGreaterThan(0);
    }
  });

  /*
   * And that the trades taken through the product's own router are among them.
   *
   * A page that showed only the trades made by a bare test router would be a page missing every
   * real one, which is the shape of failure this whole file exists to catch.
   */
  it("includes the trades made through AgenRouter", async () => {
    const trades = await app!.markets.marketSource().trades(proof.jobId);
    const throughRouter = trades.filter(
      (trade) => trade.trader.toLowerCase() === proof.router.toLowerCase(),
    );

    expect(throughRouter.length, "no trade on the page went through AgenRouter").toBe(2);
    for (const trade of throughRouter) {
      expect(trade.feePpm).toBeGreaterThan(0);
    }
  });
});
