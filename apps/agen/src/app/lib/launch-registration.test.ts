/**
 * That a market which launched is a market the product knows about.
 *
 * ## The bug this exists for
 *
 * `recordLaunch` knew one event: `AgenFactory.MarketDeployed`. An engine-v1 launch does not
 * emit it — `AgenEngineFactory` emits `EngineMarketDeployed`, from a different address, with
 * different fields — so a successful engine launch walked the receipt's logs, recognised
 * nothing, wrote no record, and returned a 400 to a browser that had just watched the
 * transaction confirm. The build stayed at `phase: "ready"` permanently: a market live on
 * chain, tradable by anyone with its address, and absent from the launchpad that made it.
 *
 * Nothing threw where anybody would see it, which is why this needed a test rather than a
 * fix. So the assertions below are about the whole registration path, not the decoder: a
 * receipt goes in, and what comes out has to be a record whose fields a market page can be
 * built from, or a refusal with a reason.
 *
 * ## Why the receipts are synthesised rather than captured
 *
 * The logs are encoded from the same ABIs the decoder reads, which is the part worth being
 * exact about, and everything else in a receipt is scaffolding. A captured receipt would pin
 * one deployment's addresses and one block, and would have to be recaptured every time the
 * engine moved — while proving nothing extra, because the only thing under test is which
 * logs are accepted and what is read out of them.
 *
 * ## What each case is for
 *
 * The engine and generated paths must each decode their own event and neither may decode the
 * other's. A log from the wrong factory must be ignored even when it carries the right event,
 * because a `MarketDeployed` from another address is another Agen. A receipt with no launch
 * event at all must refuse rather than write a record with holes in it. Unrelated logs must be
 * walked past rather than confusing the search, since a real receipt is mostly Uniswap. The
 * shared engine hook must be recorded even though the event does not carry it. And native and
 * ERC-20 markets must both register, because they differ in the vault's currency and nothing
 * about registration should notice.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  encodeAbiParameters,
  encodeEventTopics,
  getAddress,
  keccak256,
  stringToHex,
  type Address,
  type Hex,
} from "viem";
import { abi } from "@verdant/sdk";

// --- the deployment these tests are written against ------------------------

/** An address from its last few digits, so none of these has to be counted by hand. */
function addr(tail: string): Address {
  return getAddress(`0x${tail.toLowerCase().padStart(40, "0")}`);
}

const GENERATED_FACTORY = addr("f0000");
const ENGINE_FACTORY = addr("f0001");
const ENGINE_HOOK = addr("38cc");
const ENGINE_DEPLOYER = addr("d0001");
const ENGINE_REGISTRY = addr("e0001");
const GENERATED_REGISTRY = addr("e0000");

const IMPOSTOR = addr("badbad");
const TOKEN = addr("701234");
const VAULT = addr("704a17");
const LOCKER = addr("7010c3");
const CREATOR = addr("c0001");
/** Whoever paid for the transaction, which for a relayed launch is not the creator. */
const RELAYER = addr("feed");

const POOL_ID = `0x${"77".repeat(32)}` as Hex;
const CONFIG_HASH = `0x${"11".repeat(32)}` as Hex;
const COMMITMENT = `0x${"22".repeat(32)}` as Hex;
const OTHER_COMMITMENT = `0x${"33".repeat(32)}` as Hex;

const ENGINE_JOB = "11111111-1111-4111-8111-111111111111";
const GENERATED_JOB = "22222222-2222-4222-8222-222222222222";
const UNKNOWN_JOB = "33333333-3333-4333-8333-333333333333";

const TX = `0x${"ab".repeat(32)}` as Hex;
const BLOCK_NUMBER = 4_663_000n;
const BLOCK_TIMESTAMP = 1_786_890_183n;

// --- receipts --------------------------------------------------------------

interface Log {
  readonly address: Address;
  readonly topics: readonly Hex[];
  readonly data: Hex;
}

/**
 * An `EngineMarketDeployed` log, encoded through the ABI the decoder reads.
 *
 * `index`, `token` and `creator` are indexed and so live in the topics; the rest is the
 * data. Building it this way rather than pasting hex means a change to the event's shape
 * breaks these tests at the encoder rather than producing a log that silently decodes to
 * the wrong fields.
 */
function engineLog(
  overrides: {
    readonly address?: Address;
    readonly creator?: Address;
    readonly engineVersion?: number;
    readonly implementationHash?: Hex;
    readonly vault?: Address;
  } = {},
): Log {
  return {
    address: overrides.address ?? ENGINE_FACTORY,
    // Cast because `encodeEventTopics` types an indexed topic as possibly absent, for a
    // filter that leaves one out. Every one is supplied here, so none of them is null.
    topics: encodeEventTopics({
      abi: abi.agenEngineFactoryAbi,
      eventName: "EngineMarketDeployed",
      args: { index: 7n, token: TOKEN, creator: overrides.creator ?? CREATOR },
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
      [
        POOL_ID,
        overrides.vault ?? VAULT,
        LOCKER,
        overrides.engineVersion ?? 1,
        CONFIG_HASH,
        overrides.implementationHash ?? COMMITMENT,
      ],
    ),
  };
}

/** A `MarketDeployed` log from the generated-market factory. */
function generatedLog(overrides: { readonly address?: Address } = {}): Log {
  return {
    address: overrides.address ?? GENERATED_FACTORY,
    topics: encodeEventTopics({
      abi: abi.agenFactoryAbi,
      eventName: "MarketDeployed",
      args: { index: 3n, token: TOKEN, hook: ENGINE_HOOK },
    }) as Hex[],
    data: encodeAbiParameters(
      [
        { name: "poolId", type: "bytes32" },
        { name: "locker", type: "address" },
        { name: "firstTokenId", type: "uint256" },
        { name: "supplyLocked", type: "uint256" },
      ],
      [POOL_ID, LOCKER, 1n, 10n ** 27n],
    ),
  };
}

/**
 * The logs a launch shares its receipt with.
 *
 * A real engine launch emits an ERC-20 transfer per band, a pool initialisation, three
 * position mints and the registry's own record — a dozen or more before the one that
 * matters. Undecodable noise is the honest version of that for this test: what is being
 * checked is that the search walks past anything it cannot read instead of stopping.
 */
function noise(): readonly Log[] {
  return [
    { address: IMPOSTOR, topics: [keccak256(stringToHex("Transfer"))], data: "0x" },
    {
      address: ENGINE_FACTORY,
      topics: [keccak256(stringToHex("SomethingElse(uint256)"))],
      data: `0x${"00".repeat(32)}` as Hex,
    },
    { address: ENGINE_HOOK, topics: [keccak256(stringToHex("Configured"))], data: "0x" },
  ];
}

let receipt: {
  status: "success" | "reverted";
  logs: readonly Log[];
} | null = null;

// --- the modules under and around the test ---------------------------------

const ROOT = mkdtempSync(resolve(tmpdir(), "agen-launch-registration-"));

let job: unknown = null;

vi.mock("./onchain", () => ({
  publicClient: () => ({
    getTransactionReceipt: async () => {
      if (receipt === null) throw new Error("not found");
      return { ...receipt, blockNumber: BLOCK_NUMBER, from: RELAYER, transactionHash: TX };
    },
    getBlock: async () => ({ timestamp: BLOCK_TIMESTAMP }),
  }),
}));

vi.mock("./builds", () => ({
  GENERATED_ROOT: ROOT,
  jobStore: () => ({ read: async () => job }),
}));

vi.mock("./chain", () => ({
  AGEN_ADDRESSES: {
    ok: true,
    addresses: {
      factory: GENERATED_FACTORY,
      deployer: ENGINE_DEPLOYER,
      registry: GENERATED_REGISTRY,
    },
  },
}));

let engineDeployed = true;

vi.mock("./programmable", () => ({
  ENGINE_NOT_DEPLOYED: "the engine is not deployed here",
  engineAddressesOrNull: () =>
    engineDeployed
      ? {
          factory: ENGINE_FACTORY,
          hook: ENGINE_HOOK,
          deployer: ENGINE_DEPLOYER,
          registry: ENGINE_REGISTRY,
        }
      : null,
}));

const { LaunchRecordError, readLaunch, recordLaunch } = await import("./launched");

/** An engine-v1 job that reached preparation and was approved at `COMMITMENT` by `CREATOR`. */
function engineJob(implementationHash: Hex | null = COMMITMENT, approvedBy: string = CREATOR) {
  return {
    id: ENGINE_JOB,
    engineVersion: 1,
    stage: "deployment_ready",
    engine: { configHash: CONFIG_HASH, implementationHash },
    approval: { approvedBy },
  };
}

function generatedJob() {
  return { id: GENERATED_JOB, engineVersion: 0, stage: "deployment_ready", engine: null };
}

beforeEach(() => {
  engineDeployed = true;
  job = null;
  receipt = null;

  // `recordLaunch` is idempotent by returning the stored record when the job and the
  // transaction both match, which is what a reloaded launch screen depends on. These cases
  // reuse one job id and one transaction hash deliberately — they are the same launch under
  // different conditions — so the store has to start empty or the first case answers for
  // all of them.
  rmSync(resolve(ROOT, "_launched"), { recursive: true, force: true });
});

describe("registering an engine-v1 launch", () => {
  beforeEach(() => {
    job = engineJob();
  });

  it("records the market the factory said it created", async () => {
    receipt = { status: "success", logs: [...noise(), engineLog()] };

    const record = await recordLaunch(ENGINE_JOB, TX);

    expect(record).toMatchObject({
      jobId: ENGINE_JOB,
      engineVersion: 1,
      index: 7,
      token: TOKEN,
      poolId: POOL_ID,
      locker: LOCKER,
      vault: VAULT,
      configHash: CONFIG_HASH,
      implementationHash: COMMITMENT,
      txHash: TX,
      blockNumber: BLOCK_NUMBER.toString(),
      at: Number(BLOCK_TIMESTAMP),
    });
  });

  /*
   * The hook is the one field not in the event. One shared hook serves every engine market
   * and the factory holds it in an immutable, so it is a constant of the deployment — but a
   * record missing it leaves `hookAddress` null on every engine market page, which reads as
   * "this market has no hook" rather than "this record did not bother to say".
   */
  it("records the shared engine hook, which the event does not carry", async () => {
    receipt = { status: "success", logs: [engineLog()] };

    await expect(recordLaunch(ENGINE_JOB, TX)).resolves.toMatchObject({ hook: ENGINE_HOOK });
  });

  /*
   * From the event rather than from `receipt.from`. The factory takes the creator from
   * `msg.sender` and emits it, so a launch relayed or batched through another contract still
   * records the creator rather than whoever paid the gas — and the creator is what the market
   * page attributes the market to and what the fee split pays.
   */
  it("credits the creator the factory saw, not the account that paid", async () => {
    receipt = { status: "success", logs: [engineLog()] };

    const record = await recordLaunch(ENGINE_JOB, TX);

    expect(record.creator).toBe(CREATOR);
    expect(record.creator).not.toBe(RELAYER);
  });

  it("can be read back, and reads back as engine v1", async () => {
    receipt = { status: "success", logs: [engineLog()] };
    await recordLaunch(ENGINE_JOB, TX);

    const stored = await readLaunch(ENGINE_JOB);

    expect(stored?.engineVersion).toBe(1);
    expect(stored?.token).toBe(TOKEN);
    expect(stored?.vault).toBe(VAULT);
  });

  it("is idempotent, because the launch screen calls it again on reload", async () => {
    receipt = { status: "success", logs: [engineLog()] };

    const first = await recordLaunch(ENGINE_JOB, TX);
    const second = await recordLaunch(ENGINE_JOB, TX);

    expect(second).toEqual(first);
  });

  // --- what it refuses -----------------------------------------------------

  /*
   * A `EngineMarketDeployed` from an address that is not this deployment's engine factory is
   * another engine's market, or a contract imitating the event. Accepting it would let anybody
   * register any market against any build by emitting the right log.
   */
  it("ignores the right event from the wrong factory", async () => {
    receipt = { status: "success", logs: [engineLog({ address: IMPOSTOR })] };

    await expect(recordLaunch(ENGINE_JOB, TX)).rejects.toThrow(
      /did not create a market through this deployment's engine factory/,
    );
  });

  it("refuses a receipt with no launch event in it", async () => {
    receipt = { status: "success", logs: noise() };

    await expect(recordLaunch(ENGINE_JOB, TX)).rejects.toBeInstanceOf(LaunchRecordError);
    await expect(readLaunch(UNKNOWN_JOB)).resolves.toBeNull();
  });

  /*
   * The engine-0 event, in an engine-v1 job's receipt. Neither decoder may accept the other's
   * event: the fields do not line up — `MarketDeployed` has a hook where the engine event has
   * a creator — so a record built from the wrong one would be internally consistent and
   * completely wrong.
   */
  it("does not accept the generated factory's event", async () => {
    receipt = { status: "success", logs: [generatedLog()] };

    await expect(recordLaunch(ENGINE_JOB, TX)).rejects.toThrow(/engine factory/);
  });

  /*
   * Review-to-execution parity, at the last point where the two can still be told apart. The
   * factory recomputes the commitment from the rules it stored and refuses a launch that does
   * not match, so a receipt carrying a different commitment is a receipt for a different
   * market than the one on the screen. Filing it under this build would leave a page
   * describing rules the chain does not run.
   */
  it("refuses a market whose commitment is not the one approved", async () => {
    receipt = { status: "success", logs: [engineLog({ implementationHash: OTHER_COMMITMENT })] };

    await expect(recordLaunch(ENGINE_JOB, TX)).rejects.toThrow(/not the ones approved/);
    await expect(readLaunch(ENGINE_JOB)).resolves.toBeNull();
  });

  /*
   * The launch-record hijack, closed.
   *
   * `deployMarket` is permissionless by design, and a market's configuration is public — it is
   * on the review screen. So anybody can deploy a market with byte-identical economics, which
   * produces a byte-identical commitment, and the commitment check above cannot tell the two
   * apart. This endpoint takes nothing but a transaction hash, so without the creator check
   * that transaction could be filed against somebody else's build: the build page would point
   * at the attacker's token, with the attacker collecting the creator's share.
   *
   * See `docs/engine-approval-model.md` for why the on-chain factory is permissionless and
   * what that does and does not leave to the application layer.
   */
  it("refuses somebody else's identical market filed against this build", async () => {
    const attacker = addr("a77ac6");
    receipt = { status: "success", logs: [engineLog({ creator: attacker })] };

    await expect(recordLaunch(ENGINE_JOB, TX)).rejects.toThrow(/different wallet/);
    await expect(readLaunch(ENGINE_JOB)).resolves.toBeNull();
  });

  it("accepts the market launched by the wallet that approved it", async () => {
    job = engineJob(COMMITMENT, CREATOR);
    receipt = { status: "success", logs: [engineLog({ creator: CREATOR })] };

    await expect(recordLaunch(ENGINE_JOB, TX)).resolves.toMatchObject({ creator: CREATOR });
  });

  it("refuses a market from a future engine version", async () => {
    receipt = { status: "success", logs: [engineLog({ engineVersion: 2 })] };

    await expect(recordLaunch(ENGINE_JOB, TX)).rejects.toThrow(/engine version 2/);
  });

  it("refuses a reverted transaction, which created nothing", async () => {
    receipt = { status: "reverted", logs: [engineLog()] };

    await expect(recordLaunch(ENGINE_JOB, TX)).rejects.toThrow(/that transaction failed/i);
  });

  it("says so when the engine is not deployed here", async () => {
    engineDeployed = false;
    receipt = { status: "success", logs: [engineLog()] };

    await expect(recordLaunch(ENGINE_JOB, TX)).rejects.toThrow(/not deployed/);
  });
});

describe("both quote assets", () => {
  beforeEach(() => {
    job = engineJob();
  });

  /*
   * A native-ETH market and an ERC-20 market differ in the currency their vault holds and in
   * nothing registration can see: the vault is an address in the event either way. Both are
   * asserted because "native works" is the claim the launch is being made on, and a path that
   * only ever ran against an ERC-20 fixture is a path nobody has checked.
   */
  it.each([
    ["native Robinhood Chain ETH", addr("704a17")],
    ["an ERC-20 quote", addr("704a18")],
  ])("registers a market quoted in %s", async (_what, vault) => {
    receipt = { status: "success", logs: [engineLog({ vault })] };

    await expect(recordLaunch(ENGINE_JOB, TX)).resolves.toMatchObject({
      vault,
      engineVersion: 1,
    });
  });
});

describe("registering a generated launch", () => {
  beforeEach(() => {
    job = generatedJob();
  });

  it("still records `MarketDeployed`, unchanged", async () => {
    receipt = { status: "success", logs: [...noise(), generatedLog()] };

    const record = await recordLaunch(GENERATED_JOB, TX);

    expect(record).toMatchObject({
      engineVersion: 0,
      index: 3,
      token: TOKEN,
      hook: ENGINE_HOOK,
      locker: LOCKER,
      // No creator in `MarketDeployed`, so this path reads the sender. Asserted so the
      // difference between the two engines' provenance stays deliberate.
      creator: RELAYER,
    });
    expect(record.vault).toBeUndefined();
  });

  it("does not accept the engine factory's event", async () => {
    receipt = { status: "success", logs: [engineLog()] };

    await expect(recordLaunch(GENERATED_JOB, TX)).rejects.toThrow(
      /did not create an Agen market through this deployment's factory/,
    );
  });

  /*
   * A job that is not in the store reads as engine 0, which is the convention `isEngineBuild`
   * documents, and lands in the generated path's own refusal. The alternative — guessing engine
   * 1 for an unknown id — would let an engine market be registered against a build that does
   * not exist.
   */
  it("treats an unknown build as engine 0", async () => {
    job = null;
    receipt = { status: "success", logs: [engineLog()] };

    await expect(recordLaunch(UNKNOWN_JOB, TX)).rejects.toThrow(/this deployment's factory/);
  });
});

describe("a launch record written before engine v1 existed", () => {
  /*
   * The field is optional on disk and every record already written lacks it. Reading an absent
   * value as engine 0 is the only safe direction: those records were all written by the
   * generated factory's decoder, and a market is never reinterpreted under semantics invented
   * after it launched.
   */
  it("reads as engine 0 rather than as undefined", async () => {
    job = generatedJob();
    receipt = { status: "success", logs: [generatedLog()] };
    await recordLaunch(GENERATED_JOB, TX);

    const { writeFile } = await import("node:fs/promises");
    const path = resolve(ROOT, "_launched", `${GENERATED_JOB}.json`);
    const stored = JSON.parse(await (await import("node:fs/promises")).readFile(path, "utf8"));
    delete stored.engineVersion;
    await writeFile(path, JSON.stringify(stored), "utf8");

    await expect(readLaunch(GENERATED_JOB)).resolves.toMatchObject({ engineVersion: 0 });
  });
});
