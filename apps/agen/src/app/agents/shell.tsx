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
 * Three groups and ten entries. The brief asked for a narrow product and the fastest way
 * to lose that is a rail that accepts every idea anybody has, so the rail lists what an
 * owner comes here to do and nothing else. Several entries lead to pages that are not
 * built; they are still the shape of the product and still worth listing, and each of
 * those pages says plainly that it is not built rather than showing an empty chart.
 *
 * The `soon` tags that used to sit beside them are gone. Fourteen small grey words in a
 * column with four smaller grey words scattered among them is a rail that has to be read;
 * without them it can be scanned, and nothing is claimed that the destination does not
 * immediately correct.
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

interface Entry {
  readonly slug: string;
  readonly label: string;
  readonly icon: ReactNode;
}

const PRIMARY: readonly Entry[] = [
  { slug: "", label: "Overview", icon: <IconGrid /> },
  { slug: "chat", label: "Chat", icon: <IconChat /> },
  { slug: "opportunities", label: "Opportunities", icon: <IconGlass /> },
  { slug: "launches", label: "Launches", icon: <IconRise /> },
  { slug: "wallet", label: "Wallet", icon: <IconWallet /> },
  { slug: "activity", label: "Activity", icon: <IconPulse /> },
];

const AGENT: readonly Entry[] = [
  { slug: "objective", label: "Objective", icon: <IconLines /> },
  { slug: "permissions", label: "Permissions", icon: <IconShield /> },
  { slug: "memory", label: "Memory", icon: <IconMemory /> },
];

const INTEGRATIONS: readonly Entry[] = [{ slug: "keys", label: "API Key", icon: <IconKey /> }];

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
      <div className="ag-shell ag-night">
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
      <p className="ag-nav-label">Integrations</p>
      <Group items={INTEGRATIONS} username={agent.username} />
    </nav>
  );
}

function Group({
  items,
  username,
}: {
  readonly items: readonly Entry[];
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
            {item.icon}
            <span>{item.label}</span>
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
    { href: `${base}/opportunities`, label: "Ideas", icon: <IconGlass /> },
    { href: `${base}/launches`, label: "Launches", icon: <IconRise /> },
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
    <div className="ag-gate ag-night">
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
    <div className="ag-gate ag-night">
      <div className="ag-gate-top">
        <AgentMark />
      </div>
      <div className="ag-gate-mid">
        <p className="ag-gate-note">{note}…</p>
      </div>
    </div>
  );
}

/*
 * One hairline weight, one 20-unit box, no fills.
 *
 * They are drawn here rather than pulled from a set because a set arrives with its own
 * weight and its own idea of a corner radius, and eleven icons that disagree with the type
 * beside them is worse than no icons at all. Each one is the plainest possible reading of
 * its word: the wallet is a card with a pocket, memory is a chip, and none of them are
 * asked to be clever about it.
 */
function IconGrid() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" aria-hidden="true">
      <rect x="3.2" y="3.2" width="6" height="6" rx="1.6" />
      <rect x="10.8" y="3.2" width="6" height="6" rx="1.6" />
      <rect x="3.2" y="10.8" width="6" height="6" rx="1.6" />
      <rect x="10.8" y="10.8" width="6" height="6" rx="1.6" />
    </svg>
  );
}

function IconChat() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" aria-hidden="true">
      <path
        d="M3.4 7.2A3 3 0 0 1 6.4 4.2h7.2a3 3 0 0 1 3 3v3.6a3 3 0 0 1-3 3H8.2L4.4 16.4v-2.9a3 3 0 0 1-1-2.2Z"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconGlass() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" aria-hidden="true">
      <circle cx="9" cy="9" r="4.9" />
      <path d="m12.7 12.7 3.5 3.5" strokeLinecap="round" />
    </svg>
  );
}

function IconRise() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" aria-hidden="true">
      <path d="M3.4 13.6 8 9l3 3 5.2-5.2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M12.6 6.8h3.6v3.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconWallet() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" aria-hidden="true">
      <rect x="3" y="5.2" width="14" height="10.6" rx="2.4" />
      <path d="M13.2 10.5h3.8" strokeLinecap="round" />
    </svg>
  );
}

function IconPulse() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" aria-hidden="true">
      <path d="M2.8 10.4h3.1L8 5.6l3.2 8.8 2-4h4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconLines() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" aria-hidden="true">
      <path d="M3.6 5.6h12.8M3.6 10h9M3.6 14.4h5.4" strokeLinecap="round" />
    </svg>
  );
}

function IconShield() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" aria-hidden="true">
      <path d="M10 3.2 4.6 5.4v4.2c0 3.2 2.2 5.8 5.4 7 3.2-1.2 5.4-3.8 5.4-7V5.4Z" strokeLinejoin="round" />
    </svg>
  );
}

function IconMemory() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" aria-hidden="true">
      <rect x="5.4" y="5.4" width="9.2" height="9.2" rx="1.8" />
      <path d="M8.4 3v2.4M11.6 3v2.4M8.4 14.6V17M11.6 14.6V17M3 8.4h2.4M3 11.6h2.4M14.6 8.4H17M14.6 11.6H17" strokeLinecap="round" />
    </svg>
  );
}

function IconKey() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" aria-hidden="true">
      <circle cx="7.2" cy="7.2" r="3.4" />
      <path d="m9.7 9.7 6 6M13.2 13.2l-1.6 1.6M15.2 15.2l-1.6 1.6" strokeLinecap="round" />
    </svg>
  );
}
