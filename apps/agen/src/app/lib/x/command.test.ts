/**
 * The grammar, the copy, and the identity derivation.
 *
 * Everything in here is a pure function, and everything in here is load-bearing in a way that is
 * hard to see from the outside: the parser decides whether a stated ticker is honoured, the label
 * derivation decides whether a returning creator finds their own fees, and the reply is the only
 * thing most users will ever see. So they are tested against fixed expectations rather than
 * against themselves.
 */

import { describe, expect, it } from "vitest";

import { normaliseName, normaliseTicker, parseCommand } from "./command";
import { seatLabel } from "./seat";
import { launchReply, marketUrl } from "./reply";
import { postIdsFrom } from "./ingest";
import { sourceIsUsable } from "./generate";
import {
  SESSION_COOKIE,
  authenticateX,
  encodeXSession,
  readXSession,
  sessionExpiry,
} from "./session";
import type { XPost } from "./types";

const BOT = "useagen";

function post(text: string, extra: Partial<XPost> = {}): XPost {
  return {
    id: "1900000000000000001",
    text,
    author: {
      id: "4242",
      username: "someone",
      name: "Someone",
      avatarUrl: null,
      followers: 100,
      createdAt: "2020-01-01T00:00:00.000Z",
      verified: false,
    },
    createdAt: "2026-01-01T00:00:00.000Z",
    inReplyToPostId: null,
    quotedPostId: null,
    media: [],
    links: [],
    language: "en",
    ...extra,
  };
}

describe("parseCommand", () => {
  it("recognises the phrasings people actually use", () => {
    for (const text of [
      "@useagen launch this",
      "@useagen make this a token",
      "@useagen tokenize this",
      "@useagen tokenise this",
      "@useagen turn this into a coin",
      "@useagen send it",
    ]) {
      expect(parseCommand(text, BOT).looksLikeLaunch, text).toBe(true);
    }
  });

  it("is case-insensitive about the handle and still finds it", () => {
    const parsed = parseCommand("@UseAgen launch this", BOT);
    expect(parsed.mentionsBot).toBe(true);
    expect(parsed.looksLikeLaunch).toBe(true);
  });

  it("does not treat a question about launching as a launch", () => {
    for (const text of [
      "@useagen what is agen.space?",
      "@useagen why did you launch this",
      "@useagen how do I launch a token",
      "@useagen explain this token",
    ]) {
      expect(parseCommand(text, BOT).looksLikeLaunch, text).toBe(false);
    }
  });

  it("strips the bot's handle and the reply's mention chain from the body", () => {
    const parsed = parseCommand("@someone @useagen launch this", BOT);
    expect(parsed.body).toBe("launch this");
  });

  it("honours a stated ticker", () => {
    expect(parseCommand("@useagen launch this as $DOG", BOT).explicitTicker).toBe("DOG");
    expect(parseCommand("@useagen launch this, ticker dog", BOT).explicitTicker).toBe("DOG");
  });

  it("refuses a ticker the token could not carry rather than correcting it", () => {
    // Twelve characters, one over the contract's bound. Silently truncating would launch
    // something the user did not ask for and cannot change.
    expect(parseCommand("@useagen launch this as $ABCDEFGHIJKL", BOT).explicitTicker).toBe(null);
    expect(parseCommand("@useagen launch this as $5", BOT).explicitTicker).toBe(null);
  });

  it("reads a name out of the phrasings that state one", () => {
    expect(parseCommand("@useagen call it Internet Dog", BOT).explicitName).toBe("Internet Dog");
    expect(parseCommand('@useagen launch this as "Internet Dog"', BOT).explicitName).toBe(
      "Internet Dog",
    );
    expect(parseCommand("@useagen launch this as Internet Dog", BOT).explicitName).toBe(
      "Internet Dog",
    );
  });

  it("separates a name from a ticker when both are stated", () => {
    const parsed = parseCommand("@useagen launch Internet Dog $IDOG", BOT);
    expect(parsed.explicitName).toBe("Internet Dog");
    expect(parsed.explicitTicker).toBe("IDOG");
  });

  it("does not read 'this' as a name", () => {
    expect(parseCommand("@useagen launch this $DOG", BOT).explicitName).toBe(null);
  });

  it("knows when it is not being addressed", () => {
    expect(parseCommand("agen launched a token today", BOT).mentionsBot).toBe(false);
    expect(parseCommand("@useagenda launch this", BOT).mentionsBot).toBe(false);
  });
});

describe("validation of what a token may be called", () => {
  it("takes a ticker apart the way the launch form does", () => {
    expect(normaliseTicker("$dog")).toBe("DOG");
    expect(normaliseTicker(" doge2 ")).toBe("DOGE2");
    expect(normaliseTicker("do-ge")).toBe(null);
    expect(normaliseTicker("")).toBe(null);
  });

  it("measures a name in bytes, because the contract does", () => {
    expect(normaliseName("Internet   Dog")).toBe("Internet Dog");
    expect(normaliseName("a".repeat(32))).toBe("a".repeat(32));
    expect(normaliseName("a".repeat(33))).toBe(null);
    // Eight emoji is 32 bytes and passes; nine is 36 and does not.
    expect(normaliseName("🐕".repeat(8))).not.toBe(null);
    expect(normaliseName("🐕".repeat(9))).toBe(null);
  });

  it("refuses the invisible characters that make a name lie about itself", () => {
    expect(normaliseName("Dog\u202eGod")).toBe(null);
    expect(normaliseName("Dog\u0000")).toBe(null);
  });
});

describe("seat labels", () => {
  it("derives the same label for the same account, forever", () => {
    /*
     * A fixed vector, written out rather than recomputed.
     *
     * This is the one assertion in the suite that must never be "updated to match". The label
     * decides a seat's address, a seat's address is immutable on every vault that names it, and
     * so a change to this value points every creator who launched before it at a seat that no
     * market pays and nobody can occupy. If this fails, the derivation is wrong, not the test.
     */
    expect(seatLabel("1234567890")).toBe(
      "0x2a30f2970fb81182ed545044d20d61dbed3bfec0d489a50cbc7ada8bf82116cb",
    );
  });

  it("gives different accounts different seats", () => {
    expect(seatLabel("1")).not.toBe(seatLabel("2"));
  });

  it("refuses anything that is not an X user id", () => {
    expect(() => seatLabel("useagen")).toThrow();
    expect(() => seatLabel("")).toThrow();
    expect(() => seatLabel("12; DROP TABLE")).toThrow();
  });
});

describe("the reply", () => {
  it("is the copy the product promises", () => {
    const text = launchReply({ ticker: "DOG", token: "0x1111111111111111111111111111111111111111" });

    expect(text).toBe(
      [
        "$DOG is live on Robinhood.",
        "",
        "You earn 1% of every trade. Happy trenching!",
        "",
        "https://agen.space/markets/0x1111111111111111111111111111111111111111",
      ].join("\n"),
    );
  });

  it("links the existing token page rather than a second address for the same market", () => {
    expect(marketUrl("0xabc")).toBe("https://agen.space/markets/0xabc");
  });
});

describe("what can be launched", () => {
  it("accepts a post with a picture and no words", () => {
    expect(
      sourceIsUsable(
        post("", { media: [{ kind: "photo", url: "https://pbs.x.com/a.png", altText: null }] }),
      ),
    ).toBe(true);
  });

  it("refuses a post that is only a handle and a link", () => {
    expect(sourceIsUsable(post("@someone https://example.com"))).toBe(false);
  });

  it("accepts a short real post", () => {
    expect(sourceIsUsable(post("my dog ate the internet"))).toBe(true);
  });
});

describe("the X session", () => {
  const identity = {
    xUserId: "770077",
    xUsername: "trencher",
    name: "Trencher",
    avatarUrl: null,
  };

  it("round-trips the account it was issued for", () => {
    const token = encodeXSession(identity, sessionExpiry());
    expect(readXSession(token)).toMatchObject({ xUserId: "770077", xUsername: "trencher" });
  });

  it("refuses a token whose claims were edited", () => {
    const token = encodeXSession(identity, sessionExpiry());
    const [body, signature] = token.slice(4).split(".");
    const forged = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(body!, "base64url").toString()), sub: "1" }),
    ).toString("base64url");

    // Somebody else's id, the original signature. This is the attack the session exists to stop.
    expect(() => readXSession(`axs_${forged}.${signature!}`)).toThrow(/not valid/);
  });

  it("refuses an expired session", () => {
    const token = encodeXSession(identity, Math.floor(Date.now() / 1000) - 1);
    expect(() => readXSession(token)).toThrow(/expired/);
  });

  it("finds the session in a cookie among others", () => {
    const token = encodeXSession(identity, sessionExpiry());
    const request = new Request("https://agen.space/api/x/me", {
      headers: { cookie: `other=1; ${SESSION_COOKIE}=${encodeURIComponent(token)}; last=2` },
    });

    expect(authenticateX(request).xUserId).toBe("770077");
  });

  it("refuses a request with no session at all", () => {
    expect(() => authenticateX(new Request("https://agen.space/api/x/me"))).toThrow(/Sign in/);
  });
});

describe("reading ids out of a delivery payload", () => {
  it("finds the ids and ignores everything else", () => {
    const found = postIdsFrom({
      for_user_id: "999",
      tweet_create_events: [
        { id_str: "1900000000000000123", text: "@useagen launch this", user: { id_str: "77" } },
      ],
    });

    // The user id is too short to be a post id, which is the point of the length bound.
    expect(found).toContain("1900000000000000123");
    expect(found).not.toContain("77");
    expect(found).not.toContain("999");
  });

  it("survives a payload that is not the shape it expected", () => {
    expect(postIdsFrom(null)).toEqual([]);
    expect(postIdsFrom("nope")).toEqual([]);
    expect(postIdsFrom({ deeply: { nested: { nothing: true } } })).toEqual([]);
  });
});
