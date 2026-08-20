import "server-only";

/**
 * Signing somebody in with X, in two halves.
 *
 * The point of this flow is narrow: establish which X account a visitor controls, so that the
 * launches recorded against that id can be shown to them and the seat holding their fees can be
 * offered to their wallet. Nothing else. The scopes are read-only, the access token is used once
 * and dropped, and no credential capable of acting as the visitor is ever stored.
 *
 * ## PKCE, and why the state lives in the database
 *
 * The verifier is generated here, kept server-side against a random `state`, and required at the
 * exchange. Two attacks that closes: a code intercepted in a redirect is useless without the
 * verifier, and a callback arriving with a `state` this server never issued is refused rather
 * than processed. The store's row is single-use — `takeOauthState` deletes as it reads — so a
 * replayed callback fails on the second attempt.
 */

import { createHash, randomBytes } from "node:crypto";

import { authorizeUrl, exchangeCodeForIdentity } from "./client";
import { oauthCredentials } from "./config";
import { XError } from "./errors";
import { encodeXSession, sessionExpiry } from "./session";
import { xStore, type XStore } from "./store";
import type { XIdentity } from "./types";

/** Five minutes. Long enough to sign in, short enough that an abandoned attempt expires. */
const STATE_TTL_SECONDS = 5 * 60;

function base64url(bytes: Buffer): string {
  return bytes.toString("base64url");
}

export interface SignInStart {
  readonly url: string;
  readonly state: string;
}

/** Begin a sign-in: mint a verifier, remember it, and say where to send the visitor. */
export function beginSignIn(store: XStore = xStore()): SignInStart {
  const credentials = oauthCredentials();
  if (credentials === null) {
    throw new XError(
      "CONFIG_MISSING",
      "Signing in with X is not configured. X_OAUTH_CLIENT_ID and a redirect URI are needed.",
    );
  }

  const state = base64url(randomBytes(24));
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());

  store.putOauthState(state, verifier, Math.floor(Date.now() / 1000) + STATE_TTL_SECONDS);

  return { url: authorizeUrl({ credentials, state, challenge }), state };
}

export interface SignInResult {
  readonly identity: XIdentity;
  readonly token: string;
  readonly expiresAt: number;
}

/**
 * Finish a sign-in.
 *
 * The identity comes from X's own `users/me`, which is what makes it a verification rather than
 * an assertion — the visitor never tells Agen who they are. The handle is refreshed in the store
 * on the way through, so a creator who renamed themselves is displayed correctly while their
 * launches stay keyed to the id that has not changed.
 */
export async function completeSignIn(
  { code, state }: { readonly code: string; readonly state: string },
  store: XStore = xStore(),
): Promise<SignInResult> {
  const held = store.takeOauthState(state);
  if (held === null) {
    throw new XError("UNAUTHENTICATED", "That sign-in has expired or was already used.");
  }
  if (held.expiresAt < Math.floor(Date.now() / 1000)) {
    throw new XError("UNAUTHENTICATED", "That sign-in took too long. Start again.");
  }

  const author = await exchangeCodeForIdentity({ code, verifier: held.verifier });

  const identity: XIdentity = {
    xUserId: author.id,
    xUsername: author.username,
    name: author.name,
    avatarUrl: author.avatarUrl,
  };

  store.touchIdentity(identity.xUserId, identity.xUsername);

  const expiresAt = sessionExpiry();
  return { identity, token: encodeXSession(identity, expiresAt), expiresAt };
}
