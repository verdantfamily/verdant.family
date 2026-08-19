"use client";

/**
 * What the agent carries between one piece of work and the next.
 *
 * Two kinds of row and the difference matters, so the page states it rather than mixing
 * them into one list. What the owner told it is an instruction — it came from a person and
 * it will still be true tomorrow. What it noticed is an observation with a date on it: a
 * figure read from the market feed at the moment it crossed something, written by the cycle
 * itself. An owner reading this should be able to tell, without asking, which sentences
 * they are responsible for.
 *
 * Its own page rather than a section of the snapshot hook, because memory is the one thing
 * here that a cycle can change while the owner is looking at it, and it is worth being able
 * to re-read it without re-reading the chain.
 */

import { useCallback, useEffect, useState } from "react";

import { age } from "../../../lib/format";
import { useActiveAgent } from "../../shell";
import { AgentEmptyState, AgentNothing, AgentSection } from "../../ui";

interface MemoryRow {
  readonly id: string;
  readonly content: string;
  readonly source: string;
  readonly createdAt: number;
}

export function MemoryView() {
  const { agent, call } = useActiveAgent();
  const [rows, setRows] = useState<readonly MemoryRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const body = await call<{ memory: MemoryRow[] }>(`/api/v1/owner/agents/${agent.id}/memory`);
      return body.memory;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not read this agent's memory.");
      return null;
    }
  }, [agent.id, call]);

  useEffect(() => {
    let live = true;
    void load().then((memory) => {
      if (live && memory !== null) setRows(memory);
    });
    return () => {
      live = false;
    };
  }, [load]);

  const noticed = (rows ?? []).filter((row) => row.source === "run");
  const told = (rows ?? []).filter((row) => row.source !== "run");

  return (
    <div className="ag-wide">
      <div className="ag-head">
        <h1>Memory</h1>
      </div>
      <p className="ag-head-sub">
        What this agent knows going into its next cycle. Everything it noticed is a figure it
        read from the market feed on the day it read it — not a conclusion it drew about itself.
      </p>

      {error !== null ? (
        <p className="ag-note ag-note-bad">{error}</p>
      ) : rows === null ? (
        <p className="ag-gate-note">loading…</p>
      ) : rows.length === 0 ? (
        <AgentEmptyState
          lead="Nothing remembered yet."
          body="Tell the agent something in Chat and it is kept here. Once it has created a market, what happens to that market is written here too, as it happens."
        />
      ) : (
        <>
          <AgentSection title="What it noticed">
            {noticed.length === 0 ? (
              <AgentNothing>
                Nothing yet. Observations appear once one of its markets starts trading.
              </AgentNothing>
            ) : (
              <div className="ag-rows">
                {noticed.map((row) => (
                  <Row key={row.id} row={row} />
                ))}
              </div>
            )}
          </AgentSection>

          <AgentSection title="What you told it">
            {told.length === 0 ? (
              <AgentNothing>Nothing yet. Anything you tell it in Chat is kept here.</AgentNothing>
            ) : (
              <div className="ag-rows">
                {told.map((row) => (
                  <Row key={row.id} row={row} />
                ))}
              </div>
            )}
          </AgentSection>
        </>
      )}
    </div>
  );
}

/**
 * A remembered sentence and when it was written.
 *
 * No kind label under it. Every row in the noticed section is an outcome and every row in
 * the other one came from the owner, so the word would repeat the heading on every line —
 * and these rows are already sentences rather than the short identifiers this shape usually
 * holds, which is enough to read without a caption.
 */
function Row({ row }: { readonly row: MemoryRow }) {
  return (
    <div className="ag-row">
      <span className="ag-row-id">
        <strong>{row.content}</strong>
      </span>
      <time className="ag-row-when">{age(row.createdAt)}</time>
    </div>
  );
}
