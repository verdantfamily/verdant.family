/**
 * The app-level invariant: the engine-v1 screens do no economics.
 *
 * This is the property the whole refactor exists to guarantee, and it is the one a reviewer
 * cannot check by reading — a percentage computed for display looks exactly like a percentage
 * read from the configuration. So it is asserted three ways, each catching a different way of
 * breaking it:
 *
 *  1. **Nothing on screen that is not in the artefacts.** Every rate, threshold, symbol and
 *     address the screen renders is found verbatim in the canonical review data. A number
 *     derived here would appear on screen and not in the source, and fails.
 *  2. **No arithmetic and no prompt.** The source is checked for the operators and the
 *     `job.prompt` reference that a second opinion about economics would need. This catches a
 *     computation whose result happens to coincide with the configuration's.
 *  3. **Changing the configuration changes the screen.** A rate edited in the artefacts must
 *     move the rendered text, which proves the screen is reading them rather than holding a
 *     constant that matches.
 *
 * Together they mean a screen showing one market while another deploys is a failing test
 * rather than a launched token.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { PublicJob } from "../lib/builds";
import { EngineReviewScreen } from "./engine-review";
import { EngineClarify, EngineInterpretationError, EngineUnsupported } from "./engine-outcome";

const REVIEW_SOURCE = readFileSync(
  fileURLToPath(new URL("./engine-review.tsx", import.meta.url)),
  "utf8",
);

/*
 * The launch panel needs a connected wallet, and this file is not about the launch panel.
 *
 * Stubbed rather than avoided by rendering an unready job, because the ready path is the one
 * worth asserting: it is the screen a creator signs from, and a figure invented for display
 * would appear there.
 */
vi.mock("./engine-launch", () => ({
  EngineLaunch: () => <div data-stub="launch-panel" />,
}));

/** Comments say what the code must not do, so they are removed before checking that it doesn't. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/**
 * A market with a base rate, a size tier and a two-way split — the shape most likely to tempt
 * a screen into arithmetic, since every figure in it is a percentage of something.
 */
function job(overrides: Partial<PublicJob> = {}): PublicJob {
  return {
    id: "j1",
    stage: "deployment_ready",
    createdAt: 0,
    updatedAt: 0,
    name: "Exact Flow",
    symbol: "EXCT",
    prompt:
      "Charge 0.5% on every buy and sell. When a sell is at least 1% of supply charge 4%. " +
      "Send 80% to the creator and 20% to the vault.",
    stages: [],
    specification: null,
    plan: null,
    sources: [],
    tests: [],
    testOutcomes: null,
    gateFindings: null,
    intent: null,
    semanticCoverage: null,
    approval: null,
    simulation: null,
    compilationAttempts: 0,
    testAttempts: 0,
    harnessAttempts: 0,
    failure: null,
    launch: null,
    queue: null,
    engineVersion: 1,
    engine: {
      outcome: "SUPPORTED",
      assumptions: ["Fees are split between the creator and Agen's fee vault."],
      unsupported: [],
      clarifications: [],
      problems: [],
      encodedConfig: "0xabcdef",
      configHash: `0x${"11".repeat(32)}`,
      implementationHash: `0x${"22".repeat(32)}`,
      review: {
        cards: [
          {
            heading: "Every trade",
            summary: "A flat rate on both sides.",
            rows: [
              { when: "Any buy", then: "pays 0.5%" },
              { when: "Any sell", then: "pays 0.5%" },
            ],
            caution: null,
          },
          {
            heading: "Large sells",
            summary: null,
            rows: [{ when: "A sell of 1% of total supply or more", then: "pays 4%" }],
            caution: "This replaces the base rate rather than adding to it.",
          },
        ],
        maximumFee: "4%",
        quoteAssetSymbol: "ETH",
        quoteAssetLabel: "Native ETH — Robinhood Chain",
        feeCurrency: "TOKEN",
        feeCurrencySymbol: "EXCT",
        feeCurrencyReason: "this market charges by trade size, which is measured in EXCT",
      },
      simulation: {
        cases: [
          {
            label: "A sell of 0.999999% of supply",
            because: "below the 1% tier",
            evaluation: { effectiveFeePpm: 5_000, blocked: null },
          },
          {
            label: "A sell of exactly 1% of supply",
            because: "at the 1% tier",
            evaluation: { effectiveFeePpm: 40_000, blocked: null },
          },
        ],
      },
      graph: null,
      preparation: {
        factory: `0x${"f0".repeat(10)}`,
        hook: `0x${"38".repeat(10)}`,
        quoteAsset: `0x${"00".repeat(20)}`,
        quoteIsNative: true,
        configHash: `0x${"11".repeat(32)}`,
        implementationHash: `0x${"22".repeat(32)}`,
        predicted: { vault: null, token: null },
        call: { to: `0x${"f0".repeat(10)}`, selector: "0xdeadbeef", function: "deployMarket" },
      },
    },
    ...overrides,
  } as PublicJob;
}

/** Every number the markup shows, as strings, so they can be looked for in the source data. */
function numbersIn(markup: string): readonly string[] {
  const text = markup
    .replace(/<[^>]*>/g, " ")
    // React escapes apostrophes as `&#x27;`, whose digits are not a figure the screen showed.
    .replace(/&#?\w+;/g, " ");

  return [...text.matchAll(/\d+(?:\.\d+)?%?/g)].map((match) => match[0]);
}

describe("the engine-v1 review screen", () => {
  it("shows no figure that is not in the canonical artefacts", () => {
    const record = job();
    const markup = renderToStaticMarkup(<EngineReviewScreen job={record} />);

    // Everything the engine said, as one haystack. A figure on screen that is not in here was
    // produced by the screen.
    const canonical = JSON.stringify(record.engine);

    for (const figure of numbersIn(markup)) {
      expect(canonical, `the screen rendered ${figure}, which the engine never said`).toContain(
        figure,
      );
    }
  });

  it("renders the rates, thresholds and assets the configuration states", () => {
    const markup = renderToStaticMarkup(<EngineReviewScreen job={job()} />);

    expect(markup).toContain("0.5%");
    expect(markup).toContain("4%");
    expect(markup).toContain("1% of total supply or more");
    expect(markup).toContain("Native ETH — Robinhood Chain");
    expect(markup).toContain("EXCT");
  });

  /*
   * The fee currency is derived rather than chosen, so a creator who reads "EXCT" and expected
   * ether has to be told why in the same breath. A screen that showed the symbol without the
   * reason would be technically accurate and would generate a support ticket per launch.
   */
  it("explains the derived fee currency rather than stating it bare", () => {
    const markup = renderToStaticMarkup(<EngineReviewScreen job={job()} />);
    expect(markup).toContain("this market charges by trade size");
  });

  it("shows the boundary cases either side of every threshold", () => {
    const markup = renderToStaticMarkup(<EngineReviewScreen job={job()} />);

    expect(markup).toContain("A sell of 0.999999% of supply");
    expect(markup).toContain("A sell of exactly 1% of supply");
  });

  /*
   * Not a cosmetic check. The vault's address depends on its recipients, one of which is the
   * creator, so before a wallet connects there is no address to show — and inventing one from a
   * stand-in creator would print an address the launch will not use.
   */
  it("says the vault address is not yet known rather than inventing one", () => {
    const markup = renderToStaticMarkup(<EngineReviewScreen job={job()} />);
    expect(markup).toContain("derived from your address when you launch");
  });

  it("moves when the configuration moves", () => {
    const before = renderToStaticMarkup(<EngineReviewScreen job={job()} />);

    const edited = job();
    const review = edited.engine?.review as {
      cards: { rows: { when: string; then: string }[] }[];
    };
    const after = renderToStaticMarkup(
      <EngineReviewScreen
        job={job({
          engine: {
            ...edited.engine!,
            review: {
              ...(edited.engine?.review as object),
              cards: [
                { ...review.cards[0]!, rows: [{ when: "Any buy", then: "pays 3.75%" }] },
                ...review.cards.slice(1),
              ],
            },
          },
        })}
      />,
    );

    expect(before).toContain("pays 0.5%");
    expect(after).toContain("pays 3.75%");
    expect(after).not.toContain("pays 0.5%");
  });

  /**
   * The static half of the invariant.
   *
   * A screen that computed a rate would need arithmetic, and one that reconstructed a rule
   * would need the prompt. Neither appears. The one division that does — ppm to percent in the
   * simulation table — is a unit conversion of a number the engine produced, not a second
   * opinion about it, and is spelled `/ 10_000` so this can name it.
   */
  it("contains no economics of its own", () => {
    const body = code(REVIEW_SOURCE);

    expect(body, "the screen must not read the prompt").not.toContain("job.prompt");
    expect(body, "the screen must not multiply").not.toMatch(/\s\*\s/);
    expect(body, "the screen must not add or subtract").not.toMatch(/[\w)]\s[+-]\s/);

    // Slicing a hash for display is not economics, and it is the only indexing here.
    const divisions = [...body.matchAll(/\s\/\s/g)].map((match) => match.index);
    const conversions = [...body.matchAll(/\/ 10_000/g)].map((match) => match.index);
    expect(divisions.length - conversions.length, "the only division is ppm to percent").toBe(0);
  });
});

describe("the engine-v1 endings that are not a launch", () => {
  /*
   * The distinction this whole file of components exists for. Engine 0 reported an unreadable
   * model answer as an unsupported market, which tells somebody their idea is impossible on the
   * evidence of a parsing failure.
   */
  it("does not call an interpretation failure an unsupported market", () => {
    const markup = renderToStaticMarkup(<EngineInterpretationError onRetry={() => undefined} />);

    expect(markup).not.toMatch(/unsupported|cannot build|impossible/i);
    expect(markup).toContain("says nothing about whether your market can be built");
  });

  it("names the unsupported mechanic and does not condemn the market", () => {
    const markup = renderToStaticMarkup(
      <EngineUnsupported
        job={job({
          engine: {
            ...job().engine!,
            outcome: "UNSUPPORTED",
            unsupported: [
              {
                request: "after 10 consecutive buys without a sell, make the next buy fee-free",
                why: "the engine has no per-trader or per-sequence state, so it cannot count consecutive buys",
              },
            ],
          },
        })}
        onRestart={() => undefined}
      />,
    );

    expect(markup).toContain("10 consecutive buys");
    expect(markup).toContain("no per-trader or per-sequence state");
    expect(markup).toContain("Everything else you described is fine");
  });

  /*
   * No route into generated Solidity from a refusal. The experimental path exists and offering
   * it here would hand somebody an unreviewed contract at the moment they are least likely to
   * read what they are accepting.
   */
  it("offers no escape into generated Solidity", () => {
    const markup = renderToStaticMarkup(
      <EngineUnsupported job={job()} onRestart={() => undefined} />,
    );

    expect(markup).not.toMatch(/solidity|custom contract|experimental|advanced mode/i);
  });

  it("asks a clarification as a question, in the creator's own words", () => {
    const markup = renderToStaticMarkup(
      <EngineClarify
        job={job({
          engine: {
            ...job().engine!,
            outcome: "NEEDS_CLARIFICATION",
            clarifications: [
              {
                id: "tier-rate",
                question: "What should a large sell pay?",
                because: "charge more on large sells",
              },
            ],
          },
        })}
        onAnswer={async () => undefined}
      />,
    );

    expect(markup).toContain("What should a large sell pay?");
    expect(markup).toContain("charge more on large sells");
    expect(markup).not.toMatch(/failed|error|could not/i);
  });

  /*
   * A pending question is not a launchable market. If any part of the launch panel rendered
   * here, a creator could sign economics Agen has explicitly said it does not yet know.
   */
  it("offers nothing to launch while a question is pending", () => {
    const markup = renderToStaticMarkup(
      <EngineClarify
        job={job({
          engine: {
            ...job().engine!,
            clarifications: [{ id: "a", question: "How much?", because: "some fee" }],
          },
        })}
        onAnswer={async () => undefined}
      />,
    );

    expect(markup).not.toMatch(/launch (your|this) (token|market)/i);
    expect(markup).not.toContain("0xdeadbeef");
  });
});
