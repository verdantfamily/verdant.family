/**
 * Two doors, neither of which is a private key.
 *
 * The owner proves control of a wallet with a one-time signed challenge and receives
 * a short-lived session. An external agent proves itself with an API key. Neither
 * path ever returns a treasury key.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { getAddress, isAddress, verifyMessage, type Address, type Hex } from "viem";

import { AgentError } from "./errors";
import { lookLikeApiKey } from "./keys";
import { masterKeyBytes } from "./wallets";
import type { AgentApiKeyRecord, AgentRecord } from "./types";
import type { AgentStore } from "./store";

const SESSION_TTL_SECONDS = 60 * 60 * 12;
const CHALLENGE_TTL_SECONDS = 5 * 60;

function sessionSecret(): Buffer {
  const override = process.env["AGENT_SESSION_SECRET"]?.trim();
  if (override !== undefined && override !== "" && /^[0-9a-fA-F]{64}$/.test(override)) {
    return Buffer.from(override, "hex");
  }
  return createHmac("sha256", masterKeyBytes()).update("agen.agent.session.v1").digest();
}

export function ownerChallengeMessage(address: Address, nonce: string, expiresAt: number): string {
  return [
    "agen.space wants you to manage agents",
    "",
    `Address: ${address}`,
    `Nonce: ${nonce}`,
    `Expires: ${String(expiresAt)}`,
  ].join("\n");
}

export function issueChallenge(store: AgentStore, address: string): {
  readonly address: Address;
  readonly nonce: string;
  readonly expiresAt: number;
  readonly message: string;
} {
  if (!isAddress(address, { strict: false })) {
    throw new AgentError("VALIDATION_FAILED", "That is not an address.");
  }
  const checksummed = getAddress(address);
  const nonce = randomBytes(16).toString("hex");
  const expiresAt = Math.floor(Date.now() / 1000) + CHALLENGE_TTL_SECONDS;
  store.putChallenge(nonce, checksummed, expiresAt);
  return {
    address: checksummed,
    nonce,
    expiresAt,
    message: ownerChallengeMessage(checksummed, nonce, expiresAt),
  };
}

export async function redeemChallenge(
  store: AgentStore,
  input: { readonly address: string; readonly nonce: string; readonly signature: string },
): Promise<{ readonly token: string; readonly address: Address; readonly expiresAt: number }> {
  if (!isAddress(input.address, { strict: false })) {
    throw new AgentError("VALIDATION_FAILED", "That is not an address.");
  }
  const address = getAddress(input.address);
  const challenge = store.takeChallenge(input.nonce);
  if (challenge === null) {
    throw new AgentError("UNAUTHENTICATED", "That challenge is unknown or has already been used.");
  }
  if (challenge.address.toLowerCase() !== address.toLowerCase()) {
    throw new AgentError("UNAUTHENTICATED", "That challenge was issued for a different address.");
  }
  if (challenge.expiresAt < Math.floor(Date.now() / 1000)) {
    throw new AgentError("UNAUTHENTICATED", "That challenge has expired.");
  }

  const message = ownerChallengeMessage(address, input.nonce, challenge.expiresAt);
  const ok = await verifyMessage({
    address,
    message,
    signature: input.signature as Hex,
  }).catch(() => false);

  if (!ok) throw new AgentError("UNAUTHENTICATED", "That signature does not match the challenge.");

  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  return { token: encodeSession(address, expiresAt), address, expiresAt };
}

export function encodeSession(address: Address, expiresAt: number): string {
  const payload = Buffer.from(JSON.stringify({ address, exp: expiresAt })).toString("base64url");
  const sig = createHmac("sha256", sessionSecret()).update(payload).digest("base64url");
  return `ags_${payload}.${sig}`;
}

export function readSession(token: string): Address {
  if (!token.startsWith("ags_")) {
    throw new AgentError("UNAUTHENTICATED", "That is not an owner session.");
  }
  const body = token.slice(4);
  const dot = body.lastIndexOf(".");
  if (dot < 0) throw new AgentError("UNAUTHENTICATED", "That session is malformed.");

  const payload = body.slice(0, dot);
  const sig = body.slice(dot + 1);
  const expected = createHmac("sha256", sessionSecret()).update(payload).digest("base64url");
  const left = Buffer.from(sig);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) {
    throw new AgentError("UNAUTHENTICATED", "That session is not valid.");
  }

  let parsed: { address?: string; exp?: number };
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      address?: string;
      exp?: number;
    };
  } catch {
    throw new AgentError("UNAUTHENTICATED", "That session is malformed.");
  }

  if (typeof parsed.exp !== "number" || parsed.exp < Math.floor(Date.now() / 1000)) {
    throw new AgentError("UNAUTHENTICATED", "That session has expired.");
  }
  if (typeof parsed.address !== "string" || !isAddress(parsed.address, { strict: false })) {
    throw new AgentError("UNAUTHENTICATED", "That session is malformed.");
  }

  return getAddress(parsed.address);
}

export function bearerOf(request: Request): string | null {
  const header = request.headers.get("authorization") ?? request.headers.get("Authorization");
  if (header === null) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() ?? null;
}

export function authenticateOwner(request: Request): Address {
  const token = bearerOf(request);
  if (token === null) throw new AgentError("UNAUTHENTICATED", "Connect a wallet and create a session.");
  return readSession(token);
}

export function authenticateAgent(
  store: AgentStore,
  request: Request,
): { readonly agent: AgentRecord; readonly key: AgentApiKeyRecord } {
  const token = bearerOf(request);
  if (token === null || !lookLikeApiKey(token)) {
    throw new AgentError("INVALID_API_KEY", "Provide an agent API key as a Bearer token.");
  }

  const key = store.findApiKeyBySecret(token);
  if (key === null) throw new AgentError("INVALID_API_KEY", "That API key is not recognised.");
  if (key.revokedAt !== null) {
    throw new AgentError("REVOKED_API_KEY", "That API key has been revoked.");
  }

  const agent = store.getAgent(key.agentId);
  if (agent === null) throw new AgentError("AGENT_NOT_FOUND", "That API key does not belong to an agent.");

  store.touchApiKey(key.id);
  return { agent, key };
}
