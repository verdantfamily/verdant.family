/**
 * The whole path, from a reply on X to a creator claiming their fees.
 *
 * What is real here and what is stubbed is chosen deliberately. The store is a real SQLite
 * database in a temporary directory, so the idempotency and budget behaviour under test is the
 * behaviour production has rather than a description of it. X and the chain are stubbed, because
 * they are the two things a test cannot have. The model is a stub with a fixed answer for the
 * engine tests and a scripted one for the router tests, so that "the model said this" and "the
 * bot did that" can be checked separately.
 *
 * The sequence below follows the acceptance list for this feature in order: a mention arrives, the
 * parent is read, a token is generated, exactly one market is created, the X id is recorded as the
 * creator, the reply carries the right words, a redelivery launches nothing, and the same account
 * later signs in and claims.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Address, Hex } from "viem";

import type { ModelProvider } from "@verdant/market-compiler";

const TOKEN = "0x1111111111111111111111111111111111111111" as Address;
const VAULT = "0x2222222222222222222222222222222222222222" as Address;
const SEAT = "0x3333333333333333333333333333333333333333" as Address;
/** The seat's occupant. Deliberately not `SPONSOR`: the two must never be the same address. */
const OPENER = "0x4444444444444444444444444444444444444444" as Address;
const WALLET = "0x5555555555555555555555555555555555555555" as Address;
/** The wallet that pays gas, which occupies nothing. */
const SPONSOR = "0x6666666666666666666666666666666666666666" as Address;
const POOL = `0x${"aa".repeat(32)}` as Hex;
const TX = `0x${"bb".repeat(32)}` as Hex;
const LABEL = `0x${"cc".repeat(32)}` as Hex;

/** A 1×1 PNG. Real bytes, because `storeImage` sniffs them rather than trusting a name. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
  "base64",
);

// --- what the world outside this feature is made to say ----------------------

const executeSponsoredLaunch = vi.fn();
const ensureSeat = vi.fn();
const seatFor = vi.fn();
const sendAsSeatOpener = vi.fn();
const sendSponsoredToSeat = vi.fn();
const readSeatState = vi.fn();
const readSeatClaimable = vi.fn();
const readSeatedAt = vi.fn();
const readContract = vi.fn();

vi.mock("./launch", () => ({
  executeSponsoredLaunch: (...args: unknown[]) => executeSponsoredLaunch(...args),
  ensureSeat: (...args: unknown[]) => ensureSeat(...args),
}));

vi.mock("./seat", () => ({
  seatFor: (...args: unknown[]) => seatFor(...args),
  seatLabel: () => LABEL,
  assertSeatBelongsTo: async () => undefined,
}));

// Two distinct addresses, because the tests below assert which key does what. A mock that returned
// the same address for both would pass whichever way the production code was wired, which is
// exactly the bug this separation exists to prevent.
vi.mock("./sponsor", () => ({
  sponsorAddress: () => SPONSOR,
  seatOpenerAddress: () => OPENER,
  assertSponsorFunded: async () => 10n ** 20n,
  sendAsSeatOpener: (...args: unknown[]) => sendAsSeatOpener(...args),
  sendSponsoredToSeat: (...args: unknown[]) => sendSponsoredToSeat(...args),
  sponsorProblems: () => [],
}));

vi.mock("../onchain", () => ({
  publicClient: () => ({
    getGasPrice: async () => 1_000_000_000n,
    getTransactionReceipt: async () => ({ status: "success" }),
    readContract: (...args: unknown[]) => readContract(...args),
  }),
}));

vi.mock("../images", async (original) => {
  const actual = await original<typeof import("../images")>();
  return {
    ...actual,
    storeImage: async () => ({ url: "/api/images/deadbeef.png", bytes: PNG.byteLength }),
  };
});

/**
 * The model, pinned without the engine knowing.
 *
 * `routeMention` reads its provider from configuration when the caller passes none, and the engine
 * passes none — correctly, since nothing between a mention and a model should be choosing one. So
 * the module is wrapped rather than the argument threaded: a call with an explicit provider (the
 * router's own tests, below) behaves exactly as it does in production, and a call without one gets
 * whatever `answering` currently holds.
 */
let answering: Record<string, unknown> = {};

vi.mock("./intent", async (original) => {
  const actual = await original<typeof import("./intent")>();
  return {
    ...actual,
    routeMention: async (
      mention: Parameters<typeof actual.routeMention>[0],
      provider?: Parameters<typeof actual.routeMention>[1],
    ) => actual.routeMention(mention, provider ?? model(answering)),
  };
});

vi.mock("@verdant/sdk", async (original) => {
  const actual = await original<typeof import("@verdant/sdk")>();
  return {
    ...actual,
    instant: {
      ...actual.instant,
      readSeatState: (...args: unknown[]) => readSeatState(...args),
      readSeatClaimable: (...args: unknown[]) => readSeatClaimable(...args),
      readSeatedAt: (...args: unknown[]) => readSeatedAt(...args),
    },
  };
});

const { creatorView, offerSeat, collectFees } = await import("./claim");
const { handleMention } = await import("./engine");
const { mentionFromPost, pollOnce } = await import("./ingest");
const { routeMention } = await import("./intent");
const { XStore } = await import("./store");
const { XError } = await import("./errors");
const { launchReply } = await import("./reply");

type Store = InstanceType<typeof XStore>;
type Mention = Parameters<typeof handleMention>[0];
type Post = Mention["command"];

// --- the stubs ---------------------------------------------------------------

function author(overrides: Partial<Post["author"]> = {}): Post["author"] {
  return {
    id: "770077",
    username: "trencher",
    name: "Trencher",
    avatarUrl: "https://pbs.x.com/avatar.png",
    followers: 250,
    // Two years old, which clears the account-age filter.
    createdAt: new Date(Date.now() - 730 * 86_400_000).toISOString(),
    verified: false,
    ...overrides,
  };
}

function post(overrides: Partial<Post> = {}): Post {
  return {
    id: "1900000000000000001",
    text: "hello",
    author: author(),
    createdAt: new Date().toISOString(),
    inReplyToPostId: null,
    quotedPostId: null,
    media: [],
    links: [],
    language: "en",
    ...overrides,
  };
}

const SOURCE = post({
  id: "1900000000000000000",
  text: "my dog just ate the entire internet and asked for seconds",
  author: author({ id: "990099", username: "dogowner", name: "Dog Owner" }),
  media: [{ kind: "photo", url: "https://pbs.x.com/dog.png", altText: "a dog, eating a router" }],
});

const COMMAND = post({
  id: "1900000000000000002",
  text: "@useagen launch this",
  inReplyToPostId: SOURCE.id,
});

interface Recorder {
  readonly replies: { readonly text: string; readonly to: string }[];
  readonly asked: string[];
  /** Picture URLs fetched, for the tests that care which candidate the logo came from.
   * Optional so the many recorders that do not care stay two fields long. */
  readonly media?: string[];
}

function client(recorder: Recorder, posts: readonly Post[] = [SOURCE, COMMAND]) {
  return {
    mentions: async () => posts.filter((entry) => entry.text.includes("@useagen")),
    post: async (id: string) => {
      recorder.asked.push(id);
      return posts.find((entry) => entry.id === id) ?? null;
    },
    search: async () => [],
    reply: async (text: string, to: string) => {
      recorder.replies.push({ text, to });
      return "1900000000000000999";
    },
    media: async (url: string) => {
      recorder.media?.push(url);
      return PNG.buffer.slice(PNG.byteOffset, PNG.byteOffset + PNG.byteLength);
    },
  };
}

/** A model that always answers the same way, so the engine is what is under test. */
function model(answer: Record<string, unknown>): ModelProvider {
  return {
    name: "stub",
    model: "stub-1",
    generate: async <T,>() => ({
      value: answer as T,
      raw: JSON.stringify(answer),
      model: "stub-1",
      durationMs: 1,
    }),
  };
}

const LAUNCH_ANSWER = {
  intent: "LAUNCH",
  name: "Internet Dog",
  ticker: "IDOG",
  description: "A dog that ate the internet.",
  answer: null,
  confidence: 0.94,
};

function freshStore(): Store {
  return new XStore(join(mkdtempSync(join(tmpdir(), "agen-x-")), "x.db"));
}

/** What the model will say to the next mention the engine handles. */
function withModel(answer: Record<string, unknown>): void {
  answering = answer;
}

beforeEach(() => {
  vi.restoreAllMocks();
  executeSponsoredLaunch.mockReset();
  ensureSeat.mockReset();
  seatFor.mockReset();
  sendAsSeatOpener.mockReset();
  sendSponsoredToSeat.mockReset();
  readSeatState.mockReset();
  readSeatClaimable.mockReset();
  readSeatedAt.mockReset();
  readContract.mockReset();

  seatFor.mockResolvedValue({ seat: SEAT, deployed: true, opener: OPENER, label: LABEL });
  ensureSeat.mockResolvedValue(null);
  executeSponsoredLaunch.mockResolvedValue({
    token: TOKEN,
    poolId: POOL,
    vault: VAULT,
    txHash: TX,
    seat: SEAT,
    gasWei: 3_000_000_000_000_000n,
  });
});

// --- the router --------------------------------------------------------------

describe("routeMention", () => {
  it("proposes a token from the source post for a launch", async () => {
    const routed = await routeMention(
      { command: COMMAND, source: SOURCE },
      model(LAUNCH_ANSWER),
    );

    expect(routed.intent).toBe("LAUNCH");
    expect(routed.token).toMatchObject({ name: "Internet Dog", ticker: "IDOG" });
  });

  it("lets a stated ticker override the model's", async () => {
    const routed = await routeMention(
      { command: post({ text: "@useagen launch this as $DOG", inReplyToPostId: SOURCE.id }), source: SOURCE },
      model(LAUNCH_ANSWER),
    );

    expect(routed.token?.ticker).toBe("DOG");
    expect(routed.explicit.ticker).toBe("DOG");
  });

  it("answers a question in words and proposes nothing", async () => {
    const routed = await routeMention(
      { command: post({ text: "@useagen what is agen.space?" }), source: null },
      model({
        intent: "QUESTION",
        name: null,
        ticker: null,
        description: null,
        answer: "Agen launches tokens on Robinhood Chain. Reply to a post and tag me.",
        confidence: 0.9,
      }),
    );

    expect(routed.intent).toBe("QUESTION");
    expect(routed.token).toBe(null);
    expect(routed.answer).toContain("Robinhood Chain");
  });

  it("treats anything that is not one of the three intents as unknown", async () => {
    const routed = await routeMention(
      { command: COMMAND, source: SOURCE },
      model({ intent: "TRANSFER_EVERYTHING", confidence: 1 }),
    );

    expect(routed.intent).toBe("UNKNOWN");
  });

  it("normalises what the model returns rather than trusting it", async () => {
    const routed = await routeMention(
      { command: COMMAND, source: SOURCE },
      model({ ...LAUNCH_ANSWER, ticker: "$idog", confidence: 4 }),
    );

    expect(routed.token?.ticker).toBe("IDOG");
    // A model cannot talk its way past the confidence floor by exceeding it.
    expect(routed.token?.confidence).toBe(1);
  });
});

// --- the launch --------------------------------------------------------------

describe("handleMention, launching", () => {
  it("reads the parent, generates a token, launches once and replies", async () => {
    const store = freshStore();
    const recorder: Recorder = { replies: [], asked: [] };
    withModel(LAUNCH_ANSWER);

    const mention = await mentionFromPost(COMMAND, client(recorder) as never);
    expect(recorder.asked).toEqual([SOURCE.id]);
    expect(mention.source?.text).toContain("ate the entire internet");

    const outcome = await handleMention(mention, {
      store,
      client: client(recorder) as never,
    });

    expect(outcome.outcome).toBe("launched");
    expect(outcome.token).toBe(TOKEN);
    expect(executeSponsoredLaunch).toHaveBeenCalledTimes(1);

    // The token was named from the post, and the seat is what the market pays.
    const [prepared, seat] = executeSponsoredLaunch.mock.calls[0] as [
      { readonly name: string; readonly ticker: string; readonly draft: { readonly feeReceiver: string } },
      Address,
    ];
    expect(prepared.name).toBe("Internet Dog");
    expect(prepared.ticker).toBe("IDOG");
    expect(seat).toBe(SEAT);
    expect(prepared.draft.feeReceiver).toBe(SEAT);

    // The reply is the product's copy, in the thread the command was in.
    expect(recorder.replies).toHaveLength(1);
    expect(recorder.replies[0]?.to).toBe(COMMAND.id);
    expect(recorder.replies[0]?.text).toBe(launchReply({ ticker: "IDOG", token: TOKEN }));
  });

  it("records the immutable X user id as the creator, not the handle", async () => {
    const store = freshStore();
    withModel(LAUNCH_ANSWER);

    await handleMention({ command: COMMAND, source: SOURCE }, {
      store,
      client: client({ replies: [], asked: [] }) as never,
    });

    const [record] = store.launchesByUser(COMMAND.author.id);
    expect(record).toMatchObject({
      xUserId: "770077",
      xUsername: "trencher",
      sourcePostId: SOURCE.id,
      commandPostId: COMMAND.id,
      token: TOKEN,
      poolId: POOL,
      vault: VAULT,
      txHash: TX,
      seat: SEAT,
      name: "Internet Dog",
      ticker: "IDOG",
      status: "launched",
      claimStatus: "unclaimed",
    });

    // A rename does not move the entitlement: the id still finds it, the new handle does not
    // create a second one.
    store.touchIdentity("770077", "renamed");
    expect(store.launchesByUser("770077")).toHaveLength(1);
  });

  it("does not launch twice when the same post is delivered again", async () => {
    const store = freshStore();
    const recorder: Recorder = { replies: [], asked: [] };
    withModel(LAUNCH_ANSWER);

    const first = await handleMention({ command: COMMAND, source: SOURCE }, {
      store,
      client: client(recorder) as never,
    });
    const second = await handleMention({ command: COMMAND, source: SOURCE }, {
      store,
      client: client(recorder) as never,
    });

    expect(first.outcome).toBe("launched");
    expect(second.outcome).toBe("duplicate");
    expect(executeSponsoredLaunch).toHaveBeenCalledTimes(1);
    expect(store.launchesByUser("770077")).toHaveLength(1);
    expect(recorder.replies).toHaveLength(1);
  });

  it("refuses a standalone launch that does not say what to launch", async () => {
    const store = freshStore();
    const recorder: Recorder = { replies: [], asked: [] };
    withModel(LAUNCH_ANSWER);

    // No parent, no picture, no stated ticker: "launch this" with the instruction removed is
    // nothing, and a token named by a model out of nothing is the garbage the brief forbids.
    const outcome = await handleMention(
      { command: post({ id: "1900000000000000010", text: "@useagen launch this" }), source: null },
      { store, client: client(recorder) as never },
    );

    expect(outcome.outcome).toBe("refused");
    expect(outcome.code).toBe("NO_SOURCE_POST");
    expect(executeSponsoredLaunch).not.toHaveBeenCalled();
    expect(recorder.replies[0]?.text).toContain("Tell me what to launch");
  });

  it("launches from the post that tagged it when there is no parent", async () => {
    const store = freshStore();
    const recorder: Recorder = { replies: [], asked: [] };
    withModel(LAUNCH_ANSWER);

    // The commonest way to ask, and it used to be refused: a post that names the token is a
    // complete request, and there is no post above it because there does not need to be one.
    const command = post({ id: "1900000000000000011", text: "@useagen launch Internet Dog $IDOG" });
    const outcome = await handleMention({ command, source: null }, {
      store,
      client: client(recorder) as never,
    });

    expect(outcome.outcome).toBe("launched");
    expect(outcome.token).toBe(TOKEN);
    expect(executeSponsoredLaunch).toHaveBeenCalledTimes(1);

    const [prepared] = executeSponsoredLaunch.mock.calls[0] as [
      { readonly ticker: string; readonly draft: { readonly linkX: string; readonly description: string } },
    ];
    expect(prepared.ticker).toBe("IDOG");
    // Provenance points at the only post there is, so the market still says where it came from.
    expect(prepared.draft.linkX).toContain(command.id);

    const [record] = store.launchesByUser("770077");
    // Null rather than the command's id: there was no parent, and recording one would describe a
    // reply that never happened.
    expect(record?.sourcePostId).toBe(null);
    expect(record?.commandPostId).toBe(command.id);
  });

  it("uses a picture in the post that tagged it as the logo", async () => {
    const store = freshStore();
    const recorder: Recorder = { replies: [], asked: [], media: [] };
    withModel(LAUNCH_ANSWER);

    // A picture is material on its own, so this launches without a stated ticker — and the
    // attached picture is what it must reach for rather than the author's avatar.
    const command = post({
      id: "1900000000000000012",
      text: "@useagen launch this",
      media: [{ kind: "photo", url: "https://pbs.x.com/media/dog.png", altText: null }],
    });

    const outcome = await handleMention({ command, source: null }, {
      store,
      client: client(recorder) as never,
    });

    expect(outcome.outcome).toBe("launched");
    expect(recorder.media).toContain("https://pbs.x.com/media/dog.png");
  });

  it("does not launch when the model is unsure, and keeps the post for a retry of nothing", async () => {
    const store = freshStore();
    withModel({ ...LAUNCH_ANSWER, confidence: 0.2 });

    const outcome = await handleMention({ command: COMMAND, source: SOURCE }, {
      store,
      client: client({ replies: [], asked: [] }) as never,
    });

    expect(outcome.code).toBe("GENERATION_FAILED");
    expect(executeSponsoredLaunch).not.toHaveBeenCalled();
  });

  it("refuses a token whose name the contract could not hold", async () => {
    const store = freshStore();
    withModel({ ...LAUNCH_ANSWER, name: "N".repeat(80) });

    const outcome = await handleMention({ command: COMMAND, source: SOURCE }, {
      store,
      client: client({ replies: [], asked: [] }) as never,
    });

    expect(outcome.code).toBe("GENERATION_FAILED");
    expect(executeSponsoredLaunch).not.toHaveBeenCalled();
  });

  it("answers a question without touching the launch path", async () => {
    const store = freshStore();
    const recorder: Recorder = { replies: [], asked: [] };
    withModel({
      intent: "QUESTION",
      name: null,
      ticker: null,
      description: null,
      answer: "Agen turns a post into a market. Reply to one and tag me.",
      confidence: 0.9,
    });

    const outcome = await handleMention(
      { command: post({ id: "1900000000000000020", text: "@useagen what is agen.space?" }), source: null },
      { store, client: client(recorder) as never },
    );

    expect(outcome.outcome).toBe("answered");
    expect(executeSponsoredLaunch).not.toHaveBeenCalled();
    expect(recorder.replies[0]?.text).toContain("market");
  });

  it("says nothing at all when it cannot tell what was meant", async () => {
    const store = freshStore();
    const recorder: Recorder = { replies: [], asked: [] };
    withModel({ intent: "UNKNOWN", confidence: 0.1 });

    const outcome = await handleMention(
      { command: post({ id: "1900000000000000030", text: "@useagen hm" }), source: null },
      { store, client: client(recorder) as never },
    );

    expect(outcome.outcome).toBe("ignored");
    expect(recorder.replies).toHaveLength(0);
  });
});

// --- the protections ---------------------------------------------------------

describe("handleMention, refusing", () => {
  it("will not act on a blocked account", async () => {
    const store = freshStore();
    store.block("770077", "farming");
    withModel(LAUNCH_ANSWER);

    const outcome = await handleMention({ command: COMMAND, source: SOURCE }, {
      store,
      client: client({ replies: [], asked: [] }) as never,
    });

    expect(outcome.code).toBe("BLOCKED");
    expect(executeSponsoredLaunch).not.toHaveBeenCalled();
  });

  it("stops launching when the kill switch is thrown, and stays quiet about the rest", async () => {
    const store = freshStore();
    store.setLaunchesPaused(true, "operator");
    withModel(LAUNCH_ANSWER);

    const outcome = await handleMention({ command: COMMAND, source: SOURCE }, {
      store,
      client: client({ replies: [], asked: [] }) as never,
    });

    expect(outcome.code).toBe("LAUNCHES_DISABLED");
    expect(executeSponsoredLaunch).not.toHaveBeenCalled();
  });

  it("holds one account to its daily allowance", async () => {
    const store = freshStore();
    withModel(LAUNCH_ANSWER);

    // The cooldown would refuse the second launch before the allowance did, so it is turned off
    // for this test: what is under test is the count, not the interval.
    vi.stubEnv("X_USER_COOLDOWN_SECONDS", "0");
    vi.stubEnv("X_MAX_LAUNCHES_PER_USER_PER_DAY", "1");

    const first = await handleMention({ command: COMMAND, source: SOURCE }, {
      store,
      client: client({ replies: [], asked: [] }) as never,
    });
    const second = await handleMention(
      { command: post({ id: "1900000000000000040", text: "@useagen launch this", inReplyToPostId: SOURCE.id }), source: SOURCE },
      { store, client: client({ replies: [], asked: [] }) as never },
    );

    expect(first.outcome).toBe("launched");
    expect(second.code).toBe("USER_DAILY_LIMIT");
    expect(executeSponsoredLaunch).toHaveBeenCalledTimes(1);
  });

  it("refuses an account that is too new to have earned a sponsored launch", async () => {
    const store = freshStore();
    withModel(LAUNCH_ANSWER);

    const outcome = await handleMention(
      {
        command: post({
          id: "1900000000000000050",
          text: "@useagen launch this",
          inReplyToPostId: SOURCE.id,
          author: author({ id: "12121", createdAt: new Date().toISOString() }),
        }),
        source: SOURCE,
      },
      { store, client: client({ replies: [], asked: [] }) as never },
    );

    expect(outcome.code).toBe("ACCOUNT_TOO_NEW");
    expect(executeSponsoredLaunch).not.toHaveBeenCalled();
  });

  it("never retries a launch whose transaction was sent but not confirmed", async () => {
    const store = freshStore();
    withModel(LAUNCH_ANSWER);

    // The shape of the dangerous failure: the hash is known, so a market may exist, and the
    // receipt never arrived.
    executeSponsoredLaunch.mockImplementation(
      async (_prepared: unknown, _seat: Address, onHash: (hash: Hex) => void) => {
        onHash(TX);
        throw new XError("X_UNAVAILABLE", "the node went away", { retryable: true });
      },
    );

    const outcome = await handleMention({ command: COMMAND, source: SOURCE }, {
      store,
      client: client({ replies: [], asked: [] }) as never,
    });

    expect(outcome.code).toBe("LAUNCH_INDETERMINATE");
    expect(outcome.retryable).toBe(false);

    const [record] = store.launchesByUser("770077");
    expect(record?.status).toBe("indeterminate");
    expect(record?.txHash).toBe(TX);

    // The claim is deliberately kept, so a redelivery cannot send a second transaction.
    expect(store.mentionExists(COMMAND.id)).toBe(true);
    const again = await handleMention({ command: COMMAND, source: SOURCE }, {
      store,
      client: client({ replies: [], asked: [] }) as never,
    });
    expect(again.outcome).toBe("duplicate");
    expect(executeSponsoredLaunch).toHaveBeenCalledTimes(1);
  });

  it("releases the post for another pass when the failure was transient and nothing was sent", async () => {
    const store = freshStore();
    withModel(LAUNCH_ANSWER);

    executeSponsoredLaunch.mockRejectedValueOnce(
      new XError("X_UNAVAILABLE", "rpc hiccup", { retryable: true }),
    );

    const outcome = await handleMention({ command: COMMAND, source: SOURCE }, {
      store,
      client: client({ replies: [], asked: [] }) as never,
    });

    expect(outcome.retryable).toBe(true);
    expect(store.mentionExists(COMMAND.id)).toBe(false);

    // And the reservation went back, so a flapping RPC does not eat the day's allowance.
    expect(store.usage().launches).toBe(0);

    executeSponsoredLaunch.mockResolvedValue({
      token: TOKEN,
      poolId: POOL,
      vault: VAULT,
      txHash: TX,
      seat: SEAT,
      gasWei: 1n,
    });
    const retried = await handleMention({ command: COMMAND, source: SOURCE }, {
      store,
      client: client({ replies: [], asked: [] }) as never,
    });
    expect(retried).toMatchObject({ outcome: "launched", code: null });
  });
});

// --- delivery ----------------------------------------------------------------

describe("polling", () => {
  it("handles a mention, advances the cursor, and finds nothing the second time", async () => {
    const store = freshStore();
    const recorder: Recorder = { replies: [], asked: [] };
    withModel(LAUNCH_ANSWER);

    const first = await pollOnce({ store, client: client(recorder) as never });
    expect(first.launched).toBe(1);
    expect(first.cursor).toBe(COMMAND.id);
    expect(store.sinceId()).toBe(COMMAND.id);

    // The same batch again — a poll overlapping with the previous one, or a cursor that did not
    // stick. The claim, not the cursor, is what makes this safe.
    const second = await pollOnce({ store, client: client(recorder) as never });
    expect(second.launched).toBe(0);
    expect(executeSponsoredLaunch).toHaveBeenCalledTimes(1);
  });

  it("leaves the cursor behind a mention that should be tried again", async () => {
    const store = freshStore();
    withModel(LAUNCH_ANSWER);

    executeSponsoredLaunch.mockRejectedValue(
      new XError("X_UNAVAILABLE", "rpc down", { retryable: true }),
    );

    const result = await pollOnce({ store, client: client({ replies: [], asked: [] }) as never });

    expect(result.cursor).toBe(null);
    expect(store.sinceId()).toBe(null);
  });

  it("ignores a post that does not address the bot but does not re-read it forever", async () => {
    const store = freshStore();
    const chatter = post({ id: "1900000000000000060", text: "@useagen is interesting" });
    withModel({ intent: "UNKNOWN", confidence: 0.2 });

    const result = await pollOnce({
      store,
      client: client({ replies: [], asked: [] }, [chatter]) as never,
    });

    expect(result.launched).toBe(0);
    expect(store.sinceId()).toBe(chatter.id);
  });
});

// --- the claim ---------------------------------------------------------------

describe("claiming, later", () => {
  async function launched(): Promise<Store> {
    const store = freshStore();
    withModel(LAUNCH_ANSWER);
    await handleMention({ command: COMMAND, source: SOURCE }, {
      store,
      client: client({ replies: [], asked: [] }) as never,
    });
    return store;
  }

  const IDENTITY = {
    xUserId: "770077",
    xUsername: "trencher",
    name: "Trencher",
    avatarUrl: null,
  };

  it("shows the signed-in account its launches and what they have earned", async () => {
    const store = await launched();

    readContract.mockResolvedValue(5_000_000_000_000_000n);
    readSeatClaimable.mockResolvedValue(2_000_000_000_000_000n);
    readSeatedAt.mockResolvedValue(true);
    readSeatState.mockResolvedValue({
      beneficiary: OPENER,
      offered: "0x0000000000000000000000000000000000000000",
      proposed: "0x0000000000000000000000000000000000000000",
      executableAt: 0,
      arbitrable: true,
      steward: OPENER,
    });

    const view = await creatorView(IDENTITY, store);

    expect(view.launches).toHaveLength(1);
    expect(view.launches[0]?.record.ticker).toBe("IDOG");
    expect(view.totals.earnedWei).toBe(5_000_000_000_000_000n);
    expect(view.totals.claimableWei).toBe(2_000_000_000_000_000n);
    // Still Agen's seat, so the page will offer the handover rather than the collection.
    expect(view.seat.claimed).toBe(false);
  });

  it("offers the seat to the verified creator's wallet", async () => {
    const store = await launched();

    readSeatState.mockResolvedValue({
      beneficiary: OPENER,
      offered: "0x0000000000000000000000000000000000000000",
      proposed: "0x0000000000000000000000000000000000000000",
      executableAt: 0,
      arbitrable: true,
      steward: OPENER,
    });
    sendAsSeatOpener.mockResolvedValue({ hash: TX, receipt: {}, gasWei: 1n });

    const result = await offerSeat(IDENTITY, WALLET, store);

    expect(result.seat).toBe(SEAT);
    expect(result.wallet).toBe(WALLET);
    expect(result.alreadyClaimed).toBe(false);
    // The seat only moves when the wallet signs, so the caller is handed that call.
    expect(result.take.to).toBe(SEAT);
    expect(store.launchesByUser("770077")[0]?.claimStatus).toBe("offered");
    // Signed by the occupant and by nothing else. `offer` is occupant-only on the contract, so a
    // sponsor-signed attempt would revert on chain rather than fail here — which is why this is
    // asserted rather than left to integration.
    expect(sendAsSeatOpener).toHaveBeenCalledTimes(1);
    expect(sendSponsoredToSeat).not.toHaveBeenCalled();
  });

  it("refuses to offer the seat to either of Agen's own wallets", async () => {
    const store = await launched();

    readSeatState.mockResolvedValue({
      beneficiary: OPENER,
      offered: "0x0000000000000000000000000000000000000000",
      proposed: "0x0000000000000000000000000000000000000000",
      executableAt: 0,
      arbitrable: true,
      steward: OPENER,
    });

    // The opener is refused because offering a seat to its own occupant reverts; the sponsor is
    // refused because it is the rotatable key, and a creator's fees pointed at it would be lost
    // the next time it was replaced.
    for (const ours of [OPENER, SPONSOR]) {
      await expect(offerSeat(IDENTITY, ours, store)).rejects.toThrow(/Agen's own address/);
    }
    expect(sendAsSeatOpener).not.toHaveBeenCalled();
  });

  it("will not collect fees while Agen still holds the seat", async () => {
    const store = await launched();

    readSeatState.mockResolvedValue({
      beneficiary: OPENER,
      offered: WALLET,
      proposed: "0x0000000000000000000000000000000000000000",
      executableAt: 0,
      arbitrable: true,
      steward: OPENER,
    });

    const record = store.launchesByUser("770077")[0]!;
    await expect(collectFees(IDENTITY, record.id, store)).rejects.toThrow(/Take the seat/);
    expect(sendSponsoredToSeat).not.toHaveBeenCalled();
    expect(sendAsSeatOpener).not.toHaveBeenCalled();
  });

  it("collects for the creator once the seat is theirs, at Agen's expense", async () => {
    const store = await launched();

    readSeatState.mockResolvedValue({
      beneficiary: WALLET,
      offered: "0x0000000000000000000000000000000000000000",
      proposed: "0x0000000000000000000000000000000000000000",
      executableAt: 0,
      arbitrable: false,
      steward: OPENER,
    });
    readSeatClaimable.mockResolvedValue(7n);
    sendSponsoredToSeat.mockResolvedValue({ hash: TX, receipt: {}, gasWei: 1n });

    const record = store.launchesByUser("770077")[0]!;
    const result = await collectFees(IDENTITY, record.id, store);

    expect(result.amountWei).toBe(7n);
    expect(result.txHash).toBe(TX);
    // Paid by the sponsor, not signed by the opener. `collect` is permissionless and pays the
    // occupant — the creator, by now — so it needs gas and no authority over the seat.
    expect(sendSponsoredToSeat).toHaveBeenCalledTimes(1);
    expect(sendAsSeatOpener).not.toHaveBeenCalled();
  });

  it("will not show one account another account's launches", async () => {
    const store = await launched();
    readSeatState.mockResolvedValue({
      beneficiary: OPENER,
      offered: "0x0000000000000000000000000000000000000000",
      proposed: "0x0000000000000000000000000000000000000000",
      executableAt: 0,
      arbitrable: true,
      steward: OPENER,
    });

    const view = await creatorView({ ...IDENTITY, xUserId: "000111" }, store);
    expect(view.launches).toHaveLength(0);

    const record = store.launchesByUser("770077")[0]!;
    await expect(
      collectFees({ ...IDENTITY, xUserId: "000111" }, record.id, store),
    ).rejects.toThrow(/No such launch/);
  });
});
