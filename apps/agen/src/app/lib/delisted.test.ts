import { describe, expect, it } from "vitest";

import { isDelisted } from "./delisted";

const AGENBOT = "0xebb84696c6250c46dede1c0aae964096bb4d3826";

describe("markets the site does not show", () => {
  it("hides the AGENBOT launch that took the platform's own ticker", () => {
    expect(isDelisted(AGENBOT)).toBe(true);
  });

  it("answers the same for an address a wallet or an explorer would hand over checksummed", () => {
    expect(isDelisted("0xEbB84696c6250C46dEDE1c0aAE964096bB4D3826")).toBe(true);
  });

  it("shows every market that is not on the list", () => {
    expect(isDelisted("0x5f128d7c4d575bd9bb0782e4c394cce04765a636")).toBe(false);
  });

  it("shows a build, whose id is a uuid and can never be on the list", () => {
    expect(isDelisted("3f2504e0-4f89-11d3-9a0c-0305e82c3301")).toBe(false);
  });
});
