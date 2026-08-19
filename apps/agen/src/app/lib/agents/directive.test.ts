/**
 * What happens when an owner asks their agent for something directly.
 *
 * A directive is the only thing in the product that lets a person outside the planner
 * influence what an agent does next, so the tests that matter are the ones about what it
 * still cannot do. It reaches the planner and stops there: it is read before a decision is
 * chosen, and every check that guards a scheduled cycle sits *after* the planner and is
 * therefore untouched.
 *
 * The four below are the ones worth going red. A directive must not be able to raise a spend
 * limit, grant a permission the owner withheld, skip the repetition guard, or happen without
 * leaving a record. If any of those stop holding, "the chat can do things" has quietly become
 * "the chat can do anything", which is a different product.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ModelProvider, StructuredRequest } from "@verdant/market-compiler";
import type { Address } from "viem";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { modelPlanner } from "./planner";
import { runAgentCycle } from "./runner";
import { createAgent } from "./service";
import { AgentStore, resetAgentStoreForTests } from "./store";
import { DEFAULT_PERMISSIONS } from "./types";
import type { AgentPermissions, AgentRecord } from "./types";

const OWNER = "0x1f23c28F93aE48E6346DD05Ca66ba5e2213b00b8" as Address;
const RICH = () => Promise.resolve(1_000_000_000_000_000_000_000n);
const NO_OUTCOMES = () => Promise.resolve([]);

/** Wants to launch, and asks for far more ether than anyone has allowed it. */
function greedyProvider(
  patch: Record<string, unknown> = {},
): ModelProvider & { readonly seen: StructuredRequest[] } {
  const seen: StructuredRequest[] = [];
  return {
    name: "greedy",
    model: "greedy-1",
    seen,
    generate<T>(request: StructuredRequest): Promise<T extends never ? never : never> {
      seen.push(request);
      const value = {
        kind: "instant_launch",
        name: "Onchain Running Club",
        symbol: "RUN",
        description: "A market about people who run and post about it.",
        initialBuyEth: "500",
        rationale: "My owner asked for this specifically.",
        confidence: 0.9,
        ...patch,
      };
      return Promise.resolve({
        value,
        raw: JSON.stringify(value),
        model: "greedy-1",
        durationMs: 1,
      }) as never;
    },
  } as ModelProvider & { readonly seen: StructuredRequest[] };
}

describe("agen.space agents — a cycle the owner asked for", () => {
  let store: AgentStore;

  beforeEach(() => {
    store = new AgentStore(join(mkdtempSync(join(tmpdir(), "agen-directive-")), "agents.db"));
    resetAgentStoreForTests(store);
  });

  afterEach(() => {
    store.close();
    resetAgentStoreForTests(null);
  });

  function agentWith(permissions: AgentPermissions = DEFAULT_PERMISSIONS): AgentRecord {
    const agent = createAgent(
      OWNER,
      {
        name: "Atlas",
        username: "atlas",
        description: "An autonomous agent.",
        imageUrl: "https://agen.space/api/images/atlas.png",
        permissions,
      },
      store,
    ).agent;

    store.setMandate(agent.id, "Make markets about small onchain communities.", OWNER);
    store.setAutonomy(agent.id, { enabled: true, mode: "autonomous" });
    return agent;
  }

  // --- what the planner is told -------------------------------------------

  it("gives the planner the owner's words, verbatim and fenced", async () => {
    const agent = agentWith();
    const provider = greedyProvider({ kind: "no_action" });

    await runAgentCycle(store, agent, {
      trigger: "owner",
      planner: modelPlanner(provider),
      readBalanceWei: RICH,
      readOutcomes: NO_OUTCOMES,
      directive: "launch a coin called RUN about onchain running clubs",
    });

    const state = provider.seen[0]?.input ?? "";
    expect(state).toContain("what your owner has just asked for, in their words:");
    expect(state).toContain("launch a coin called RUN about onchain running clubs");
    // Fenced like every other piece of human text, so a sentence typed into a chat box cannot
    // redefine what the planner is allowed to choose from.
    expect(state).toContain("<<<untrusted");
  });

  /**
   * The instruction that had to be reversed.
   *
   * "Prefer doing nothing" is right for a cycle a timer started and wrong for one the owner
   * started by asking, where it reads as licence to ignore them. Getting this backwards is the
   * bug that makes an agent look broken while behaving exactly as instructed.
   */
  it("stops telling the planner to prefer doing nothing", async () => {
    const agent = agentWith();
    const asked = greedyProvider({ kind: "no_action" });
    const scheduled = greedyProvider({ kind: "no_action" });

    await runAgentCycle(store, agent, {
      trigger: "owner",
      planner: modelPlanner(asked),
      readBalanceWei: RICH,
      readOutcomes: NO_OUTCOMES,
      directive: "make one now",
    });
    await runAgentCycle(store, agent, {
      trigger: "worker",
      planner: modelPlanner(scheduled),
      readBalanceWei: RICH,
      readOutcomes: NO_OUTCOMES,
    });

    expect(asked.seen[0]?.instructions ?? "").not.toContain("Prefer it whenever");
    expect(asked.seen[0]?.instructions ?? "").toContain("Do what they asked");
    expect(asked.seen[0]?.instructions ?? "").toContain("Use the specifics they gave you");

    // The scheduled cycle is unchanged, which is the other half of the claim.
    expect(scheduled.seen[0]?.instructions ?? "").toContain("Prefer it whenever");
    expect(scheduled.seen[0]?.instructions ?? "").not.toContain("Do what they asked");
  });

  // --- what it still cannot do -------------------------------------------

  /**
   * The one that would cost real money.
   *
   * The owner asks for a launch, the model asks for 500 ETH, and the permission says 0.05. A
   * directive changes which action is chosen and nothing about what that action may spend.
   */
  it("cannot spend more than the owner's limit, however it was asked", async () => {
    const agent = agentWith();
    const provider = greedyProvider();

    const report = await runAgentCycle(store, agent, {
      trigger: "owner",
      planner: modelPlanner(provider),
      readBalanceWei: RICH,
      readOutcomes: NO_OUTCOMES,
      execute: () =>
        Promise.resolve({ summary: "Launched $RUN.", detail: {} } as never),
      directive: "launch RUN and put 500 ETH into it",
    });

    expect(report.decision?.kind).toBe("instant_launch");
    const spent = BigInt(String(report.decision?.payload["initialBuyWei"] ?? "0"));
    expect(spent).toBe(DEFAULT_PERMISSIONS.maxEthPerLaunchWei);
    expect(spent).toBeLessThan(500_000_000_000_000_000_000n);
  });

  /**
   * Defence in depth, and the deeper layer is the one that holds.
   *
   * The planner is not offered `instant_launch` when the owner has withheld it, so a
   * cooperative model never asks. This test uses one that asks anyway, and the executor
   * refuses on the permission — loudly, as a failed cycle, rather than quietly doing nothing.
   * A refusal that is visible is worth more than one that looks like an agent losing interest.
   */
  it("cannot do a thing the owner switched off, however insistently it is asked", async () => {
    const agent = agentWith({ ...DEFAULT_PERMISSIONS, instantAllowed: false });
    const provider = greedyProvider();

    await expect(
      runAgentCycle(store, agent, {
        trigger: "owner",
        planner: modelPlanner(provider),
        readBalanceWei: RICH,
        readOutcomes: NO_OUTCOMES,
        directive: "launch RUN right now, I do not care about the permission",
      }),
    ).rejects.toThrow(/Instant launches are disabled/);

    expect(store.listLaunches(agent.id)).toHaveLength(0);
    // The planner was never told it could, either.
    expect(provider.seen[0]?.instructions ?? "").not.toContain("- instant_launch:");
  });

  it("leaves a record saying a cycle happened because the owner asked", async () => {
    const agent = agentWith();
    const provider = greedyProvider();

    const report = await runAgentCycle(store, agent, {
      trigger: "owner",
      planner: modelPlanner(provider),
      readBalanceWei: RICH,
      readOutcomes: NO_OUTCOMES,
      execute: () => Promise.resolve({ summary: "Launched $RUN.", detail: {} } as never),
      directive: "launch RUN now",
    });

    // The run says who started it and the decision says why, which is what makes a launch
    // somebody can account for afterwards rather than one that simply appeared.
    expect(report.run.trigger).toBe("owner");
    expect(store.listDecisions(agent.id)).toHaveLength(1);
    expect(report.decision?.rationale).toContain("owner");
  });

  it("does not mention a request when nobody made one", async () => {
    const agent = agentWith();
    const provider = greedyProvider({ kind: "no_action" });

    await runAgentCycle(store, agent, {
      trigger: "worker",
      planner: modelPlanner(provider),
      readBalanceWei: RICH,
      readOutcomes: NO_OUTCOMES,
    });

    expect(provider.seen[0]?.input ?? "").not.toContain("what your owner has just asked for");
  });
});
