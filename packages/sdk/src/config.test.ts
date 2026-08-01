import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BOUNDS,
  DYNAMIC_FEE_FLAG,
  EXTERNAL_ADDRESSES,
  MARKET_MODELS,
  MAX_PROTOCOL_BPS,
  MAX_TICK_ABSOLUTE,
  MAX_USABLE_TICK,
  MIN_USABLE_TICK,
  MODELS,
  MODEL_BOUNDS,
  OVERRIDE_FEE_FLAG,
  SECONDS,
  TICK_BOUNDS,
  TICK_SPACING,
  WETH_BY_CHAIN,
  robinhoodMainnet,
  robinhoodTestnet,
} from "@verdant/config";

/**
 * Golden values for the parameter register.
 *
 * This is a deliberate second transcription of the numbers in bounds.ts, not a
 * restatement of the same expression. The bounds are mirrored in three places
 * that must agree — this file, the ModelRegistry deployment, and the hook's
 * re-validation — and a single digit wrong in any of them is a live protocol
 * bug that no behavioural test would catch, because every layer would agree on
 * the wrong number. Changing a bound should therefore require editing two files
 * and noticing that you did.
 */
describe("parameter register", () => {
  it("fee bounds are 100..100_000 ppm with a 1% default", () => {
    expect(BOUNDS.schedule.feePpm.min).toBe(100);
    expect(BOUNDS.schedule.feePpm.max).toBe(100_000);
    expect(BOUNDS.schedule.feePpm.default).toBe(10_000);
  });

  it("fee bounds sit strictly inside Uniswap's own ceiling", () => {
    // MAX_LP_FEE is 1_000_000. A Verdant fee can never be mistaken for the
    // dynamic-fee sentinel or exceed what the pool will accept.
    expect(BOUNDS.schedule.feePpm.max).toBeLessThan(1_000_000);
    expect(BOUNDS.schedule.feePpm.max).toBeLessThan(DYNAMIC_FEE_FLAG);
    expect(BOUNDS.schedule.feePpm.min).toBeGreaterThan(0);
  });

  it("stage count is 1..8", () => {
    expect(BOUNDS.schedule.stageCount.min).toBe(1);
    expect(BOUNDS.schedule.stageCount.max).toBe(8);
  });

  it("the first stage offset is exactly zero", () => {
    expect(BOUNDS.schedule.firstOffset).toBe(0);
  });

  it("minimum stage gap is 300 seconds", () => {
    expect(BOUNDS.schedule.minStageGap).toBe(300);
  });

  it("schedule horizon is 730 days", () => {
    expect(BOUNDS.schedule.startOffset.max).toBe(730 * 24 * 60 * 60);
    expect(BOUNDS.schedule.startOffset.max).toBe(63_072_000);
  });

  it("has no creator share to configure, because it is derived", () => {
    // ADR-005. The creator share is total - protocol - reserve, so there is no
    // input to bound and no third number that can disagree with the other two.
    expect("creatorBps" in BOUNDS.splits).toBe(false);
  });

  it("caps the protocol share at 2000 bps and defaults it to 1000", () => {
    expect(BOUNDS.splits.protocolBps.min).toBe(0);
    expect(BOUNDS.splits.protocolBps.max).toBe(2_000);
    expect(BOUNDS.splits.protocolBps.default).toBe(1_000);
    expect(MAX_PROTOCOL_BPS).toBe(2_000);
    expect(BOUNDS.splits.protocolBps.max).toBe(MAX_PROTOCOL_BPS);
  });

  it("evergreen reserve share is 1000..8000 bps", () => {
    expect(BOUNDS.splits.reserveBps.min).toBe(1_000);
    expect(BOUNDS.splits.reserveBps.max).toBe(8_000);
  });

  it("splits total 10000 bps", () => {
    expect(BOUNDS.splits.total).toBe(10_000);
  });

  it("leaves the creator a positive share at every reachable protocol and reserve setting", () => {
    // The previous version of this test asked whether the three maxima could
    // reach the total and whether the three minima could stay under it. Both
    // held, and the register was still broken: with the reserve at 0 the caps
    // admitted exactly one split, and the stated defaults came to 8 000. The
    // question worth asking is the one the derivation raises — whether the
    // derived share is always well defined, i.e. never negative.
    //
    // It is exactly 0 at Evergreen's extreme (2 000 protocol + 8 000 reserve),
    // which is a legitimate market: everything the creator would have taken is
    // reinforced into the locked position instead. One basis point more of
    // either cap would make the derivation underflow, so this is the assertion
    // that keeps the two caps honest against the total.
    for (const model of MARKET_MODELS) {
      const reserve = MODEL_BOUNDS[model].reserveBps.max;
      const creator =
        BOUNDS.splits.total - BOUNDS.splits.protocolBps.max - reserve;
      expect(creator).toBeGreaterThanOrEqual(0);
      expect(creator + BOUNDS.splits.protocolBps.max + reserve).toBe(
        BOUNDS.splits.total,
      );
    }
  });

  it("no model offers the creator a share to set, because none exists", () => {
    // `unlockedParameters` is rendered as the create flow's controls, so a
    // parameter listed here is a promise that the creator chooses it. The
    // creator share is derived (ADR-005), which makes listing it a false
    // disclosure rather than a stale string.
    for (const model of MARKET_MODELS) {
      expect(MODELS[model].unlockedParameters).not.toContain("creatorBps");
    }
  });

  it("only evergreen unlocks the reserve share", () => {
    // The reserve is the one split input a creator has, and only under the one
    // model whose mechanism spends it.
    for (const model of MARKET_MODELS) {
      const unlocked = MODELS[model].unlockedParameters.includes("reserveBps");
      expect(unlocked).toBe(model === "evergreen");
      expect(unlocked).toBe(MODEL_BOUNDS[model].reserveBps.max > 0);
    }
  });

  it("supply is 1e6..1e15 whole tokens", () => {
    expect(BOUNDS.token.totalSupplyTokens.min).toBe(1_000_000n);
    expect(BOUNDS.token.totalSupplyTokens.max).toBe(1_000_000_000_000_000n);
  });

  it("creator allocation is 0..2000 bps", () => {
    expect(BOUNDS.token.creatorAllocationBps.min).toBe(0);
    expect(BOUNDS.token.creatorAllocationBps.max).toBe(2_000);
  });

  it("decimals are fixed at 18", () => {
    expect(BOUNDS.token.decimals).toBe(18);
  });

  it("minimum lock is 180 days", () => {
    expect(BOUNDS.liquidity.lockDuration.min).toBe(180 * 24 * 60 * 60);
    expect(BOUNDS.liquidity.lockDuration.min).toBe(15_552_000);
  });

  it("vesting duration, when present, is 30..730 days", () => {
    expect(BOUNDS.vesting.duration.min).toBe(30 * 24 * 60 * 60);
    expect(BOUNDS.vesting.duration.max).toBe(730 * 24 * 60 * 60);
    expect(BOUNDS.vesting.duration.default).toBe(0);
  });

  it("creation deadline caps at one hour, defaulting to twenty minutes", () => {
    expect(BOUNDS.creation.deadline.max).toBe(3_600);
    expect(BOUNDS.creation.deadline.default).toBe(1_200);
  });

  it("the token share of supply going to liquidity is at least 60%", () => {
    expect(BOUNDS.liquidity.tokenShareBps.min).toBe(6_000);
    expect(BOUNDS.liquidity.tokenShareBps.max).toBe(10_000);
  });

  it("creator allocation and the liquidity floor cannot overcommit supply", () => {
    // 2000 bps to the creator plus a 6000 bps liquidity floor leaves headroom;
    // if these were ever set so their sum exceeded 10000, every creation with a
    // maximal allocation would revert.
    expect(
      BOUNDS.token.creatorAllocationBps.max + BOUNDS.liquidity.tokenShareBps.min,
    ).toBeLessThanOrEqual(10_000);
  });
});

describe("Uniswap constants mirrored from v4", () => {
  it("dynamic fee and override flags match LPFeeLibrary", () => {
    // Asserted against v4-core in packages/contracts/test/Remappings.t.sol.
    expect(DYNAMIC_FEE_FLAG).toBe(0x800000);
    expect(OVERRIDE_FEE_FLAG).toBe(0x400000);
  });

  it("tick bounds are aligned to the tick spacing", () => {
    // Math.abs because JS `%` keeps the sign of the dividend: -887200 % 200 is
    // -0, and Object.is(-0, 0) is false, so a bare toBe(0) fails here. Worth
    // remembering wherever this package does signed arithmetic on ticks.
    expect(Math.abs(TICK_BOUNDS.max % TICK_SPACING)).toBe(0);
    expect(Math.abs(TICK_BOUNDS.min % TICK_SPACING)).toBe(0);
    expect(TICK_BOUNDS.min).toBe(-TICK_BOUNDS.max);
  });
});

/**
 * ADR-001. The spacing changed from 60 to 200, which also moved the usable ticks
 * from ±887 220 to ±887 200 — a change that is easy to apply in one place and
 * forget in four. These tests are the mechanised form of the ADR's arithmetic.
 */
describe("tick spacing (ADR-001)", () => {
  it("is 200", () => {
    expect(TICK_SPACING).toBe(200);
  });

  it("usable ticks are the widest multiples of the spacing inside v4's bound", () => {
    expect(MAX_USABLE_TICK).toBe(887_200);
    expect(MIN_USABLE_TICK).toBe(-887_200);

    // Aligned...
    expect(Math.abs(MAX_USABLE_TICK % TICK_SPACING)).toBe(0);
    expect(Math.abs(MIN_USABLE_TICK % TICK_SPACING)).toBe(0);

    // ...strictly inside v4's own limit...
    expect(MAX_USABLE_TICK).toBeLessThan(MAX_TICK_ABSOLUTE);
    expect(MIN_USABLE_TICK).toBeGreaterThan(-MAX_TICK_ABSOLUTE);

    // ...and the widest such multiples: one more step would fall outside.
    expect(MAX_USABLE_TICK + TICK_SPACING).toBeGreaterThan(MAX_TICK_ABSOLUTE);
    expect(MIN_USABLE_TICK - TICK_SPACING).toBeLessThan(-MAX_TICK_ABSOLUTE);
  });

  it("keeps v4's absolute bound as the unaligned constant it is", () => {
    // 887272 is not a multiple of 200. Asserted so nobody "fixes" the constant
    // to make the alignment tests above pass trivially.
    expect(MAX_TICK_ABSOLUTE).toBe(887_272);
    expect(MAX_TICK_ABSOLUTE % TICK_SPACING).not.toBe(0);
  });

  it("agrees with the liquidity bounds that quote it", () => {
    expect(BOUNDS.liquidity.tickSpacing).toBe(TICK_SPACING);
    expect(BOUNDS.liquidity.tick.min).toBe(MIN_USABLE_TICK);
    expect(BOUNDS.liquidity.tick.max).toBe(MAX_USABLE_TICK);
  });
});

/**
 * The other half of "nothing anywhere else may hardcode a tick spacing".
 *
 * Alignment tests prove the constants are right; they say nothing about a second
 * copy of a tick literal sitting in a preset, a Zod schema, or a script. This
 * scans the source for tick literals in a tick context and fails on any it did
 * not expect — a lint rule expressed as a test, because it is cheaper than an
 * ESLint plugin and runs in the same command as everything else.
 */
describe("no stray tick literals (ADR-001)", () => {
  const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

  /**
   * Files allowed to contain tick literals, and why. Deliberately short — the
   * point of ADR-001 is that this list has two entries per language.
   */
  const ALLOWED = new Set([
    // The single TypeScript definition.
    "packages/config/src/bounds.ts",
    // This file: the golden-value transcription that guards that definition.
    "packages/sdk/src/config.test.ts",
    // The single Solidity definition. Solidity cannot import from TypeScript, so
    // the constant necessarily exists twice; VerdantConstants.t.sol asserts the
    // Solidity copy against Uniswap's own TickMath rather than against a literal.
    "packages/contracts/src/libraries/VerdantConstants.sol",
  ]);

  const SEARCH_DIRS = ["packages", "apps", "scripts"];
  const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".sol"]);

  /**
   * Stale values from before ADR-001, plus the raw v4 bound. `\b` on both sides
   * so a longer number containing these digits does not match, and the
   * underscore form is included because Solidity and TypeScript both allow it.
   */
  const FORBIDDEN = [
    { pattern: /\b887_?220\b/, what: "887220 — the spacing-60 usable tick" },
    { pattern: /\b887_?272\b/, what: "887272 — v4's raw bound" },
    {
      pattern: /tickSpacing\s*[:=]\s*\d+/i,
      what: "an inline tickSpacing assignment",
    },
  ];

  /**
   * Strips comments before scanning. A documented derivation — "887272 / 200 =
   * 4436.36, so 4436 x 200 = 887200" — is exactly what we want people to write;
   * a literal in an expression is what we forbid. Scanning raw text cannot tell
   * the difference and would punish the good case.
   *
   * Deliberately simple: line comments, block comments, nothing else. It does not
   * understand a `//` inside a string literal, which for a lint over our own
   * source is an acceptable limit rather than a hazard — a false negative here
   * means an unusual line is not scanned, not that a bad line passes silently.
   */
  function stripComments(source: string): string {
    return source
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
  }

  function sourceFiles(dir: string): string[] {
    const found: string[] = [];
    const walk = (current: string): void => {
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        const full = join(current, entry.name);
        if (entry.isDirectory()) {
          // vendor/ is upstream Uniswap source and node_modules is not ours;
          // out/ and .next/ are build artefacts of files already checked.
          if (
            ["vendor", "node_modules", "out", "dist", ".next", ".turbo"].includes(
              entry.name,
            )
          ) {
            continue;
          }
          walk(full);
        } else if (SOURCE_EXTENSIONS.has(extname(entry.name))) {
          found.push(full);
        }
      }
    };
    if (existsSync(dir)) walk(dir);
    return found;
  }

  it("finds tick literals only where they are defined", () => {
    const offenders: string[] = [];

    for (const dir of SEARCH_DIRS) {
      for (const file of sourceFiles(resolve(REPO_ROOT, dir))) {
        const path = relative(REPO_ROOT, file);
        if (ALLOWED.has(path)) continue;

        const code = stripComments(readFileSync(file, "utf8"));
        for (const { pattern, what } of FORBIDDEN) {
          if (pattern.test(code)) {
            offenders.push(`${path}: ${what}`);
          }
        }
      }
    }

    expect(
      offenders,
      `tick values must come from @verdant/config (ADR-001). Offending files:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("is actually looking at files", () => {
    // A scan that silently matched nothing would pass forever. Assert the walk
    // finds the source tree it is supposed to be guarding.
    const files = SEARCH_DIRS.flatMap((dir) =>
      sourceFiles(resolve(REPO_ROOT, dir)),
    );
    expect(files.length).toBeGreaterThan(10);
    expect(
      files.some((f) => f.endsWith("packages/config/src/bounds.ts")),
    ).toBe(true);
  });

  it("would catch a stale literal", () => {
    // The regexes themselves, checked against the values they exist to find.
    expect(FORBIDDEN[0]?.pattern.test("min: -887_220")).toBe(true);
    expect(FORBIDDEN[0]?.pattern.test("max: 887220")).toBe(true);
    expect(FORBIDDEN[1]?.pattern.test("MAX_TICK = 887272")).toBe(true);
    expect(FORBIDDEN[2]?.pattern.test("tickSpacing: 60")).toBe(true);
    // ...and not against the values that are legitimate.
    expect(FORBIDDEN[0]?.pattern.test("887200")).toBe(false);
    expect(FORBIDDEN[2]?.pattern.test("tickSpacing: TICK_SPACING")).toBe(false);
  });
});

describe("chain configuration", () => {
  it("uses the verified chain ids", () => {
    expect(robinhoodMainnet.id).toBe(4663);
    expect(robinhoodTestnet.id).toBe(46630);
  });

  it("marks only the testnet as a testnet", () => {
    expect(robinhoodTestnet.testnet).toBe(true);
    expect(robinhoodMainnet.testnet).toBeUndefined();
  });

  it("uses ETH as the gas token on both chains", () => {
    for (const chain of [robinhoodMainnet, robinhoodTestnet]) {
      expect(chain.nativeCurrency.symbol).toBe("ETH");
      expect(chain.nativeCurrency.decimals).toBe(18);
    }
  });

  it("has a distinct WETH per chain", () => {
    // Sharing one WETH across both chains would be a copy-paste error that no
    // amount of testing on a single chain would reveal.
    expect(WETH_BY_CHAIN[4663]).not.toBe(WETH_BY_CHAIN[46630]);
  });

  it("holds every external address as a 20-byte hex string", () => {
    for (const [name, address] of Object.entries(EXTERNAL_ADDRESSES)) {
      expect(address, name).toMatch(/^0x[0-9a-fA-F]{40}$/);
    }
  });
});

describe("model definitions", () => {
  it("defines bounds and metadata for every model", () => {
    for (const model of MARKET_MODELS) {
      expect(MODEL_BOUNDS[model], model).toBeDefined();
      expect(MODELS[model], model).toBeDefined();
    }
    expect(Object.keys(MODELS).sort()).toEqual([...MARKET_MODELS].sort());
  });

  it("gives every model at least one written risk", () => {
    // A model whose risks are undocumented cannot ship: the create flow renders
    // them next to the mechanism, and an empty list would render as reassurance.
    for (const model of MARKET_MODELS) {
      expect(MODELS[model].risks.length, model).toBeGreaterThan(0);
      expect(MODELS[model].mechanism.length, model).toBeGreaterThan(0);
    }
  });

  it("keeps per-model stage bounds inside the global stage bounds", () => {
    for (const model of MARKET_MODELS) {
      const bounds = MODEL_BOUNDS[model];
      expect(bounds.minStages, model).toBeGreaterThanOrEqual(
        BOUNDS.schedule.stageCount.min,
      );
      expect(bounds.maxStages, model).toBeLessThanOrEqual(
        BOUNDS.schedule.stageCount.max,
      );
      expect(bounds.minStages, model).toBeLessThanOrEqual(bounds.maxStages);
    }
  });

  it("permits a reserve share only for evergreen", () => {
    expect(MODEL_BOUNDS.fixed.reserveBps.max).toBe(0);
    expect(MODEL_BOUNDS.progressive.reserveBps.max).toBe(0);
    expect(MODEL_BOUNDS.evergreen.reserveBps.min).toBeGreaterThan(0);
  });

  it("restricts fixed to exactly one stage and progressive to at least two", () => {
    expect(MODEL_BOUNDS.fixed.minStages).toBe(1);
    expect(MODEL_BOUNDS.fixed.maxStages).toBe(1);
    expect(MODEL_BOUNDS.progressive.minStages).toBe(2);
  });
});

describe("time constants", () => {
  it("derives durations from seconds, never from float days", () => {
    expect(SECONDS.minute).toBe(60);
    expect(SECONDS.hour).toBe(3_600);
    expect(SECONDS.day).toBe(86_400);
  });
});
