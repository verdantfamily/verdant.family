import { afterEach, describe, expect, it } from "vitest";
import type { Address } from "viem";

import { BOUNDS, INSTANT_FEES } from "@verdant/config";

import {
  INSTANT_FEE_PERCENTS,
  INSTANT_FEE_PPM,
  INSTANT_HELD,
  INSTANT_LAUNCHABLE,
  INSTANT_SUPPLY_TOKENS,
  INSTANT_VALUATION_WEI,
  absoluteUrl,
  derive,
  emptyDraft,
  instantParams,
  normaliseLink,
  parseDecimal,
  siteOriginProblem,
  validate as validateAll,
  type InstantDraft,
} from "./instant";

/**
 * Everything wrong with a draft *except* the hold.
 *
 * The hold is a property of the deployment rather than of what was typed, and it is
 * asserted on its own below. Folding it into every other assertion would mean the day it
 * lifts, forty tests change for a reason none of them are about.
 */
function validate(draft: InstantDraft, connected: Address | undefined): readonly string[] {
  return validateAll(draft, connected).filter((problem) => problem !== INSTANT_HELD);
}

const CREATOR = "0x1f23c28F93aE48E6346DD05Ca66ba5e2213b00b8" as const;
const OTHER = "0xed91105C6f6F45185A80509402CB4C941918ac63" as const;
const SALT = `0x${"11".repeat(32)}` as const;
const URI = "https://agen.space/api/metadata/abc.json";

/** The three required fields, filled. Every test starts from a launchable draft. */
function draft(overrides: Partial<InstantDraft> = {}): InstantDraft {
  return {
    ...emptyDraft(),
    name: "King",
    symbol: "KING",
    imageUrl: "https://agen.space/api/images/abc.png",
    ...overrides,
  };
}

describe("the address a token records forever", () => {
  const configured = process.env.NEXT_PUBLIC_SITE_URL;

  afterEach(() => {
    process.env.NEXT_PUBLIC_SITE_URL = configured;
  });

  it("is satisfied by a real public origin", () => {
    expect(siteOriginProblem()).toBeNull();
  });

  /**
   * The three ways a build can have no permanent address, each refused at the launch
   * rather than at the upload.
   *
   * An Instant token's `metadataURI` is written with `metadataMutable` false, so it is the
   * one string in the whole flow that nobody — not the creator, not Agen — can ever
   * correct. A launch from a laptop produces a token whose picture and description are
   * unreachable from every wallet and explorer on earth, permanently, and it produces it
   * silently: the creator's own browser resolves the URL perfectly.
   */
  it("refuses a build with no configured origin", () => {
    delete process.env.NEXT_PUBLIC_SITE_URL;
    expect(siteOriginProblem()).toMatch(/no public address configured/);
    expect(validateAll(draft(), CREATOR).some((p) => /no public address/.test(p))).toBe(true);
  });

  it("refuses one that points at the machine it is running on", () => {
    for (const origin of ["http://localhost:3000", "http://127.0.0.1:3000", "http://a.local"]) {
      process.env.NEXT_PUBLIC_SITE_URL = origin;
      expect(siteOriginProblem()).toMatch(/points at this machine/);
    }
  });

  it("refuses one that is not an http address", () => {
    process.env.NEXT_PUBLIC_SITE_URL = "ipfs://somewhere";
    expect(siteOriginProblem()).toMatch(/not an http address/);

    process.env.NEXT_PUBLIC_SITE_URL = "not a url";
    expect(siteOriginProblem()).toMatch(/not a valid URL/);
  });
});

/**
 * The hold, lifted.
 *
 * It was never about an unfinished screen. Instant promises the creator earns in ether,
 * and `VerdantHook` charges Uniswap's LP fee, taken from whatever goes *into* the pool —
 * ether on a buy, the launched token on a sell. So the hold stood until a hook existed
 * that takes from the ether leg in both directions, and the note where it was asserted
 * said plainly that deleting the test was not how it would lift; deploying that hook was.
 *
 * That is what happened. `InstantHook` and `InstantFactory` are live on 4663 and recorded
 * in `@verdant/config`, the fork lifecycle passed, and `scripts/preflight-instant.ts`
 * reads the deployment's wiring back off the chain and simulates an encoded launch against
 * it. These tests now hold the switch in the open position, so turning it back is a
 * deliberate act with a failing test attached rather than a quiet edit.
 */
describe("the hold on launching, lifted", () => {
  it("lets a complete draft through", () => {
    expect(INSTANT_LAUNCHABLE).toBe(true);
    expect(validateAll(draft(), CREATOR)).toEqual([]);
  });

  it("no longer says the fee cannot be paid in ether, because it can", () => {
    expect(validateAll(draft(), CREATOR)).not.toContain(INSTANT_HELD);
  });

  it("still says what else is wrong, so the form stays usable", () => {
    // The point this has always made, and the reason it outlived the hold: a draft with a
    // real problem is told about that problem, in the place the creator is about to press.
    const problems = validateAll(draft({ name: "" }), CREATOR);
    expect(problems).toContain("Your token needs a name.");
    expect(problems).not.toContain(INSTANT_HELD);
  });
});

describe("what an Instant launch requires", () => {
  it("accepts a draft with a logo, a name, a ticker and a wallet", () => {
    expect(validate(draft(), CREATOR)).toEqual([]);
  });

  it("insists on a logo, because it cannot be added afterwards", () => {
    // `metadataMutable` is false, so the URI written at creation is the only one this
    // token will ever have. A missing picture is permanent.
    expect(validate(draft({ imageUrl: null }), CREATOR)).toEqual(["Your token needs a logo."]);
  });

  it("insists on a name and a ticker", () => {
    const problems = validate(draft({ name: "  ", symbol: "" }), CREATOR);
    expect(problems).toContain("Your token needs a name.");
    expect(problems).toContain("Your token needs a ticker.");
  });

  it("holds the name and ticker to the lengths the token constructor will", () => {
    expect(validate(draft({ name: "n".repeat(BOUNDS.token.nameLength.max + 1) }), CREATOR)).toEqual(
      [`A name can be up to ${String(BOUNDS.token.nameLength.max)} characters.`],
    );
    expect(
      validate(draft({ symbol: "S".repeat(BOUNDS.token.symbolLength.max + 1) }), CREATOR),
    ).toEqual([`A ticker can be up to ${String(BOUNDS.token.symbolLength.max)} characters.`]);
  });

  it("measures those lengths in bytes, because the chain does", () => {
    // Eleven emoji are eleven characters and forty-four bytes. A form counting
    // characters would accept a name the constructor rejects.
    expect(validate(draft({ name: "🌱".repeat(11) }), CREATOR).length).toBe(1);
  });

  it("refuses a ticker with punctuation in it", () => {
    expect(validate(draft({ symbol: "KI-NG" }), CREATOR)).toEqual([
      "A ticker can only use letters and numbers.",
    ]);
  });

  it("treats the description and the links as optional", () => {
    expect(validate(draft({ description: "", linkX: "", website: "", telegram: "" }), CREATOR)).toEqual(
      [],
    );
  });

  it("accepts the path the upload route answers with, once there is an origin for it", () => {
    // The route answers `/api/images/abc.png`. On a build that knows its own public
    // address that resolves to something the chain can find, which is the whole job of
    // `NEXT_PUBLIC_SITE_URL` — and a build without one is refused before this point.
    expect(validate(draft({ imageUrl: "/api/images/abc.png" }), CREATOR)).toEqual([]);
  });

  it("refuses a logo that cannot be made absolute at all", () => {
    // Neither a URL nor a rooted path, so there is nothing to resolve it against and
    // nothing that could be written into the token.
    expect(validate(draft({ imageUrl: "abc.png" }), CREATOR)[0]).toMatch(/no public address/);
  });
});

describe("where the fees go", () => {
  it("uses the connected wallet by default", () => {
    expect(emptyDraft().useConnectedWallet).toBe(true);
    expect(derive(draft(), CREATOR)?.feeRecipient).toBe(CREATOR);
  });

  it("asks for a wallet when the box is ticked and none is connected", () => {
    expect(validate(draft(), undefined)).toEqual(["Connect a wallet to launch."]);
  });

  it("takes a typed address once the box is cleared", () => {
    const typed = draft({ useConnectedWallet: false, feeReceiver: OTHER });
    expect(validate(typed, undefined)).toEqual([]);
    expect(derive(typed, CREATOR)?.feeRecipient).toBe(OTHER);
  });

  it("refuses a cleared box with nothing usable in the field", () => {
    expect(validate(draft({ useConnectedWallet: false, feeReceiver: "vitalik.eth" }), CREATOR)).toEqual(
      ["The fee receiver is not an address."],
    );
    expect(validate(draft({ useConnectedWallet: false, feeReceiver: "" }), CREATOR)).toEqual([
      "The fee receiver is not an address.",
    ]);
  });

  it("ignores whatever is in the field while the box is ticked", () => {
    const both = draft({ useConnectedWallet: true, feeReceiver: OTHER });
    expect(derive(both, CREATOR)?.feeRecipient).toBe(CREATOR);
  });
});

/**
 * A draft Agen pays for, which is the only kind that can be launched with nothing connected.
 *
 * These assertions are about the shared model rather than the server: `derive` and `validate` are
 * what the form, the preview and `lib/instant-sponsor.ts` all read, so a disagreement between the
 * two functions here would be a button that offers a launch the server refuses — or, far worse, a
 * transaction that spends the platform's ether on a first buy.
 */
describe("a launch the platform pays for", () => {
  it("is off unless it is asked for", () => {
    expect(emptyDraft().sponsored).toBe(false);
  });

  it("launches with no wallet connected at all", () => {
    const paid = draft({ sponsored: true, feeReceiver: OTHER });
    expect(validate(paid, undefined)).toEqual([]);
    expect(derive(paid, undefined)?.feeRecipient).toBe(OTHER);
  });

  /**
   * The one refusal with no fallback behind it. `InstantFeeVault.creator` is fixed at creation,
   * and there is neither a connected wallet to name nor a verified identity to derive a claimable
   * seat from — so an address is the only thing that can make the fees reachable.
   */
  it("insists on an address, because there is nothing to fall back on", () => {
    expect(validate(draft({ sponsored: true, feeReceiver: "" }), undefined)).toEqual([
      "Add the address your fees should go to — there is no wallet to use instead.",
    ]);
  });

  it("still insists on one when a wallet happens to be connected", () => {
    // The box is on by default, and for a sponsored launch it must not resolve to the wallet:
    // whoever is connected in this tab is not who the server will submit as.
    expect(validate(draft({ sponsored: true }), CREATOR)).toEqual([
      "Add the address your fees should go to — there is no wallet to use instead.",
    ]);
    expect(derive(draft({ sponsored: true }), CREATOR)?.feeRecipient).toBeNull();
  });

  /** The amount would be the transaction's `value`, and the sponsor wallet is what sends it. */
  it("refuses a first buy, and derives zero even if one is left in the draft", () => {
    const paid = draft({ sponsored: true, feeReceiver: OTHER, initialBuy: "0.5" });
    expect(validate(paid, undefined)).toEqual([
      "A launch Agen pays for cannot include a first buy. Connect a wallet to buy at launch.",
    ]);
    expect(derive(paid, undefined)?.initialBuyWei).toBe(0n);
  });

  /** An escrow has an owner, and a typed address is not proof of who that is. */
  it("names the address itself rather than a Boost escrow", () => {
    const paid = draft({ sponsored: true, feeReceiver: OTHER, boostCapable: true });
    expect(derive(paid, undefined)?.boostCapable).toBe(false);
  });
});

describe("the first buy", () => {
  it("is optional, and zero when left empty", () => {
    expect(validate(draft({ initialBuy: "" }), CREATOR)).toEqual([]);
    expect(derive(draft({ initialBuy: "" }), CREATOR)?.initialBuyWei).toBe(0n);
  });

  it("refuses something that is not an amount", () => {
    expect(validate(draft({ initialBuy: "one ether" }), CREATOR)).toEqual([
      "The first buy is not an amount.",
    ]);
  });

  it("reads at the token's own decimals, without a float in the way", () => {
    expect(parseDecimal("0.1", 18)).toBe(100_000_000_000_000_000n);
    expect(parseDecimal("1", 18)).toBe(1_000_000_000_000_000_000n);
    // 0.1 + 0.2 in binary floating point is famously not 0.3. This path never sees one.
    expect(parseDecimal("0.3", 18)).toBe(300_000_000_000_000_000n);
  });

  it("refuses more precision than the token has, rather than truncating it", () => {
    expect(parseDecimal(`0.${"0".repeat(18)}1`, 18)).toBeNull();
  });
});

describe("the optional links", () => {
  it("adds a scheme to a bare host", () => {
    expect(normaliseLink("yourtoken.com", "website")).toBe("https://yourtoken.com/");
    expect(normaliseLink("t.me/yourtoken", "telegram")).toBe("https://t.me/yourtoken");
  });

  it("turns an @handle into an X profile", () => {
    expect(normaliseLink("@yourtoken", "x")).toBe("https://x.com/yourtoken");
  });

  it("drops anything that is not http or https, rather than repairing it", () => {
    // A creator's typo rendered as their website is the reason this is an allowlist of
    // two schemes and not a check for a dot.
    expect(normaliseLink("javascript:alert(1)", "website")).toBeNull();
    expect(normaliseLink("data:text/html,hi", "website")).toBeNull();
    expect(validate(draft({ website: "javascript:alert(1)" }), CREATOR)).toEqual([
      "That website is not a web address.",
    ]);
  });

  it("leaves an empty field out of the document entirely", () => {
    expect(derive(draft(), CREATOR)?.links).toEqual({});
    expect(derive(draft({ website: "yourtoken.com" }), CREATOR)?.links).toEqual({
      website: "https://yourtoken.com/",
    });
  });
});

describe("a URL the chain can find", () => {
  const configured = process.env.NEXT_PUBLIC_SITE_URL;

  afterEach(() => {
    process.env.NEXT_PUBLIC_SITE_URL = configured;
  });

  it("leaves an absolute one alone", () => {
    expect(absoluteUrl("https://cdn.example/a.png")).toBe("https://cdn.example/a.png");
  });

  it("resolves a bare path against the configured origin", () => {
    expect(absoluteUrl("/api/images/a.png")).toBe("https://agen.space/api/images/a.png");
  });

  /**
   * On a server with nothing configured there is no origin to guess, and guessing is what
   * this must not do: the value ends up inside a token that can never be edited. The
   * launch is refused earlier — see `siteOriginProblem` — but this is the floor underneath
   * that, so a caller which skipped the check still cannot produce a relative address.
   */
  it("refuses a bare path when there is no origin to resolve it against", () => {
    delete process.env.NEXT_PUBLIC_SITE_URL;
    expect(absoluteUrl("/api/images/a.png")).toBeNull();
  });

  it("treats nothing as nothing", () => {
    expect(absoluteUrl("   ")).toBeNull();
  });
});

describe("the parameters the factory is actually given", () => {
  const derived = derive(draft({ initialBuy: "0.25" }), CREATOR)!;
  const params = instantParams({ feeRecipient: derived.feeRecipient!, derived, metadataURI: URI, salt: SALT });

  it("is exactly the seven fields the factory takes", () => {
    // The count is the assertion. `InstantFactory.CreateParams` is ABI-encoded
    // positionally, so an eighth field here would not be ignored — it would shift
    // everything after it and launch a market nobody described.
    expect(Object.keys(params).sort()).toEqual([
      "feeRecipient",
      "initialBuyAmount",
      "initialBuyMinTokens",
      "metadataURI",
      "name",
      "salt",
      "symbol",
    ]);
  });

  it("cannot state the supply, the opening price, the quote asset or the fee", () => {
    // Not "sets them to the Instant value" — there is nowhere to put them. They are
    // constants of `InstantFactory`, so this module cannot get them wrong and a future
    // edit to it cannot quietly reprice a launch. That is the difference between a
    // standard and a default, and it is the whole argument of ADR-014.
    for (const absent of ["supplyTokens", "initialTick", "quoteAsset", "model", "stages"]) {
      expect(params).not.toHaveProperty(absent);
    }
  });

  it("cannot hold supply back or vest it", () => {
    // An allocation is the most consequential thing a launchpad can hide in a form.
    // Instant's answer is not a zero in this struct; it is the absence of the field.
    for (const absent of ["creatorAllocationBps", "vestingCliff", "vestingDuration"]) {
      expect(params).not.toHaveProperty(absent);
    }
  });

  it("cannot make the metadata mutable", () => {
    // The factory passes `false` itself, so an Instant token has no privileged function
    // at all: no mint, no owner, no pause, not even a URI setter.
    expect(params).not.toHaveProperty("metadataMutable");
  });

  it("points at the document rather than at the picture", () => {
    // The token carries one string. A picture in that slot would mean the description
    // and the links were collected and then dropped.
    expect(params.metadataURI).toBe(URI);
  });

  it("carries the first buy as the amount the transaction will also send", () => {
    expect(params.initialBuyAmount).toBe(250_000_000_000_000_000n);
    expect(params.initialBuyMinTokens).toBe(0n);
  });

  it("upper-cases the ticker and strips a dollar sign the creator typed", () => {
    const withDollar = derive(draft({ symbol: "$king" }), CREATOR)!;
    const p = instantParams({
      derived: withDollar,
      metadataURI: URI,
      salt: SALT,
      feeRecipient: withDollar.feeRecipient!,
    });
    expect(p.symbol).toBe("KING");
  });

  /**
   * The recipient is submitted rather than derived, and this is what stands in for the throw
   * that used to be here.
   *
   * `instantParams` used to read `derived.feeRecipient` and refuse a null. It now takes the
   * address explicitly, because a Boost-capable launch submits the creator's *escrow* while
   * `derived.feeRecipient` stays their payout address — and the vault makes whichever is
   * submitted immutable. So the guard moved to where it can still be wrong: a draft with no
   * recipient cannot pass validation, and the type makes the argument impossible to omit.
   */
  it("cannot be built for a draft with nowhere to pay the fees", () => {
    const noReceiver = derive(draft(), undefined)!;
    expect(noReceiver.feeRecipient).toBeNull();
    expect(validate(draft(), undefined)).not.toEqual([]);
  });

  it("submits whatever address it was given, not the creator's own", () => {
    // The Boost case: the launch names the escrow, and the escrow pays the creator. Getting
    // this backwards would produce a market that can never be Boosted, permanently.
    const escrow = "0xB005700000000000000000000000000000000001" as const;
    const p = instantParams({ derived, metadataURI: URI, salt: SALT, feeRecipient: escrow });

    expect(p.feeRecipient).toBe(escrow);
    expect(p.feeRecipient).not.toBe(derived.feeRecipient);
  });
});

/**
 * Boost, at the point where it is decided.
 *
 * The launch is the only moment this can be chosen, because `InstantFeeVault.creator` is
 * immutable — so these assertions are about a decision that cannot be revisited, which is why
 * the default is the one that keeps the option open.
 */
describe("whether a launch can ever be Boosted", () => {
  it("defaults to keeping the option open", () => {
    expect(emptyDraft().boostCapable).toBe(true);
    expect(derive(draft(), CREATOR)?.boostCapable).toBe(true);
  });

  it("carries a creator's refusal through", () => {
    expect(derive(draft({ boostCapable: false }), CREATOR)?.boostCapable).toBe(false);
  });

  /**
   * The flag decides where fees are *routed*, never who they belong to.
   *
   * A Boost-capable launch submits the escrow as `feeRecipient` and the escrow pays this
   * address, so `derive` must keep reporting the creator's own answer either way. If it started
   * reporting the escrow instead, the profile would attribute the market to the wrong wallet
   * and the launch form would show a creator an address they never typed.
   */
  it("does not change who the fees belong to", () => {
    const on = derive(draft({ boostCapable: true }), CREATOR);
    const off = derive(draft({ boostCapable: false }), CREATOR);

    expect(on?.feeRecipient).toBe(CREATOR);
    expect(off?.feeRecipient).toBe(CREATOR);
  });

  it("does not affect whether a draft is launchable", () => {
    // Boost is never a reason a launch is refused. A build without it simply hides the control.
    expect(validate(draft({ boostCapable: false }), CREATOR)).toEqual(
      validate(draft({ boostCapable: true }), CREATOR),
    );
  });
});

describe("the constants a creator is not asked about", () => {
  it("gives every market the same supply", () => {
    expect(INSTANT_SUPPLY_TOKENS).toBe(BOUNDS.token.defaultTotalSupplyTokens);
    expect(derive(draft(), CREATOR)?.supplyTokens).toBe(INSTANT_SUPPLY_TOKENS);
  });

  it("keeps that supply inside what the factory will accept", () => {
    expect(INSTANT_SUPPLY_TOKENS).toBeGreaterThanOrEqual(BOUNDS.token.totalSupplyTokens.min);
    expect(INSTANT_SUPPLY_TOKENS).toBeLessThanOrEqual(BOUNDS.token.totalSupplyTokens.max);
  });

  it("opens on the grid the factory checks the tick against", () => {
    const tick = derive(draft(), CREATOR)!.initialTick;
    expect(tick % BOUNDS.liquidity.tickSpacing).toBe(0);
    expect(tick).toBeGreaterThanOrEqual(BOUNDS.liquidity.tick.min);
    expect(tick).toBeLessThanOrEqual(BOUNDS.liquidity.tick.max);
  });

  it("opens every market at the same valuation", () => {
    expect(INSTANT_VALUATION_WEI).toBe(1_500_000_000_000_000_000n);
  });

  it("writes Instant's own fee into the hook, not the register's default", () => {
    // The register's default is what a Programmable creator's first stage is
    // pre-filled with. Instant's is a constant of the hook, and the two are
    // deliberately different numbers.
    expect(INSTANT_FEE_PPM).toBe(INSTANT_FEES.totalPpm);
    expect(INSTANT_FEE_PPM).toBe(15_000);
    expect(INSTANT_FEE_PPM).not.toBe(BOUNDS.schedule.feePpm.default);
  });
});

describe("what the fee split means", () => {
  it("is 1.50% of a trade, 1.00% to the creator and 0.50% to Agen", () => {
    expect(INSTANT_FEE_PERCENTS.total).toBe(1.5);
    expect(INSTANT_FEE_PERCENTS.creator).toBe(1);
    expect(INSTANT_FEE_PERCENTS.platform).toBe(0.5);
  });

  it("leaves nothing over, so no third party is owed a share", () => {
    expect(INSTANT_FEE_PERCENTS.creator + INSTANT_FEE_PERCENTS.platform).toBe(
      INSTANT_FEE_PERCENTS.total,
    );
  });

  it("gives the creator twice what the platform takes", () => {
    expect(INSTANT_FEE_PERCENTS.creator).toBe(INSTANT_FEE_PERCENTS.platform * 2);
  });

  it("does not depend on the register, which cannot express this split", () => {
    // 0.50 of 1.50 is one third of the fee, which is 3 333.33 bps — not a whole
    // number, and above the immutable 2 000 cap on the live register besides. This
    // is why the screen states a constant instead of reading `protocolBps`.
    const asBpsOfTheFee =
      (INSTANT_FEES.platformPpm * BOUNDS.splits.total) / INSTANT_FEES.totalPpm;

    expect(Number.isInteger(asBpsOfTheFee)).toBe(false);
    expect(Math.round(asBpsOfTheFee)).toBeGreaterThan(BOUNDS.splits.protocolBps.max);
  });
});
