"use client";

/**
 * The pages behind the sidebar that have something true to show.
 *
 * Launches, Wallet, Activity, Permissions and API Keys all run on data the API already
 * returned before this phase started — they are longer views of what the Overview
 * summarises, not new capabilities. Nothing here calls an endpoint that did not exist,
 * and nothing here changes how one behaves.
 *
 * Everything else in the sidebar is a `Soon`, which says what it will be and does not
 * draw a chart of nothing in the meantime.
 */

import Link from "next/link";
import { useState } from "react";

import { EXPLORER_URL } from "../../lib/chain";
import { age, eth } from "../../lib/format";
import { labelActivity, weiToEth } from "../activity";
import { workspaceHref } from "../routing";
import { useActiveAgent } from "../shell";
import {
  AgentEmptyState,
  AgentMetric,
  AgentMetrics,
  AgentNothing,
  AgentSection,
  Arrow,
  LaunchRow,
} from "../ui";
import { CopyWallet } from "./copy-wallet";
import { useAgentSnapshot, type ApiKey } from "./data";

function Head({ title, sub }: { readonly title: string; readonly sub?: string }) {
  return (
    <>
      <div className="ag-head">
        <h1>{title}</h1>
      </div>
      {sub === undefined ? null : <p className="ag-head-sub">{sub}</p>}
    </>
  );
}

function Loading() {
  return <p className="ag-gate-note">loading…</p>;
}

export function LaunchesView() {
  const { snapshot, loading } = useAgentSnapshot();

  return (
    <div className="ag-wide">
      <Head title="Markets" sub="Every market this agent has created, and every attempt it made." />
      {loading ? (
        <Loading />
      ) : snapshot === null || snapshot.launches.length === 0 ? (
        <AgentEmptyState
          lead="No markets created yet."
          body="Markets appear here as soon as the agent creates one through the API."
        />
      ) : (
        <div className="ag-rows">
          {snapshot.launches.map((row) => (
            <LaunchRow key={String(row.id)} row={row} />
          ))}
        </div>
      )}
    </div>
  );
}

export function ActivityView() {
  const { snapshot, loading } = useAgentSnapshot();

  return (
    <div className="ag-wide">
      <Head
        title="Activity"
        sub="Everything the agent did, and everything it was refused. Recorded as it happened."
      />
      {loading ? (
        <Loading />
      ) : snapshot === null || snapshot.activity.length === 0 ? (
        <AgentEmptyState lead="Nothing to show yet." />
      ) : (
        <div className="ag-rows">
          {snapshot.activity.map((row) => (
            <div className="ag-row" key={String(row.id)}>
              <span className="ag-row-id">
                <strong>{labelActivity(String(row.type))}</strong>
                {typeof row.detail === "string" && row.detail !== "" ? <em>{row.detail}</em> : null}
              </span>
              <time className="ag-row-when">{age(Number(row.createdAt ?? 0))}</time>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function WalletView() {
  const { agent } = useActiveAgent();
  const { snapshot, loading, reload } = useAgentSnapshot();

  return (
    <div className="ag-wide">
      <Head
        title="Wallet"
        sub="This agent holds its own key. It can spend into agen.space contracts and nowhere else — transfers to an external address are refused by the signer, not by a setting."
      />

      <div className="ag-wallet" style={{ marginTop: 0 }}>
        <span className="ag-wallet-tag">Address</span>
        {EXPLORER_URL === undefined ? (
          <code>{agent.walletAddress}</code>
        ) : (
          <a href={`${EXPLORER_URL}/address/${agent.walletAddress}`} target="_blank" rel="noreferrer">
            <code>{agent.walletAddress}</code>
          </a>
        )}
        <CopyWallet address={agent.walletAddress} />
      </div>

      {loading ? (
        <p className="ag-gate-note" style={{ marginTop: 34 }}>
          loading…
        </p>
      ) : snapshot === null ? null : (
        <>
          <AgentSection title="Balance">
            <AgentMetrics columns={3}>
              <AgentMetric
                label="Treasury"
                value={eth(snapshot.treasuryEth === null ? null : Number(snapshot.treasuryEth))}
              />
              <AgentMetric label="Spent today" value={eth(weiToEth(snapshot.allowance.spentWei))} />
              <AgentMetric
                label="Budget left today"
                value={eth(weiToEth(snapshot.allowance.spendRemainingWei))}
              />
            </AgentMetrics>
          </AgentSection>

          <AgentSection title="Creator revenue">
            {snapshot.revenue === null ? (
              <AgentNothing>Fee balances could not be read from the chain just now.</AgentNothing>
            ) : (
              <AgentMetrics columns={3}>
                <AgentMetric label="Earned" value={eth(weiToEth(snapshot.revenue.lifetimeWei))} />
                <AgentMetric label="Claimable" value={eth(weiToEth(snapshot.revenue.claimableWei))} />
                <AgentMetric label="Claimed" value={eth(weiToEth(snapshot.revenue.claimedWei))} />
              </AgentMetrics>
            )}
          </AgentSection>

          <Recovery reload={reload} />
        </>
      )}
    </div>
  );
}

/**
 * Taking the money back.
 *
 * The agent cannot transfer to an external address and never will be able to, so
 * without this an owner's ETH would be stranded behind an agent they no longer
 * want running. The destination is not a field on this form: the server pays the
 * owner address recorded on the agent and nothing else, so there is nothing here
 * to get wrong or to tamper with.
 */
function Recovery({ reload }: { readonly reload: () => void }) {
  const { agent, refresh, call } = useActiveAgent();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const recover = async () => {
    setBusy(true);
    setNote(null);
    try {
      const body = await call<{ recovery: { valueWei: string } }>(
        `/api/v1/owner/agents/${agent.id}/recover`,
        { method: "POST", body: "{}" },
      );
      setNote(`Sent ${eth(weiToEth(body.recovery.valueWei))} back to your wallet.`);
      setAsking(false);
      await refresh();
      reload();
    } catch (caught) {
      setNote(caught instanceof Error ? caught.message : "That did not go through.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <AgentSection title="Recover funds">
      <p className="ag-hint" style={{ marginTop: 0 }}>
        Sends everything this wallet holds, less gas, to the address that owns the agent. It
        switches autonomy off at the same time, so the agent cannot start spending again
        while the transfer is in flight.
      </p>
      <div className="ag-actions">
        {asking ? (
          <>
            <button type="button" className="ag-go" disabled={busy} onClick={() => void recover()}>
              {busy ? "sending…" : "yes, send it back"}
            </button>
            <button type="button" className="ag-quiet" disabled={busy} onClick={() => setAsking(false)}>
              cancel
            </button>
          </>
        ) : (
          <button type="button" className="ag-quiet" onClick={() => setAsking(true)}>
            recover treasury
          </button>
        )}
        {note !== null ? <span className="ag-actions-note">{note}</span> : null}
      </div>
    </AgentSection>
  );
}

export function PermissionsView() {
  const { snapshot, loading } = useAgentSnapshot();

  return (
    <div className="ag-wide">
      <Head
        title="Permissions"
        sub="The boundaries this agent works inside. The last two are not settings — no owner can turn them off, and the signer enforces them on every transaction."
      />

      {loading ? (
        <Loading />
      ) : snapshot === null ? null : (
        <>
          <AgentMetrics>
            <AgentMetric
              label="Max per launch"
              value={eth(weiToEth(snapshot.permissions.maxEthPerLaunchWei))}
            />
            <AgentMetric
              label="Max per day"
              value={eth(weiToEth(snapshot.permissions.maxEthPerDayWei))}
            />
            <AgentMetric label="Launches per day" value={snapshot.permissions.maxLaunchesPerDay} />
            <AgentMetric
              label="Max creator buy"
              value={eth(weiToEth(snapshot.permissions.maxCreatorBuyWei))}
            />
          </AgentMetrics>

          <AgentSection title="May do">
            <div className="ag-rows">
              <Rule label="Create Instant markets" on={snapshot.permissions.instantAllowed} />
              <Rule
                label="Create Programmable markets"
                on={snapshot.permissions.programmableAllowed}
              />
              <Rule label="Claim creator fees" on={snapshot.permissions.canClaimCreatorFees} />
            </div>
          </AgentSection>

          <AgentSection title="Cannot do">
            <div className="ag-rows">
              <Rule label="Transfer to an external address" on={snapshot.permissions.externalTransfers} fixed />
              <Rule
                label="Call anything but approved agen.space contracts"
                on={!snapshot.permissions.approvedContractsOnly}
                fixed
              />
            </div>
          </AgentSection>
        </>
      )}
    </div>
  );
}

function Rule({
  label,
  on,
  fixed = false,
}: {
  readonly label: string;
  readonly on: boolean;
  readonly fixed?: boolean;
}) {
  return (
    <div className="ag-row">
      <span className="ag-row-id">
        <strong>{label}</strong>
        {fixed ? <em>enforced by the signer</em> : null}
      </span>
      <span className="ag-row-when">{on ? "yes" : "no"}</span>
    </div>
  );
}

export function KeysView() {
  const { agent, call } = useActiveAgent();
  const { snapshot, loading, reload } = useAgentSnapshot();
  const [issued, setIssued] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const act = async (run: () => Promise<void>) => {
    setError(null);
    setBusy(true);
    try {
      await run();
      reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That did not work.");
    } finally {
      setBusy(false);
    }
  };

  const live = (snapshot?.keys ?? []).filter((key) => key.revokedAt === null);

  return (
    <div className="ag-wide">
      <Head
        title="API Keys"
        sub="A key lets the agent act on its own behalf, inside the permissions you set for it. It is shown once and stored only as a hash — if it is lost, issue another and revoke the old one."
      />

      <button
        type="button"
        className="ag-go"
        disabled={busy}
        onClick={() =>
          void act(async () => {
            const result = await call<{ key: string }>(`/api/v1/owner/agents/${agent.id}/keys`, {
              method: "POST",
              body: "{}",
            });
            setIssued(result.key);
          })
        }
      >
        {busy ? "working…" : "Issue a key"}
        {busy ? null : <Arrow />}
      </button>

      {issued === null ? null : (
        <div className="ag-wallet" style={{ marginTop: 22 }}>
          <span className="ag-wallet-tag">Copy it now</span>
          <code>{issued}</code>
          <CopyWallet address={issued} />
        </div>
      )}

      {error === null ? null : <p className="ag-note ag-note-bad">{error}</p>}

      <AgentSection title="Keys">
        {loading ? (
          <Loading />
        ) : live.length === 0 ? (
          <AgentNothing>No active keys.</AgentNothing>
        ) : (
          <div className="ag-rows">
            {live.map((key) => (
              <KeyRow
                key={key.id}
                row={key}
                busy={busy}
                onRevoke={() =>
                  void act(async () => {
                    await call(`/api/v1/owner/agents/${agent.id}/keys/${key.id}`, {
                      method: "DELETE",
                    });
                  })
                }
              />
            ))}
          </div>
        )}
      </AgentSection>
    </div>
  );
}

function KeyRow({
  row,
  busy,
  onRevoke,
}: {
  readonly row: ApiKey;
  readonly busy: boolean;
  readonly onRevoke: () => void;
}) {
  return (
    <div className="ag-row">
      <span className="ag-row-id">
        <strong style={{ fontFamily: "var(--ag-mono)", fontSize: "0.84rem" }}>{row.prefix}…</strong>
        <em>
          issued {age(row.createdAt)}
          {row.lastUsedAt === null ? " · never used" : ` · last used ${age(row.lastUsedAt)}`}
        </em>
      </span>
      <button type="button" className="ag-quiet ag-quiet-sm" disabled={busy} onClick={onRevoke}>
        revoke
      </button>
    </div>
  );
}

/**
 * A page that exists in the navigation because the product has that shape, and says
 * plainly that it is not built. The alternative — hiding it until it works — makes the
 * sidebar change under people, and the other alternative is worse.
 */
export function Soon({
  title,
  sub,
  body,
  action,
}: {
  readonly title: string;
  readonly sub: string;
  readonly body: string;
  /** `slug` is a page within this agent's environment, resolved against its handle. */
  readonly action?: { readonly slug: string; readonly label: string };
}) {
  const { agent } = useActiveAgent();

  return (
    <div className="ag-wide">
      <Head title={title} sub={sub} />
      <AgentEmptyState
        lead="Not available yet."
        body={body}
        action={
          action === undefined ? undefined : (
            <Link className="ag-btn" href={workspaceHref(agent.username, action.slug)}>
              {action.label}
            </Link>
          )
        }
      />
    </div>
  );
}
