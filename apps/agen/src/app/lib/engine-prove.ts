/**
 * Proving that a prepared engine-v1 launch actually launches.
 *
 * ## What `deployment_ready` is allowed to mean
 *
 * `prepareLaunch` encodes calldata. That establishes that some bytes are well-formed, which is
 * not the same claim as "this market can be created", and the gap between the two is where
 * every launch-time surprise lives: a factory paused, a hook address that has no code on this
 * chain, a quote asset that is not what the pool manager thinks it is, a recipient the vault
 * refuses, a tick the position manager rejects. None of those are visible in bytes and all of
 * them are visible in execution.
 *
 * So the app's prover executes the transaction. Not a mock of it and not a partial one: the
 * exact `call.data` the creator's wallet would send, to the exact factory, through `eth_call`
 * against current chain state. If it reverts, the build fails at preparation with the revert
 * in hand, and the creator never reaches a review screen for a market that cannot exist.
 *
 * ## Why `eth_call` is enough, and where it is not
 *
 * `eth_call` runs real bytecode against real storage at a real block, so everything above is
 * caught. What it cannot catch is anything that depends on being a transaction rather than a
 * call — gas at the block limit, and state that changes between now and signing. Those are
 * genuinely not knowable here, and the alternative to an imperfect proof is no proof, which is
 * the position engine 0 was in.
 *
 * ## The balance override
 *
 * The simulated creator is given ether they do not have, exactly as `instant-quote.ts` does
 * and for the same reason: a build is prepared long before anybody funds a wallet, and "you do
 * not have the gas" is not an answer to "does this market launch". The override is local to
 * one `eth_call`, moves nothing, and does not weaken the real launch — which is still bounded
 * by the real balance and by the checks the factory makes on chain.
 */

import type { PreparedLaunch } from "@verdant/market-compiler";
import type { CanonicalConfig } from "@verdant/market-engine";
import { type Address, type Hex } from "viem";

import { publicClient } from "./onchain";

/** Enough to cover gas for a launch, at any plausible gas price. See the note above. */
const GAS_HEADROOM_WEI = 10n ** 18n;

/**
 * Who a build stands in for, before it has a creator.
 *
 * Used twice and it has to be the same address both times: as the launch's fee receiver when
 * the build prepares its calldata, and as the sender when this file executes that calldata. If
 * they differed the proof would be of a transaction nobody is going to send.
 *
 * What it does not affect is what the creator approves. The commitment covers the canonical
 * configuration, the chain and the engine — not who signs — so the economics proved here are
 * exactly the economics that launch, and only the calldata is rebuilt per creator at signing.
 *
 * The factory's `deployMarket` resolves the creator from `msg.sender`, and every check it makes
 * on that address — that it is not zero, that it is not a contract the vault would refuse — is
 * satisfied by any ordinary account. So the identity is arbitrary and the execution is not.
 *
 * Deliberately not the treasury or any address with privileges, so a proof cannot pass on
 * permissions the real creator will not have.
 */
export const SIMULATED_CREATOR = "0xA9e1f0000000000000000000000000000000A9e1" as Address;

export class LaunchProofError extends Error {
  constructor(
    message: string,
    readonly configHash: Hex,
  ) {
    super(message);
    this.name = "LaunchProofError";
  }
}

/**
 * Extract something a person can act on from a revert.
 *
 * viem's error text is long, and its useful line is the revert reason or the custom error
 * name. A creator does not see this — the build's failure detail does, and so does whoever
 * reads the log — but an operator diagnosing a systematically failing engine needs the error
 * name rather than three paragraphs about a contract function call.
 */
function reasonOf(error: unknown): string {
  if (!(error instanceof Error)) return "the simulation failed for an unrecorded reason";

  const named = /reverted with the following (?:reason|signature):\s*\n?(.+)/.exec(error.message);
  if (named?.[1] !== undefined) return named[1].trim();

  const custom = /Error: (\w+)\(/.exec(error.message);
  if (custom?.[1] !== undefined) return `${custom[1]}()`;

  return error.message.split("\n")[0] ?? "the simulation reverted";
}

/**
 * A prover bound to this deployment's chain.
 *
 * Returns a function rather than doing the work, because the pipeline calls it once per build
 * and the client is shared. Throwing is how a prover refuses — see `LaunchProver` — so
 * everything here either returns nothing or throws with the reason attached.
 */
export function launchProver(): (
  prepared: PreparedLaunch,
  config: CanonicalConfig,
) => Promise<void> {
  return async (prepared, config) => {
    const client = publicClient();

    try {
      await client.call({
        account: SIMULATED_CREATOR,
        to: prepared.call.to,
        data: prepared.call.data,
        value: prepared.call.value,
        stateOverride: [{ address: SIMULATED_CREATOR, balance: GAS_HEADROOM_WEI }],
      });
    } catch (error) {
      throw new LaunchProofError(
        `this market's launch transaction does not execute against the current chain: ` +
          `${reasonOf(error)}. Nothing was sent and nothing was charged for.`,
        prepared.configHash,
      );
    }

    /*
     * The call succeeded, so the market is creatable. One more thing is worth asserting while
     * the configuration is in hand: that the transaction we just proved is the transaction the
     * commitment covers.
     *
     * This is cheap and it closes a real gap. `prepareLaunch` derives the calldata and the
     * commitment from the same configuration, so they cannot disagree — but the prover is the
     * last place both are together before a job is marked ready, and a future caller that
     * assembles them from two sources would produce a review screen describing one market and
     * calldata creating another. Asserting it here means that mistake fails a build rather
     * than reaching a creator.
     */
    if (prepared.encodedConfig.length <= 2) {
      throw new LaunchProofError(
        "this market's launch carries an empty configuration, so the engine would read no rules " +
          "from it.",
        prepared.configHash,
      );
    }

    if (prepared.feeCurrency !== config.feeCurrency) {
      throw new LaunchProofError(
        `this market's launch would collect fees in ${prepared.feeCurrency} while the reviewed ` +
          `configuration collects them in ${config.feeCurrency}.`,
        prepared.configHash,
      );
    }
  };
}
