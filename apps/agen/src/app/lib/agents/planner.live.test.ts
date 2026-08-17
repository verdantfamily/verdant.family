/**
 * The planner against a real vendor.
 *
 * Every other planner test supplies the model's answer, which proves the wiring but
 * not the part that actually involves a third party: that a live model, given these
 * instructions and this structured-output schema, returns something `decision.ts`
 * accepts. A schema the vendor quietly rejects, or a field returned in a shape the
 * validator refuses, would pass the entire suite and fail on the first real cycle.
 *
 * Skipped unless `AGENT_LIVE_MODEL=1`, because it costs money and needs a network.
 * It signs nothing and touches no chain — the planner has no wallet by construction
 * — so it is safe to run at any time against any environment.
 *
 *   AGENT_LIVE_MODEL=1 OPENAI_API_KEY=... pnpm vitest run src/app/lib/agents/planner.live.test.ts
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Address } from "viem";
import { describe, expect, it } from "vitest";

import { setAgentAutonomy, setAgentMandate } from "./autonomy";
import { DECISION_KINDS } from "./types";
import { validateDecision } from "./decision";
import { defaultPlanner } from "./planner";
import { createAgent } from "./service";
import { AgentStore } from "./store";
import { DEFAULT_PERMISSIONS, DEFAULT_POLICY } from "./types";

const LIVE = process.env["AGENT_LIVE_MODEL"] === "1";
const OWNER = "0x1f23c28F93aE48E6346DD05Ca66ba5e2213b00b8" as Address;

const MANDATE =
  "Create at most one market a week, about something people are already arguing about " +
  "online. Never create two markets about the same thing.";

describe.skipIf(!LIVE)("the planner against a real model", () => {
  it("returns a decision the validator accepts", async () => {
    const store = new AgentStore(join(mkdtempSync(join(tmpdir(), "agen-live-")), "agents.db"));
    const agent = createAgent(
      OWNER,
      {
        name: "Atlas",
        username: "atlas",
        description: "An autonomous agent that creates markets.",
        imageUrl: "https://agen.space/api/images/atlas.png",
        permissions: { ...DEFAULT_PERMISSIONS },
      },
      store,
    ).agent;
    setAgentMandate(OWNER, agent.id, MANDATE, store);
    setAgentAutonomy(OWNER, agent.id, { mode: "autonomous", enabled: true }, store);

    const planner = defaultPlanner();
    expect(planner.name).not.toBe("null");

    const policy = { ...DEFAULT_POLICY, agentId: agent.id, updatedAt: 0 };
    const spendableWei = 5_000_000_000_000_000n; // 0.005 ETH: a small agent's budget.
    const context = {
      store,
      agent,
      mandate: store.getMandate(agent.id)!,
      permissions: DEFAULT_PERMISSIONS,
      policy,
      spendableWei,
      launchesRemaining: 1,
    };

    const started = Date.now();
    const result = await planner.plan(context);

    console.log(`model ${result.model} in ${String(Date.now() - started)}ms`);
    console.log("raw:", JSON.stringify(result.raw, null, 2));

    // The vendor's structured output is only a proposal. This is the code that
    // decides whether it means anything, and it is the call a real cycle makes.
    const decision = validateDecision(result.raw, { ...context });
    console.log(
      "validated:",
      JSON.stringify(decision, (_key, value: unknown) => (typeof value === "bigint" ? `${value.toString()} wei` : value), 2),
    );

    expect(DECISION_KINDS).toContain(decision.kind);
    expect(decision.rationale.length).toBeGreaterThan(0);
    expect(store.modelUsage(agent.id).calls).toBe(1);

    store.close();
  }, 180_000);
});
