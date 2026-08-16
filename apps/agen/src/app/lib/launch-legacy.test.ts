/**
 * A build older than the shape the launch reads.
 *
 * `LaunchManifest.deployment` is not optional, so `prepareLaunch` had no reason to doubt it, and
 * for jobs the current pipeline writes there is nothing to doubt. Jobs are persisted, though,
 * and a volume holds builds written before the field existed. EMBER and VOLT were two of them:
 * both at `deployment_ready`, both offered a launch button, both answering a creator's
 * signature request by reading `components` off `undefined` three frames inside the
 * materializer — surfaced as "This market could not be prepared for launch" with the cause
 * dropped on the floor.
 *
 * The refusal is the fix, not the crash being caught. A stale build is an ordinary thing for a
 * volume to contain and it deserves the same plain answer as a missing manifest.
 */

import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const CREATOR = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const RECEIVER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

/** The launch reads its root once, at import, so the volume has to be in place first. */
let prepareLaunch: typeof import("./launch").prepareLaunch;

const LEGACY = "11111111-1111-4111-8111-111111111111";
const CURRENT = "22222222-2222-4222-8222-222222222222";

/** A cleared job, with a manifest as it was written before deployment specifications. */
function job(id: string, { withDeployment }: { readonly withDeployment: boolean }) {
  return {
    id,
    stage: "deployment_ready",
    name: "Ember",
    symbol: "EMBER",
    prompt: "one percent on sells",
    plan: { components: [] },
    manifest: {
      version: 1,
      jobId: id,
      name: "Ember",
      symbol: "EMBER",
      lpFee: 8_388_608,
      supplyTokens: { __bigint__: "1000000000" },
      ...(withDeployment ? { deployment: { version: 1, components: [] } } : {}),
    },
  };
}

beforeAll(async () => {
  const root = await mkdtemp(resolve(tmpdir(), "agen-legacy-"));
  await mkdir(resolve(root, "_jobs"), { recursive: true });

  for (const [id, withDeployment] of [
    [LEGACY, false],
    [CURRENT, true],
  ] as const) {
    await writeFile(
      resolve(root, "_jobs", `${id}.json`),
      JSON.stringify(job(id, { withDeployment })),
    );
  }

  process.env["AGEN_DATA_DIR"] = root;
  ({ prepareLaunch } = await import("./launch"));
}, 60_000);

describe("a build whose manifest predates the deployment specification", () => {
  it("is refused in terms a creator can act on, rather than crashing", async () => {
    const error = await prepareLaunch({
      jobId: LEGACY,
      creator: CREATOR,
      feeReceiver: RECEIVER,
    }).then(
      () => null,
      (thrown: Error) => thrown,
    );

    expect(error).not.toBeNull();
    expect(error?.message).toContain("predates");
    // Names the way out. A refusal a creator cannot act on is only a nicer crash.
    expect(error?.message).toContain("again");
    expect(error).toHaveProperty("status", 409);
  }, 60_000);

  /**
   * The control. Without it this test passes just as well against a `prepareLaunch` that
   * refuses every build, which is the easiest way to make a launch never crash.
   */
  it("does not refuse a build that carries one", async () => {
    const error = await prepareLaunch({
      jobId: CURRENT,
      creator: CREATOR,
      feeReceiver: RECEIVER,
    }).then(
      () => null,
      (thrown: Error) => thrown,
    );

    expect(error?.message ?? "").not.toContain("predates");
  }, 60_000);
});
