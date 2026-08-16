/**
 * What an agent is allowed to do, enforced here rather than trusted of the caller.
 *
 * An external model can be told the rules and still ignore them. Every launch path
 * runs these checks before a key is unlocked and before a transaction is encoded.
 * Spending limits are reserved atomically in the store; this module is the policy
 * that decides whether to ask for a reservation at all.
 */

import { formatEther } from "viem";

import { AgentError } from "./errors";
import type { AgentPermissions, AgentRecord, LaunchKind } from "./types";
import { DEFAULT_PERMISSIONS } from "./types";

export function parsePermissions(input: unknown): AgentPermissions {
  if (typeof input !== "object" || input === null) return DEFAULT_PERMISSIONS;
  const raw = input as Record<string, unknown>;

  const flag = (value: unknown, fallback: boolean): boolean =>
    typeof value === "boolean" ? value : fallback;

  const wei = (value: unknown, fallback: bigint, field: string): bigint => {
    if (value === undefined || value === null || value === "") return fallback;
    if (typeof value === "bigint") return value;
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      return BigInt(Math.trunc(value));
    }
    if (typeof value === "string" && /^\d+$/.test(value.trim())) return BigInt(value.trim());
    throw new AgentError("VALIDATION_FAILED", `${field} is not an amount in wei.`);
  };

  const count = (value: unknown, fallback: number, field: string): number => {
    if (value === undefined || value === null || value === "") return fallback;
    const n = typeof value === "number" ? value : Number(value);
    if (!Number.isInteger(n) || n < 0) {
      throw new AgentError("VALIDATION_FAILED", `${field} must be a whole number.`);
    }
    return n;
  };

  const parsed: AgentPermissions = {
    instantAllowed: flag(raw.instantAllowed, DEFAULT_PERMISSIONS.instantAllowed),
    programmableAllowed: flag(raw.programmableAllowed, DEFAULT_PERMISSIONS.programmableAllowed),
    maxEthPerLaunchWei: wei(raw.maxEthPerLaunchWei, DEFAULT_PERMISSIONS.maxEthPerLaunchWei, "maxEthPerLaunchWei"),
    maxLaunchesPerDay: count(raw.maxLaunchesPerDay, DEFAULT_PERMISSIONS.maxLaunchesPerDay, "maxLaunchesPerDay"),
    maxEthPerDayWei: wei(raw.maxEthPerDayWei, DEFAULT_PERMISSIONS.maxEthPerDayWei, "maxEthPerDayWei"),
    maxCreatorBuyWei: wei(raw.maxCreatorBuyWei, DEFAULT_PERMISSIONS.maxCreatorBuyWei, "maxCreatorBuyWei"),
    canClaimCreatorFees: flag(raw.canClaimCreatorFees, DEFAULT_PERMISSIONS.canClaimCreatorFees),
    // Phase 1 hard rules. An owner cannot loosen these from the API.
    externalTransfers: false,
    approvedContractsOnly: true,
  };

  if (parsed.maxEthPerLaunchWei > parsed.maxEthPerDayWei) {
    throw new AgentError(
      "VALIDATION_FAILED",
      "The per-launch ETH limit cannot exceed the daily ETH budget.",
    );
  }

  return parsed;
}

export function assertAgentOperable(agent: AgentRecord): void {
  if (agent.status === "paused") {
    throw new AgentError("AGENT_PAUSED", "This agent is paused, so it cannot launch.", {
      permission: "status",
    });
  }
  if (agent.status === "archived") {
    throw new AgentError("AGENT_ARCHIVED", "This agent has been archived.", {
      permission: "status",
    });
  }
}

export function assertLaunchTypeAllowed(permissions: AgentPermissions, kind: LaunchKind): void {
  if (kind === "instant" && !permissions.instantAllowed) {
    throw new AgentError(
      "PERMISSION_INSTANT_DISABLED",
      "Instant launches are disabled for this agent.",
      { permission: "instantAllowed", limit: "false", requested: "true" },
    );
  }
  if (kind === "programmable" && !permissions.programmableAllowed) {
    throw new AgentError(
      "PERMISSION_PROGRAMMABLE_DISABLED",
      "Programmable launches are disabled for this agent.",
      { permission: "programmableAllowed", limit: "false", requested: "true" },
    );
  }
}

export function assertCreatorBuy(permissions: AgentPermissions, buyWei: bigint): void {
  if (buyWei > permissions.maxCreatorBuyWei) {
    throw new AgentError(
      "PERMISSION_MAX_CREATOR_BUY",
      `The creator buy of ${formatEther(buyWei)} ETH exceeds the ${formatEther(permissions.maxCreatorBuyWei)} ETH maximum.`,
      {
        permission: "maxCreatorBuy",
        limit: permissions.maxCreatorBuyWei.toString(),
        requested: buyWei.toString(),
      },
    );
  }
}

export function assertNoExternalTransfer(): never {
  throw new AgentError(
    "PERMISSION_EXTERNAL_TRANSFER",
    "External transfers are disabled. An agent wallet may only interact with approved Agen contracts.",
    { permission: "externalTransfers", limit: "false", requested: "true" },
  );
}

export function assertCannotSelfModify(): never {
  throw new AgentError(
    "PERMISSION_SELF_MODIFY",
    "An agent cannot change its own permissions. The owner must do that.",
    { permission: "permissions" },
  );
}

export function assertCannotChooseWallet(): never {
  throw new AgentError(
    "PERMISSION_WALLET_OVERRIDE",
    "An agent cannot choose a signer. Launches are signed by its own treasury.",
    { permission: "wallet" },
  );
}

export function publicPermissions(permissions: AgentPermissions): Record<string, unknown> {
  return {
    instantAllowed: permissions.instantAllowed,
    programmableAllowed: permissions.programmableAllowed,
    maxEthPerLaunchWei: permissions.maxEthPerLaunchWei.toString(),
    maxLaunchesPerDay: permissions.maxLaunchesPerDay,
    maxEthPerDayWei: permissions.maxEthPerDayWei.toString(),
    maxCreatorBuyWei: permissions.maxCreatorBuyWei.toString(),
    canClaimCreatorFees: permissions.canClaimCreatorFees,
    externalTransfers: permissions.externalTransfers,
    approvedContractsOnly: permissions.approvedContractsOnly,
  };
}
