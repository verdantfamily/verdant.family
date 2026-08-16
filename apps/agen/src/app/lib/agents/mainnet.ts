/**
 * Agent signing is mainnet-only.
 *
 * Phase 1 acceptance and production both target Robinhood Chain 4663. A mis-set
 * `NEXT_PUBLIC_CHAIN_ID` would otherwise let an agent key sign on a fork or
 * testnet while the interface still named Instant's mainnet factory. Fail closed.
 */

import { ROBINHOOD_MAINNET_ID } from "@verdant/config";

import { CHAIN_ID } from "../chain";
import { AgentError } from "./errors";

export const AGENT_SIGNING_CHAIN_ID = ROBINHOOD_MAINNET_ID;

export function assertMainnetSigning(): void {
  if (CHAIN_ID !== AGENT_SIGNING_CHAIN_ID) {
    throw new AgentError(
      "WRONG_CHAIN",
      `Agent signing is restricted to Robinhood Chain mainnet (${String(AGENT_SIGNING_CHAIN_ID)}). This process is on ${String(CHAIN_ID)}.`,
      { details: { required: AGENT_SIGNING_CHAIN_ID, actual: CHAIN_ID } },
    );
  }
}
