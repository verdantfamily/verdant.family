import { agentStore } from "../../lib/agents/store";
import { authenticateAgent, authenticateOwner } from "../../lib/agents/auth";
import { assertRateLimit } from "../../lib/agents/rate-limit";
import { AgentError } from "../../lib/agents/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function store() {
  return agentStore();
}

export function owner(request: Request) {
  return { store: store(), address: authenticateOwner(request) };
}

export function agent(request: Request, kind: "read" | "launch" = "read") {
  const db = store();
  const auth = authenticateAgent(db, request);
  try {
    assertRateLimit(db, auth.key.id, kind);
  } catch (error) {
    db.recordUsage({
      agentId: auth.agent.id,
      keyId: auth.key.id,
      method: request.method,
      path: new URL(request.url).pathname,
      status: error instanceof AgentError ? error.status : 429,
      code: error instanceof AgentError ? error.code : "RATE_LIMITED",
    });
    throw error;
  }
  return { store: db, ...auth };
}

export function logAgent(
  request: Request,
  agentId: string,
  keyId: string | null,
  status: number,
  code: string | null,
): void {
  store().recordUsage({
    agentId,
    keyId,
    method: request.method,
    path: new URL(request.url).pathname,
    status,
    code,
  });
}
