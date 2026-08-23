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
 * The browser rebuilds this message rather than being handed one to sign, so the copy in
 * `engine-launch.tsx` is held against this one too. If they drift, a wallet shows text the
 * server will not accept, and every approval silently fails.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { approvalMessage, engineApprovalMessage } from "@verdant/market-compiler";
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

  /*
   * The browser builds this message itself so the wallet dialog can be read against the review
   * screen rather than trusted. That only works while the two definitions agree, and they
   * agree by being compared here — a drift makes every approval fail verification server-side,
   * which is safe but completely opaque to the person clicking the button.
   */
  it("is reproduced exactly by the browser", () => {
    const browser = readFileSync(
      fileURLToPath(new URL("../launch/engine-launch.tsx", import.meta.url)),
      "utf8",
    );

    for (const line of message().split("\n")) {
      if (line === "") continue;

      // The lines that interpolate values are checked by their literal prefix; the prose is
      // checked whole, since that is where a reworded sentence would silently diverge.
      const literal = line.replace(/(: ).*$/, "$1");
      const needle = literal.length < line.length ? literal.trim() : line;

      expect(browser, `the browser's copy is missing: ${needle}`).toContain(
        needle.length > 60 ? needle.slice(0, 60) : needle,
      );
    }
  });
});
