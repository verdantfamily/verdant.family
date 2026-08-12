/**
 * The Agen autonomous runtime: the part that decides, none of the part that runs.
 *
 * This package holds no keys, opens no sockets, reads no clock and writes no rows.
 * Everything it does is a pure function of arguments it was handed, and everything it
 * needs from the world arrives through `RuntimeEnvironment`. That is not tidiness for
 * its own sake — it is what makes the security properties testable. "A guardian revokes
 * the agent while the model is thinking" is a two-line test here and an afternoon of
 * staging anywhere else.
 *
 * The service in `apps/runtime` supplies the environment: wallets, RPC, storage, a
 * scheduler and an HTTP surface. Anything with a credential in it lives there.
 *
 * ## The one-paragraph version of the security model
 *
 * A model chooses between three named actions and nothing else. It cannot express a
 * destination, an amount or a recipient, because no intent has a field for one. The
 * launch it may ask for was committed on chain before the agent existed, so its every
 * parameter is fixed and the chain refuses anything else. The revenue it may move can
 * only go where an immutable split already says. The runtime signs with a developer key
 * that cannot touch the treasury, cannot change the mandate and cannot pause or revoke,
 * and the human keeps the guardian key that can stop all of it.
 */

export * from "./config.js";
export * from "./context.js";
export * from "./guard.js";
export * from "./intent.js";
export * from "./model.js";
export * from "./pipeline.js";
export * from "./plan.js";
export * from "./prompt.js";
export * from "./records.js";
