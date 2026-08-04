/**
 * The metadata boundary's tests.
 *
 * Everything parsed here came from an address a stranger put on chain, so the cases that
 * matter are the hostile and the malformed rather than the well-formed: a document that is
 * an array, a link that is a script, a description long enough to be the page. The
 * well-formed case is one test; the rest of this file is about what happens when the
 * document is not what `metadataDocument` would have written.
 */

import { describe, expect, it } from "vitest";

import { directImage, parseTokenDocument, resolveUri } from "./token-uri";

describe("parseTokenDocument", () => {
  it("reads the document the launch form writes", () => {
    expect(
      parseTokenDocument({
        name: "Test2",
        symbol: "TEST2",
        description: "A market for testing.",
        image: "https://example.com/logo.png",
        links: {
          website: "https://example.com",
          x: "https://x.com/example",
          telegram: "https://t.me/example",
        },
      }),
    ).toEqual({
      description: "A market for testing.",
      website: "https://example.com/",
      x: "https://x.com/example",
      telegram: "https://t.me/example",
    });
  });

  it("refuses a link that is not http", () => {
    // An `href` is rendered for a reader to click, and `javascript:` in one is the oldest
    // way there is to turn somebody else's page into your own.
    const parsed = parseTokenDocument({
      links: {
        website: "javascript:alert(1)",
        x: "data:text/html,<script>alert(1)</script>",
        telegram: "  ",
      },
    });

    expect(parsed.website).toBeNull();
    expect(parsed.x).toBeNull();
    expect(parsed.telegram).toBeNull();
  });

  it("accepts `twitter` where a document predates the rename", () => {
    expect(parseTokenDocument({ links: { twitter: "https://twitter.com/example" } }).x).toBe(
      "https://twitter.com/example",
    );
  });

  it("survives a document that is not one", () => {
    // All of these are things a `metadataURI` can point at, and none of them may throw:
    // the market page renders regardless of what a creator hosted.
    for (const value of [null, undefined, 42, "a string", [1, 2, 3], [], true]) {
      expect(parseTokenDocument(value)).toEqual({
        description: null,
        website: null,
        x: null,
        telegram: null,
      });
    }
  });

  it("survives fields of the wrong type", () => {
    const parsed = parseTokenDocument({
      description: { nested: "object" },
      links: "not an object",
    });

    expect(parsed.description).toBeNull();
    expect(parsed.website).toBeNull();
  });

  it("truncates a description long enough to be the page", () => {
    const parsed = parseTokenDocument({ description: "x".repeat(5_000) });
    expect(parsed.description).toHaveLength(601);
    expect(parsed.description?.endsWith("…")).toBe(true);
  });
});

describe("resolving a token's URI", () => {
  it("sends ipfs through a gateway and leaves http alone", () => {
    expect(resolveUri("ipfs://abc123")).toBe("https://ipfs.io/ipfs/abc123");
    expect(resolveUri("https://example.com/a.png")).toBe("https://example.com/a.png");
  });

  it("tells an image apart from a document", () => {
    // A `.json` is a document even over https, and anything that is neither scheme is
    // neither — a bare CID cannot be fetched by a browser.
    expect(directImage("https://example.com/logo.png")).toBe("https://example.com/logo.png");
    expect(directImage("https://example.com/token.json")).toBeNull();
    expect(directImage("https://example.com/token.json?v=2")).toBeNull();
    expect(directImage("QmSomeBareCid")).toBeNull();
  });
});
