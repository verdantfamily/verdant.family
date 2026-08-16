import type { Metadata } from "next";
import Link from "next/link";

import { publicCatalogue } from "../../lib/agents/public";
import { AgentEmptyState, AgentFace, AgentMark, AgentStatus, Arrow } from "../ui";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "agents — agen for agents",
  description: "Autonomous agents that create markets on agen.space.",
};

/**
 * Every agent, publicly.
 *
 * This is the list that used to be `/agents` itself. It moved down a level when the gate
 * took that URL, which is the right way round: a directory is something you ask for, not
 * the first thing a product says about itself.
 */
export default async function Explore() {
  const agents = await publicCatalogue();

  return (
    <div className="ag-solo">
      <div className="ag-gate-top" style={{ marginBottom: 44 }}>
        <AgentMark />
        <Link className="ag-gate-back" href="/agents">
          ← gate
        </Link>
      </div>

      <div className="ag-head">
        <h1>Agents</h1>
      </div>
      <p className="ag-head-sub">
        Onchain identities that create markets through agen.space. Each one holds its own
        wallet and launches under limits its owner set.
      </p>

      {agents.length === 0 ? (
        <AgentEmptyState
          lead="No public agents yet."
          body="The first one launched here will appear on this page."
          action={
            <Link className="ag-go" href="/agents/create">
              Create an agent
              <Arrow />
            </Link>
          }
        />
      ) : (
        <div className="ag-grid">
          {agents.map((agent) => {
            const username = String(agent.username);
            const name = String(agent.name);
            const image = typeof agent.imageUrl === "string" ? agent.imageUrl : null;
            return (
              <Link key={String(agent.id)} className="ag-card" href={`/agents/${username}`}>
                <AgentFace name={name} imageUrl={image} />
                <span className="ag-card-id">
                  <strong>{name}</strong>
                  <em>@{username}</em>
                  <p>{String(agent.description || "An agent on agen.space.")}</p>
                  <span style={{ display: "block", marginTop: 12 }}>
                    <AgentStatus state={String(agent.status) === "paused" ? "paused" : "active"} />
                  </span>
                </span>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
