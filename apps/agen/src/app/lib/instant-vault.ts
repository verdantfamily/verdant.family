import "server-only";

/**
 * Which contract holds a market's fees, derived from the chain rather than taken on trust.
 *
 * One function, in its own module, because two callers need it and they need it for opposite
 * reasons. `instant-payout.ts` asks so it can read what is owed, where being wrong about an
 * address that is not one of ours costs nothing. `x/sponsor.ts` asks so it can decide what the
 * platform's hot key is allowed to call, where being wrong is a wallet somebody else can spend
 * the gas out of.
 *
 * The stricter caller cannot delegate its check to the looser one, so the derivation lives here
 * and each does its own thing with the answer. What must not happen is two copies of the
 * derivation drifting apart, because then the address that was inspected and the address that
 * was signed for would be different addresses.
 *
 * ## Why the pool id is re-derived
 *
 * The registry holds every market on the deployment, not only Instant's, and a row alone proves
 * only that something was registered. Instant has exactly one pool shape — ether against the
 * token, the dynamic-fee flag, the shared hook — so its key is a function of the token, and a row
 * whose recorded id does not hash from that key is not one of these markets. That check is what
 * turns "in the registry" into "an Instant market".
 *
 * ## Why `splitter`
 *
 * The registry's field is named for the job rather than the contract. A programmable market puts
 * a `FeeSplitter` there; an Instant market puts its `InstantFeeVault`. See ADR-014.
 */

import { getAddress, type Address } from "viem";

import { markets as marketReads, pool } from "@verdant/sdk";

import { INSTANT_ADDRESSES } from "./chain";
import { XError } from "./x/errors";
import { publicClient } from "./onchain";

/**
 * The `InstantFeeVault` of the Instant market for this token.
 *
 * Throws rather than returning null, because every caller treats "not a market of ours" as a
 * refusal with a reason rather than as an empty result.
 */
export async function readInstantVault(token: Address): Promise<Address> {
  if (INSTANT_ADDRESSES === null) {
    throw new XError("CONFIG_MISSING", "Instant is not configured on this deployment.");
  }

  const registry = { hook: INSTANT_ADDRESSES.hook, marketRegistry: INSTANT_ADDRESSES.registry };

  let record: Awaited<ReturnType<typeof marketReads.readMarketRecord>>;
  try {
    record = await marketReads.readMarketRecord(publicClient(), registry, { token });
  } catch {
    // `marketByToken` reverts for a token the registry does not know, which is the ordinary case
    // for any address somebody types into a URL.
    throw new XError("TOKEN_NOT_FOUND", "That is not a market on this deployment.", {
      details: { token },
    });
  }

  if (pool.poolIdOf(marketReads.poolKeyOf(record, registry.hook)) !== record.poolId) {
    throw new XError("TOKEN_NOT_FOUND", "That is not an Instant market.", { details: { token } });
  }

  return getAddress(record.splitter);
}
