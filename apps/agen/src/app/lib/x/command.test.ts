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
import { getAddress, parseEther } from "viem";

import { needsSource, normaliseName, normaliseTicker, parseCommand } from "./command";
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

/**
 * The one parse that spends somebody's money.
 *
 * Tested harder than the launch grammar and in the opposite direction. There, a miss costs a
 * model call; here, a false positive is a stranger's ether spent on a token they were talking
 * about rather than asking for — so most of these cases are about *not* trading.
 */
describe("parseTrade", () => {
  const TOKEN = "0x1111111111111111111111111111111111111111";

  it("reads the buy people will actually type", () => {
    const parsed = parseCommand(`@useagen buy 0.001 ETH of ${TOKEN}`, BOT);
    expect(parsed.trade).toEqual({
      side: "buy",
      target: { kind: "address", token: getAddress(TOKEN) },
      amountWei: parseEther("0.001"),
      fraction: null,
    });
  });

  it("reads the amount however it is written", () => {
    for (const [text, expected] of [
      ["buy 0.5 eth of $DOG", parseEther("0.5")],
      ["buy .25 ETH of $DOG", parseEther("0.25")],
      ["buy 2 ether of $DOG", parseEther("2")],
      ["ape 0.01 eth into $DOG", parseEther("0.01")],
    ] as const) {
      expect(parseCommand(`@useagen ${text}`, BOT).trade?.amountWei, text).toBe(expected);
    }
  });

  it("takes a contract address out of the brackets people put it in", () => {
    const parsed = parseCommand(`@useagen buy 0.001 ETH of (${TOKEN})`, BOT);
    expect(parsed.trade?.target).toEqual({ kind: "address", token: getAddress(TOKEN) });
  });

  it("keeps a ticker as a ticker, for somebody else to resolve", () => {
    expect(parseCommand("@useagen buy 0.01 eth of $DOG", BOT).trade?.target).toEqual({
      kind: "ticker",
      ticker: "DOG",
    });
  });

  it("asks how much rather than choosing an amount", () => {
    const parsed = parseCommand("@useagen buy $DOG", BOT);
    expect(parsed.trade?.side).toBe("buy");
    expect(parsed.trade?.amountWei).toBe(null);
  });

  it("sells the position by default and honours a share when given one", () => {
    expect(parseCommand("@useagen sell $DOG", BOT).trade?.fraction).toBe(1);
    expect(parseCommand("@useagen sell all my $DOG", BOT).trade?.fraction).toBe(1);
    expect(parseCommand("@useagen sell 50% of $DOG", BOT).trade?.fraction).toBe(0.5);
    expect(parseCommand("@useagen sell half my $DOG", BOT).trade?.fraction).toBe(0.5);
  });

  it("does not read a question about buying as an instruction to buy", () => {
    for (const text of [
      "@useagen how do i buy 0.1 eth of $DOG",
      "@useagen what happens when i buy $DOG",
      "@useagen why would anyone buy 1 eth of $DOG",
      "@useagen when should i sell $DOG",
    ]) {
      expect(parseCommand(text, BOT).trade, text).toBe(null);
    }
  });

  it("refuses to guess when a post asks for both sides", () => {
    expect(parseCommand("@useagen sell $DOG and buy $CAT", BOT).trade).toBe(null);
  });

  it("does not trade on a post with no token in it", () => {
    expect(parseCommand("@useagen buy 0.1 eth", BOT).trade).toBe(null);
    expect(parseCommand("@useagen i bought the dip", BOT).trade).toBe(null);
  });

  it("takes the token from the post being replied to when they said of it", () => {
    // The live failure: a reply under a launch announcement, no address in the command.
    // The parent is the launch reply itself — ticker plus the market link.
    const parent = [
      "$TEST2 is live on Robinhood.",
      "You earn 1% of every trade. Happy trenching!",
      "https://agen.space/markets/0xa20931BcA92deDdf725d4108721e683B7c2BCdD3",
    ].join("\n");

    const parsed = parseCommand("@useagen now buy 0.005 ETH of it", BOT, parent);
    expect(parsed.trade).toEqual({
      side: "buy",
      target: { kind: "address", token: getAddress("0xa20931BcA92deDdf725d4108721e683B7c2BCdD3") },
      amountWei: parseEther("0.005"),
      fraction: null,
    });
  });

  it("takes the token from a reply that is only an amount", () => {
    const parsed = parseCommand("@useagen buy 0.1 eth", BOT, "check out $DOG");
    expect(parsed.trade?.target).toEqual({ kind: "ticker", ticker: "DOG" });
    expect(parsed.trade?.amountWei).toBe(parseEther("0.1"));
  });

  it("will not guess when the parent names two different markets", () => {
    const parent =
      "0x1111111111111111111111111111111111111111 vs 0x2222222222222222222222222222222222222222";
    expect(parseCommand("@useagen buy 0.1 eth of it", BOT, parent).trade).toBe(null);
  });

  it("sells 'it' the same way, from the parent market", () => {
    const parent = "https://agen.space/markets/0xa20931BcA92deDdf725d4108721e683B7c2BCdD3";
    const parsed = parseCommand("@useagen sell it", BOT, parent);
    expect(parsed.trade).toMatchObject({
      side: "sell",
      fraction: 1,
      target: { kind: "address", token: getAddress("0xa20931BcA92deDdf725d4108721e683B7c2BCdD3") },
    });
  });

  it("does not wait on a parent when the trade or the wallet is already named", () => {
    expect(needsSource(parseCommand("@useagen buy 0.001 ETH of $DOG", BOT))).toBe(false);
    expect(needsSource(parseCommand("@useagen sell $DOG", BOT))).toBe(false);
    expect(needsSource(parseCommand("@useagen my wallet", BOT))).toBe(false);
    expect(needsSource(parseCommand("@useagen now buy 0.005 ETH of it", BOT))).toBe(true);
    expect(needsSource(parseCommand("@useagen launch this", BOT))).toBe(true);
  });

  it("still will not treat 'i bought the dip' as a buy just because it is a reply", () => {
    expect(
      parseCommand(
        "@useagen i bought the dip",
        BOT,
        "$DOG is live https://agen.space/markets/0x1111111111111111111111111111111111111111",
      ).trade,
    ).toBe(null);
  });

  it("lets a launch win when a post asks for both", () => {
    // Guessing wrong this way costs Agen gas. Guessing wrong the other way costs the person
    // ether they had not asked to spend yet.
    const parsed = parseCommand("@useagen launch $DOG then buy 0.1 eth of it", BOT);
    expect(parsed.looksLikeLaunch).toBe(true);
    expect(parsed.trade).toBe(null);
  });

  it("will not buy a mistyped address", () => {
    // `0x…1aAa` is the checksummed form; `0x…1AAa` is the same address with one letter's case
    // flipped, which is what a mangled copy-paste looks like. The token at the address as typed
    // is not the token that was meant, so it is refused rather than corrected.
    expect(
      parseCommand("@useagen buy 0.1 eth of 0x1111111111111111111111111111111111111AAa", BOT).trade,
    ).toBe(null);
  });

  it("still accepts an address written in one case throughout", () => {
    // Lower case carries no checksum to fail, and it is how most addresses are pasted.
    const lower = "0x1111111111111111111111111111111111111aaa";
    expect(parseCommand(`@useagen buy 0.1 eth of ${lower}`, BOT).trade?.target).toEqual({
      kind: "address",
      token: getAddress(lower),
    });
  });
});

describe("asksWallet", () => {
  it("recognises somebody asking about their own wallet", () => {
    for (const text of [
      "@useagen my wallet",
      "@useagen what's my balance",
      "@useagen wallet balance",
      "@useagen my holdings",
      "@useagen deposit address",
      "@useagen wallet?",
      "@useagen balance",
    ]) {
      expect(parseCommand(text, BOT).asksWallet, text).toBe(true);
    }
  });

  it("leaves questions about other wallets to the model", () => {
    for (const text of [
      "@useagen which wallet launched this",
      "@useagen is the treasury wallet public",
      "@useagen what does this wallet hold",
    ]) {
      expect(parseCommand(text, BOT).asksWallet, text).toBe(false);
    }
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
