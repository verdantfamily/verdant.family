import { describe, expect, it } from "vitest";

import { detectRefs, describeRefs } from "./detect";
import { contextFromMention } from "../x/context";
import type { XMention, XPost } from "../x/types";

function post(text: string, extra: Partial<XPost> = {}): XPost {
  return {
    id: "1",
    text,
    author: {
      id: "7",
      username: "trencher",
      name: "Trencher",
      avatarUrl: null,
      followers: 10,
      createdAt: null,
      verified: false,
    },
    createdAt: null,
    inReplyToPostId: null,
    quotedPostId: null,
    media: [],
    links: [],
    language: "en",
    ...extra,
  };
}

describe("detectRefs", () => {
  it("picks up addresses, tickers and agen.space market URLs", () => {
    const found = detectRefs(
      "look at $DOG vs $dog and https://agen.space/markets/0x1111111111111111111111111111111111111111",
      "also 0x2222222222222222222222222222222222222222",
    );

    expect(found.tickers).toEqual(["DOG"]);
    expect(found.agenMarkets).toEqual(["0x1111111111111111111111111111111111111111"]);
    expect(found.addresses).toContain("0x1111111111111111111111111111111111111111");
    expect(found.addresses).toContain("0x2222222222222222222222222222222222222222");
    expect(describeRefs(found).detected_tickers).toBe("$DOG");
  });
});

describe("contextFromMention", () => {
  it("puts the parent in a public block so thoughts? has something to be about", () => {
    const mention: XMention = {
      command: post("@useagen thoughts?", { id: "2", inReplyToPostId: "1" }),
      source: post("volume just printed 18 ETH on $IDOG"),
    };

    const context = contextFromMention(mention);
    expect(context.surface).toBe("x");
    expect(context.question).toBe("thoughts?");
    expect(context.blocks.some((block) => block.label === "PARENT POST")).toBe(true);
    expect(context.facts?.detected_tickers).toBe("$IDOG");
  });
});
