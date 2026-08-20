/**
 * The tests Agen writes itself, which are the ones allowed to fail a build.
 *
 * Every behaviour test used to come from a model, and one day of real builds showed what
 * that costs: of thirty-five programmable launches that died in the testing stages,
 * fourteen died because the *tests* were wrong. Six ended with "the generated test suite
 * could not be made to compile" after three repair rounds. Others reverted inside their own
 * `setUp` on `InsufficientAllowance`, on `PoolAlreadyInitialized`, on a prank they had
 * already opened. One market was refused for an assertion that read `0 <= 0`, with its own
 * failure record noting the market "behaves correctly in the ordinary case".
 *
 * None of that is evidence about the market. It is evidence about the test, and it was
 * being counted as the market's fault — so the fix is not a better prompt, it is to stop
 * asking a model for the assertions Agen already knows how to write.
 *
 * ## What belongs here
 *
 * Only what follows from the locked specification and the declared deployment, and only
 * where it holds unconditionally. The market trades. The hook holds nothing. The fee that
 * was promised is the fee that is taken, and it arrives somewhere the market controls. A
 * side declared free is free. Nothing here knows what a streak, an epoch or a jackpot is,
 * and nothing here should: a mechanic-specific assertion is a judgement, judgements are
 * what models are for, and a wrong one must never be able to block a launch.
 *
 * That division is the whole design. These tests are authoritative — a failure means the
 * market is wrong and the contracts are the thing to change. The model's tests are
 * advisory: they find bugs Agen could not think of, and when they cannot be made to run
 * they are quarantined rather than fatal.
 *
 * ## Why the fee is measured as a sum
 *
 * A fee can land in a vault, in an accounting contract, or straight in the receiver's
 * wallet, and which of those a design chose is not this file's business. So the assertion
 * is over `_marketAccounts()` — every account a fee may legitimately reach — and it holds
 * for every architecture that pays somebody. The hook is excluded from that set, which
 * makes "the fee was collected" and "the hook kept it" different results rather than the
 * same one.
 */

import type { GeneratedSource } from "./workspace.js";
import type { MarketSpecification, Rule } from "./spec.js";
import { feeAt, feeSchedule, type FeeSchedule } from "./threshold.js";

export const CORE_TEST_PATH = "test/MarketCore.t.sol";

/** The trade sides a fee can be stated for, as the interpretation names them. */
type Side = "buy" | "sell";

/**
 * A fee that applies to every trade on one side, or nothing.
 *
 * `null` is the common and correct answer for any market with a mechanic: a waiver, a
 * threshold, a streak or a phase all mean the fee on that side depends on something, and a
 * test asserting a flat rate would be wrong about a market that is right. Only the flat
 * case is claimed, and the flat case is most of what people ask for.
 */
export interface StatedFee {
  readonly side: Side;
  readonly ppm: number;
}

/**
 * Read the unconditional hook fee for one side out of the specification.
 *
 * Unconditional means exactly that: a rule that fires on this side with no conditions, not
 * limited to a phase, not once-only, and no other rule anywhere in the specification that
 * could change a fee on this side. The last clause is what makes this safe — a market whose
 * sells pay 0.5% except after five buys has a sell rule that looks flat on its own, and the
 * waiver two rules later is the part that matters.
 */
export function statedFee(specification: MarketSpecification, side: Side): number | null {
  const applies = (rule: Rule): boolean =>
    rule.when.kind === side || rule.when.kind === "swap" || rule.when.kind === "trade";

  const alters = (rule: Rule): boolean => rule.then.some(chargesFee);

  const unconditional = (rule: Rule): boolean =>
    rule.conditions.every((clause) => sideOnly(clause)) &&
    rule.onceOnly !== true &&
    (rule.activeInPhases === undefined || rule.activeInPhases.length === 0);

  const feeRules = specification.rules.filter((rule) => alters(rule) && applies(rule));

  // Any conditional fee rule on this side, or one whose trigger this file does not
  // understand well enough to rule out, and the flat reading is abandoned. Silence is not
  // taken as agreement anywhere here.
  if (feeRules.some((rule) => !unconditional(rule))) return null;
  if (
    specification.rules.some(
      (rule) =>
        alters(rule) &&
        !applies(rule) &&
        !SIDED.has(rule.when.kind) &&
        !downstreamOfTheCharge(rule),
    )
  )
    return null;

  const stated = feeRules.flatMap((rule) =>
    rule.then
      .filter(chargesFee)
      .map((effect) => rateOf(effect, side))
      .filter((value): value is number => value !== null),
  );

  // Two rules each setting a flat fee on the same side is a specification whose total this
  // file will not guess at, and a rule whose fee is not a plain integer is not a fee it can
  // check. Both fall back to the model's own tests.
  if (feeRules.length > 0 && stated.length !== feeRules.length) return null;
  if (stated.length > 1) return null;

  if (stated.length === 0) {
    // No rule touches a fee on this side at all, which is the "buys are free" case and is
    // worth proving: it is the single most common thing a prompt says, and a hook that
    // charges anyway is the single most common way one is wrong.
    //
    // Guarded by a second reading, because concluding "free" from an effect this file did not
    // recognise is the one mistake here that fails a market for being right. Any effect on
    // this side carrying a rate — under any name — means something is charged, whatever the
    // effect is called, and the flat reading is abandoned instead.
    const rated = specification.rules
      .filter((rule) => applies(rule))
      .some((rule) => rule.then.some((effect) => rateOf(effect, side) !== null));

    return feeRules.length === 0 && !rated ? 0 : null;
  }

  return stated[0]!;
}

/**
 * Whether a condition only says which side of the trade this is.
 *
 * STORY: "buying should cost you nothing at all, selling costs half a percent". The rule fired on
 * any trade, its effect carried `{ buyFeePpm: 0, sellFeePpm: 5000 }`, and it also carried a
 * condition of kind `tradeSide` reading "apply the zero rate to buys and the 0.5% rate to sells".
 * That is not a gate on the fee — it is the effect's own sidedness written a second time — but any
 * condition at all abandoned the flat reading, so nothing asserted the half percent and the
 * benchmark reported a correct market as charging nothing.
 *
 * Kept narrow, because the cost of being wrong here is asymmetric: mistaking a real gate for this
 * would assert a flat rate on a market that waives it, which fails a market for being right. So it
 * must name the side or the direction *and* compare against nothing numeric. A streak of ten, a
 * size above one percent, a window — all of those carry a number and none of them qualify.
 */
function sideOnly(clause: Rule["conditions"][number]): boolean {
  const numeric = Object.values(clause.parameters ?? {}).some((value) => typeof value === "number");
  if (numeric) return false;

  return /^(?:trade)?side$|direction|isbuy|issell|buyorsell|zeroforone|swapkind/i.test(clause.kind);
}

/**
 * Whether an effect is one that takes something from a trade.
 *
 * The named kinds are the ones the schema suggests. The pattern is there because the
 * interpretation is free text and models use their own words for it: DEGEN and TYPO both came
 * back with `routeFee`, which was in neither the set nor the schema, and a fee this function
 * cannot see is a side it would otherwise call free. Being wide is safe in this direction —
 * every use of it either abandons the flat reading or looks for a rate that is not there.
 */
function chargesFee(effect: Rule["then"][number]): boolean {
  return FEE_EFFECTS.has(effect.kind) || /fee|tax|charge|skim|toll|cut/i.test(effect.kind);
}

/**
 * Whether a rule fires on a fee that has already been taken, rather than on a trade.
 *
 * Where a fee *goes* is a separate rule from what a trade *pays*, and interpretations write it
 * that way: EMBR asked for 3% on sells and 1% on buys, both stated plainly, and a third rule
 * sent the proceeds to the creator — `transferFee` on `feeCollected`. Read as one more rule
 * that might touch a fee, it made both sides unreadable, and a market whose prompt could not
 * have been clearer got no fee assertion from this file at all.
 *
 * Narrow on purpose, in the direction that costs nothing. Mistaking a real trade fee for a
 * routing rule would mean asserting a rate that another rule changes — failing a market that
 * is right, which is the one outcome this file must never produce. So both halves are
 * required: the trigger has to name a fee *and* say it already happened. A trigger that merely
 * mentions a fee still abandons the flat reading.
 */
function downstreamOfTheCharge(rule: Rule): boolean {
  const kind = rule.when.kind.toLowerCase();
  if (/fee/.test(kind) && /collect|charged|taken|received|accru|earned/.test(kind)) return true;

  /*
   * And anything a trade cannot trigger at all.
   *
   * HOLD charges 0.3% on every swap and pays it out to holders when they claim. The payout rule
   * fires on `claim`, mentions fees because that is what it distributes, and made the flat 0.3%
   * unreadable — so the one number the market is built on was asserted by nothing. A claim, a
   * withdrawal or a settlement happens because somebody asked for it, never because somebody
   * traded, so no such rule can change what a trade pays.
   */
  return /^(?:claim|withdraw|harvest|redeem|distribut|settle|payout)/.test(kind);
}

/**
 * The rate an effect states, in parts per million, whatever unit it stated it in.
 *
 * Prompts say percent, interpretations say basis points as often as ppm, and the schema asks
 * for neither in particular. The unit comes from the parameter's own name, so nothing is
 * inferred from the size of the number — a bare `50` is fifty ppm or half a percent depending
 * entirely on what it was called, and guessing between them would be the difference between a
 * market that charges nothing and one that charges a hundred times too much. A parameter whose
 * name says no unit is not read at all.
 */
function rateOf(effect: Rule["then"][number], side: Side): number | null {
  const other: Side = side === "sell" ? "buy" : "sell";

  const numeric = Object.entries(effect.parameters ?? {}).filter(
    ([, value]) => typeof value === "number",
  );

  /*
   * A parameter that names a side belongs to that side and to no other.
   *
   * One effect frequently carries both halves of a market: POT's single rule fires on any
   * trade and says `{ sellFeeBps: 200, buyFeeBps: 0 }`. Read without regard to which side was
   * asked about, the first readable number won — so "no fee on buys", stated in the prompt, in
   * the rule and in the market's own `buys-are-free` invariant, became a core test demanding
   * that buys pay two percent.
   *
   * That is the worst thing this file can do. The assertion is Agen's, so it cannot be
   * quarantined and it blames the contract: the repair was handed a market that had to charge
   * buyers and promise it did not, correctly reported that both could not hold, and gave up.
   * A correct market was refused because Agen misread it.
   */
  const mine = numeric.filter(([key]) => key.toLowerCase().includes(side));
  const theirs = numeric.filter(([key]) => key.toLowerCase().includes(other));
  const neutral = numeric.filter(
    ([key]) => !key.toLowerCase().includes("sell") && !key.toLowerCase().includes("buy"),
  );

  /*
   * Naming the other side and not this one is not silence about this one: it is an effect whose
   * shape this file has not understood, and guessing from what is left is how the above
   * happened. Only a parameter that is about this side, or about neither, is read.
   *
   * With one exception, which is where a real market went unproven. SPEC's effect said
   * `{ feePpm: 5000, buyFeePpm: 0 }` on a rule firing on sells: the other side is named, so
   * everything else was discarded and the 0.5% the prompt asked for in three different ways
   * became unreadable. Nothing then asserted it — this same function writes the core suite's fee
   * assertions — and the build reached the launch button with its central requirement unproven,
   * twice. It happened to be implemented correctly, which is worse than failing, because the
   * only thing standing behind it was the model's own good behaviour.
   *
   * An other-side rate of zero cannot be the neutral rate's owner: the effect has said that side
   * pays nothing, so a rate stated alongside it belongs to the side that is left. A non-zero rate
   * for the other side stays as it was — two rates and no statement of which applies here is
   * exactly the shape this guard was written for.
   */
  const otherSideIsFree =
    theirs.length > 0 &&
    theirs.every(([key, value]) => value === 0 && /fee|tax|charge|rate/i.test(key));

  const readable = mine.length > 0 ? mine : theirs.length === 0 || otherSideIsFree ? neutral : [];

  for (const [key, value] of readable) {
    if (typeof value !== "number") continue;

    const name = key.toLowerCase();

    // A split of a fee is not the fee. EMBR's routing rule carried `creatorSharePercent: 100`
    // — the creator gets all of it — which read as a rate is a hundred percent trade fee, the
    // largest possible misreading of a market that charges three. Every name here divides
    // something already taken, so none of them can be what a trade pays.
    if (/share|split|portion|allocation|payout/.test(name)) continue;

    const ppm = name.includes("ppm")
      ? value
      : name.includes("bps") || name.includes("basispoint")
        ? value * 100
        : name.includes("percent") || name.includes("pct")
          ? value * 10_000
          : null;

    if (ppm !== null && Number.isInteger(ppm)) return ppm;
  }

  return null;
}

/** Effect kinds that change what a trade pays. */
const FEE_EFFECTS = new Set(["extraFee", "setFee", "waiveFee", "routeFee", "chargeFee"]);

/** Triggers that name a trade side, so a rule on the other side cannot affect this one. */
const SIDED = new Set(["buy", "sell"]);

export interface CoreTestSuite {
  readonly source: GeneratedSource;
  /**
   * What this suite proves, in one line each.
   *
   * Reported on the build so a creator can see which of their market's promises were
   * checked by Agen itself rather than by a generated test, and so a failure record can say
   * which claim broke.
   */
  readonly proves: readonly string[];
}

/**
 * Render the core suite for one market.
 *
 * Deliberately dependency-free beyond the specification: it inherits `MarketTestBase`, so
 * the launch, the actors, the trading helpers and the account set are already correct and
 * this file contains no fixture code at all. Every failure in it is therefore about the
 * market.
 */
export function coreTests(
  specification: MarketSpecification,
  { collectsItsOwnFee }: { readonly collectsItsOwnFee: boolean },
): CoreTestSuite {
  const sell = statedFee(specification, "sell");
  const buy = statedFee(specification, "buy");
  const sellSchedule = feeSchedule(specification, "sell");
  const proves = ["the market launches and both sides of it trade", "the hook keeps no balances"];

  const tests: string[] = [TRADES];

  /*
   * Where the fee goes decides whether this file may say anything about it.
   *
   * A hook can charge in two ways. It can move the value itself, through a swap delta, and
   * then the fee lands in an account the market controls and both the size and the
   * destination are checkable here. Or it can override the pool's own LP fee, and then
   * Uniswap collects it for the liquidity providers — the market never touches it, and there
   * is no account for it to arrive in.
   *
   * Asserting the first about the second fails a market that is right. It nearly did: a
   * fixture charging one percent through the fee override was told "the sell fee reached none
   * of this market's accounts" and sent for repair, which is precisely the wrong-assertion
   * failure this whole file exists to remove. So an override market gets the assertions that
   * are true of it — it trades, the hook holds nothing, the ceiling holds — and its rate is
   * left to the checks that read the hook's own constant instead of the money.
   */
  const claims = !collectsItsOwnFee
    ? []
    : [
        ...(sell === null ? [] : [sell === 0 ? freeSide("sell") : chargedSide("sell", sell)]),
        ...(buy === null ? [] : [buy === 0 ? freeSide("buy") : chargedSide("buy", buy)]),
      ];

  for (const [side, ppm] of [
    ["sell", sell],
    ["buy", buy],
  ] as const) {
    if (ppm === null || !collectsItsOwnFee) continue;
    proves.push(
      ppm === 0
        ? `${side}s pay no hook fee`
        : `every ${side} pays ${asPercent(ppm)} and it reaches an account this market controls`,
    );
  }

  // One function rather than one per side. Every test function pays for the canonical launch
  // again — a real PoolManager, a PositionManager, a factory and a mined hook address — and
  // a build that spends thirty seconds proving two fees is a build that has taken thirty
  // seconds from the creator. The assertion messages carry the attribution instead.
  if (claims.length > 0) {
    tests.push(`    /// What this market promises about what a trade costs.
    function test_core_fees_are_what_the_specification_says() public {
${claims.join("\n\n")}
    }`);
  }

  /*
   * A size-gated sell fee is the one conditional shape this file can read completely:
   * a base rate, a higher rate, a percentage of a fixed supply, and a comparison.
   * That is not a judgement about a streak or a phase — it is the same arithmetic
   * `threshold.ts` already holds the contract to — so a wrong boundary here is a
   * wrong market, and it is allowed to fail the build.
   *
   * Only a share of the token's own supply is claimed. A share of the pool moves
   * as the test itself trades, and asserting a fee against a basis the test is
   * changing would fail a market that is right.
   */
  if (
    collectsItsOwnFee &&
    sell === null &&
    sellSchedule !== null &&
    sellSchedule.tier !== null &&
    sellSchedule.tier.threshold.basis === "supply"
  ) {
    tests.push(sizeGatedSellFees({ ...sellSchedule, tier: sellSchedule.tier }));
    proves.push(
      `a sell of ${thresholdShare(sellSchedule.tier.threshold.percent)} of supply ` +
        `pays ${asPercent(sellSchedule.tier.ppm)}, and everything at or below it pays ` +
        `${asPercent(sellSchedule.basePpm)}`,
    );
  }

  tests.push(ceiling(specification.maxFeePpm));
  proves.push(`no trade is charged more than the declared ceiling of ${asPercent(specification.maxFeePpm)}`);

  return {
    source: {
      path: CORE_TEST_PATH,
      content: `// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {MarketTestBase} from "./MarketTestBase.sol";

/// @title MarketCoreTest
/// @notice What Agen proves about every market, written by Agen rather than generated.
/// @dev These assertions follow from the locked specification, so a failure here is a
/// statement about the contracts and not about the test. Nothing mechanic-specific belongs
/// in this file — that is what the generated suite beside it is for.
contract MarketCoreTest is MarketTestBase {
${tests.join("\n\n")}
}
`,
    },
    proves,
  };
}

/**
 * The market trades at all, which is the assertion that would have caught the most.
 *
 * `NotHook`, an unwired vault, a hook that reverts in `beforeSwap`, a pool opened at a fee
 * its hook rejects: every one of those arrived as a wall of `WrappedError` hex in a
 * generated suite, and every one of them fails this in one line.
 */
const TRADES = `    function test_core_market_trades_and_the_hook_keeps_nothing() public {
        assertTrue(address(hook).code.length > 0, "hook has no code");

        uint256 bought = buy(0.01 ether);
        assertGt(bought, 0, "a buy returned no tokens");
        // Not equality with what the swap returned: a market entitled to take its fee out
        // of the tokens leaving the pool would fail that, and would be right to.
        assertGt(tokenBalance(TRADER), 0, "the buyer received nothing");

        uint256 proceeds = sell(uint128(bought / 2));
        assertGt(proceeds, 0, "a sell returned nothing");

        // A hook is called on every swap, so a hook with a balance has a withdrawal path in
        // every callback. House rule, and it is checked here because it is checkable here.
        assertEq(tokenBalance(address(hook)), 0, "the hook is holding tokens");
        assertEq(address(hook).balance, 0, "the hook is holding ether");
    }`;

/**
 * One side pays exactly what the specification says, and it arrives somewhere.
 *
 * Both halves are measured, because either alone passes for a broken market: a fee taken
 * and stranded in a contract nobody can claim from satisfies "the trader paid", and a fee of
 * the wrong size satisfies "somebody was paid". The exact check applies to whichever
 * currency the fee arrived in and is tolerant of one wei, since rounding a fee down is a
 * choice the contract is entitled to make and rounding it up by a wei is not worth a
 * failure.
 */
function chargedSide(side: Side, ppm: number): string {
  const trade = side === "sell" ? "sell(uint128(bought))" : "buy(size)";
  const amount = side === "sell" ? "uint256(lastSellTokens)" : "uint256(size)";

  return `        // The market's own promise: ${side}s pay ${asPercent(ppm)}.
        {
            uint128 size = 0.02 ether;
            uint256 bought = buy(size);

            uint256 tokensBefore = _collectedTokens();
            uint256 etherBefore = _collectedEther();
            ${trade};

            uint256 tokens = _collectedTokens() - tokensBefore;
            uint256 received = _collectedEther() - etherBefore;
            assertGt(
                tokens + received,
                0,
                "the ${side} fee reached none of this market's accounts"
            );

            // Charged on the currency in, which is what ${
              side === "sell" ? "the tokens sold" : "the ether spent"
            } is.
            uint256 expected = ${amount} * ${String(ppm)} / 1_000_000;
            uint256 taken = ${side === "sell" ? "tokens" : "received"};
            if (taken > 0) {
                assertGe(taken + 1, expected, "the ${side} fee was smaller than specified");
                assertLe(taken, expected + 1, "the ${side} fee was larger than specified");
            }
        }`;
}

/**
 * A side the specification leaves alone pays nothing.
 *
 * "Buys have no hook fee" is the most common sentence in an Agen prompt and the least
 * checked: a hook that applies its sell fee to both sides passes every test about the sell.
 */
function freeSide(side: Side): string {
  const trade = side === "sell" ? "sell(uint128(bought / 2))" : "buy(0.01 ether)";

  return `        // The market's own promise: ${side}s pay no hook fee.
        {
            uint256 bought = buy(0.02 ether);

            uint256 tokensBefore = _collectedTokens();
            uint256 etherBefore = _collectedEther();
            ${trade};

            assertEq(
                _collectedTokens(),
                tokensBefore,
                "a ${side} moved tokens into this market's accounts"
            );
            assertEq(
                _collectedEther(),
                etherBefore,
                "a ${side} moved ether into this market's accounts"
            );
        }`;
}

/**
 * The ceiling the specification declares, across the whole tradable band.
 *
 * Fuzzed over the size rather than asserted at one amount, because the failures worth
 * finding are at the edges: a fee computed before a cap is applied, an overflow in the
 * arithmetic, a threshold that flips at a size nobody tried by hand.
 */
function ceiling(maxFeePpm: number): string {
  return `    /// Invariant: no trade pays more than the ceiling this market declared.
    function testFuzz_core_fee_never_exceeds_the_ceiling(uint128 size) public {
        uint256 bought = buy(_tradeSize(size, MIN_TRADE, MAX_TRADE));

        uint256 tokensBefore = _collectedTokens();
        sell(uint128(bought));
        uint256 taken = _collectedTokens() - tokensBefore;

        uint256 ceilingAmount = uint256(lastSellTokens) * ${String(maxFeePpm)} / 1_000_000;
        assertLe(taken, ceilingAmount + 1, "a sell paid more than the declared ceiling");
    }`;
}

/** `5000` reads as `0.5%` in a message somebody has to act on. */
function asPercent(ppm: number): string {
  const percent = ppm / 10_000;
  return `${percent % 1 === 0 ? percent.toFixed(0) : String(percent)}%`;
}

/** `2` reads as `2%`, `1.99` as `1.99%`. */
function thresholdShare(percent: number): string {
  return `${percent % 1 === 0 ? percent.toFixed(0) : String(percent)}%`;
}

/**
 * Points around a size threshold, as millionths of the basis.
 *
 * Derived from the threshold rather than written for one market: a quarter of it, half
 * of it, a hair under it, exactly it, a hair over it, and well above it. For a 2%
 * supply gate that is 0.5%, 1%, 1.99%, 2%, 2.01% and 5% — the ladder a creator checks
 * by hand, and the one that tells a substituted 1% default from the figure they named.
 */
function ladderAround(percent: number): readonly number[] {
  return [0.25, 0.5, 0.995, 1, 1.005, 2.5].map((factor) => Math.round(percent * factor * 10_000));
}

/**
 * A sell fee that only applies above a share of the token's supply.
 *
 * Authoritative for the same reason a flat rate is: the comparison is already a value
 * this package can compute, and a hook that flips at a different size is a different
 * market from the one that was asked for.
 */
function sizeGatedSellFees(schedule: FeeSchedule & { readonly tier: NonNullable<FeeSchedule["tier"]> }): string {
  const supply = 1_000_000_000n * 10n ** 18n;
  const cases = ladderAround(schedule.tier.threshold.percent).map((sharePpm) => {
    const amount = (supply * BigInt(sharePpm)) / 1_000_000n;
    const ppm = feeAt(schedule, { amount, basisAmount: supply });
    return { sharePpm, ppm };
  });

  const rows = cases
    .map(
      ({ sharePpm, ppm }) =>
        `            (${String(sharePpm)}, ${String(ppm)})`,
    )
    .join(",\n");

  return `    /// A sell of this size pays this rate, including exactly on the named boundary.
    function test_core_size_gated_fees_match_the_specified_threshold() public {
        uint256 supply = tokenSupply();
        (uint256 sharePpm, uint256 feePpm)[${String(cases.length)}] memory ladder = [
${rows}
        ];

        for (uint256 at = 0; at < ladder.length; at++) {
            uint256 amount = supply * ladder[at].sharePpm / 1_000_000;
            require(amount > 0 && amount <= type(uint128).max, "share is not a sellable amount");

            uint256 tokensBefore = _collectedTokens();
            sell(uint128(amount));
            uint256 taken = _collectedTokens() - tokensBefore;
            uint256 expected = uint256(lastSellTokens) * ladder[at].feePpm / 1_000_000;

            assertGt(taken, 0, "the sell fee reached none of this market's accounts");
            assertGe(taken + 1, expected, "the sell fee was smaller than specified at this size");
            assertLe(taken, expected + 1, "the sell fee was larger than specified at this size");
        }
    }`;
}
