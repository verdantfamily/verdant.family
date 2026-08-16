/**
 * Agent API credentials.
 *
 * A key is shown in full once, stored as a hash, and belongs to exactly one agent.
 * The secret never appears in activity logs, responses after issuance, or the
 * database. Regeneration is create-then-revoke of the previous live key, so an
 * operator can rotate without a window where two keys both work unless they ask.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import type { AgentApiKeyRecord, IssuedApiKey } from "./types";

const PREFIX = "agn_";

export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

export function issueApiKey(agentId: string): {
  readonly record: AgentApiKeyRecord;
  readonly issued: IssuedApiKey;
} {
  const raw = randomBytes(32).toString("base64url");
  const secret = `${PREFIX}${raw}`;
  const id = randomBytes(16).toString("hex");
  const now = Math.floor(Date.now() / 1000);
  const prefix = secret.slice(0, 12);

  return {
    record: {
      id,
      agentId,
      prefix,
      hash: hashSecret(secret),
      createdAt: now,
      revokedAt: null,
      lastUsedAt: null,
    },
    issued: { id, prefix, secret, createdAt: now },
  };
}

export function lookLikeApiKey(value: string): boolean {
  return value.startsWith(PREFIX) && value.length >= 20;
}

export function hashesEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "hex");
  const b = Buffer.from(right, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
