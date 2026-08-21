/**
 * Launching from the form with no wallet, at Agen's expense.
 *
 * What is real here and what is stubbed follows `x/engine.test.ts`: the ledger is a real SQLite
 * database in a temporary directory, because the budget and idempotency behaviour under test is
 * arithmetic and constraints rather than intent, and a mock of a store would only restate what
 * this module believes. The chain and the sponsor keys are stubbed, since they are the two things
 * a test cannot have.
 *
 * The order below is the order the refusals matter in. Everything that costs the platform money
 * is checked first: who the fees can be named to, what the client is allowed to decide, and what
 * happens to the day's budget when a launch fails. The convenience cases come after.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Address, Hex } from "viem";

const TOKEN = "0x1111111111111111111111111111111111111111" as Address;
const VAULT = "0x2222222222222222222222222222222222222222" as Address;
const POOL = `0x${"aa".repeat(32)}` as Hex;
const TX = `0x${"bb".repeat(32)}` as Hex;

/** The creator's own address, typed into the form. Checksummed, as `getAddress` returns it. */
const CREATOR = "0xEB2d2F1b8c558a40207669291Fda468E50c8A0bB" as Address;
const SECOND = "0xed91105C6f6F45185A80509402CB4C941918ac63" as Address;
const SPONSOR = "0x6666666666666666666666666666666666666666" as Address;
const OPENER = "0x4444444444444444444444444444444444444444" as Address;
const ZERO = "0x0000000000000000000000000000000000000000" as Address;

const executeSponsoredLaunch = vi.fn();

vi.mock("./x/launch", () => ({
  executeSponsoredLaunch: (...args: unknown[]) => executeSponsoredLaunch(...args),
  ensureSeat: async () => null,
}));

// Two distinct addresses, because the module refuses both by name and a stub returning one
// address for each would pass however the production code was wired.
vi.mock("./x/sponsor", () => ({
  sponsorAddress: () => SPONSOR,
  seatOpenerAddress: () => OPENER,
  assertSponsorFunded: async () => 10n ** 20n,
  sponsorProblems: () => [],
}));

vi.mock("./onchain", () => ({
  publicClient: () => ({
    getGasPrice: async () => 1_000_000_000n,
  }),
}));

const { XStore } = await import("./x/store");
const { XError } = await import("./x/errors");
const { budgetKeyFor, buildDraft, launchSponsoredFromWeb, readRequest, webLimits } = await import(
  "./instant-sponsor"
);

type Store = InstanceType<typeof XStore>;

function freshStore(): Store {
  return new XStore(join(mkdtempSync(join(tmpdir(), "agen-web-launch-")), "x.db"));
}

let attempts = 0;

/** A launchable request. Each call gets its own attempt name, as a separate submission would. */
function request(overrides: Record<string, unknown> = {}) {
  attempts += 1;
  return readRequest({
    name: "King",
    symbol: "KING",
    description: "A king.",
    imageUrl: "/api/images/abc.png",
    feeReceiver: CREATOR,
    linkX: "",
    website: "",
    telegram: "",
    idempotencyKey: `attempt-${String(attempts)}`,
    ...overrides,
  });
}

/** The environment dials, restored between tests so one test's limits cannot set another's. */
const DIALS = [
  "AGEN_WEB_MAX_LAUNCHES_PER_RECIPIENT_PER_DAY",
  "AGEN_WEB_COOLDOWN_SECONDS",
  "AGEN_WEB_SPONSOR_DISABLED",
  "X_MAX_LAUNCHES_PER_DAY",
  "X_MAX_GAS_PER_DAY_WEI",
] as const;

beforeEach(() => {
  executeSponsoredLaunch.mockReset();
  executeSponsoredLaunch.mockResolvedValue({
    token: TOKEN,
    poolId: POOL,
    vault: VAULT,
    txHash: TX,
    seat: CREATOR,
    gasWei: 3_000_000_000_000_000n,
  });

  for (const dial of DIALS) delete process.env[dial];
  // Generous by default, so a test about anything other than a limit is not accidentally
  // about a limit. The tests that care set their own.
  process.env.AGEN_WEB_MAX_LAUNCHES_PER_RECIPIENT_PER_DAY = "50";
  process.env.AGEN_WEB_COOLDOWN_SECONDS = "0";
});

/** What `executeSponsoredLaunch` was asked to do, for the assertions about the draft. */
function submitted(): { prepared: { derived: Record<string, unknown> }; recipient: Address } {
  const call = executeSponsoredLaunch.mock.calls[0] as [
    { derived: Record<string, unknown> },
    Address,
  ];
  return { prepared: call[0], recipient: call[1] };
}

describe("who the fees are named to", () => {
  it("names the address that was typed, and nothing else", async () => {
    const store = freshStore();
    const result = await launchSponsoredFromWeb(request(), store);

    expect(result.token).toBe(TOKEN);
    expect(result.feeRecipient).toBe(CREATOR);
    // The address itself, checksummed, rather than an escrow or a seat derived from it. This is
    // the value `InstantFeeVault` makes immutable, so it is asserted on the call rather than
    // inferred from the result.
    expect(submitted().recipient).toBe(CREATOR);
    expect(submitted().prepared.derived.feeRecipient).toBe(CREATOR);
  });

  /**
   * The one refusal that is not a convenience.
   *
   * There is no connected wallet to fall back on and no verified identity to derive a claimable
   * seat from, so a launch with no address would accrue a stranger's fees somewhere nobody can
   * ever collect them — permanently, on a market Agen paid to create.
   */
  it("refuses a launch with no address for the fees", async () => {
    const store = freshStore();
    await expect(launchSponsoredFromWeb(request({ feeReceiver: "" }), store)).rejects.toThrow(
      /address your fees should go to/i,
    );
    expect(executeSponsoredLaunch).not.toHaveBeenCalled();
  });

  it("refuses something that is not an address", async () => {
    const store = freshStore();
    await expect(
      launchSponsoredFromWeb(request({ feeReceiver: "my wallet" }), store),
    ).rejects.toThrow(/address your fees should go to/i);
  });

  it("refuses the address that would burn the fees", async () => {
    const store = freshStore();
    await expect(launchSponsoredFromWeb(request({ feeReceiver: ZERO }), store)).rejects.toThrow(
      /burn your fees/i,
    );
  });

  /**
   * Not a hypothetical: both addresses are public, and a request naming one is either a copy-paste
   * from a block explorer or an attempt to make the platform look like it pays itself.
   */
  it.each([
    ["the sponsor wallet", SPONSOR],
    ["the seat opener", OPENER],
  ])("refuses %s as a fee recipient", async (_name, address) => {
    const store = freshStore();
    await expect(launchSponsoredFromWeb(request({ feeReceiver: address }), store)).rejects.toThrow(
      /Agen's own addresses/i,
    );
    expect(executeSponsoredLaunch).not.toHaveBeenCalled();
  });
});

describe("what the client is allowed to decide", () => {
  /**
   * The three fields that would cost the platform money, forced rather than read.
   *
   * `initialBuy` is the sharpest: it becomes the transaction's `value` and the sponsor wallet is
   * what sends it, so a request that could set it would be a request that could make Agen buy
   * somebody else's tokens.
   */
  it("forces the fields that decide who signs and what is spent", () => {
    const draft = buildDraft(request());

    expect(draft.sponsored).toBe(true);
    expect(draft.useConnectedWallet).toBe(false);
    expect(draft.boostCapable).toBe(false);
    expect(draft.initialBuy).toBe("");
  });

  it("cannot be talked into a first buy by the request body", async () => {
    const store = freshStore();
    // Fields the request shape does not carry. Present here because a body can contain anything,
    // and the assertion is that carrying them changes nothing.
    await launchSponsoredFromWeb(
      request({ initialBuy: "5", boostCapable: true, useConnectedWallet: true, sponsored: false }),
      store,
    );

    expect(submitted().prepared.derived.initialBuyWei).toBe(0n);
    expect(submitted().prepared.derived.boostCapable).toBe(false);
  });

  /**
   * The picture's address is written into an immutable metadata document on a token Agen paid
   * for. Left to the client, a launch could point it at an address somebody else controls and
   * change it afterwards.
   */
  it.each([
    ["an off-site address", "https://evil.example/logo.png"],
    ["a path outside the image route", "/api/metadata/abc.json"],
    ["nothing at all", ""],
  ])("refuses a logo that is %s", async (_name, imageUrl) => {
    const store = freshStore();
    await expect(launchSponsoredFromWeb(request({ imageUrl }), store)).rejects.toThrow(
      /picture/i,
    );
    expect(executeSponsoredLaunch).not.toHaveBeenCalled();
  });
});

describe("the platform's budget", () => {
  it("keys the day's usage per recipient, apart from X ids", () => {
    // An X id is digits and this never is, so the two populations cannot collide on a key.
    expect(budgetKeyFor(CREATOR)).toBe(`web:${CREATOR.toLowerCase()}`);
    expect(budgetKeyFor(CREATOR)).not.toMatch(/^\d+$/);
  });

  it("shares the platform-wide ceilings with the bot rather than adding a second one", () => {
    process.env.X_MAX_LAUNCHES_PER_DAY = "7";
    process.env.X_MAX_GAS_PER_DAY_WEI = "42";

    expect(webLimits().launchesPerDay).toBe(7);
    expect(webLimits().gasPerDayWei).toBe(42n);
  });

  it("stops a recipient at its launches for the day", async () => {
    process.env.AGEN_WEB_MAX_LAUNCHES_PER_RECIPIENT_PER_DAY = "1";
    const store = freshStore();

    await launchSponsoredFromWeb(request(), store);
    await expect(launchSponsoredFromWeb(request(), store)).rejects.toMatchObject({
      code: "USER_DAILY_LIMIT",
    });

    // A different address is a different key, and that is the known limit of keying on one: the
    // platform-wide count is what bounds somebody willing to rotate.
    await expect(
      launchSponsoredFromWeb(request({ feeReceiver: SECOND }), store),
    ).resolves.toMatchObject({ feeRecipient: SECOND });
  });

  it("stops the platform at its launches for the day", async () => {
    process.env.X_MAX_LAUNCHES_PER_DAY = "1";
    const store = freshStore();

    await launchSponsoredFromWeb(request(), store);
    await expect(
      launchSponsoredFromWeb(request({ feeReceiver: SECOND }), store),
    ).rejects.toMatchObject({ code: "PLATFORM_DAILY_LIMIT" });
  });

  it("stops when the day's gas is spent", async () => {
    process.env.X_MAX_GAS_PER_DAY_WEI = "1";
    const store = freshStore();

    await expect(launchSponsoredFromWeb(request(), store)).rejects.toMatchObject({
      code: "GAS_BUDGET_EXHAUSTED",
    });
    expect(executeSponsoredLaunch).not.toHaveBeenCalled();
  });

  it("makes a recipient wait between launches", async () => {
    process.env.AGEN_WEB_COOLDOWN_SECONDS = "300";
    const store = freshStore();

    await launchSponsoredFromWeb(request(), store);
    await expect(launchSponsoredFromWeb(request(), store)).rejects.toMatchObject({
      code: "COOLDOWN",
    });
  });

  it("charges the day what the launch actually cost, not what was reserved", async () => {
    const store = freshStore();
    await launchSponsoredFromWeb(request(), store);

    expect(store.usage().launches).toBe(1);
    expect(store.usage().gasWei).toBe(3_000_000_000_000_000n);
  });

  /**
   * A refusal that sent nothing must not draw down the day.
   *
   * Otherwise a scripted flood of launches that fail late costs the platform its whole budget
   * without ever creating a market, which is a cheaper attack than the one the budget is for.
   */
  it("gives the budget back when nothing reached the chain", async () => {
    const store = freshStore();
    executeSponsoredLaunch.mockRejectedValue(new XError("LAUNCH_REVERTED", "no."));

    await expect(launchSponsoredFromWeb(request(), store)).rejects.toThrow();

    expect(store.usage().gasWei).toBe(0n);
    expect(store.usage().launches).toBe(0);
  });

  /**
   * A launch whose transaction was accepted and whose receipt never arrived.
   *
   * The reservation is *kept*, because the money is gone whether or not this process learned
   * what it bought, and the caller is told never to retry: the chain may already hold the market.
   */
  it("keeps the spend and refuses to look retryable when a transaction was sent", async () => {
    const store = freshStore();
    executeSponsoredLaunch.mockImplementation(
      async (_prepared: unknown, _recipient: Address, onHash: (hash: Hex) => void) => {
        await onHash(TX);
        throw new XError("X_UNAVAILABLE", "the node stopped answering");
      },
    );

    await expect(launchSponsoredFromWeb(request(), store)).rejects.toMatchObject({
      code: "LAUNCH_INDETERMINATE",
      retryable: false,
    });

    expect(store.usage().gasWei).toBeGreaterThan(0n);
  });
});

describe("one submission, one market", () => {
  it("refuses a second launch under the same request id", async () => {
    const store = freshStore();
    const once = request();

    await launchSponsoredFromWeb(once, store);
    await expect(launchSponsoredFromWeb(once, store)).rejects.toMatchObject({
      code: "ALREADY_HANDLED",
    });
    expect(executeSponsoredLaunch).toHaveBeenCalledTimes(1);
  });

  it("lets an honest retry through when the first attempt sent nothing", async () => {
    const store = freshStore();
    const once = request();

    executeSponsoredLaunch.mockRejectedValueOnce(new XError("X_UNAVAILABLE", "not now"));
    await expect(launchSponsoredFromWeb(once, store)).rejects.toThrow();

    await expect(launchSponsoredFromWeb(once, store)).resolves.toMatchObject({ token: TOKEN });
  });

  it("refuses a launch that names no attempt at all", async () => {
    const store = freshStore();
    await expect(
      launchSponsoredFromWeb(request({ idempotencyKey: "" }), store),
    ).rejects.toThrow(/request id/i);
  });

  /** The record is keyed so that these rows never appear on a page about claiming X seats. */
  it("records the launch against the budget key rather than an X id", async () => {
    const store = freshStore();
    const once = request();
    await launchSponsoredFromWeb(once, store);

    const record = store.launchByCommandPost(`web:${once.idempotencyKey}`);
    expect(record?.status).toBe("launched");
    expect(record?.xUserId).toBe(budgetKeyFor(CREATOR));
    expect(record?.token).toBe(TOKEN);
    expect(store.launchesByUser("770077")).toHaveLength(0);
  });
});

describe("the switch that turns it off", () => {
  it("refuses every launch when sponsorship is disabled", async () => {
    process.env.AGEN_WEB_SPONSOR_DISABLED = "1";
    const store = freshStore();

    await expect(launchSponsoredFromWeb(request(), store)).rejects.toMatchObject({
      code: "CONFIG_MISSING",
    });
  });

  /** One wallet and one budget, so the bot's stop switch stops this too. */
  it("honours the stop switch the bot's launches use", async () => {
    const store = freshStore();
    store.setLaunchesPaused(true, "an operator");

    await expect(launchSponsoredFromWeb(request(), store)).rejects.toMatchObject({
      code: "LAUNCHES_DISABLED",
    });
  });
});
