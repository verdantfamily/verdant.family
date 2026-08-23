import { describe, expect, it } from "vitest";

import { approvalMessage } from "./approval.js";

describe("creator approval", () => {
  it("binds the wallet to one specification and implementation", () => {
    const message = approvalMessage({
      jobId: "job-floor",
      specificationVersion: 3,
      specificationHash: `0x${"11".repeat(32)}`,
      implementationHash: `0x${"22".repeat(32)}`,
      intentHash: `0x${"33".repeat(32)}`,
      creator: "0xABCDEFabcdefABCDEFabcdefABCDEFabcdefABCD",
    });

    expect(message).toContain("Build: job-floor");
    expect(message).toContain("Specification version: 3");
    expect(message).toContain(`Specification hash: 0x${"11".repeat(32)}`);
    expect(message).toContain(`Implementation hash: 0x${"22".repeat(32)}`);
    expect(message).toContain(`Intent hash: 0x${"33".repeat(32)}`);
    expect(message).toContain("Creator: 0xabcdefabcdefabcdefabcdefabcdefabcdefabcd");
  });
});
