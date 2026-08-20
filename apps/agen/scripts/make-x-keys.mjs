/**
 * Mint the two platform keys the X bot needs, straight into .env.local.
 *
 *   node scripts/make-x-keys.mjs
 *
 * Deliberately prints addresses and never private keys. The addresses are public by
 * construction — they will be the `from` of every sponsored launch and the occupant of every
 * unclaimed seat — but a private key echoed to a terminal ends up in scrollback, logs and
 * screenshots, and one of these two keys can never be rotated: `X_CREATOR_SEAT_OPENER_ADDRESS`
 * is an input to the CREATE2 salt behind every creator's seat, so changing it renames every
 * seat and strands every unclaimed entitlement. See docs/decisions/017.
 *
 * Refuses to overwrite either key. Generating a second opener over a live one is the exact
 * mistake that cannot be undone.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const here = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(here, "../.env.local");

const existing = readFileSync(envPath, "utf8");

const already = ["X_SPONSOR_PRIVATE_KEY", "X_CREATOR_SEAT_OPENER_PRIVATE_KEY"].filter((name) =>
  new RegExp(`^${name}=`, "m").test(existing),
);

if (already.length > 0) {
  console.error(`Refusing to run: ${already.join(" and ")} already set in .env.local.`);
  console.error("Remove them by hand if you really mean to replace them, and read the note about the opener first.");
  process.exit(1);
}

const sponsor = generatePrivateKey();
const opener = generatePrivateKey();
const sponsorAddress = privateKeyToAccount(sponsor).address;
const openerAddress = privateKeyToAccount(opener).address;

const block = `
# ---------------------------------------------------------------------------
# The two launch keys, generated ${new Date().toISOString().slice(0, 10)} by scripts/make-x-keys.mjs.
#
# Separate on purpose, and the reason is in docs/decisions/017. The sponsor pays gas and
# submits launches, so it is a hot wallet that should be rotatable. The opener is the initial
# occupant of every creator seat and is an input to the seat's CREATE2 address, so rotating it
# renames every seat and strands every unclaimed entitlement. Keeping them apart is what makes
# the sponsor safe to rotate.
#
# Neither is allowed to sign anything generic. sponsor.ts holds each to a function selector and
# destination allowlist: the sponsor may only reach InstantFactory, CreatorSeatFactory, and
# collect/sweep on a verified seat; the opener may only reach offer/withdrawOffer on one.
#
# The stated addresses are not redundant. sponsor.ts refuses to start if a key does not match
# the address next to it, which turns a pasted-wrong key into a boot failure instead of a
# launch from an unfunded wallet or a seat nobody can hand over.
# ---------------------------------------------------------------------------
X_SPONSOR_PRIVATE_KEY=${sponsor}
X_SPONSOR_ADDRESS=${sponsorAddress}
X_CREATOR_SEAT_OPENER_PRIVATE_KEY=${opener}
X_CREATOR_SEAT_OPENER_ADDRESS=${openerAddress}
`;

writeFileSync(envPath, `${existing.replace(/\s*$/, "")}\n${block}`, "utf8");

console.log("Written to apps/agen/.env.local (gitignored). Private keys were not printed.\n");
console.log(`  sponsor      ${sponsorAddress}`);
console.log(`  seat opener  ${openerAddress}\n`);
console.log("Fund both on Robinhood Chain 4663. The sponsor pays for every launch; the opener");
console.log("only pays for handover calls when a creator claims, so it needs far less.");
