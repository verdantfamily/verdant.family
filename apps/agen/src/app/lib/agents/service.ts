/**
 * The agent product, as one façade.
 *
 * Routes and pages talk to this. Persistence, permissions, Instant and Programmable
 * each stay in their own module; this is the order they run in and the place an
 * API key is told it may not do something.
 */

import { randomBytes } from "node:crypto";

import { getAddress, isAddress, parseEther, type Address } from "viem";

import { instant as instantFees } from "@verdant/sdk";

import { publicClient } from "../onchain";
import { readInstantMarket } from "../instant-markets";
import { verifyInstantToken } from "../instant-verify";
import { AgentError } from "./errors";
import { issueApiKey } from "./keys";
import {
  assertAgentOperable,
  assertCannotChooseWallet,
  assertCannotSelfModify,
  assertCreatorBuy,
  assertLaunchTypeAllowed,
  assertNoExternalTransfer,
  parsePermissions,
  publicPermissions,
} from "./permissions";
import { executeInstantLaunch, spendWeiOf, draftFromRequest, type AgentInstantRequest } from "./instant";
import {
  answerAgentBuild,
  launchAgentBuild,
  parseBuildRequest,
  readAgentBuild,
  startAgentBuild,
} from "./programmable";
import { assertRateLimit } from "./rate-limit";
import { AGENT_PROGRAMMABLE_HELD, AGENT_PROGRAMMABLE_LAUNCHABLE } from "../programmable";
import { sendApproved, sendProvenInstantClaim } from "./signer";
import { assertMainnetSigning } from "./mainnet";
import { agentStore, type AgentStore } from "./store";
import { readTreasury } from "./treasury";
import type { AgentPermissions, AgentRecord, IssuedApiKey } from "./types";
import { DEFAULT_PERMISSIONS, RESERVED_USERNAMES, USERNAME_PATTERN } from "./types";
import { createIsolatedWallet } from "./wallets";

export function normaliseUsername(raw: string): string {
  const username = raw.trim().toLowerCase();
  if (!USERNAME_PATTERN.test(username)) {
    throw new AgentError(
      "USERNAME_INVALID",
      "A username is 3–20 characters of lowercase letters, numbers or underscores.",
      { permission: "username" },
    );
  }
  if (RESERVED_USERNAMES.has(username)) {
    throw new AgentError("USERNAME_UNAVAILABLE", "That username is reserved.", {
      permission: "username",
    });
  }
  return username;
}

export function createAgent(
  owner: Address,
  input: {
    readonly name: string;
    readonly username: string;
    readonly description?: string;
    readonly imageUrl?: string | null;
    readonly permissions?: unknown;
  },
  store: AgentStore = agentStore(),
): { readonly agent: AgentRecord; readonly permissions: AgentPermissions } {
  const name = input.name.trim();
  if (name.length === 0 || name.length > 64) {
    throw new AgentError("VALIDATION_FAILED", "An agent needs a name of at most 64 characters.");
  }

  const username = normaliseUsername(input.username);
  if (store.getAgentByUsername(username) !== null) {
    throw new AgentError("USERNAME_UNAVAILABLE", "That username is already taken.");
  }

  const description = (input.description ?? "").trim().slice(0, 280);
  const imageUrl =
    typeof input.imageUrl === "string" && input.imageUrl.trim() !== "" ? input.imageUrl.trim() : null;
  const permissions = parsePermissions(input.permissions ?? DEFAULT_PERMISSIONS);
  const id = randomBytes(16).toString("hex");
  const now = Math.floor(Date.now() / 1000);
  const wallet = createIsolatedWallet(id);

  const agent = store.insertAgent({
    agent: {
      id,
      username,
      name,
      description,
      imageUrl,
      ownerAddress: owner,
      walletAddress: wallet.address,
      status: "active",
      createdAt: now,
      updatedAt: now,
    },
    wallet: wallet.record,
    permissions,
  });

  store.recordActivity({
    agentId: id,
    type: "agent_created",
    payload: { username, name, wallet: wallet.address },
  });

  return { agent, permissions };
}

export function updateAgentProfile(
  owner: Address,
  agentId: string,
  patch: { readonly name?: string; readonly description?: string; readonly imageUrl?: string | null },
  store: AgentStore = agentStore(),
): AgentRecord {
  const agent = owned(store, owner, agentId);
  const next = store.updateAgent(agent.id, {
    ...(patch.name === undefined ? {} : { name: patch.name.trim().slice(0, 64) }),
    ...(patch.description === undefined ? {} : { description: patch.description.trim().slice(0, 280) }),
    ...(patch.imageUrl === undefined ? {} : { imageUrl: patch.imageUrl }),
  });
  store.recordActivity({ agentId: agent.id, type: "agent_updated", payload: { fields: Object.keys(patch) } });
  return next;
}

export function setAgentPermissions(
  owner: Address,
  agentId: string,
  input: unknown,
  store: AgentStore = agentStore(),
): AgentPermissions {
  const agent = owned(store, owner, agentId);
  const permissions = parsePermissions(input);
  store.setPermissions(agent.id, permissions);
  store.recordActivity({ agentId: agent.id, type: "permissions_updated", payload: publicPermissions(permissions) });
  return permissions;
}

export function setAgentStatus(
  owner: Address,
  agentId: string,
  status: "active" | "paused" | "archived",
  store: AgentStore = agentStore(),
): AgentRecord {
  const agent = owned(store, owner, agentId);
  const next = store.updateAgent(agent.id, { status });
  store.recordActivity({
    agentId: agent.id,
    type: status === "paused" ? "agent_paused" : status === "archived" ? "agent_archived" : "agent_resumed",
    payload: { status },
  });
  return next;
}

export function createAgentKey(
  owner: Address,
  agentId: string,
  store: AgentStore = agentStore(),
): IssuedApiKey {
  const agent = owned(store, owner, agentId);
  const issued = issueApiKey(agent.id);
  store.insertApiKey(issued.record);
  store.recordActivity({
    agentId: agent.id,
    type: "key_created",
    payload: { keyId: issued.issued.id, prefix: issued.issued.prefix },
  });
  return issued.issued;
}

export function revokeAgentKey(
  owner: Address,
  agentId: string,
  keyId: string,
  store: AgentStore = agentStore(),
): void {
  const agent = owned(store, owner, agentId);
  const revoked = store.revokeApiKey(keyId, agent.id);
  if (revoked === null) throw new AgentError("AGENT_NOT_FOUND", "No such API key.");
  store.recordActivity({ agentId: agent.id, type: "key_revoked", payload: { keyId } });
}

export function regenerateAgentKey(
  owner: Address,
  agentId: string,
  store: AgentStore = agentStore(),
): IssuedApiKey {
  const agent = owned(store, owner, agentId);
  for (const key of store.listApiKeys(agent.id)) {
    if (key.revokedAt === null) store.revokeApiKey(key.id, agent.id);
  }
  return createAgentKey(owner, agentId, store);
}

export function owned(store: AgentStore, owner: Address, agentId: string): AgentRecord {
  const agent = store.getAgent(agentId);
  if (agent === null) throw new AgentError("AGENT_NOT_FOUND", "No such agent.");
  if (agent.ownerAddress.toLowerCase() !== owner.toLowerCase()) {
    throw new AgentError("FORBIDDEN", "That agent is not yours.");
  }
  return agent;
}

export function rejectAgentSelfModify(): never {
  assertCannotSelfModify();
}

export function rejectWalletOverride(body: Record<string, unknown>): void {
  if (body.creator !== undefined || body.wallet !== undefined || body.signer !== undefined) {
    assertCannotChooseWallet();
  }
}

export function rejectExternalTransfer(): never {
  assertNoExternalTransfer();
}

export async function agentInstantLaunch(
  store: AgentStore,
  agent: AgentRecord,
  keyId: string | null,
  body: Record<string, unknown>,
  send = sendApproved,
): Promise<Record<string, unknown>> {
  if (keyId !== null) assertRateLimit(store, keyId, "launch");
  assertMainnetSigning();
  assertAgentOperable(agent);
  rejectWalletOverride(body);

  const permissions = store.getPermissions(agent.id);
  assertLaunchTypeAllowed(permissions, "instant");

  const request = instantRequestOf(body);
  const draft = draftFromRequest(request, agent.walletAddress);
  const spendWei = spendWeiOf(draft, agent.walletAddress);
  assertCreatorBuy(permissions, spendWei);

  store.recordActivity({
    agentId: agent.id,
    type: "launch_requested",
    payload: { kind: "instant", name: request.name, symbol: request.symbol, spendWei: spendWei.toString() },
  });

  const reservation = store.reserveSpend({
    agentId: agent.id,
    kind: "instant",
    wei: spendWei,
    permissions,
  });

  const launchId = crypto.randomUUID();
  store.insertLaunch({
    id: launchId,
    agentId: agent.id,
    agentWallet: agent.walletAddress,
    kind: "instant",
    token: null,
    pool: null,
    txHash: null,
    jobId: null,
    name: request.name,
    symbol: request.symbol.trim().replace(/^\$/, "").toUpperCase(),
    spendWei,
    feeRecipient: agent.walletAddress,
    status: "requested",
    createdAt: Math.floor(Date.now() / 1000),
    error: null,
  });

  try {
    const result = await executeInstantLaunch(store, agent, request, send);
    store.finalizeReservation(reservation.id, "committed");
    store.updateLaunch(launchId, {
      token: result.token,
      pool: result.poolId,
      txHash: result.txHash,
      feeRecipient: result.feeRecipient,
      status: "succeeded",
      spendWei: result.spendWei,
    });
    store.recordActivity({
      agentId: agent.id,
      type: "launch_succeeded",
      payload: { kind: "instant", launchId, token: result.token, txHash: result.txHash },
    });
    store.recordActivity({
      agentId: agent.id,
      type: "treasury_spend",
      payload: { launchId, wei: result.spendWei.toString() },
    });
    void verifyInstantToken(result.token).catch(() => undefined);
    return {
      launchId,
      kind: "instant",
      token: result.token,
      pool: result.poolId,
      txHash: result.txHash,
      spendWei: result.spendWei.toString(),
    };
  } catch (error) {
    store.finalizeReservation(reservation.id, "released");
    const message = error instanceof Error ? error.message : String(error);
    store.updateLaunch(launchId, { status: "failed", error: message });
    store.recordActivity({
      agentId: agent.id,
      type: "launch_failed",
      payload: { kind: "instant", launchId, message },
    });
    throw error;
  }
}

function instantRequestOf(body: Record<string, unknown>): AgentInstantRequest {
  const name = typeof body.name === "string" ? body.name : "";
  const symbol = typeof body.symbol === "string" ? body.symbol : "";
  const imageUrl = typeof body.imageUrl === "string" ? body.imageUrl : "";
  if (name.trim() === "" || symbol.trim() === "" || imageUrl.trim() === "") {
    throw new AgentError("VALIDATION_FAILED", "An Instant launch needs a name, ticker and imageUrl.");
  }
  return {
    name,
    symbol,
    imageUrl,
    description: typeof body.description === "string" ? body.description : "",
    initialBuy: typeof body.initialBuy === "string" ? body.initialBuy : "",
    boostCapable: typeof body.boostCapable === "boolean" ? body.boostCapable : true,
    linkX: typeof body.linkX === "string" ? body.linkX : "",
    website: typeof body.website === "string" ? body.website : "",
    telegram: typeof body.telegram === "string" ? body.telegram : "",
  };
}

export async function agentStartBuild(
  store: AgentStore,
  agent: AgentRecord,
  keyId: string | null,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (keyId !== null) assertRateLimit(store, keyId, "launch");
  assertAgentOperable(agent);
  const permissions = store.getPermissions(agent.id);
  assertLaunchTypeAllowed(permissions, "programmable");
  parseBuildRequest(body);

  store.recordActivity({
    agentId: agent.id,
    type: "build_started",
    payload: { name: body.name, symbol: body.symbol },
  });

  const job = await startAgentBuild(store, agent, body);
  return job as unknown as Record<string, unknown>;
}

export async function agentLaunchBuild(
  store: AgentStore,
  agent: AgentRecord,
  keyId: string | null,
  jobId: string,
  body: Record<string, unknown>,
  send = sendApproved,
): Promise<Record<string, unknown>> {
  if (keyId !== null) assertRateLimit(store, keyId, "launch");
  assertMainnetSigning();
  assertAgentOperable(agent);
  rejectWalletOverride(body);

  const permissions = store.getPermissions(agent.id);
  assertLaunchTypeAllowed(permissions, "programmable");
  if (!AGENT_PROGRAMMABLE_LAUNCHABLE) {
    throw new AgentError("PROGRAMMABLE_HELD", AGENT_PROGRAMMABLE_HELD);
  }

  const initialBuy = typeof body.initialBuy === "string" ? body.initialBuy : "";
  let spendWei = 0n;
  if (initialBuy.trim() !== "") {
    try {
      spendWei = parseEther(initialBuy.trim());
    } catch {
      throw new AgentError("VALIDATION_FAILED", "The initial buy is not an amount.");
    }
  }
  assertCreatorBuy(permissions, spendWei);

  store.recordActivity({
    agentId: agent.id,
    type: "launch_requested",
    payload: { kind: "programmable", jobId, spendWei: spendWei.toString() },
  });

  const reservation = store.reserveSpend({
    agentId: agent.id,
    kind: "programmable",
    wei: spendWei,
    permissions,
  });

  const launchId = crypto.randomUUID();
  store.insertLaunch({
    id: launchId,
    agentId: agent.id,
    agentWallet: agent.walletAddress,
    kind: "programmable",
    token: null,
    pool: null,
    txHash: null,
    jobId,
    name: null,
    symbol: null,
    spendWei,
    feeRecipient: agent.walletAddress,
    status: "requested",
    createdAt: Math.floor(Date.now() / 1000),
    error: null,
  });

  try {
    const result = await launchAgentBuild(store, agent, jobId, initialBuy, send);
    store.finalizeReservation(reservation.id, "committed");
    store.updateLaunch(launchId, {
      token: result.token,
      txHash: result.txHash,
      status: "succeeded",
      spendWei: result.spendWei,
    });
    store.recordActivity({
      agentId: agent.id,
      type: "launch_succeeded",
      payload: { kind: "programmable", launchId, token: result.token, txHash: result.txHash, jobId },
    });
    return {
      launchId,
      kind: "programmable",
      token: result.token,
      hook: result.hook,
      txHash: result.txHash,
      buyTxHash: result.buyTxHash,
      spendWei: result.spendWei.toString(),
      jobId,
    };
  } catch (error) {
    store.finalizeReservation(reservation.id, "released");
    const message = error instanceof Error ? error.message : String(error);
    store.updateLaunch(launchId, { status: "failed", error: message });
    store.recordActivity({
      agentId: agent.id,
      type: error instanceof AgentError && error.code.startsWith("PERMISSION")
        ? "permission_rejected"
        : "launch_failed",
      payload: { kind: "programmable", launchId, jobId, message },
    });
    throw error;
  }
}

export { readAgentBuild, answerAgentBuild, readTreasury };

export async function agentRevenue(
  store: AgentStore,
  agent: AgentRecord,
): Promise<{
  readonly lifetimeWei: string;
  readonly claimedWei: string;
  readonly claimableWei: string;
  readonly markets: readonly {
    readonly token: Address;
    readonly lifetimeWei: string;
    readonly claimedWei: string;
    readonly claimableWei: string;
  }[];
}> {
  const launches = store.listLaunches(agent.id).filter((row) => row.status === "succeeded" && row.token !== null);
  const client = publicClient();
  const storedRows = store.listRevenue(agent.id);
  const markets: {
    readonly token: Address;
    readonly lifetimeWei: string;
    readonly claimedWei: string;
    readonly claimableWei: string;
  }[] = [];

  let lifetime = 0n;
  let claimable = 0n;
  let claimed = 0n;

  for (const launch of launches) {
    const token = launch.token!;
    const stored = storedRows.find((row) => row.token.toLowerCase() === token.toLowerCase());
    let rowClaimable = stored?.claimableWei ?? 0n;
    const rowClaimed = stored?.claimedWei ?? 0n;

    if (launch.kind === "instant") {
      try {
        const market = await readInstantMarket(token);
        if (market !== null) {
          const outstanding = await instantFees.readInstantOutstanding(client, { vault: market.vault });
          rowClaimable = outstanding.creator;
        }
      } catch {
        // A vault that cannot be read is reported from our store rather than failing the page.
      }
    }

    const rowLifetime = rowClaimable + rowClaimed;
    store.upsertRevenue({ agentId: agent.id, token, lifetimeWei: rowLifetime, claimedWei: rowClaimed });

    lifetime += rowLifetime;
    claimable += rowClaimable;
    claimed += rowClaimed;
    markets.push({
      token,
      lifetimeWei: rowLifetime.toString(),
      claimedWei: rowClaimed.toString(),
      claimableWei: rowClaimable.toString(),
    });
  }

  return {
    lifetimeWei: lifetime.toString(),
    claimedWei: claimed.toString(),
    claimableWei: claimable.toString(),
    markets,
  };
}

export async function claimAgentRevenue(
  store: AgentStore,
  actor: { readonly agent: AgentRecord; readonly asOwner: boolean },
  token: string,
): Promise<Record<string, unknown>> {
  const agent = actor.agent;
  const permissions = store.getPermissions(agent.id);
  if (!actor.asOwner && !permissions.canClaimCreatorFees) {
    throw new AgentError(
      "PERMISSION_CLAIM_DISABLED",
      "This agent is not allowed to claim creator fees.",
      { permission: "canClaimCreatorFees" },
    );
  }

  if (!isAddress(token, { strict: false })) {
    throw new AgentError("VALIDATION_FAILED", "That is not a token address.");
  }
  const checksummed = getAddress(token);
  const launch = store.launchByToken(checksummed);
  if (launch === null || launch.agentId !== agent.id) {
    throw new AgentError("FORBIDDEN", "This agent did not launch that market.");
  }

  if (launch.kind !== "instant") {
    throw new AgentError(
      "VALIDATION_FAILED",
      "Programmable fee claims stay on the existing profile claims flow for Phase 1.",
    );
  }

  const market = await readInstantMarket(checksummed);
  if (market === null) {
    throw new AgentError("LAUNCH_NOT_FOUND", "That Instant market is not on this chain yet.");
  }

  const sent = await sendProvenInstantClaim(store, agent.id, checksummed);
  store.addClaimed(agent.id, checksummed, 0n);
  store.recordActivity({
    agentId: agent.id,
    type: "creator_fee_claim",
    payload: { token: checksummed, txHash: sent.hash },
  });
  return { token: checksummed, txHash: sent.hash };
}

export function publicAgentView(
  agent: AgentRecord,
  extras: {
    readonly permissions?: AgentPermissions;
    readonly launches?: number;
    readonly volume?: string;
    readonly revenueWei?: string;
    readonly treasuryEth?: string;
  } = {},
): Record<string, unknown> {
  return {
    id: agent.id,
    username: agent.username,
    name: agent.name,
    description: agent.description,
    imageUrl: agent.imageUrl,
    walletAddress: agent.walletAddress,
    status: agent.status,
    createdAt: agent.createdAt,
    label: "Autonomous Agent",
    url: `/agents/${agent.username}`,
    launches: extras.launches ?? 0,
    volume: extras.volume ?? "0",
    creatorRevenueWei: extras.revenueWei ?? "0",
    treasuryEth: extras.treasuryEth ?? null,
    ...(extras.permissions === undefined ? {} : { permissions: publicPermissions(extras.permissions) }),
  };
}
