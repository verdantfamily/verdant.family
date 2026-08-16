/**
 * The only contracts an agent wallet may be asked to call.
 *
 * Phase 1 has no general "send transaction" endpoint. Every signed call is built
 * here from Instant / Programmable / claim helpers, then checked against this
 * list before the key is used. A compromised API client therefore cannot point
 * the treasury at an arbitrary address.
 *
 * Instant fee vaults are per-market and cannot live on this static list. A claim
 * is allowed only after `readInstantMarket` proves the vault is the Instant
 * registry's `splitter` for a token this agent launched — see `signer.ts`.
 */

import { getAddress, isAddress, type Address, type Hex } from "viem";

import { AGEN_ADDRESSES, AGEN_ROUTER, BOOST_ADDRESSES, INSTANT_ADDRESSES } from "../chain";
import { AgentError } from "./errors";

export interface MainnetAllowlist {
  readonly chainId: 4663;
  readonly instantFactory: Address | null;
  readonly instantRegistry: Address | null;
  readonly instantHook: Address | null;
  readonly boostEscrowFactory: Address | null;
  readonly agenFactory: Address | null;
  readonly agenRouter: Address | null;
}

export function mainnetAllowlist(): MainnetAllowlist {
  return {
    chainId: 4663,
    instantFactory: INSTANT_ADDRESSES?.factory ?? null,
    instantRegistry: INSTANT_ADDRESSES?.registry ?? null,
    instantHook: INSTANT_ADDRESSES?.hook ?? null,
    boostEscrowFactory: BOOST_ADDRESSES?.escrowFactory ?? null,
    agenFactory: AGEN_ADDRESSES.ok ? AGEN_ADDRESSES.addresses.factory : null,
    agenRouter: AGEN_ROUTER,
  };
}

export function approvedAgenContracts(): readonly Address[] {
  const found: Address[] = [];
  if (INSTANT_ADDRESSES !== null) found.push(INSTANT_ADDRESSES.factory);
  if (BOOST_ADDRESSES !== null) found.push(BOOST_ADDRESSES.escrowFactory);
  if (AGEN_ADDRESSES.ok) found.push(AGEN_ADDRESSES.addresses.factory);
  if (AGEN_ROUTER !== null) found.push(AGEN_ROUTER);
  return found;
}

export function assertApprovedTarget(to: Address): void {
  const allowed = new Set(approvedAgenContracts().map((address) => address.toLowerCase()));
  if (!allowed.has(to.toLowerCase())) {
    throw new AgentError(
      "PERMISSION_UNAPPROVED_CONTRACT",
      "This agent may only call approved Agen contracts.",
      { permission: "approvedContractsOnly", requested: to },
    );
  }
}

export function asAddress(value: string, what: string): Address {
  if (!isAddress(value, { strict: false })) {
    throw new AgentError("VALIDATION_FAILED", `${what} is not an address.`);
  }
  return getAddress(value);
}

export interface UnsignedTx {
  readonly to: Address;
  readonly data: Hex;
  readonly value: bigint;
}
