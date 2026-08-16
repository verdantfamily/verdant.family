"use client";

/**
 * The autonomy layer, as the interface sees it.
 *
 * In Phase 1 this file was a declared seam with no implementation, so that the
 * panels could not accidentally render an invented opportunity. There is now a
 * real one behind `/api/v1/owner/agents/{id}/autonomy`, and this reads it.
 *
 * What is still absent is still absent, and deliberately has no shape here:
 * research state, signals analysed, scored opportunities, a watchlist. Those are
 * the parts of the product that need an agent to go and look at the world, which
 * nothing does yet. A cycle today reasons from the agent's own objective, budget
 * and history — so the interface shows a decision and the reasoning behind it,
 * and does not imply research that did not happen.
 */

import { useCallback, useEffect, useState } from "react";

import { useActiveAgent } from "./shell";

export type ExecutionMode = "observe" | "approve" | "autonomous";

export interface DecisionView {
  readonly id: string;
  readonly kind: string;
  readonly status: string;
  readonly rationale: string;
  readonly confidence: number;
  readonly payload: Record<string, unknown>;
  readonly createdAt: number;
  readonly executedAt: number | null;
  readonly result: Record<string, unknown> | null;
  readonly error: string | null;
}

export interface PolicyView {
  readonly treasuryReserveWei: string;
  readonly revenuePolicy: string;
  readonly boostAllowed: boolean;
  readonly maxRunsPerDay: number;
  readonly maxModelCallsPerDay: number;
  readonly launchCooldownSeconds: number;
}

export interface AutonomyView {
  readonly enabled: boolean;
  readonly mode: ExecutionMode;
  readonly intervalSeconds: number;
  readonly nextRunAt: number | null;
  readonly lastRunAt: number | null;
  /** True while a cycle holds the lease. */
  readonly running: boolean;
  readonly globallyPaused: boolean;
  readonly mandate: { readonly text: string; readonly version: number; readonly updatedAt: number } | null;
  readonly policy: PolicyView;
  readonly lastDecision: DecisionView | null;
  readonly pending: readonly DecisionView[];
  readonly modelCallsToday: number;
}

export function useAutonomy(): {
  readonly autonomy: AutonomyView | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly reload: () => void;
} {
  const { agent, call } = useActiveAgent();
  const [autonomy, setAutonomy] = useState<AutonomyView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const reload = useCallback(() => setNonce((was) => was + 1), []);

  useEffect(() => {
    let live = true;
    setError(null);

    const run = async () => {
      try {
        const body = await call<{ autonomy: AutonomyView }>(`/api/v1/owner/agents/${agent.id}/autonomy`);
        if (!live) return;
        setAutonomy(body.autonomy);
      } catch (caught) {
        if (!live) return;
        setError(caught instanceof Error ? caught.message : "Could not read this agent's autonomy.");
      }
    };

    void run();
    return () => {
      live = false;
    };
  }, [agent.id, call, nonce]);

  return { autonomy, loading: autonomy === null && error === null, error, reload };
}

/** How a decision reads to somebody who did not write the schema. */
export function describeDecision(decision: DecisionView): string {
  const payload = decision.payload;
  switch (decision.kind) {
    case "no_action":
      return "Do nothing";
    case "instant_launch":
      return `Create ${String(payload.symbol ?? "a market")} on Instant`;
    case "programmable_build":
      return `Build ${String(payload.symbol ?? "a Programmable market")}`;
    case "answer_clarification":
      return "Answer questions on a build";
    case "claim_revenue":
      return "Claim creator fees";
    default:
      return decision.kind.replace(/_/g, " ");
  }
}

export function modeBlurb(mode: ExecutionMode): string {
  switch (mode) {
    case "observe":
      return "Decides and records. Never acts.";
    case "approve":
      return "Decides and waits for you before acting.";
    case "autonomous":
      return "Decides and acts, within its permissions.";
  }
}
