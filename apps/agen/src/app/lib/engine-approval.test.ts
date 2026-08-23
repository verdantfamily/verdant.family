/**
 * That an engine-v1 approval means what it says, and covers only what it says.
 *
 * Approval is the one place where a mistake ends with a creator having consented to economics
 * they never saw. The properties that prevent that are all about the signed preimage, so they
 * are tested against the message itself rather than through a wallet:
 *
 *  - An engine-0 signature must never verify as an engine-1 approval, or the reverse. The two
 *    engines put different things in the `implementationHash` field — one a hash of generated
 *    Solidity, the other a commitment over a configuration — so a shared preimage would let a
 *    signature approving a contract stand as approval of a market's rules.
 *  - Changing any economic field must change the message. Consent is to a commitment, and the
 *    commitment is only binding if it moves when the market does.
 *  - The message must be readable. A creator checking a wallet dialog against a review screen
 *    can only do that if the hashes appear literally, so the text is asserted, not just its
 *    uniqueness.
 *
 * The browser builds this message rather than being handed one to sign, and it builds it by
 * calling the same function the server verifies with — so there is one implementation and the
 * parity tests below prove that rather than comparing two.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { approvalMessage, engineApprovalMessage } from "@verdant/market-compiler";
import { engineApprovalMessage as engineApprovalMessageInBrowser } from "@verdant/market-compiler/browser";
import { describe, expect, it } from "vitest";

const CREATOR = "0x00000000000000000000000000000000000C0FFE";
const CONFIG = `0x${"11".repeat(32)}` as const;
const COMMITMENT = `0x${"22".repeat(32)}` as const;

function message(overrides: Partial<Parameters<typeof engineApprovalMessage>[0]> = {}): string {
  return engineApprovalMessage({
    jobId: "job-1",
    engineVersion: 1,
    configHash: CONFIG,
    implementationHash: COMMITMENT,
    creator: CREATOR,
    ...overrides,
  });
}

describe("the engine approval message", () => {
  it("states the hashes literally, so a creator can check them", () => {
    const text = message();

    expect(text).toContain(CONFIG);
    expect(text).toContain(COMMITMENT);
    expect(text).toContain(CREATOR.toLowerCase());
    expect(text).toContain("Build: job-1");
  });

  /*
   * The cross-engine property. Both messages carry a commitment and a creator, and if the
   * surrounding text were shared, a signature over one field layout could be replayed as the
   * other — approving a generated contract on the strength of having approved a configuration.
   */
  it("cannot be confused with an engine-0 approval", () => {
    const engine = message();
    const legacy = approvalMessage({
      jobId: "job-1",
      specificationVersion: 1,
      specificationHash: CONFIG,
      implementationHash: COMMITMENT,
      intentHash: COMMITMENT,
      creator: CREATOR,
    });

    expect(engine).not.toBe(legacy);

    // Not merely different: no line of one is a prefix of the other's preimage in a way a
    // signer could mistake, because the engine text names the engine and the legacy text names
    // a compiled implementation.
    expect(engine).toContain("Engine version: 1");
    expect(engine).not.toContain("compiled implementation");
    expect(legacy).not.toContain("Engine version");
  });

  it("moves when any part of the market moves", () => {
    const baseline = message();

    for (const [what, changed] of [
      ["the configuration", message({ configHash: `0x${"33".repeat(32)}` })],
      ["the commitment", message({ implementationHash: `0x${"44".repeat(32)}` })],
      ["the creator", message({ creator: "0x000000000000000000000000000000000000dEaD" })],
      ["the build", message({ jobId: "job-2" })],
    ] as const) {
      expect(changed, `${what} did not change what is signed`).not.toBe(baseline);
    }
  });

  /*
   * A signature is only informed consent if the text says what is being consented to. This
   * asserts the two facts a creator most needs and is least likely to know: that nothing was
   * written for their market, and that the commitment covers every economic field.
   */
  it("says what approving it commits to", () => {
    const text = message();

    expect(text).toContain("No contract was written for this market");
    expect(text).toMatch(/changing any rate, threshold, recipient or asset changes the commitment/);
  });

});

/**
 * That the browser and the server sign and verify the same bytes.
 *
 * ## Why this is not a comparison of two implementations any more
 *
 * It used to be. There were two builders — one in `packages/market-compiler/src/approval.ts`
 * and one written out again inside `engine-launch.tsx` — and a test that read the component's
 * source and looked for each line of the server's message in it. That test could only ever be
 * an approximation: it matched prefixes and truncated long prose, so a reworded sentence, a
 * changed separator or a different case on an address could all pass it. And what it was
 * checking was that two implementations happened to agree, which is a property that decays.
 *
 * The failure mode it was guarding against is severe and silent. The browser's message is what
 * a wallet hashes; the server rebuilds the message and recovers the signer from it. Disagree by
 * one byte and the recovered address is a different address, so the server rejects a perfectly
 * good signature from the right wallet — and the only thing a creator sees is that approving
 * their market does not work, with nothing in the response that could distinguish that from a
 * wallet problem.
 *
 * So the duplicate is gone. The component imports the canonical builder through
 * `@verdant/market-compiler/browser`, which is the entry point that exists for pure modules the
 * interface shares with the pipeline, and these tests hold the two things that still need
 * holding: that there is genuinely one implementation, and that its output has not moved.
 *
 * ## Why bytes and not semantics
 *
 * Because a signature is over bytes. Two messages that mean the same thing to a reader and
 * differ in whitespace are two different preimages and two different signatures, so "the same
 * message" can only mean identical — and the vectors are compared with `toBe` on the whole
 * string rather than by asserting the fields it contains.
 */
const VECTORS = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL("../../../../../packages/market-engine/approval/engine-v1.vectors.json", import.meta.url),
    ),
    "utf8",
  ),
) as {
  readonly vectors: readonly {
    readonly name: string;
    readonly covers: string;
    readonly jobId: string;
    readonly engineVersion: number;
    readonly configHash: `0x${string}`;
    readonly implementationHash: `0x${string}`;
    readonly creator: string;
    readonly approvalMessage: string;
  }[];
};

describe("approval-message parity between the browser and the server", () => {
  /*
   * Nine shapes, because the message must be sensitive to the market and to nothing else. The
   * three "different X" cases are the same build with one field moved, which is what proves
   * consent is to a specific market rather than to a template.
   */
  it("has nine vectors covering every axis the gate names", () => {
    expect(VECTORS.vectors.map((vector) => vector.name)).toEqual([
      "flat",
      "tiered",
      "time-ladder",
      "volume-ladder",
      "native-quote",
      "erc20-quote",
      "different-creator",
      "different-config-hash",
      "different-implementation-hash",
    ]);
  });

  for (const vector of VECTORS.vectors) {
    describe(`${vector.name} — ${vector.covers}`, () => {
      const inputs = {
        jobId: vector.jobId,
        engineVersion: 1,
        configHash: vector.configHash,
        implementationHash: vector.implementationHash,
        creator: vector.creator,
      } as const;

      it("is byte-for-byte the recorded message on the server", () => {
        expect(engineApprovalMessage(inputs)).toBe(vector.approvalMessage);
      });

      it("is byte-for-byte the recorded message in the browser", () => {
        expect(engineApprovalMessageInBrowser(inputs)).toBe(vector.approvalMessage);
      });

      /*
       * The property the gate actually asks for, asserted directly rather than inferred from
       * the two above both matching a file. If the vectors were ever regenerated from one side
       * only, the two assertions above could pass together while this one failed.
       */
      it("is the same bytes through both entry points", () => {
        expect(engineApprovalMessageInBrowser(inputs)).toBe(engineApprovalMessage(inputs));
      });
    });
  }

  /*
   * Every vector distinct, so a case that turned out to be a duplicate cannot sit in the set
   * looking like coverage. A collision here would also be a much worse thing on its own: two
   * different markets with one signable message means a signature for one approves the other.
   */
  it("gives every market its own preimage", () => {
    const messages = VECTORS.vectors.map((vector) => vector.approvalMessage);
    expect(new Set(messages).size).toBe(messages.length);
  });
});

describe("the launch panel's approval message", () => {
  const COMPONENT = readFileSync(
    fileURLToPath(new URL("../launch/engine-launch.tsx", import.meta.url)),
    "utf8",
  );

  /*
   * The structural half. Byte equality above is only a durable property while there is one
   * builder, and the way that stops being true is somebody restating the text in the component
   * again — which is exactly what happened before. A literal of the message's first line is the
   * cheapest reliable signal that a second implementation has appeared.
   */
  it("contains no second implementation of the message", () => {
    expect(COMPONENT).not.toContain("Approve this Agen market");
    expect(COMPONENT).not.toContain("Configuration hash:");
    expect(COMPONENT).not.toContain("No contract was written for this market");
  });

  it("signs what the canonical builder produces", () => {
    expect(COMPONENT).toContain('from "@verdant/market-compiler/browser"');
    expect(COMPONENT).toContain("engineApprovalMessage({");
  });
});
