"use client";

/**
 * The frame of the agent environment.
 *
 * Everything an owner does happens inside this: it resolves who is signed in, which of
 * their agents is being looked at, and hands both to the page through context so no page
 * has to repeat the sign-in dance. Pages are otherwise ordinary.
 *
 * ## The sidebar is not a menu of everything
 *
 * Four groups, thirteen entries, and several of them say `soon` rather than pretending.
 * The brief asked for a narrow product and the fastest way to lose that is a sidebar
 * that accepts every idea anybody has. Entries that lead nowhere useful are still worth
 * listing — they are the shape of the product — but they are marked, and the page behind
 * them says plainly that it is not built rather than showing an empty chart.
 *
 * ## Mobile is not the sidebar in a drawer
 *
 * A drawer turns every navigation into two taps and a gesture. The four destinations
 * worth reaching one-handed go into a fixed bottom bar instead, and the agent switcher
 * moves to a sticky strip at the top. The configuration pages are reachable from the
 * Overview rather than from a hamburger nobody opens.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";

import { Wallet } from "../wallet";
import { useOwner, type OwnerAgent } from "./owner";
import { AgentFace, AgentMark, AgentStatus, Arrow, type AgentState } from "./ui";

interface ActiveValue {
  readonly agent: OwnerAgent;
  readonly refresh: () => Promise<void>;
  readonly call: <T>(path: string, init?: RequestInit) => Promise<T>;
}

const ActiveCtx = createContext<ActiveValue | null>(null);

/** The agent this page is about. Only callable inside `AgentShell`. */
export function useActiveAgent(): ActiveValue {
  const value = useContext(ActiveCtx);
  if (value === null) throw new Error("useActiveAgent must be used inside AgentShell.");
  return value;
}

const PRIMARY = [
  { slug: "", label: "Overview", ready: true },
  { slug: "chat", label: "Chat", ready: false },
  { slug: "opportunities", label: "Opportunities", ready: false },
  { slug: "launches", label: "Launches", ready: true },
  { slug: "wallet", label: "Wallet", ready: true },
  { slug: "activity", label: "Activity", ready: true },
] as const;

const AGENT = [
  { slug: "objective", label: "Objective", ready: false },
  { slug: "skills", label: "Skills", ready: false },
  { slug: "permissions", label: "Permissions", ready: true },
  { slug: "memory", label: "Memory", ready: false },
] as const;

const CREATE = [
  { slug: "instant", label: "Instant", ready: false },
  { slug: "programmable", label: "Programmable", ready: false },
] as const;

const INTEGRATIONS = [
  { slug: "telegram", label: "Telegram", ready: false },
  { slug: "keys", label: "API Keys", ready: true },
] as const;

export function AgentShell({
  username,
  children,
}: {
  readonly username: string;
  readonly children: ReactNode;
}) {
  const owner = useOwner();

  if (owner.phase === "connecting") {
    return <Waiting note="looking for your wallet" />;
  }

  if (owner.phase === "disconnected") {
    return (
      <Doorway
        lead="Connect the wallet that owns this agent."
        body="An agent is controlled by one address. Nothing here is readable without proving you hold it."
        action={<Wallet />}
      />
    );
  }

  if (owner.phase === "unsigned" || owner.phase === "signing") {
    return (
      <Doorway
        lead="Sign in to open the agent environment."
        body="One signature, nothing spent, and it lasts as long as this tab stays open."
        action={
          <button
            type="button"
            className="ag-go"
            disabled={owner.phase === "signing"}
            onClick={() => void owner.signIn()}
          >
            {owner.phase === "signing" ? "waiting for signature…" : "Sign in"}
            {owner.phase === "signing" ? null : <Arrow />}
          </button>
        }
        error={owner.error}
      />
    );
  }

  if (owner.phase === "loading") {
    return <Waiting note="loading agents" />;
  }

  const agent = owner.agents.find((row) => row.username === username);

  if (agent === undefined) {
    return (
      <Doorway
        lead={`No agent @${username} on this wallet.`}
        body={
          owner.agents.length === 0
            ? "This wallet does not own an agent yet."
            : "It may belong to a different address, or it may have been archived."
        }
        action={
          <Link className="ag-go" href={owner.agents.length === 0 ? "/agents/create" : `/agents/@${owner.agents[0]!.username}`}>
            {owner.agents.length === 0 ? "Create an agent" : "Go to your agent"}
            <Arrow />
          </Link>
        }
      />
    );
  }

  return (
    <ActiveCtx.Provider value={{ agent, refresh: owner.refresh, call: owner.call }}>
      <div className="ag-shell">
        <aside className="ag-side">
          <div className="ag-side-top">
            <AgentSwitcher agents={owner.agents} active={agent} />
          </div>

          <Nav agent={agent} />

          <div className="ag-side-foot">
            <Link href="/">← return to agen.space</Link>
          </div>
        </aside>

        <MobileTop agents={owner.agents} active={agent} />

        <main className="ag-main">{children}</main>

        <MobileTabs username={agent.username} />
      </div>
    </ActiveCtx.Provider>
  );
}

function Nav({ agent }: { readonly agent: OwnerAgent }) {
  return (
    <nav className="ag-nav">
      <Group items={PRIMARY} username={agent.username} />
      <p className="ag-nav-label">Agent</p>
      <Group items={AGENT} username={agent.username} />
      <p className="ag-nav-label">Create</p>
      <Group items={CREATE} username={agent.username} />
      <p className="ag-nav-label">Integrations</p>
      <Group items={INTEGRATIONS} username={agent.username} />
    </nav>
  );
}

function Group({
  items,
  username,
}: {
  readonly items: readonly { readonly slug: string; readonly label: string; readonly ready: boolean }[];
  readonly username: string;
}) {
  const pathname = usePathname();
  const base = `/agents/@${username}`;

  return (
    <>
      {items.map((item) => {
        const href = item.slug === "" ? base : `${base}/${item.slug}`;
        const current = decodeURIComponent(pathname) === href;
        return (
          <Link key={item.label} href={href} aria-current={current ? "page" : undefined}>
            {item.label}
            {item.ready ? null : <span className="ag-nav-soon">soon</span>}
          </Link>
        );
      })}
    </>
  );
}

/**
 * The switcher runs on the owner's real agent list, which the API has always returned in
 * full — multiple agents per wallet was never a limitation of the backend, only something
 * the old single-page desk had no way to express.
 */
function AgentSwitcher({
  agents,
  active,
}: {
  readonly agents: readonly OwnerAgent[];
  readonly active: OwnerAgent;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent) => {
      if (box.current !== null && !box.current.contains(event.target as Node)) setOpen(false);
    };
    const esc = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  const others = useMemo(() => agents.filter((row) => row.id !== active.id), [agents, active.id]);

  return (
    <div className="ag-switch" ref={box}>
      <button
        type="button"
        className="ag-switch-face"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((was) => !was)}
      >
        <AgentFace name={active.name} imageUrl={active.imageUrl} />
        <span className="ag-switch-id">
          <strong>{active.name}</strong>
          <em>@{active.username}</em>
        </span>
        <svg className="ag-switch-chev" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
          <path d="m4.5 6.5 3.5 3.5 3.5-3.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open ? (
        <div className="ag-switch-menu" role="menu">
          {others.map((row) => (
            <Link
              key={row.id}
              role="menuitem"
              className="ag-switch-item"
              href={`/agents/@${row.username}`}
              onClick={() => setOpen(false)}
            >
              <AgentFace name={row.name} imageUrl={row.imageUrl} />
              <span>{row.name}</span>
            </Link>
          ))}
          <Link className="ag-switch-new" href="/agents/create" onClick={() => setOpen(false)}>
            Create agent
          </Link>
        </div>
      ) : null}
    </div>
  );
}

function MobileTop({
  agents,
  active,
}: {
  readonly agents: readonly OwnerAgent[];
  readonly active: OwnerAgent;
}) {
  return (
    <div className="ag-mobile-top">
      <AgentSwitcher agents={agents} active={active} />
      <AgentStatus state={active.status as AgentState} />
    </div>
  );
}

function MobileTabs({ username }: { readonly username: string }) {
  const pathname = usePathname();
  const base = `/agents/@${username}`;
  const tabs = [
    { href: base, label: "Overview", icon: <IconGrid /> },
    { href: `${base}/chat`, label: "Chat", icon: <IconChat /> },
    { href: `${base}/opportunities`, label: "Ideas", icon: <IconSpark /> },
    { href: `${base}/launches`, label: "Launches", icon: <IconArrowUp /> },
  ];

  return (
    <nav className="ag-tabs">
      {tabs.map((tab) => (
        <Link
          key={tab.href}
          href={tab.href}
          aria-current={decodeURIComponent(pathname) === tab.href ? "page" : undefined}
        >
          {tab.icon}
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}

/** The signed-out and in-between screens. Same furniture, so the environment never blinks. */
function Doorway({
  lead,
  body,
  action,
  error,
}: {
  readonly lead: string;
  readonly body: string;
  readonly action: ReactNode;
  readonly error?: string | null;
}) {
  return (
    <div className="ag-gate">
      <div className="ag-gate-top">
        <AgentMark />
        <Link className="ag-gate-back" href="/agents">
          ← gate
        </Link>
      </div>
      <div className="ag-gate-mid">
        <p className="ag-gate-lead">{lead}</p>
        <p className="ag-gate-sub">{body}</p>
        <div className="ag-gate-acts">{action}</div>
        {error === null || error === undefined ? null : <p className="ag-note ag-note-bad">{error}</p>}
      </div>
    </div>
  );
}

function Waiting({ note }: { readonly note: string }) {
  return (
    <div className="ag-gate">
      <div className="ag-gate-top">
        <AgentMark />
      </div>
      <div className="ag-gate-mid">
        <p className="ag-gate-note">{note}…</p>
      </div>
    </div>
  );
}

function IconGrid() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <rect x="3" y="3" width="6" height="6" rx="1.6" />
      <rect x="11" y="3" width="6" height="6" rx="1.6" />
      <rect x="3" y="11" width="6" height="6" rx="1.6" />
      <rect x="11" y="11" width="6" height="6" rx="1.6" />
    </svg>
  );
}

function IconChat() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path d="M3.5 6.5A2.5 2.5 0 0 1 6 4h8a2.5 2.5 0 0 1 2.5 2.5v5A2.5 2.5 0 0 1 14 14H8l-4 3v-3a.5.5 0 0 1-.5-.5Z" strokeLinejoin="round" />
    </svg>
  );
}

function IconSpark() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path d="M10 3l1.7 4.3L16 9l-4.3 1.7L10 15l-1.7-4.3L4 9l4.3-1.7Z" strokeLinejoin="round" />
    </svg>
  );
}

function IconArrowUp() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path d="M10 16V5m0 0L5.5 9.5M10 5l4.5 4.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
