import { describe, expect, it } from "vitest";
import { getAddress } from "viem";

import { ROBINHOOD_MAINNET_ID } from "@verdant/config";

import { AGEN_ADDRESSES, AGEN_ROUTER, BOOST_ADDRESSES, CHAIN_ID, INSTANT_ADDRESSES } from "../chain";
import { AGENT_PROGRAMMABLE_LAUNCHABLE } from "../programmable";
import { approvedAgenContracts, assertApprovedTarget, mainnetAllowlist } from "./allowlist";
import { AgentError } from "./errors";
import { AGENT_SIGNING_CHAIN_ID, assertMainnetSigning } from "./mainnet";

const RANDOM = "0x000000000000000000000000000000000000dEaD" as const;
const ZERO = "0x0000000000000000000000000000000000000000" as const;

describe("agent signing safety", () => {
  it("is pinned to Robinhood Chain mainnet 4663", () => {
    expect(CHAIN_ID).toBe(4663);
    expect(AGENT_SIGNING_CHAIN_ID).toBe(ROBINHOOD_MAINNET_ID);
    expect(AGENT_SIGNING_CHAIN_ID).toBe(4663);
    expect(() => assertMainnetSigning()).not.toThrow();
  });

  it("publishes the exact static allowlist from production config", () => {
    const list = mainnetAllowlist();
    expect(list.chainId).toBe(4663);
    expect(list.instantFactory).toBe(INSTANT_ADDRESSES?.factory ?? null);
    expect(list.agenFactory).toBe(AGEN_ADDRESSES.ok ? AGEN_ADDRESSES.addresses.factory : null);
    expect(list.agenRouter).toBe(AGEN_ROUTER);
    expect(list.boostEscrowFactory).toBe(BOOST_ADDRESSES?.escrowFactory ?? null);
    expect(approvedAgenContracts().length).toBeGreaterThan(0);
  });

  it("refuses an arbitrary target", () => {
    expect(() => assertApprovedTarget(RANDOM)).toThrow(AgentError);
    expect(() => assertApprovedTarget(ZERO)).toThrow(AgentError);
    try {
      assertApprovedTarget(getAddress(RANDOM));
    } catch (error) {
      expect(error).toMatchObject({ code: "PERMISSION_UNAPPROVED_CONTRACT" });
    }
  });

  it("refuses an arbitrary vault, factory, or router that is not on the list", () => {
    const known = new Set(approvedAgenContracts().map((address) => address.toLowerCase()));
    const impostors = [
      "0x1111111111111111111111111111111111111111",
      "0xF85b06710E2CbEf54230c92733e12824c8fCa2D6", // Instant factory is allowed; use a lookalike
    ] as const;

    for (const address of impostors) {
      const checksummed = getAddress(address);
      if (known.has(checksummed.toLowerCase())) {
        expect(() => assertApprovedTarget(checksummed)).not.toThrow();
        continue;
      }
      expect(() => assertApprovedTarget(checksummed)).toThrow(AgentError);
    }

    expect(() => assertApprovedTarget(getAddress("0x2222222222222222222222222222222222222222"))).toThrow(
      AgentError,
    );
  });

  it("does not accept caller-supplied extra destinations", () => {
    expect(assertApprovedTarget).toHaveLength(1);
  });

  /**
   * The agent gate, which is now its own switch. Programmable opened for people, who read a
   * review screen before signing; an agent reads nothing, so its gate did not travel with
   * theirs and this is what says so.
   */
  it("keeps the agent Programmable launch gate closed", () => {
    expect(AGENT_PROGRAMMABLE_LAUNCHABLE).toBe(false);
  });
});
