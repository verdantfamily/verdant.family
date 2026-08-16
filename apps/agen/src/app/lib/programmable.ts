/**
 * Whether a Programmable market can be created yet. It cannot.
 *
 * Opened for an afternoon and closed again, on evidence rather than nerves. The last mile is
 * genuinely proven — every cleared build on the volume has been through the launch a creator
 * signs, against a fork of the live chain, landing at the addresses the review screen promises
 * and trading afterwards (`launch.e2e.test.ts`). What is not proven is repeatability: the same
 * fifteen prompts run twice against the same compiler produced different outcomes, three
 * markets passing in one run and failing in the next with nothing changed between them.
 *
 * That is the thing a creator would actually meet. A pipeline that succeeds six times in ten
 * and cannot say which six is not a compiler, and the honest place to hold it is here rather
 * than in an apology after somebody's build. Opening again wants at least nine of fifteen
 * across consecutive runs with no unexplained flipping — the bar is consistency, not a good
 * afternoon.
 *
 * One constant, read in two places: the shelf's badge and the flow's own notice. That is
 * the whole mechanism, and turning it over is one edit — deliberately, because a hold
 * spread across several files is a hold that gets half-lifted.
 *
 * Annotated `boolean` rather than inferred as `false`, so the interface's handling of the
 * open case stays type-checked code rather than becoming unreachable while this is off. It
 * is a switch, and a switch that cannot be turned back is not one.
 */
export const PROGRAMMABLE_LAUNCHABLE: boolean = false;

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
