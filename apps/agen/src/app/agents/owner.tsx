"use client";

/**
 * Who is looking, for the whole environment.
 *
 * The server has no cookie and no session for `/agents`; the only proof of ownership is
 * a signature, and the API that follows is bearer-authenticated. That was already true
 * of the old single-page desk, which kept its token in a `useState` beside the form.
 * This lifts exactly that logic to the layout so it survives navigation between the
 * shell's pages, and adds nothing to it — same challenge endpoint, same message, same
 * session endpoint, same header.
 *
 * ## Why the token stays in memory
 *
 * Not `localStorage`, not `sessionStorage`, not a cookie. This was weighed and settled
 * rather than defaulted into: a reload asks for a signature again, which is worse to use
 * and much easier to reason about, because the credential exists only for as long as the
 * tab has this React tree mounted — which is what the sign-in copy has always promised.
 * Persisting it would widen the blast radius of a script injection to every session a
 * browser has ever held, and the cost of not persisting it is one extra signature.
 *
 * Revisit this only alongside a deliberate decision about token lifetime and revocation,
 * never as a convenience while building something else.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useAccount, useSignMessage } from "wagmi";

export interface OwnerAgent {
  readonly id: string;
  readonly username: string;
  readonly name: string;
  readonly description: string;
  readonly imageUrl: string | null;
  readonly walletAddress: string;
  readonly status: string;
}

export type OwnerPhase =
  | "connecting"
  | "disconnected"
  | "unsigned"
  | "signing"
  | "loading"
  | "ready";

interface OwnerValue {
  readonly phase: OwnerPhase;
  readonly address: string | undefined;
  readonly agents: readonly OwnerAgent[];
  readonly error: string | null;
  readonly signIn: () => Promise<void>;
  readonly refresh: () => Promise<void>;
  /** Authenticated call against `/api/v1/owner/*`. Throws when there is no session. */
  readonly call: <T>(path: string, init?: RequestInit) => Promise<T>;
}

const Ctx = createContext<OwnerValue | null>(null);

export function useOwner(): OwnerValue {
  const value = useContext(Ctx);
  if (value === null) throw new Error("useOwner must be used inside OwnerProvider.");
  return value;
}

export function OwnerProvider({ children }: { readonly children: ReactNode }) {
  const { address, status } = useAccount();
  const sign = useSignMessage();

  const [token, setToken] = useState<string | null>(null);
  const [agents, setAgents] = useState<readonly OwnerAgent[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A different wallet is a different owner, so the session issued to the last one stops
  // being about anybody who is here.
  useEffect(() => {
    setToken(null);
    setAgents([]);
    setLoaded(false);
  }, [address]);

  const call = useCallback(
    async <T,>(path: string, init: RequestInit = {}): Promise<T> => {
      if (token === null) throw new Error("Sign in to manage agents.");
      const response = await fetch(path, {
        ...init,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
          ...(init.headers ?? {}),
        },
      });
      const body = (await response.json()) as {
        ok?: boolean;
        data?: T;
        error?: { message?: string };
      };
      if (!response.ok || body.ok === false || body.data === undefined) {
        throw new Error(body.error?.message ?? "That request failed.");
      }
      return body.data;
    },
    [token],
  );

  const load = useCallback(async (session: string) => {
    const response = await fetch("/api/v1/owner/agents", {
      headers: { authorization: `Bearer ${session}` },
    });
    const body = (await response.json()) as { data?: { agents?: OwnerAgent[] } };
    setAgents((body.data?.agents ?? []).filter((agent) => agent.status !== "archived"));
    setLoaded(true);
  }, []);

  const refresh = useCallback(async () => {
    if (token === null) return;
    await load(token);
  }, [token, load]);

  const signIn = useCallback(async () => {
    if (address === undefined) return;
    setError(null);
    setBusy(true);
    try {
      const challengeRes = await fetch("/api/v1/owner/challenge", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address }),
      });
      const challenge = (await challengeRes.json()) as {
        data?: { message?: string; nonce?: string };
        error?: { message?: string };
      };
      if (challenge.data?.message === undefined || challenge.data.nonce === undefined) {
        throw new Error(challenge.error?.message ?? "Could not start a session.");
      }

      const signature = await sign.signMessageAsync({ message: challenge.data.message });

      const sessionRes = await fetch("/api/v1/owner/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address, nonce: challenge.data.nonce, signature }),
      });
      const session = (await sessionRes.json()) as {
        data?: { token?: string };
        error?: { message?: string };
      };
      if (session.data?.token === undefined) {
        throw new Error(session.error?.message ?? "The session could not be created.");
      }

      setToken(session.data.token);
      await load(session.data.token);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not sign in.");
    } finally {
      setBusy(false);
    }
  }, [address, sign, load]);

  const phase: OwnerPhase =
    status === "connecting" || status === "reconnecting"
      ? "connecting"
      : address === undefined
        ? "disconnected"
        : busy
          ? "signing"
          : token === null
            ? "unsigned"
            : loaded
              ? "ready"
              : "loading";

  const value = useMemo<OwnerValue>(
    () => ({ phase, address, agents, error, signIn, refresh, call }),
    [phase, address, agents, error, signIn, refresh, call],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
