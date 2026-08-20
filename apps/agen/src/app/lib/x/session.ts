import "server-only";

/**
 * Who is signed in, when "who" is an X account rather than a wallet.
 *
 * The owner session in `agents/auth.ts` proves control of an address, which is the right proof
 * for somebody managing a treasury and the wrong one here: the person arriving at `/useagen`
 * launched a token from a reply and may not own a wallet at all. What they can prove is control
 * of an X account, and that is what this session holds.
 *
 * ## The subject is the id
 *
 * The signed payload carries the numeric X user id. The handle rides along for display and is
 * refreshed on every sign-in, because it is a setting: somebody who renames themselves must
 * still find their launches, and somebody who *takes* an abandoned handle must not.
 *
 * ## Why a cookie
 *
 * OAuth finishes with a redirect from X's servers, so the credential has to survive a browser
 * navigation that carries no JavaScript state. `HttpOnly`, `Secure`, `SameSite=Lax` — Lax
 * rather than Strict because the callback *is* a cross-site navigation and a Strict cookie set
 * there would not be sent on the redirect that follows it.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

import { masterKeyBytes } from "../agents/wallets";
import { XError } from "./errors";
import type { XIdentity } from "./types";

export const SESSION_COOKIE = "agen_x_session";

/** Twelve hours, matching the owner session. Long enough to claim, short enough to expire. */
const TTL_SECONDS = 60 * 60 * 12;

/**
 * The signing key.
 *
 * Derived from the wallet master key by default, so a deployment that can sign transactions can
 * also sign sessions and there is one secret to manage rather than two. `X_SESSION_SECRET`
 * overrides it for a deployment that runs the bot's web surface without the sponsor's key.
 */
function secret(): Buffer {
  const override = process.env.X_SESSION_SECRET?.trim();
  if (override !== undefined && /^[0-9a-fA-F]{64}$/.test(override)) {
    return Buffer.from(override, "hex");
  }
  return createHmac("sha256", masterKeyBytes()).update("agen.x.session.v1").digest();
}

interface Payload {
  /** The immutable X user id. */
  readonly sub: string;
  readonly un: string;
  readonly nm: string;
  readonly av: string | null;
  readonly exp: number;
}

export function encodeXSession(identity: XIdentity, expiresAt: number): string {
  const payload: Payload = {
    sub: identity.xUserId,
    un: identity.xUsername,
    nm: identity.name,
    av: identity.avatarUrl,
    exp: expiresAt,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", secret()).update(body).digest("base64url");
  return `axs_${body}.${signature}`;
}

export function sessionExpiry(): number {
  return Math.floor(Date.now() / 1000) + TTL_SECONDS;
}

/**
 * Read a session, or refuse.
 *
 * The signature is compared in constant time and *before* the payload is parsed, so a forged
 * token is rejected without its contents ever being interpreted.
 */
export function readXSession(token: string): XIdentity {
  if (!token.startsWith("axs_")) {
    throw new XError("UNAUTHENTICATED", "That is not an X session.");
  }

  const body = token.slice(4);
  const dot = body.lastIndexOf(".");
  if (dot < 0) throw new XError("UNAUTHENTICATED", "That session is malformed.");

  const claims = body.slice(0, dot);
  const signature = Buffer.from(body.slice(dot + 1));
  const expected = createHmac("sha256", secret()).update(claims).digest("base64url");
  const right = Buffer.from(expected);

  if (signature.length !== right.length || !timingSafeEqual(signature, right)) {
    throw new XError("UNAUTHENTICATED", "That session is not valid.");
  }

  let parsed: Partial<Payload>;
  try {
    parsed = JSON.parse(Buffer.from(claims, "base64url").toString("utf8")) as Partial<Payload>;
  } catch {
    throw new XError("UNAUTHENTICATED", "That session is malformed.");
  }

  if (typeof parsed.exp !== "number" || parsed.exp < Math.floor(Date.now() / 1000)) {
    throw new XError("UNAUTHENTICATED", "That session has expired.");
  }
  if (typeof parsed.sub !== "string" || !/^\d{1,25}$/.test(parsed.sub)) {
    throw new XError("UNAUTHENTICATED", "That session names no X account.");
  }

  return {
    xUserId: parsed.sub,
    xUsername: typeof parsed.un === "string" ? parsed.un : "",
    name: typeof parsed.nm === "string" ? parsed.nm : "",
    avatarUrl: typeof parsed.av === "string" ? parsed.av : null,
  };
}

/** The signed-in identity for a request, or a refusal. Cookie first, bearer for API clients. */
export function authenticateX(request: Request): XIdentity {
  const cookie = request.headers
    .get("cookie")
    ?.split(";")
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith(`${SESSION_COOKIE}=`));

  if (cookie !== undefined) {
    return readXSession(decodeURIComponent(cookie.slice(SESSION_COOKIE.length + 1)));
  }

  const header = request.headers.get("authorization");
  const bearer = header === null ? null : /^Bearer\s+(.+)$/i.exec(header.trim())?.[1]?.trim();
  if (bearer === undefined || bearer === null || bearer === "") {
    throw new XError("UNAUTHENTICATED", "Sign in with X to see your launches.");
  }

  return readXSession(bearer);
}

/** The `Set-Cookie` value for a session, and for clearing one. */
export function sessionCookie(token: string, expiresAt: number): string {
  const maxAge = Math.max(0, expiresAt - Math.floor(Date.now() / 1000));
  return [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    // Omitted on http so that a local deployment can sign in at all; every real deployment is
    // https, and `NEXT_PUBLIC_SITE_URL` is what says which this is.
    ...(process.env.NEXT_PUBLIC_SITE_URL?.startsWith("https://") === true ? ["Secure"] : []),
    `Max-Age=${String(maxAge)}`,
  ].join("; ");
}

export function clearedSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}
