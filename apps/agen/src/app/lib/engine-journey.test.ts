/**
 * One engine-v1 market, carried through the app the way a creator carries it.
 *
 * ## What this covers that nothing else does
 *
 * Every layer already has tests. The engine has them, the hook and factory have them,
 * `EngineJourney.t.sol` walks a prompt's calldata onto a real `PoolManager` and checks the fee
 * against what the TypeScript predicted. The approval message has golden vectors and the
 * registration decoder has its own suite.
 *
 * What none of them establish is that the app's stages are *joined*. Each can be perfectly
 * correct about a different market and every suite stays green — which is exactly what
 * happened: the review screen, the approval, the calldata and the contracts were all right,
 * and a launched market was invisible in the product because two functions in between had
 * never been asked to agree. Registration only knew engine 0's event, and the registry read
 * only knew engine 0's registry.
 *
 * So this runs the app's own modules in order, with no reimplementation of any step:
 *
 *   canonical config -> commitment -> approval message -> real wallet signature
 *   -> `approveBuild`      (the real verifier)
 *   -> `prepareEngineLaunch` (the real calldata, and the real commitment re-check)
 *   -> `recordLaunch`      (the real receipt decoder)
 *   -> `readLaunch`        (the persisted state)
 *   -> `marketSource().list()` and `.read()`  (the listing and the market page)
 *
 * ## Where the chain is and is not real
 *
 * The receipt is synthesised and the registry read is stubbed; everything between them is the
 * shipped code. That division is deliberate. Whether the factory emits this event with these
 * fields is a question about Solidity, and `EngineLaunch.t.sol` and `EngineJourney.t.sol`
 * answer it against a real `PoolManager` — repeating it here would be a worse version of a
 * test that already exists. What is unproven, and what this proves, is that the app reads that
 * event correctly and carries what it read all the way to a page.
 *
 * The event is encoded through the same ABI the decoder reads, so a change to the event's
 * shape breaks this at the encoder rather than producing a log that decodes to wrong fields.
 *
 * ## Why it runs ten times
 *
 * Because the failure being guarded against was not a crash. Nothing threw; a market was
 * simply absent. A single passing journey establishes that the path can work once, which is
 * also what the broken version would have shown if the fixture happened to line up — so the
 * gate asks for a run of them, on both market shapes that matter, with the store cleared
 * between each.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { compile, configHash, encodeConfig, implementationHash } from "@verdant/market-engine";
import type { AgenMarketSpec, CanonicalConfig } from "@verdant/market-engine";
import { engineApprovalMessage } from "@verdant/market-compiler";
import { abi } from "@verdant/sdk";
import {
  encodeAbiParameters,
  encodeEventTopics,
  getAddress,
  keccak256,
  stringToHex,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { beforeEach, describe, expect, it, vi } from "vitest";

// --- the deployment these journeys run against -----------------------------

function addr(tail: string): Address {
  return getAddress(`0x${tail.toLowerCase().padStart(40, "0")}`);
}

const CHAIN_ID = 4663;
const ENGINE = {
  factory: addr("f0001"),
  hook: addr("38cc"),
  deployer: addr("d0001"),
  registry: addr("e0001"),
} as const;

const NATIVE_QUOTE = addr("0");
const SUPPLY = 1_000_000_000n * 10n ** 18n;

/** Anvil's first account, so the signature is a real one from a real key. */
const CREATOR_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
const creator = privateKeyToAccount(CREATOR_KEY);

/**
 * A real job store and a real launch store, in a temp directory.
 *
 * Set before anything imports `./builds`, because `GENERATED_ROOT` is resolved once at module
 * load. The alternative was a partial mock of `./builds` that replaced `jobStore` — which
 * silently does not work: `approveBuild` closes over its own module's `jobStore`, so the real
 * one is what it would read while this file wrote to the fake, and every approval failed with
 * "there is no build with that id". Pointing the real store at a temp directory is both
 * simpler and a better test, since the store is then also the shipped one.
 */
const ROOT = mkdtempSync(resolve(tmpdir(), "agen-engine-journey-"));
process.env["AGEN_DATA_DIR"] = ROOT;

// --- the two markets -------------------------------------------------------

/**
 * Native ETH, one rate forever. The simplest market the engine launches, and the one the
 * go-live gate names first.
 */
function flatSpec(): AgenMarketSpec {
  return {
    engineVersion: 1,
    baseRate: { buy: "1", sell: "2" },
    ladder: null,
    sizeTiers: [],
    distribution: [{ recipient: { kind: "CREATOR" }, share: "100" }],
    protections: [],
  };
}

/**
 * Native ETH with a size tier, which by ADR-018 moves the fee currency to the launched
 * token. The two shapes exercise the two settlement paths, so a journey that only ever ran
 * the flat one would leave the tiered fee currency untested end to end.
 */
function tieredSpec(): AgenMarketSpec {
  return {
    engineVersion: 1,
    baseRate: { buy: "0.5", sell: "0.5" },
    ladder: null,
    sizeTiers: [
      {
        side: "SELL",
        measure: { kind: "PERCENT_REFERENCE_SUPPLY", percent: "1", operator: "GTE" },
        rate: "4",
      },
    ],
    distribution: [
      { recipient: { kind: "CREATOR" }, share: "80" },
      { recipient: { kind: "TREASURY" }, share: "20" },
    ],
    protections: [],
  };
}

interface Market {
  readonly name: string;
  readonly config: CanonicalConfig;
  readonly encodedConfig: Hex;
  readonly configHash: Hex;
  readonly implementationHash: Hex;
}

function marketFrom(name: string, spec: AgenMarketSpec): Market {
  const compiled = compile(spec, {
    referenceSupply: SUPPLY,
    quoteAsset: { address: NATIVE_QUOTE, symbol: "ETH", decimals: 18 },
    launchedTokenSymbol: "FLOW",
  });

  if (!compiled.ok) {
    throw new Error(
      `the ${name} fixture does not compile: ${compiled.problems.map((p) => p.code).join(", ")}`,
    );
  }

  return {
    name,
    config: compiled.config,
    encodedConfig: encodeConfig(compiled.config),
    configHash: configHash(compiled.config),
    // The same identity the factory recomputes on chain, and the same one `prepareLaunch`
    // derives from the addresses below. If these disagree the launch is refused, which is the
    // check this journey most wants to have actually run rather than mocked.
    implementationHash: implementationHash(compiled.config, {
      chainId: CHAIN_ID,
      engine: ENGINE.hook,
      engineVersion: 1,
    }),
  };
}

const FLAT = marketFrom("native flat", flatSpec());
const TIERED = marketFrom("native tiered", tieredSpec());

// --- the build a creator would have -----------------------------------------

interface StoredJob {
  id: string;
  engineVersion: 1;
  stage: string;
  [key: string]: unknown;
}

/** A build that reached `deployment_ready`, as the engine pipeline leaves one. */
function jobFor(id: string, market: Market): StoredJob {
  return {
    id,
    engineVersion: 1,
    stage: "deployment_ready",
    name: "Flow",
    symbol: "FLOW",
    prompt: "Launch Flow, ticker FLOW.",
    createdAt: 1_786_890_000_000,
    updatedAt: 1_786_890_000_000,
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
      encodedConfig: market.encodedConfig,
      configHash: market.configHash,
      implementationHash: market.implementationHash,
      // What the listing and the market page describe the market from. The engine derives
      // these; nothing in the app recomputes them.
      summary: {
        headline: `A market charging ${market.name === "native flat" ? "1% to buy and 2% to sell" : "0.5%, and 4% on large sells"}.`,
        ruleCount: 1,
        hasPhases: false,
        openingBuyPpm: market.name === "native flat" ? 10_000 : 5_000,
        openingSellPpm: market.name === "native flat" ? 20_000 : 5_000,
      },
      review: { cards: [], rows: [] },
      preparation: { supply: SUPPLY.toString(), predicted: { vault: addr("704a17") } },
    },
  };
}

// --- the chain, at the two points a journey touches it ---------------------

let receipt: { status: "success" | "reverted"; logs: readonly unknown[] } | null = null;

const TX = `0x${"ab".repeat(32)}` as Hex;
const BLOCK_NUMBER = 4_663_000n;
const BLOCK_TIMESTAMP = 1_786_890_183n;

const TOKEN = addr("701234");
const POOL_ID = `0x${"77".repeat(32)}` as Hex;
const VAULT = addr("704a17");
const LOCKER = addr("7010c3");

/**
 * The launch event, encoded through the ABI the decoder reads.
 *
 * The commitment carried here is the market's real one, so `recordLaunch`'s parity check is
 * exercised rather than bypassed: a journey whose event carried an arbitrary hash would fail
 * at registration, which is what makes this the right value rather than a convenient one.
 */
function launchLog(market: Market) {
  return {
    address: ENGINE.factory,
    topics: encodeEventTopics({
      abi: abi.agenEngineFactoryAbi,
      eventName: "EngineMarketDeployed",
      args: { index: 1n, token: TOKEN, creator: creator.address },
    }) as Hex[],
    data: encodeAbiParameters(
      [
        { name: "poolId", type: "bytes32" },
        { name: "vault", type: "address" },
        { name: "locker", type: "address" },
        { name: "engineVersion", type: "uint8" },
        { name: "configHash", type: "bytes32" },
        { name: "implementationHash", type: "bytes32" },
      ],
      [POOL_ID, VAULT, LOCKER, 1, market.configHash, market.implementationHash],
    ),
  };
}

/** The noise a real launch receipt is mostly made of: transfers, mints, the registry write. */
function noise() {
  return [
    { address: TOKEN, topics: [keccak256(stringToHex("Transfer"))], data: "0x" as Hex },
    { address: ENGINE.registry, topics: [keccak256(stringToHex("Registered"))], data: "0x" as Hex },
    { address: ENGINE.hook, topics: [keccak256(stringToHex("MarketConfigured"))], data: "0x" as Hex },
  ];
}

/** What the engine registry says about the launched market, once it exists. */
let registryKnowsMarket = true;

vi.mock("./chain", () => ({
  CHAIN_ID: 4663,
  AGEN_ADDRESSES: {
    ok: true,
    addresses: { factory: addr("f0000"), deployer: addr("d0000"), registry: addr("e0000") },
  },
  EXTERNAL: { stateView: addr("57a7e") },
  chain: {
    id: 4663,
    name: "test",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: ["http://127.0.0.1:8545"] } },
  },
}));

vi.mock("./programmable", () => ({
  ENGINE_NOT_DEPLOYED: "the engine is not deployed here",
  engineAddressesOrNull: () => ENGINE,
  engineTokenSalt: (jobId: string) => keccak256(stringToHex(`agen.engine.${jobId}`)),
}));

/*
 * The chain, at exactly two points.
 *
 * `publicClient` answers the launch receipt; `readLiveMarket` answers the registry. Both are
 * stubbed and nothing between them is — see the note at the top of the file on where the real
 * chain is proven instead.
 */
vi.mock("./onchain", () => ({
  publicClient: () => ({
    getTransactionReceipt: async () => {
      if (receipt === null) throw new Error("not found");
      return { ...receipt, blockNumber: BLOCK_NUMBER, from: creator.address, transactionHash: TX };
    },
    getBlock: async () => ({ timestamp: BLOCK_TIMESTAMP }),
  }),
  registryFor: (engineVersion: number) => (engineVersion === 1 ? ENGINE.registry : addr("e0000")),
  readLiveMarket: async (token: Address, engineVersion: number) => {
    // The routing this returns is asserted directly in `engine-registry-routing.test.ts`; here
    // it stands in for the chain, and refusing an engine-0 lookup keeps a regression in the
    // caller from passing unnoticed.
    if (engineVersion !== 1 || !registryKnowsMarket) return null;

    return {
      token,
      hook: ENGINE.hook,
      poolId: POOL_ID,
      creator: creator.address,
      quoteAsset: NATIVE_QUOTE,
      metadataURI: "https://agen.space/api/metadata/x.json",
      createdAt: Number(BLOCK_TIMESTAMP),
      lpFee: 0x800000,
      price: 0.000_000_01,
      liquidity: 10n ** 18n,
      tick: 0,
      sqrtPriceX96: 79_228_162_514_264_337_593_543_950_336n,
    };
  },
}));

// No indexer in a unit test. The trade list and the day's figures are absent rather than
// invented, which is what a market that has just launched looks like anyway.
vi.mock("./feed", () => ({
  fetchMarketStats: async () => null,
  fetchCandles: async () => null,
  fetchAgenTrades: async () => [],
}));

vi.mock("./instant-markets", () => ({
  readInstantMarkets: async () => [],
  readInstantMarket: async () => null,
}));

vi.mock("./instant-feed", () => ({
  fetchInstantStats: async () => null,
  fetchInstantCandles: async () => null,
  fetchInstantTrades: async () => [],
}));

vi.mock("./instant", () => ({
  absoluteUrl: (path: string) => `https://agen.space${path}`,
}));

const { approveBuild, jobStore } = await import("./builds");
const { prepareEngineLaunch } = await import("./engine-launch");
const { readLaunch, recordLaunch } = await import("./launched");
const { marketSource } = await import("./markets");

// --- the journey -----------------------------------------------------------

interface Journey {
  readonly jobId: string;
  readonly approvalMessage: string;
  readonly signature: Hex;
  readonly calldata: Hex;
  readonly to: Address;
}

/**
 * One market, from a compiled configuration to a page that shows it.
 *
 * Every step calls the shipped function. Nothing is reimplemented and nothing is skipped, so
 * a failure names the stage that broke rather than the fixture.
 */
async function journey(market: Market, run: number): Promise<Journey> {
  // A uuid-shaped id, because `launched.ts` builds a filesystem path from it and checks the
  // shape rather than trusting it.
  const jobId = `${String(run).padStart(8, "0")}-1111-4111-8111-111111111111`;

  await jobStore().write(jobFor(jobId, market) as never);

  // 1. The exact bytes the wallet will sign, from the one canonical builder.
  const approvalMessage = engineApprovalMessage({
    jobId,
    engineVersion: 1,
    configHash: market.configHash,
    implementationHash: market.implementationHash,
    creator: creator.address,
  });

  // 2. A real signature from a real key over those bytes.
  const signature = await creator.signMessage({ message: approvalMessage });

  // 3. The server's own verifier. It rebuilds the message from the stored job and recovers
  //    the signer, so a message that differed by one byte would fail here.
  const approved = await approveBuild({ jobId, creator: creator.address, signature });
  expect(approved.ok, `approval was refused: ${approved.error ?? ""}`).toBe(true);

  // 4. The calldata a wallet would be handed, with the commitment re-checked against the
  //    approval before any of it is returned.
  const prepared = await prepareEngineLaunch({
    jobId,
    creator: creator.address,
    feeReceiver: creator.address,
  });

  expect(prepared.engineVersion).toBe(1);
  expect(prepared.chainId).toBe(CHAIN_ID);
  expect(prepared.to).toBe(ENGINE.factory);
  expect(prepared.implementationHash).toBe(market.implementationHash);
  expect(prepared.configHash).toBe(market.configHash);
  expect(prepared.quoteIsNative).toBe(true);
  expect(prepared.quoteAsset).toBe(NATIVE_QUOTE);

  // 5. The factory's event, decoded by the app rather than by this test.
  receipt = { status: "success", logs: [...noise(), launchLog(market)] };
  const record = await recordLaunch(jobId, TX);

  expect(record.engineVersion).toBe(1);
  expect(record.token).toBe(TOKEN);
  expect(record.poolId).toBe(POOL_ID);
  expect(record.vault).toBe(VAULT);
  expect(record.creator).toBe(creator.address);
  expect(record.implementationHash).toBe(market.implementationHash);

  // 6. Persisted, and readable by anything that asks later.
  const stored = await readLaunch(jobId);
  expect(stored, "the launch was not persisted").not.toBeNull();
  expect(stored?.engineVersion).toBe(1);

  return {
    jobId,
    approvalMessage,
    signature,
    calldata: prepared.data,
    to: prepared.to,
  };
}

beforeEach(() => {
  receipt = null;
  registryKnowsMarket = true;

  // Both stores emptied, so every run is a first launch of a build nothing has seen. The
  // listing reads every job on disk, so a leftover from a previous case would otherwise make
  // "is this market on the shelf" pass for the wrong reason.
  rmSync(resolve(ROOT, "_launched"), { recursive: true, force: true });
  rmSync(resolve(ROOT, "_jobs"), { recursive: true, force: true });
});

describe.each([
  ["native flat", FLAT],
  ["native tiered", TIERED],
])("a %s engine market, end to end", (name, market) => {
  /*
   * Ten runs. The bug this file exists for did not throw — a market was simply absent — and a
   * single green journey is exactly what the broken version would have produced if the one
   * fixture happened to line up. The store is cleared between runs, so each is a first launch.
   */
  it.each([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])(`completes on run %i`, async (run) => {
    const completed = await journey(market, run);

    // The calldata is addressed at the engine factory and carries something. Its contents are
    // proved against a real chain by `EngineJourney.t.sol`, which executes exactly these bytes.
    expect(completed.to).toBe(ENGINE.factory);
    expect(completed.calldata.length).toBeGreaterThan(1_000);
  });

  it("is discoverable on the listing once launched", async () => {
    const completed = await journey(market, 1);

    const listed = await marketSource().list();
    const found = listed.find((entry) => entry.id === completed.jobId);

    expect(found, `${name} is not on the listing after launching`).toBeDefined();
    expect(found?.phase).toBe("live");
    expect(found?.tokenAddress).toBe(TOKEN);
    expect(found?.creator).toBe(creator.address);

    /*
     * A price, which is what proves the registry read went to the right registry.
     *
     * `phase` alone cannot: it is "live" as soon as there is a launch record, deliberately, so
     * that an unreachable chain does not make a launched market look unlaunched. That makes it
     * insensitive to the read having gone to engine 0's registry — which is the other half of
     * the bug this file exists for — and `trading` is what stays sensitive to it.
     */
    expect(found?.trading, `${name} has no figures, so its registry was not read`).toBeDefined();
    expect(found?.trading?.marketCap).toBeGreaterThan(0);
    // Zero contracts, because none was written. The card reads this as "how much bespoke code
    // is behind this market", and any other number would advertise code that does not exist.
    expect(found?.kind === "programmable" ? found.contractCount : -1).toBe(0);
  });

  it("resolves on its own market page", async () => {
    const completed = await journey(market, 1);

    const detail = await marketSource().read(completed.jobId);

    expect(detail, `${name} has no market page after launching`).not.toBeNull();
    expect(detail?.kind).toBe("programmable");

    // Narrowed rather than cast: the union is what stops an engine market being rendered
    // through engine 0's concepts, and a test that cast past it would not be checking the
    // thing the type exists for.
    if (detail === null || detail.kind !== "programmable" || detail.engineVersion !== 1) {
      throw new Error("the market page did not resolve as an engine-v1 market");
    }

    expect(detail.configHash).toBe(market.configHash);
    expect(detail.implementationHash).toBe(market.implementationHash);
    expect(detail.poolId).toBe(POOL_ID);
    expect(detail.phase).toBe("live");
  });

  /*
   * The failure this whole file is about, asserted directly. Before the fix the market page
   * described an unlaunched build forever — `phase: "ready"`, no token, no creator — with a
   * live market on chain and nothing anywhere saying so.
   */
  it("is not still described as an unlaunched build", async () => {
    const completed = await journey(market, 1);

    const detail = await marketSource().read(completed.jobId);
    expect(detail?.phase).not.toBe("ready");
    expect(detail?.tokenAddress).not.toBeNull();
  });

  /*
   * And the softer half of it: a market whose registry read fails is still a launched market.
   * Hinging `phase` on the chain answering meant an RPC hiccup was indistinguishable from a
   * market that had never launched, which is the same wrong page arrived at by a different
   * route.
   */
  it("stays launched when the chain cannot be read", async () => {
    const completed = await journey(market, 1);
    registryKnowsMarket = false;

    const detail = await marketSource().read(completed.jobId);

    expect(detail?.phase).toBe("live");
    // No price, though: `trading` depends on the registry read, so a market that cannot be
    // read shows a dash rather than a stale figure.
    expect(detail?.trading).toBeUndefined();
  });
});

/**
 * Registration, repeated across both shapes.
 *
 * The gate asks for twenty successful launch registrations because the property is a run
 * rather than an instance: what broke before was not a step that failed but a step that
 * silently did nothing, and doing nothing is perfectly repeatable.
 */
describe("launch registration, twenty times", () => {
  it.each(Array.from({ length: 20 }, (_, index) => index + 1))(
    "run %i: a launch becomes a listed, resolvable market",
    async (run) => {
      const market = run % 2 === 0 ? TIERED : FLAT;
      const completed = await journey(market, run);

      const listed = await marketSource().list();
      expect(listed.some((entry) => entry.id === completed.jobId)).toBe(true);

      const detail = await marketSource().read(completed.jobId);
      expect(detail?.phase).toBe("live");
      expect(detail?.tokenAddress).toBe(TOKEN);
    },
  );
});

/**
 * That the journey is a journey of something.
 *
 * The way a file like this goes quiet is by every fixture collapsing to a default: two market
 * shapes that compile to the same configuration, or a commitment of zero that matches
 * everything. Both would leave every assertion above passing against nothing.
 */
describe("the fixtures", () => {
  it("describes two genuinely different markets", () => {
    expect(FLAT.configHash).not.toBe(TIERED.configHash);
    expect(FLAT.implementationHash).not.toBe(TIERED.implementationHash);
    expect(FLAT.encodedConfig).not.toBe(TIERED.encodedConfig);
  });

  it("binds each commitment to this chain and this engine", () => {
    for (const market of [FLAT, TIERED]) {
      expect(market.implementationHash).not.toBe(market.configHash);
      expect(
        implementationHash(market.config, {
          chainId: CHAIN_ID + 1,
          engine: ENGINE.hook,
          engineVersion: 1,
        }),
      ).not.toBe(market.implementationHash);
      expect(
        implementationHash(market.config, {
          chainId: CHAIN_ID,
          engine: addr("dead"),
          engineVersion: 1,
        }),
      ).not.toBe(market.implementationHash);
    }
  });

  it("quotes both markets in native ETH, which is what the gate asks for", () => {
    for (const market of [FLAT, TIERED]) {
      expect(market.config.quoteAsset.address).toBe(NATIVE_QUOTE);
    }
  });

  /*
   * ADR-018, at the fixture level. The tiered market has size tiers, so its fee is collected
   * in the launched token; the flat one has none, so it collects in the quote. If both came
   * out the same, the two journeys would be exercising one settlement path twice.
   */
  it("gives the two markets different fee currencies", () => {
    expect(FLAT.config.feeCurrency).not.toBe(TIERED.config.feeCurrency);
  });
});
