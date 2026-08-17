/**
 * Reading fields off a request body that came from a stranger.
 *
 * Two helpers rather than a schema library: the agent routes already answer in
 * `AgentError`'s vocabulary, and a validator with its own error shape would have to be
 * translated into it at every call site.
 */

import { getAddress, isAddress, type Address } from "viem";

import { AgentError } from "../../lib/agents/errors";

/** A string field, or undefined for anything absent, empty or of the wrong type. */
export function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.trim() === "" ? undefined : value;
}

/**
 * An address field, checksummed, or undefined when absent.
 *
 * Checksummed rather than lowercased so that everything downstream compares one spelling,
 * and rejected rather than coerced: an address that is one character short is a different
 * address, not a typo to fix on somebody's behalf.
 */
export function addressField(value: unknown, field: string): Address | undefined {
  const raw = optionalString(value);
  if (raw === undefined) return undefined;

  const trimmed = raw.trim();
  if (!isAddress(trimmed, { strict: false })) {
    throw new AgentError("VALIDATION_FAILED", `${field} is not an address.`);
  }
  return getAddress(trimmed);
}
