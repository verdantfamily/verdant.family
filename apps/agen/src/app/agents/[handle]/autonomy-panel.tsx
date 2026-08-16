"use client";

/**
 * Whether the agent is thinking, and what it last decided.
 *
 * In Phase 1 this panel had one honest sentence in it, because there was nothing
 * to report. There is now: an objective, a mode, a schedule, a decision history
 * and — in approve mode — proposals waiting on the owner.
 *
 * It stays a separate file for the reason it always was. When research and
 * opportunity scoring arrive, they land here, and the Overview around it, which is
 * entirely real data about money and limits, does not change.
 */

import Link from "next/link";
import { useState } from "react";

import { age } from "../../lib/format";
import { describeDecision, modeBlurb, useAutonomy, type DecisionView } from "../autonomy";
import { workspaceHref } from "../routing";
import { useActiveAgent } from "../shell";
import { AgentEmptyState, AgentMetric, AgentMetrics, AgentSection } from "../ui";

export function AutonomyPanel({ name, username }: { readonly name: string; readonly username: string }) {
  const { agent, call } = useActiveAgent();
  const { autonomy, loading, error, reload } = useAutonomy();
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const act = async (what: string, path: string) => {
    setBusy(what);
    setNote(null);
    try {
      const body = await call<{ note?: string }>(path, { method: "POST", body: "{}" });
      setNote(body.note ?? "Done.");
      reload();
    } catch (caught) {
      setNote(caught instanceof Error ? caught.message : "That did not work.");
    } finally {
      setBusy(null);
    }
  };

  if (loading) {
    return (
      <AgentSection title="Autonomy">
        <p className="ag-gate-note">reading autonomy…</p>
      </AgentSection>
    );
  }

  if (error !== null || autonomy === null) {
    return (
      <AgentSection title="Autonomy">
        <p className="ag-note ag-note-bad">{error ?? "Autonomy could not be read."}</p>
      </AgentSection>
    );
  }

  if (autonomy.mandate === null) {
    return (
      <AgentSection title="Autonomy">
        <AgentEmptyState
          lead="Not configured yet."
          body={`Give ${name} an objective and it can start deciding for itself — within the permissions you have already set.`}
          action={
            <Link className="ag-go" href={workspaceHref(username, "objective")}>
              Write an objective
            </Link>
          }
        />
      </AgentSection>
    );
  }

  return (
    <AgentSection
      title="Autonomy"
      more={
        <Link className="ag-sec-more" href={workspaceHref(username, "objective")}>
          settings
        </Link>
      }
    >
      {autonomy.globallyPaused ? (
        <p className="ag-note ag-note-bad">
          Autonomous agents are paused across agen.space. Nothing will run until that is lifted.
        </p>
      ) : null}

      <p className="ag-mandate">{autonomy.mandate.text}</p>

      <AgentMetrics columns={3}>
        <AgentMetric
          label="State"
          value={autonomy.running ? "thinking" : autonomy.enabled ? "on" : "off"}
          note={modeBlurb(autonomy.mode)}
        />
        <AgentMetric
          label="Last cycle"
          value={autonomy.lastRunAt === null ? "never" : age(autonomy.lastRunAt)}
        />
        <AgentMetric
          label="Next cycle"
          value={autonomy.enabled ? "on request" : "—"}
          note={autonomy.enabled ? "nothing runs it automatically yet" : "switched off"}
        />
      </AgentMetrics>

      {autonomy.pending.length > 0 ? (
        <div className="ag-proposals">
          <h3 className="ag-proposals-title">
            Waiting for you · {autonomy.pending.length}
          </h3>
          {autonomy.pending.map((decision) => (
            <Proposal
              key={decision.id}
              decision={decision}
              busy={busy === decision.id}
              onApprove={() =>
                void act(decision.id, `/api/v1/owner/agents/${agent.id}/decisions/${decision.id}/approve`)
              }
              onReject={() =>
                void act(decision.id, `/api/v1/owner/agents/${agent.id}/decisions/${decision.id}/reject`)
              }
            />
          ))}
        </div>
      ) : null}

      {autonomy.lastDecision !== null && autonomy.pending.length === 0 ? (
        <div className="ag-decision">
          <span className="ag-decision-head">
            <strong>{describeDecision(autonomy.lastDecision)}</strong>
            <span className="ag-decision-tag">{autonomy.lastDecision.status}</span>
            <time className="ag-row-when">{age(autonomy.lastDecision.createdAt)}</time>
          </span>
          <p className="ag-decision-why">{autonomy.lastDecision.rationale}</p>
        </div>
      ) : null}

      <div className="ag-actions">
        <button
          type="button"
          className="ag-quiet"
          disabled={!autonomy.enabled || busy !== null || autonomy.globallyPaused}
          onClick={() => void act("run", `/api/v1/owner/agents/${agent.id}/runs`)}
        >
          {busy === "run" ? "thinking…" : "run one cycle"}
        </button>
        {note !== null ? <span className="ag-actions-note">{note}</span> : null}
      </div>
    </AgentSection>
  );
}

function Proposal({
  decision,
  busy,
  onApprove,
  onReject,
}: {
  readonly decision: DecisionView;
  readonly busy: boolean;
  readonly onApprove: () => void;
  readonly onReject: () => void;
}) {
  return (
    <div className="ag-proposal">
      <span className="ag-decision-head">
        <strong>{describeDecision(decision)}</strong>
        <time className="ag-row-when">{age(decision.createdAt)}</time>
      </span>
      <p className="ag-decision-why">{decision.rationale}</p>
      <div className="ag-actions">
        <button type="button" className="ag-go" disabled={busy} onClick={onApprove}>
          {busy ? "…" : "approve"}
        </button>
        <button type="button" className="ag-quiet" disabled={busy} onClick={onReject}>
          decline
        </button>
      </div>
    </div>
  );
}
