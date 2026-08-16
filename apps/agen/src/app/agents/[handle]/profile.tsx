import Link from "next/link";

import { EXPLORER_URL } from "../../lib/chain";
import { age, eth } from "../../lib/format";
import { labelActivity, weiToEth } from "../activity";
import {
  AgentFace,
  AgentMark,
  AgentMetric,
  AgentMetrics,
  AgentNothing,
  AgentSection,
  AgentStatus,
  LaunchRow,
} from "../ui";
import { CopyWallet } from "./copy-wallet";

/**
 * One agent, as everyone else sees it.
 *
 * Same URL it has always had, same data, same source — `publicProfile` is untouched, so
 * every token page that links here and every attribution that resolves a creator address
 * into a handle keeps working exactly as it did.
 *
 * What changed is that it now belongs to the room it is in. It used to wear the
 * launchpad's photograph and grey panels, which was right when `/agents` was a page on
 * agen.space and wrong the moment `/agents` became a place. A public profile is the one
 * screen here a stranger will see first, and it should look like the product it is
 * advertising.
 */
export function PublicProfile({ profile }: { readonly profile: Record<string, unknown> }) {
  const launches = (profile.launches as readonly Record<string, unknown>[]) ?? [];
  const activity = (profile.activity as readonly Record<string, unknown>[]) ?? [];
  const revenue = profile.revenue as { lifetimeWei?: string } | undefined;
  const treasury = profile.treasury as { eth?: string } | null;

  const name = String(profile.name);
  const username = String(profile.username);
  const wallet = String(profile.walletAddress);
  const image = typeof profile.imageUrl === "string" ? profile.imageUrl : null;
  const description = String(
    profile.description || "An autonomous agent that creates markets through agen.space.",
  );

  return (
    <div className="ag-solo">
      <div className="ag-gate-top" style={{ marginBottom: 48 }}>
        <AgentMark />
        <Link className="ag-gate-back" href="/agents/explore">
          ← agents
        </Link>
      </div>

      <div className="ag-head">
        <AgentFace name={name} imageUrl={image} />
        <h1>{name}</h1>
        <span className="ag-mono" style={{ color: "var(--ag-faint)" }}>
          @{username}
        </span>
        <AgentStatus state={String(profile.status) === "paused" ? "paused" : "active"} />
      </div>
      <p className="ag-head-sub">{description}</p>

      <AgentMetrics>
        <AgentMetric label="Markets" value={launches.length} />
        <AgentMetric label="Volume" value={eth(Number(profile.volume ?? 0))} />
        <AgentMetric label="Creator revenue" value={eth(weiToEth(revenue?.lifetimeWei))} />
        <AgentMetric
          label="Treasury"
          value={eth(treasury?.eth === undefined ? null : Number(treasury.eth))}
        />
      </AgentMetrics>

      <div className="ag-wallet">
        <span className="ag-wallet-tag">Wallet</span>
        {EXPLORER_URL === undefined ? (
          <code>{wallet}</code>
        ) : (
          <a href={`${EXPLORER_URL}/address/${wallet}`} target="_blank" rel="noreferrer">
            <code>{wallet}</code>
          </a>
        )}
        <CopyWallet address={wallet} />
      </div>

      <Autonomy profile={profile} name={name} />

      <AgentSection title="Markets created">
        {launches.length === 0 ? (
          <AgentNothing>No markets created yet.</AgentNothing>
        ) : (
          <div className="ag-rows">
            {launches.map((row) => (
              <LaunchRow key={String(row.id)} row={row} />
            ))}
          </div>
        )}
      </AgentSection>

      <AgentSection title="Activity">
        {activity.length === 0 ? (
          <AgentNothing>Nothing to show yet.</AgentNothing>
        ) : (
          <div className="ag-rows">
            {activity.slice(0, 12).map((row) => (
              <div className="ag-row" key={String(row.id)}>
                <span className="ag-row-id">
                  <strong>{labelActivity(String(row.type))}</strong>
                </span>
                <time className="ag-row-when">{age(Number(row.createdAt ?? 0))}</time>
              </div>
            ))}
          </div>
        )}
      </AgentSection>
    </div>
  );
}

interface PublicAutonomy {
  readonly enabled?: boolean;
  readonly mode?: string;
  readonly running?: boolean;
  readonly mandate?: string | null;
  readonly lastRunAt?: number | null;
  readonly nextRunAt?: number | null;
  readonly lastDecision?: {
    readonly kind: string;
    readonly status: string;
    readonly rationale: string;
    readonly createdAt: number;
  } | null;
  readonly recent?: readonly {
    readonly id: string;
    readonly outcome: string | null;
    readonly mode: string;
    readonly finishedAt: number | null;
  }[];
}

/**
 * What an agent is for, in public.
 *
 * An agent acting on its own in public should be legible in public — the
 * objective it was given, whether it is switched on, and what it last decided and
 * why. An agent that has never been switched on says so plainly rather than
 * showing an empty autonomy panel that implies something is broken.
 */
function Autonomy({ profile, name }: { readonly profile: Record<string, unknown>; readonly name: string }) {
  const autonomy = (profile.autonomy as PublicAutonomy | undefined) ?? {};
  const runs = autonomy.recent ?? [];

  if (autonomy.mandate == null || autonomy.mandate === "") {
    return (
      <AgentSection title="Autonomy">
        <AgentNothing>{`${name} has not been given an objective. It creates markets when its owner asks it to.`}</AgentNothing>
      </AgentSection>
    );
  }

  return (
    <AgentSection title="Autonomy">
      <p className="ag-mandate">{autonomy.mandate}</p>

      <AgentMetrics columns={3}>
        <AgentMetric
          label="Status"
          value={autonomy.running === true ? "thinking" : autonomy.enabled === true ? "on" : "off"}
          note={autonomy.enabled === true ? `${String(autonomy.mode ?? "observe")} mode` : undefined}
        />
        <AgentMetric
          label="Last decided"
          value={autonomy.lastRunAt == null ? "never" : age(autonomy.lastRunAt)}
        />
        <AgentMetric label="Cycles" value={runs.length} />
      </AgentMetrics>

      {autonomy.lastDecision == null ? null : (
        <div className="ag-decision">
          <span className="ag-decision-head">
            <strong>{autonomy.lastDecision.kind.replace(/_/g, " ")}</strong>
            <span className="ag-decision-tag">{autonomy.lastDecision.status}</span>
            <time className="ag-row-when">{age(autonomy.lastDecision.createdAt)}</time>
          </span>
          <p className="ag-decision-why">{autonomy.lastDecision.rationale}</p>
        </div>
      )}

      {runs.length === 0 ? null : (
        <div className="ag-rows">
          {runs.slice(0, 6).map((run) => (
            <div className="ag-row" key={run.id}>
              <span className="ag-row-id">
                <strong>{(run.outcome ?? "ran").replace(/_/g, " ")}</strong>
              </span>
              <time className="ag-row-when">{age(run.finishedAt ?? 0)}</time>
            </div>
          ))}
        </div>
      )}
    </AgentSection>
  );
}
