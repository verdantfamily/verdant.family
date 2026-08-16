/**
 * Per-key rate limits.
 *
 * An agent is an untrusted client. The daily ETH budget is the expensive limit;
 * this one exists so a tight retry loop cannot drown the process before a launch
 * is even reserved. Counts are persisted so a restart does not reset a flood.
 */

import { AgentError } from "./errors";
import type { AgentStore } from "./store";

export const RATE_LIMIT = {
  windowSeconds: 60,
  maxRequests: 60,
  maxLaunchRequests: 10,
} as const;

export function assertRateLimit(store: AgentStore, keyId: string, kind: "read" | "launch"): void {
  const used = store.recentUsageCount(keyId, RATE_LIMIT.windowSeconds);
  const max = kind === "launch" ? RATE_LIMIT.maxLaunchRequests : RATE_LIMIT.maxRequests;
  if (used >= max) {
    throw new AgentError(
      "RATE_LIMITED",
      `This API key is limited to ${String(max)} ${kind} requests per minute.`,
      { details: { windowSeconds: RATE_LIMIT.windowSeconds, limit: max } },
    );
  }
}
