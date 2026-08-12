import { describe, expect, it } from "vitest";

import vectors from "./vectors/lifecycle.json" with { type: "json" };
import {
  AGENT_STATES,
  AGENT_STATE_NAMES,
  AgentState,
  IllegalTransitionError,
  agentStateFromName,
  agentStateName,
  canTransition,
  isAgentState,
  isLive,
  isTerminal,
  mayConfigureServices,
  mayExecute,
  mayReceiveRevenue,
  maySettleFixedEntitlement,
  requireTransition,
  transitionsFrom,
} from "./lifecycle.js";

/**
 * Every ordered pair of states, against the matrix the contract enforces.
 *
 * `packages/contracts/test/agents/AgentLifecycle.t.sol` walks the same twenty-five
 * pairs against `AgentLifecycle.canTransition`. Both suites list the permitted
 * transitions independently — the expectation below is written out rather than
 * derived from `canTransition`, because a test that computes its expectation from
 * the code under test asserts nothing.
 */

/** The eight moves that exist, written out. Everything else must be refused. */
const PERMITTED: readonly (readonly [AgentState, AgentState])[] = [
  [AgentState.Created, AgentState.MarketBound],
  [AgentState.Created, AgentState.Revoked],
  [AgentState.MarketBound, AgentState.Active],
  [AgentState.MarketBound, AgentState.Revoked],
  [AgentState.Active, AgentState.Paused],
  [AgentState.Active, AgentState.Revoked],
  [AgentState.Paused, AgentState.Active],
  [AgentState.Paused, AgentState.Revoked],
];

function isPermitted(from: AgentState, to: AgentState): boolean {
  return PERMITTED.some(([a, b]) => a === from && b === to);
}

describe("the state set", () => {
  it("is the five the chain has, at the ordinals the chain uses", () => {
    // The numbering is part of the interface: events carry the ordinal, and the
    // indexer stores it. Renumbering would relabel every historical state change.
    expect(AgentState).toEqual({
      Created: 0,
      MarketBound: 1,
      Active: 2,
      Paused: 3,
      Revoked: 4,
    });

    expect(AGENT_STATES).toEqual([0, 1, 2, 3, 4]);
    expect(AGENT_STATE_NAMES).toHaveLength(5);
  });

  it("maps names and ordinals both ways", () => {
    for (const state of AGENT_STATES) {
      expect(agentStateFromName(agentStateName(state))).toBe(state);
    }

    expect(agentStateName(AgentState.MarketBound)).toBe("MarketBound");
  });

  it("recognises exactly the five, and refuses a sixth", () => {
    // A sixth ordinal means the chain is ahead of this file. Failing at the
    // boundary beats rendering "undefined" in a status pill.
    for (const state of AGENT_STATES) expect(isAgentState(state)).toBe(true);

    for (const notAState of [-1, 5, 1.5, Number.NaN]) {
      expect(isAgentState(notAState), `${notAState}`).toBe(false);
    }

    expect(() => agentStateName(5 as AgentState)).toThrow(RangeError);
  });
});

describe("canTransition", () => {
  it("answers every one of the twenty-five ordered pairs correctly", () => {
    let permitted = 0;

    for (const from of AGENT_STATES) {
      for (const to of AGENT_STATES) {
        const expected = isPermitted(from, to);
        expect(
          canTransition(from, to),
          `${agentStateName(from)} -> ${agentStateName(to)}`,
        ).toBe(expected);
        if (expected) permitted++;
      }
    }

    expect(permitted, "exactly eight transitions exist").toBe(8);
  });

  it("refuses every self-transition", () => {
    // Re-entering the state you are already in is never a real event. Permitting it
    // would let `pause` on a paused agent put a state change in the feed that did
    // not happen.
    for (const state of AGENT_STATES) {
      expect(canTransition(state, state), agentStateName(state)).toBe(false);
    }
  });

  it("makes revocation reachable from every live state and terminal once reached", () => {
    for (const from of [
      AgentState.Created,
      AgentState.MarketBound,
      AgentState.Active,
      AgentState.Paused,
    ]) {
      expect(canTransition(from, AgentState.Revoked), agentStateName(from)).toBe(
        true,
      );
    }

    for (const to of AGENT_STATES) {
      expect(
        canTransition(AgentState.Revoked, to),
        `Revoked -> ${agentStateName(to)}`,
      ).toBe(false);
    }
  });

  it("does not let binding be skipped", () => {
    // An agent cannot go straight to Active: activation requires a proved market.
    expect(canTransition(AgentState.Created, AgentState.Active)).toBe(false);
    expect(canTransition(AgentState.Created, AgentState.Paused)).toBe(false);
  });

  it("makes pausing reachable only from Active", () => {
    // In Created and MarketBound nothing can execute anyway, so a pause there would
    // be a state that means nothing and a resume whose destination is ambiguous.
    for (const from of AGENT_STATES) {
      expect(
        canTransition(from, AgentState.Paused),
        `${agentStateName(from)} -> Paused`,
      ).toBe(from === AgentState.Active);
    }
  });

  it("never moves backwards past a binding", () => {
    expect(canTransition(AgentState.MarketBound, AgentState.Created)).toBe(false);
    expect(canTransition(AgentState.Active, AgentState.MarketBound)).toBe(false);
    expect(canTransition(AgentState.Paused, AgentState.MarketBound)).toBe(false);
  });
});

describe("requireTransition", () => {
  it("passes silently for a permitted move", () => {
    expect(() =>
      requireTransition(AgentState.Active, AgentState.Paused),
    ).not.toThrow();
  });

  it("throws for every refused pair, naming both states", () => {
    for (const from of AGENT_STATES) {
      for (const to of AGENT_STATES) {
        if (isPermitted(from, to)) continue;

        try {
          requireTransition(from, to);
          expect.unreachable(
            `${agentStateName(from)} -> ${agentStateName(to)} did not throw`,
          );
        } catch (error) {
          expect(error).toBeInstanceOf(IllegalTransitionError);
          const illegal = error as IllegalTransitionError;
          expect(illegal.from).toBe(from);
          expect(illegal.to).toBe(to);
          expect(illegal.message).toContain(agentStateName(from));
          expect(illegal.message).toContain(agentStateName(to));
        }
      }
    }
  });
});

describe("transitionsFrom", () => {
  it("lists exactly what canTransition permits", () => {
    // Derived from the matrix rather than restated, so an interface offering a
    // button this does not return would be offering a move the chain refuses.
    for (const from of AGENT_STATES) {
      const expected = AGENT_STATES.filter((to) => isPermitted(from, to));
      expect(transitionsFrom(from), agentStateName(from)).toEqual(expected);
    }

    expect(transitionsFrom(AgentState.Revoked)).toEqual([]);
    expect(transitionsFrom(AgentState.Active)).toEqual([
      AgentState.Paused,
      AgentState.Revoked,
    ]);
  });
});

describe("what a state permits", () => {
  it("lets only an Active agent execute a discretionary action", () => {
    for (const state of AGENT_STATES) {
      expect(mayExecute(state), agentStateName(state)).toBe(
        state === AgentState.Active,
      );
      expect(isLive(state), agentStateName(state)).toBe(
        state === AgentState.Active,
      );
    }
  });

  it("lets services be configured from binding until the agent is stopped", () => {
    for (const state of AGENT_STATES) {
      expect(mayConfigureServices(state), agentStateName(state)).toBe(
        state === AgentState.MarketBound || state === AgentState.Active,
      );
    }
  });

  it("never switches revenue or fixed entitlements off, in any state", () => {
    // ADR-012. A guardian who could stop money arriving could starve the developer
    // and the protocol of shares that were fixed at launch — including from
    // Revoked, which is the state where it would matter most.
    for (const state of AGENT_STATES) {
      expect(mayReceiveRevenue(state), agentStateName(state)).toBe(true);
      expect(maySettleFixedEntitlement(state), agentStateName(state)).toBe(true);
    }
  });

  it("calls only revocation terminal", () => {
    for (const state of AGENT_STATES) {
      expect(isTerminal(state), agentStateName(state)).toBe(
        state === AgentState.Revoked,
      );
    }
  });
});

/**
 * The same questions, against the shared corpus rather than against this file.
 *
 * Everything above and everything in `AgentLifecycle.t.sol` states the matrix twice —
 * once in each implementation and once in each suite — and two suites that each agree
 * with themselves are not two implementations that agree with each other. A clause
 * transposed in `lifecycle.ts` *and* in `PERMITTED` above would be green here and green
 * there, and wrong on an agent page.
 *
 * `vectors/lifecycle.json` is that third statement, derived in the generator from the
 * lifecycle as prose. `packages/contracts/test/agents/AgentLifecycle.vectors.t.sol`
 * reads the same file, so a divergence between the mirrors fails on one side or the
 * other rather than on neither.
 */
describe("the shared vectors", () => {
  it("describes the lifecycle this file implements", () => {
    // The corpus's own shape first: a truncated fixture would make every assertion
    // below vacuous, and JSON has no way to say "all twenty-five pairs".
    expect(vectors.stateNames).toEqual(AGENT_STATE_NAMES);
    expect(vectors.pairCount).toBe(AGENT_STATES.length ** 2);
    expect(vectors.from).toHaveLength(vectors.pairCount);
    expect(vectors.to).toHaveLength(vectors.pairCount);
    expect(vectors.allowed).toHaveLength(vectors.pairCount);
    expect(vectors.allowedCount).toBe(8);
  });

  it("agrees with canTransition on every pair", () => {
    for (let i = 0; i < vectors.pairCount; i++) {
      const from = vectors.from[i] as AgentState;
      const to = vectors.to[i] as AgentState;

      expect(
        canTransition(from, to),
        `${agentStateName(from)} -> ${agentStateName(to)}`,
      ).toBe(vectors.allowed[i]);
    }
  });

  it("agrees with every predicate, in every state", () => {
    for (const state of AGENT_STATES) {
      const where = agentStateName(state);

      expect(mayExecute(state), where).toBe(vectors.mayExecute[state]);
      expect(mayConfigureServices(state), where).toBe(
        vectors.mayConfigureServices[state],
      );
      expect(mayReceiveRevenue(state), where).toBe(vectors.mayReceiveRevenue[state]);
      expect(maySettleFixedEntitlement(state), where).toBe(
        vectors.maySettleFixedEntitlement[state],
      );
      expect(isTerminal(state), where).toBe(vectors.isTerminal[state]);
    }
  });
});
