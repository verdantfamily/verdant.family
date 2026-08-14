/**
 * Whether a Programmable market can be created yet. It cannot.
 *
 * Not a claim that the pipeline is broken: it compiles, tests and deploys markets, and the
 * ones on chain were made with it. It is a hold on offering that to strangers while Instant
 * is the product being opened — a generated market is a contract nobody has read, and
 * putting it behind the same button as a standard ERC-20 asks a creator to make a much
 * larger decision than the shelf currently explains.
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

/** Why the button is off, in the words the interface uses. */
export const PROGRAMMABLE_HELD =
  "Programmable is not open yet. Agen can already write, compile and test a custom v4 " +
  "market — what is not ready is handing that to anyone who asks, since a generated " +
  "contract deserves more explanation than a launch button.";
