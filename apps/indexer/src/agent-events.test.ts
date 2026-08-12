import { abi } from "@verdant/sdk";
import { describe, expect, it } from "vitest";

import {
  AGENT_EVENTS,
  LEG_ALLOCATED_COLUMN,
  LEG_SETTLED_COLUMN,
  isSkipped,
  type AgentEventName,
} from "./agent-events.ts";
import { AgentActivityType } from "../ponder.schema.ts";


/**
 * That no agent event goes unindexed, and that none is indexed twice.
 *
 * The failure this exists for is silence. An event with no handler produces no error,
 * no log and no row — the indexer runs, reports healthy, and an agent's feed is missing
 * something that happened. Nothing inside the running system can notice.
 *
 * So the emitted ABIs are the authority and `AGENT_EVENTS` is held to them in both
 * directions: an event the contracts have and this indexer does not is a gap, and an
 * entry for an event the contracts no longer have is a stale decision. Either fails
 * here, at typecheck time rather than in production.
 */

/** The seven agent contracts, under the names Ponder knows them by. */
const CONTRACTS = {
  AgentLaunchFactory: abi.agentLaunchFactoryAbi,
  AgentIdentityRegistry: abi.agentIdentityRegistryAbi,
  AgentServiceRegistry: abi.agentServiceRegistryAbi,
  AgentMandate: abi.agentMandateAbi,
  AgentTreasury: abi.agentTreasuryAbi,
  AgentExecutionModule: abi.agentExecutionModuleAbi,
  AgentRevenueRouter: abi.agentRevenueRouterAbi,
} as const;

/** Every `contract:event` the seven ABIs declare. */
function eventsInAbis(): readonly string[] {
  const names: string[] = [];

  for (const [contract, contractAbi] of Object.entries(CONTRACTS)) {
    for (const entry of contractAbi) {
      if ((entry as { type?: string }).type !== "event") continue;
      names.push(`${contract}:${(entry as { name: string }).name}`);
    }
  }

  return names.sort();
}

describe("the agent event set", () => {
  it("covers every event the seven contracts declare", () => {
    const declared = eventsInAbis();
    const covered = Object.keys(AGENT_EVENTS).sort();

    // Reported as a set difference rather than a length comparison, so a failure names
    // the event rather than saying a number changed.
    const missing = declared.filter((name) => !covered.includes(name));

    expect(
      missing,
      "these agent events have no entry in AGENT_EVENTS, so nothing indexes them and " +
        "nothing reports that nothing does",
    ).toEqual([]);
  });

  it("has no entry for an event the contracts no longer declare", () => {
    const declared = eventsInAbis();
    const stale = Object.keys(AGENT_EVENTS).filter((name) => !declared.includes(name));

    expect(
      stale,
      "these entries name events that are not in any agent ABI, so they are decisions " +
        "about contracts that have changed",
    ).toEqual([]);
  });

  it("finds all seven contracts in the SDK's emitted ABIs", () => {
    // If an ABI were missing from the SDK's generation, `eventsInAbis` would quietly
    // return a shorter list and the coverage check above would pass on it.
    for (const [contract, contractAbi] of Object.entries(CONTRACTS)) {
      expect(contractAbi, contract).toBeDefined();
      expect(
        contractAbi.some((entry) => (entry as { type?: string }).type === "event"),
        `${contract} has no events at all, which means its ABI was not emitted`,
      ).toBe(true);
    }
  });

  it("indexes nineteen events, skipping exactly one, with a reason", () => {
    const entries = Object.entries(AGENT_EVENTS) as [
      AgentEventName,
      (typeof AGENT_EVENTS)[AgentEventName],
    ][];

    const skipped = entries.filter(([, entry]) => isSkipped(entry));

    // `AgentRegistered` is the one, because it duplicates `AgentLaunched` inside the
    // same transaction. A second skip appearing here is a decision worth reviewing
    // rather than one to wave through.
    expect(skipped.map(([name]) => name)).toEqual([
      "AgentIdentityRegistry:AgentRegistered",
    ]);

    for (const [name, entry] of skipped) {
      expect(
        isSkipped(entry) && entry.skip.length > 10,
        `${name} is skipped without a reason worth reading`,
      ).toBe(true);
    }
  });

  it("gives each indexed event its own activity type", () => {
    // Two events sharing a type would merge two different things in the feed, and the
    // frontend would have no way to tell them apart from the type alone.
    const types = Object.values(AGENT_EVENTS).filter(
      (entry): entry is AgentActivityType => !isSkipped(entry),
    );

    expect(new Set(types).size).toBe(types.length);
  });

  it("uses only types the schema declares", () => {
    const declared = new Set<string>(Object.values(AgentActivityType));

    for (const [name, entry] of Object.entries(AGENT_EVENTS)) {
      if (isSkipped(entry)) continue;
      expect(declared.has(entry), `${name} produces a type the schema does not declare`).toBe(
        true,
      );
    }
  });

  it("declares no activity type that nothing produces", () => {
    const produced = new Set(
      Object.values(AGENT_EVENTS).filter((entry) => !isSkipped(entry)),
    );

    const orphans = Object.values(AgentActivityType).filter(
      (type) => !produced.has(type),
    );

    // A type in the schema that no event produces is a case the frontend will write a
    // renderer for and never see.
    expect(orphans).toEqual([]);
  });

  it("uses machine constants rather than phrases", () => {
    // The indexer must not decide the wording: storing "Agent paused" would fix the
    // language, the tense and the capitalisation for every consumer forever, and
    // changing any of it would need a resync.
    for (const type of Object.values(AgentActivityType)) {
      expect(type, `${type} is not an upper snake-case constant`).toMatch(
        /^AGENT_[A-Z_]+$/,
      );
      expect(type).not.toContain(" ");
    }
  });
});

describe("the four revenue legs", () => {
  it("are in RevenueAllocationLib's order, on both column sets", () => {
    // The order is the contract's, and the index is what `Settled` reports. Getting it
    // wrong would credit the developer's payout to the protocol, in a way no total
    // would reveal — the sum across legs would still be right.
    expect(LEG_ALLOCATED_COLUMN).toEqual([
      "operationsAllocated",
      "buybacksAllocated",
      "developerAllocated",
      "protocolAllocated",
    ]);

    expect(LEG_SETTLED_COLUMN).toEqual([
      "operationsSettled",
      "buybacksSettled",
      "developerSettled",
      "protocolSettled",
    ]);
  });

  it("are four, and pair up index for index", () => {
    expect(LEG_ALLOCATED_COLUMN).toHaveLength(4);
    expect(LEG_SETTLED_COLUMN).toHaveLength(4);

    for (let leg = 0; leg < 4; leg++) {
      const allocated = LEG_ALLOCATED_COLUMN[leg] as string;
      const settled = LEG_SETTLED_COLUMN[leg] as string;

      expect(
        allocated.replace("Allocated", ""),
        `leg ${leg} names different things in the two lists`,
      ).toBe(settled.replace("Settled", ""));
    }
  });
});
