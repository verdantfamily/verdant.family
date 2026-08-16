"use client";

/**
 * Where an agent is given something to do, and switched on.
 *
 * The order on this page is the order of the decision an owner is actually making:
 * what it should aim for, how far it may go on its own, what it may spend getting
 * there, and only then the switch. The switch is last and refuses to move without
 * an objective, because "on" with nothing to pursue is a state worth making
 * impossible rather than merely unlikely.
 *
 * Everything here writes through owner-authenticated endpoints, and none of it can
 * widen a permission. The boundaries live on the Permissions page and hold whatever
 * the objective says.
 */

import Link from "next/link";
import { useEffect, useState } from "react";

import { modeBlurb, useAutonomy, type ExecutionMode } from "../autonomy";
import { workspaceHref } from "../routing";
import { useActiveAgent } from "../shell";
import { AgentSection } from "../ui";

const MODES: readonly ExecutionMode[] = ["observe", "approve", "autonomous"];

export function ObjectiveView() {
  const { agent, call } = useActiveAgent();
  const { autonomy, loading, error, reload } = useAutonomy();

  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const written = autonomy?.mandate?.text ?? null;
  useEffect(() => {
    if (written !== null) setDraft(written);
  }, [written]);

  const send = async (path: string, body: Record<string, unknown>, said: string) => {
    setBusy(true);
    setProblem(null);
    setNote(null);
    try {
      await call(path, { method: "PUT", body: JSON.stringify(body) });
      setNote(said);
      reload();
    } catch (caught) {
      setProblem(caught instanceof Error ? caught.message : "That did not save.");
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <div className="ag-wide">
        <div className="ag-head">
          <h1>Objective</h1>
        </div>
        <p className="ag-gate-note">loading…</p>
      </div>
    );
  }

  if (error !== null || autonomy === null) {
    return (
      <div className="ag-wide">
        <div className="ag-head">
          <h1>Objective</h1>
        </div>
        <p className="ag-note ag-note-bad">{error ?? "This agent could not be read."}</p>
      </div>
    );
  }

  const base = `/api/v1/owner/agents/${agent.id}`;
  const unchanged = written === draft.trim();

  return (
    <div className="ag-wide">
      <div className="ag-head">
        <h1>Objective</h1>
      </div>
      <p className="ag-head-sub">
        What you want {agent.name} to pursue, in your own words. It is read at the start of every
        cycle, and it cannot grant permissions the agent does not already have.
      </p>

      {problem !== null ? <p className="ag-note ag-note-bad">{problem}</p> : null}
      {note !== null ? <p className="ag-note">{note}</p> : null}

      <AgentSection title="What it should do">
        <label className="ag-field" htmlFor="ag-mandate">
          <span>Objective</span>
          <textarea
            id="ag-mandate"
            rows={5}
            value={draft}
            maxLength={2_000}
            placeholder="Create one market a week about something people are already arguing about online."
            onChange={(event) => setDraft(event.target.value)}
          />
        </label>
        <div className="ag-actions">
          <button
            type="button"
            className="ag-go"
            disabled={busy || unchanged || draft.trim().length < 20}
            onClick={() => void send(`${base}/mandate`, { mandate: draft.trim() }, "Objective saved.")}
          >
            {busy ? "saving…" : "save objective"}
          </button>
          <span className="ag-actions-note">
            {autonomy.mandate === null
              ? "Not set yet. A sentence at least."
              : `version ${autonomy.mandate.version}`}
          </span>
        </div>
      </AgentSection>

      <AgentSection title="How far it may go on its own">
        <div className="ag-modes">
          {MODES.map((mode) => (
            <button
              key={mode}
              type="button"
              className={`ag-mode${autonomy.mode === mode ? " ag-mode-on" : ""}`}
              disabled={busy}
              onClick={() => void send(`${base}/autonomy`, { mode }, `Mode set to ${mode}.`)}
            >
              <strong>{mode}</strong>
              <span>{modeBlurb(mode)}</span>
            </button>
          ))}
        </div>
        <p className="ag-hint">
          Whatever the mode, this agent can only spend what its{" "}
          <Link href={workspaceHref(agent.username, "permissions")}>permissions</Link> allow and can
          only call contracts agen.space approved. Autonomous does not mean unbounded.
        </p>
      </AgentSection>

      <AgentSection title="What it may spend getting there">
        <div className="ag-pair">
          <label className="ag-field" htmlFor="ag-reserve">
            <span>Never spend below (ETH)</span>
            <input
              id="ag-reserve"
              defaultValue={weiEth(autonomy.policy.treasuryReserveWei)}
              disabled={busy}
              onBlur={(event) =>
                void send(`${base}/policy`, { treasuryReserveEth: event.target.value.trim() }, "Reserve saved.")
              }
            />
          </label>
          <label className="ag-field" htmlFor="ag-cooldown">
            <span>Hours between markets</span>
            <input
              id="ag-cooldown"
              type="number"
              defaultValue={autonomy.policy.launchCooldownSeconds / 3_600}
              disabled={busy}
              onBlur={(event) =>
                void send(
                  `${base}/policy`,
                  { launchCooldownSeconds: Math.round(Number(event.target.value) * 3_600) },
                  "Cooldown saved.",
                )
              }
            />
          </label>
        </div>

        <div className="ag-pair">
          <label className="ag-field" htmlFor="ag-runs">
            <span>Cycles a day</span>
            <input
              id="ag-runs"
              type="number"
              defaultValue={autonomy.policy.maxRunsPerDay}
              disabled={busy}
              onBlur={(event) =>
                void send(`${base}/policy`, { maxRunsPerDay: Number(event.target.value) }, "Saved.")
              }
            />
          </label>
          <label className="ag-field" htmlFor="ag-calls">
            <span>Model calls a day</span>
            <input
              id="ag-calls"
              type="number"
              defaultValue={autonomy.policy.maxModelCallsPerDay}
              disabled={busy}
              onBlur={(event) =>
                void send(`${base}/policy`, { maxModelCallsPerDay: Number(event.target.value) }, "Saved.")
              }
            />
          </label>
        </div>

        <p className="ag-hint">
          {autonomy.modelCallsToday} of {autonomy.policy.maxModelCallsPerDay} model calls used today.
          A cycle costs one, whether or not it decides to do anything.
        </p>
      </AgentSection>

      <AgentSection title={autonomy.enabled ? "Switched on" : "Switched off"}>
        <p className="ag-hint" style={{ marginTop: 0 }}>
          {autonomy.enabled
            ? `${agent.name} decides on every cycle it is given. Nothing starts a cycle automatically yet — you start one from the Overview.`
            : `${agent.name} will not decide anything until you switch it on.`}
        </p>
        <div className="ag-actions">
          <button
            type="button"
            className={autonomy.enabled ? "ag-quiet" : "ag-go"}
            disabled={busy || (!autonomy.enabled && autonomy.mandate === null)}
            onClick={() =>
              void send(
                `${base}/autonomy`,
                { enabled: !autonomy.enabled },
                autonomy.enabled ? "Switched off." : "Switched on.",
              )
            }
          >
            {autonomy.enabled ? "switch off" : "switch on"}
          </button>
          {!autonomy.enabled && autonomy.mandate === null ? (
            <span className="ag-actions-note">Write an objective first.</span>
          ) : null}
        </div>
      </AgentSection>
    </div>
  );
}

function weiEth(wei: string): string {
  try {
    const value = BigInt(wei);
    const whole = value / 10n ** 18n;
    const fraction = (value % 10n ** 18n).toString().padStart(18, "0").replace(/0+$/, "");
    return fraction === "" ? whole.toString() : `${whole.toString()}.${fraction}`;
  } catch {
    return "0";
  }
}
