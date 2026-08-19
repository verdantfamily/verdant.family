/**
 * Whether a Programmable market can be created yet. It can.
 *
 * Held while the same fifteen prompts flipped between runs, and while a cleared build could
 * still be the wrong market. The last mile was already proven — a signed launch against a
 * fork of the live chain, at the addresses the review screen promises (`launch.e2e.test.ts`).
 * What was missing was that a correct answer was being refused, and a wrong one was getting
 * through.
 *
 * The coverage reader now sees Foundry `invariant_*` tests, so a suite that did what it was
 * asked is no longer thrown away. A rate written as "half a percent" is compared before
 * Solidity is written, so a market that locked nothing against a prompt that asked for 0.5%
 * is refused rather than launched. A file that reaches around the fixture is rewritten
 * instead of costing the suite. A dry OpenAI account aborts a benchmark instead of filing
 * a fake collapse.
 *
 * The agent switch below is a different product and stays off. A person launching one reads
 * the review screen. An agent does not.
 *
 * One constant, read in two places: the shelf's badge and the flow's own notice. That is
 * the whole mechanism, and turning it over is one edit — deliberately, because a hold
 * spread across several files is a hold that gets half-lifted.
 *
 * Annotated `boolean` rather than inferred as `true`, so the interface's handling of the
 * closed case stays type-checked code rather than becoming unreachable while this is on.
 */
export const PROGRAMMABLE_LAUNCHABLE: boolean = true;

/**
 * Whether an *agent* may launch a Programmable market. It may not.
 *
 * A second switch, which the file above argues against, and the argument holds for one
 * product: a hold spread across files gets half-lifted. These are two products. A person
 * launching a generated market read the review screen, saw the addresses and the fee it opens
 * at, and pressed the button; an agent launching one did none of that, and the API's own
 * documentation has promised throughout that this is held for every agent and owner alike.
 *
 * The per-agent limits are real — a launch cap, a daily cap, an approved-target allowlist —
 * but they bound what a mistake costs rather than deciding whether the market was understood.
 * Opening the human flow is a judgement about an explanation somebody reads. There is nobody
 * to read one here, so it stays shut until that is its own decision rather than a side effect
 * of this one.
 */
export const AGENT_PROGRAMMABLE_LAUNCHABLE: boolean = false;

/** Why the button is off, in the words the interface uses. */
export const PROGRAMMABLE_HELD =
  "Programmable is not open yet. Agen can already write, compile and test a custom v4 " +
  "market — what is not ready is handing that to anyone who asks, since a generated " +
  "contract deserves more explanation than a launch button.";

/** The same, for an agent, which is held for a different reason and should say so. */
export const AGENT_PROGRAMMABLE_HELD =
  "Launching a Programmable market is held for agents. A generated market is a contract " +
  "nobody has read, and the review a person sees before launching one has no equivalent " +
  "here. Building and testing one through the API is open.";
