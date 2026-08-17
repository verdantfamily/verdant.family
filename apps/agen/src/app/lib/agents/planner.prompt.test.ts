/**
 * What the model is told before it decides.
 *
 * The first agent to launch on mainnet described its market as "resolves YES if…",
 * which is a sentence about a prediction market and this is not one — the token had
 * no oracle, no settlement and no end, and the description could never be edited
 * because a market's metadata is fixed at creation. The model was not wrong so much
 * as uninformed: nothing in the prompt said what the thing it was creating actually
 * was.
 *
 * So these assert the prompt's content, which is unusual and deliberate. Prompt text
 * is normally too soft to test, but here a missing paragraph does not fail a build or
 * throw at runtime; it produces a permanent public page that misleads whoever reads
 * it. That deserves a test that goes red.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ModelProvider, StructuredRequest } from "@verdant/market-compiler";
import type { Address } from "viem";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { setAgentAutonomy, setAgentMandate } from "./autonomy";
import { modelPlanner } from "./planner";
import { runAgentCycle } from "./runner";
import { createAgent, updateAgentProfile } from "./service";
import { AgentStore, resetAgentStoreForTests } from "./store";
import { DEFAULT_PERMISSIONS } from "./types";
import type { AgentRecord } from "./types";

const OWNER = "0x1f23c28F93aE48E6346DD05Ca66ba5e2213b00b8" as Address;
const RICH = () => Promise.resolve(1_000_000_000_000_000_000n);

/** Answers no_action, and keeps the request it was asked. */
function capturingProvider(): ModelProvider & { readonly seen: StructuredRequest[] } {
  const seen: StructuredRequest[] = [];
  return {
    name: "capture",
    model: "capture-1",
    seen,
    generate<T>(request: StructuredRequest): Promise<T extends never ? never : never> {
      seen.push(request);
      const value = { kind: "no_action", rationale: "Nothing to do.", confidence: 0.5 };
      return Promise.resolve({
        value,
        raw: JSON.stringify(value),
        model: "capture-1",
        durationMs: 1,
      }) as never;
    },
  } as ModelProvider & { readonly seen: StructuredRequest[] };
}

describe("agen.space agents — what the planner tells the model", () => {
  let store: AgentStore;

  beforeEach(() => {
    store = new AgentStore(join(mkdtempSync(join(tmpdir(), "agen-prompt-")), "agents.db"));
    resetAgentStoreForTests(store);
  });

  afterEach(() => {
    store.close();
    resetAgentStoreForTests(null);
  });

  function armed(imageUrl: string | null): AgentRecord {
    const agent = createAgent(
      OWNER,
      {
        name: "Atlas",
        username: "atlas",
        description: "An autonomous agent.",
        ...(imageUrl === null ? {} : { imageUrl }),
        permissions: DEFAULT_PERMISSIONS,
      },
      store,
    ).agent;
    setAgentMandate(OWNER, agent.id, "Create one market about something people argue about.", store);
    setAgentAutonomy(OWNER, agent.id, { mode: "observe", enabled: true }, store);
    return store.getAgent(agent.id) ?? agent;
  }

  /** The prompt an armed agent's cycle actually sent. */
  async function instructions(imageUrl: string | null): Promise<string> {
    const provider = capturingProvider();
    const agent = armed(imageUrl);
    await runAgentCycle(store, agent, {
      trigger: "owner",
      planner: modelPlanner(provider),
      readBalanceWei: RICH,
    });
    expect(provider.seen).toHaveLength(1);
    return provider.seen[0]?.instructions ?? "";
  }

  it("says a market is a token with a pool, not a question that settles", async () => {
    const text = await instructions("https://agen.space/api/images/atlas.png");

    expect(text).toContain("tradable the moment it exists");
    expect(text).toMatch(/does not settle/);
    expect(text).toMatch(/resolve/);
  });

  it("forbids the resolution criteria that produced the first bad market", async () => {
    const text = await instructions("https://agen.space/api/images/atlas.png");

    expect(text).toContain("resolves YES if");
    expect(text).toMatch(/do not write resolution criteria/i);
  });

  it("warns that the description can never be edited afterwards", async () => {
    const text = await instructions("https://agen.space/api/images/atlas.png");

    expect(text).toMatch(/fixed at creation forever/);
  });

  it("does not describe launching at all to an agent that cannot launch", async () => {
    const text = await instructions(null);

    expect(text).not.toContain("tradable the moment it exists");
    expect(text).toContain("You cannot create markets right now");
    expect(text).toContain("no picture");
  });

  it("asks for a ticker somebody could say out loud", async () => {
    const provider = capturingProvider();
    const agent = armed("https://agen.space/api/images/atlas.png");
    await runAgentCycle(store, agent, {
      trigger: "owner",
      planner: modelPlanner(provider),
      readBalanceWei: RICH,
    });

    const schema = JSON.stringify(provider.seen[0]?.schema ?? {});
    expect(schema).toMatch(/reads like a mistake/);
  });

  it("reads the picture from the agent as it is now, not as it was created", async () => {
    const agent = armed(null);
    updateAgentProfile(
      OWNER,
      agent.id,
      { imageUrl: "https://agen.space/api/images/atlas.png" },
      store,
    );

    const provider = capturingProvider();
    await runAgentCycle(store, store.getAgent(agent.id) ?? agent, {
      trigger: "owner",
      planner: modelPlanner(provider),
      readBalanceWei: RICH,
    });
    expect(provider.seen[0]?.instructions ?? "").toContain("tradable the moment it exists");
  });
});
