import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import {
  approvalMessage,
  hashSpecification,
  newJob,
  type GenerationJob,
  type MarketSpecification,
} from "@verdant/market-compiler";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const account = privateKeyToAccount(KEY);
const SPECIFICATION_HASH = `0x${"11".repeat(32)}` as const;
const IMPLEMENTATION_HASH = `0x${"22".repeat(32)}` as const;
const intent = {
  prompt: "Charge 0.5% on every trade.",
  atoms: [],
  problems: [],
  complete: true,
} as const;
const INTENT_HASH = hashSpecification(intent);

let root = "";
let builds: typeof import("./builds");

const specification: MarketSpecification = {
  version: 1,
  name: "Floor",
  symbol: "FLOR",
  summary: "A market",
  baseFeePpm: 5_000,
  maxFeePpm: 40_000,
  phases: [],
  state: [],
  rules: [
    {
      id: "fee",
      title: "FEE",
      when: { kind: "swap", description: "a trade" },
      conditions: [],
      then: [{ kind: "setFee", description: "charge 0.5%", parameters: { feePpm: 5_000 } }],
    },
  ],
  invariants: [],
  externalDependencies: [],
  assumptions: [],
  ambiguities: [],
  suggestions: [],
  unsupported: [],
};

beforeAll(async () => {
  root = await mkdtemp(resolve(tmpdir(), "agen-approval-"));
  process.env["AGEN_DATA_DIR"] = root;
  builds = await import("./builds");
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("approving an exact build", () => {
  it("stores a verified wallet signature bound to both hashes", async () => {
    const base = newJob({
      id: "approval-build",
      prompt: "Charge 0.5% on every trade.",
      name: "Floor",
      symbol: "FLOR",
      now: 1,
    });
    const job = {
      ...base,
      stage: "deployment_ready",
      specification,
      specificationHistory: [specification],
      intent,
      semanticCoverage: { complete: true, claims: [], unproven: [] },
      manifest: {
        specificationHash: SPECIFICATION_HASH,
        implementationHash: IMPLEMENTATION_HASH,
      },
    } as unknown as GenerationJob;
    await builds.jobStore().create(job);

    const message = approvalMessage({
      jobId: job.id,
      specificationVersion: specification.version,
      specificationHash: SPECIFICATION_HASH,
      implementationHash: IMPLEMENTATION_HASH,
      intentHash: INTENT_HASH,
      creator: account.address,
    });
    const signature = await account.signMessage({ message });

    expect(
      await builds.approveBuild({
        jobId: job.id,
        creator: account.address,
        signature,
      }),
    ).toMatchObject({ ok: true });

    const approved = await builds.jobStore().read(job.id);
    expect(approved?.approval).toMatchObject({
      specificationHash: SPECIFICATION_HASH,
      implementationHash: IMPLEMENTATION_HASH,
      intentHash: INTENT_HASH,
      approvedBy: account.address,
    });
  });

  it("rejects a signature over a different implementation", async () => {
    const message = approvalMessage({
      jobId: "approval-build",
      specificationVersion: specification.version,
      specificationHash: SPECIFICATION_HASH,
      implementationHash: `0x${"33".repeat(32)}`,
      intentHash: INTENT_HASH,
      creator: account.address,
    });
    const signature = await account.signMessage({ message });

    expect(
      await builds.approveBuild({
        jobId: "approval-build",
        creator: account.address,
        signature,
      }),
    ).toMatchObject({ ok: false, error: expect.stringContaining("exact build") });
  });
});
