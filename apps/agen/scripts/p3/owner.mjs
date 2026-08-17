/**
 * An owner session against a live deployment, and whatever call the acceptance run
 * needs next.
 *
 * The signing key is read from a file rather than an argument or an environment
 * variable, so it stays out of argv, out of the process environment and out of
 * shell history. Everything here is the same HTTP the browser makes.
 *
 *   node scripts/p3/owner.mjs <base-url> <method> <path> [json-body]
 */

import { readFileSync } from "node:fs";

import { privateKeyToAccount } from "viem/accounts";

const [, , base = "https://agen.space", method = "GET", path = "/api/v1/owner/agents", body] = process.argv;

const account = privateKeyToAccount(readFileSync("/tmp/agen-p3/owner.key", "utf8").trim());

async function post(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return { status: response.status, body: await response.json() };
}

const challenge = await post(`${base}/api/v1/owner/challenge`, { address: account.address });
if (challenge.status !== 200) {
  console.error("challenge failed", JSON.stringify(challenge));
  process.exit(1);
}

const { nonce, message } = challenge.body.data;
const signature = await account.signMessage({ message });

const session = await post(`${base}/api/v1/owner/session`, {
  address: account.address,
  nonce,
  signature,
});
if (session.status !== 200) {
  console.error("session failed", JSON.stringify(session));
  process.exit(1);
}

const token = session.body.data.token;
console.error(`owner ${account.address} authenticated against ${base}`);

const response = await fetch(`${base}${path}`, {
  method,
  headers: {
    authorization: `Bearer ${token}`,
    ...(body === undefined ? {} : { "content-type": "application/json" }),
  },
  ...(body === undefined ? {} : { body }),
});

console.error(`${method} ${path} -> ${String(response.status)}`);

// A route that does not exist answers with Next's HTML 404, and printing a page of
// markup to say "not deployed yet" buries the one fact that matters.
const raw = await response.text();
try {
  console.log(JSON.stringify(JSON.parse(raw), null, 2));
} catch {
  console.log(raw.trimStart().startsWith("<") ? "(HTML — this route is not deployed)" : raw.slice(0, 400));
}
