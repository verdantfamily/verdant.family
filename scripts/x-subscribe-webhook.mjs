import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function loadLocalEnv() {
  const path = resolve(import.meta.dirname, "../apps/agen/.env.local");
  const text = readFileSync(path, "utf8");
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const cut = trimmed.indexOf("=");
    if (cut < 1) continue;
    const key = trimmed.slice(0, cut);
    let value = trimmed.slice(cut + 1);
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadLocalEnv();

const {
  X_API_KEY,
  X_API_SECRET,
  X_ACCESS_TOKEN,
  X_ACCESS_SECRET,
  X_BEARER_TOKEN,
  X_BOT_USER_ID,
} = process.env;

const WEBHOOK_ID = process.env.X_WEBHOOK_ID ?? "2090571058831089664";

function oauthHeader(method, url) {
  const parsed = new URL(url);
  const params = {
    oauth_consumer_key: X_API_KEY,
    oauth_nonce: crypto.randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_token: X_ACCESS_TOKEN,
    oauth_version: "1.0",
  };
  const all = { ...params };
  for (const [k, v] of parsed.searchParams) all[k] = v;
  const enc = (s) =>
    encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  const normalised = Object.keys(all)
    .sort()
    .map((k) => `${enc(k)}=${enc(all[k])}`)
    .join("&");
  const base = [method.toUpperCase(), enc(`${parsed.origin}${parsed.pathname}`), enc(normalised)].join("&");
  const key = `${enc(X_API_SECRET)}&${enc(X_ACCESS_SECRET)}`;
  const signature = crypto.createHmac("sha1", key).update(base).digest("base64");
  const header = { ...params, oauth_signature: signature };
  return (
    "OAuth " +
    Object.keys(header)
      .sort()
      .map((k) => `${enc(k)}="${enc(header[k])}"`)
      .join(", ")
  );
}

async function call(label, method, url, { oauth = false, bearer = false, body } = {}) {
  const headers = {};
  if (oauth) headers.authorization = oauthHeader(method, url);
  if (bearer) headers.authorization = `Bearer ${X_BEARER_TOKEN}`;
  if (body) headers["content-type"] = "application/json";
  const res = await fetch(url, {
    method,
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  console.log(`=== ${label} ${res.status} ===`);
  console.log(text.slice(0, 800));
}

async function main() {
  await call(
    "AAA list",
    "GET",
    `https://api.x.com/2/account_activity/webhooks/${WEBHOOK_ID}/subscriptions/all/list`,
    { bearer: true },
  );
  await call(
    "AAA subscribe",
    "POST",
    `https://api.x.com/2/account_activity/webhooks/${WEBHOOK_ID}/subscriptions/all`,
    { oauth: true },
  );
  await call("activity list", "GET", "https://api.x.com/2/activity/subscriptions", { bearer: true });
  for (const event_type of ["dm.received", "post.mention.create"]) {
    await call(`activity ${event_type} oauth`, "POST", "https://api.x.com/2/activity/subscriptions", {
      oauth: true,
      body: {
        event_type,
        filter: { user_id: X_BOT_USER_ID },
        webhook_id: WEBHOOK_ID,
      },
    });
  }
  await call(
    "AAA list after",
    "GET",
    `https://api.x.com/2/account_activity/webhooks/${WEBHOOK_ID}/subscriptions/all/list`,
    { bearer: true },
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
