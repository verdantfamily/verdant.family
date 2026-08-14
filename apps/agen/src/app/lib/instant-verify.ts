import "server-only";

/**
 * Source verification for a launched Instant token.
 *
 * An unverified token is a token whose holders have to take somebody's word for what it
 * does. Instant's whole claim is that the contract is standard — no mint, no owner, no
 * pause, immutable metadata — and that claim is only checkable on an explorer showing the
 * source. So verification is part of launching, not a favour the creator does afterwards.
 *
 * ## Off-chain, after the fact, and unable to affect the launch
 *
 * Nothing here signs anything or touches the chain except to read. It runs after the
 * launch transaction has already mined, from a route that answers before the work starts,
 * so a Blockscout outage produces a token that is live and unverified rather than a launch
 * that appears to have failed. There is no path from this file back into the transaction.
 *
 * ## Why the arguments come from the chain
 *
 * `VerdantToken` takes six constructor arguments and exposes all six as getters. Reading
 * them back off the deployed token means the verification payload is derived from what was
 * actually deployed rather than from what a caller says was deployed — which is also what
 * makes this route safe to expose: it cannot be pointed at a contract to verify it as
 * something it is not, because the arguments would not match the bytecode and Blockscout
 * would refuse.
 *
 * ## Why the compiler input is a file
 *
 * Every Instant token is the same contract, so the Standard JSON Input is a constant. It
 * is committed under `packages/contracts/verification` and read from disk — see the README
 * there for why generating it per launch would be both slower and less trustworthy.
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { encodeAbiParameters, getAddress, type Address } from "viem";

import { publicClient } from "./onchain";

/**
 * The checkout, derived exactly as `lib/builds.ts` derives it.
 *
 * Repeated rather than imported: that module is `server-only` and pulls in the whole
 * generation pipeline, and this file needs one path from it. `AGEN_REPO_ROOT=/app` in the
 * container, and the working directory otherwise.
 */
const REPO_ROOT = process.env["AGEN_REPO_ROOT"] ?? resolve(process.cwd(), "../..");

/** Where Robinhood's Blockscout lives. Chain 4663 is not indexed by Etherscan. */
const EXPLORER = "https://robinhoodchain.blockscout.com";

/** The exact compiler this deployment was built with. See `foundry.toml`. */
const COMPILER = "v0.8.26+commit.8a97fa7a";

/** `VerdantToken` carries an MIT header, and Blockscout wants the licence named. */
const LICENCE = "mit";

const STANDARD_INPUT = resolve(
  REPO_ROOT,
  "packages/contracts/verification/VerdantToken.standard.json",
);

/**
 * How long to keep trying, and how patiently.
 *
 * The first attempt usually fails and should: Blockscout indexes a block a moment after
 * the node has it, and a contract it has not seen cannot be verified. Backing off across
 * roughly two minutes covers that gap without hammering an explorer that rate-limits
 * aggressively — which it does, and which is itself a reason to give up quietly rather
 * than retry forever.
 */
const DELAYS_MS = [3_000, 6_000, 12_000, 25_000, 40_000, 60_000] as const;

export type VerifyOutcome =
  | { readonly status: "verified"; readonly attempts: number }
  | { readonly status: "already" }
  | { readonly status: "failed"; readonly reason: string; readonly attempts: number };

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

/**
 * Whether Blockscout already holds source for this address.
 *
 * Detected by the presence of `source_code` rather than a flag, because that is what the
 * response actually distinguishes: an unverified contract comes back as bytecode and
 * nothing else, with no field saying so.
 */
export async function isVerified(address: Address): Promise<boolean> {
  try {
    const response = await fetch(`${EXPLORER}/api/v2/smart-contracts/${address}`, {
      signal: AbortSignal.timeout(8_000),
      cache: "no-store",
    });
    if (!response.ok) return false;

    const body = (await response.json()) as { source_code?: unknown };
    return typeof body.source_code === "string" && body.source_code.length > 0;
  } catch {
    return false;
  }
}

/**
 * The six arguments the token was constructed with, read off the token.
 *
 * ABI-encoded rather than handed over as fields, because that is what the explorer
 * compares against the tail of the creation bytecode. `InstantVerify.test.ts` is not the
 * check that this is right — the deployed bytecode is: an encoding that did not match
 * would fail verification rather than verify something wrong.
 */
async function constructorArgs(token: Address): Promise<`0x${string}`> {
  const client = publicClient();

  const string_ = (name: string) =>
    client.readContract({
      address: token,
      abi: [{ type: "function", name, inputs: [], outputs: [{ type: "string" }], stateMutability: "view" }],
      functionName: name,
    }) as Promise<string>;

  const [name, symbol, supply, creator, metadataURI, metadataMutable] = await Promise.all([
    string_("name"),
    string_("symbol"),
    client.readContract({
      address: token,
      abi: [{ type: "function", name: "totalSupply", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" }],
      functionName: "totalSupply",
    }) as Promise<bigint>,
    client.readContract({
      address: token,
      abi: [{ type: "function", name: "creator", inputs: [], outputs: [{ type: "address" }], stateMutability: "view" }],
      functionName: "creator",
    }) as Promise<Address>,
    string_("metadataURI"),
    client.readContract({
      address: token,
      abi: [{ type: "function", name: "metadataMutable", inputs: [], outputs: [{ type: "bool" }], stateMutability: "view" }],
      functionName: "metadataMutable",
    }) as Promise<boolean>,
  ]);

  return encodeAbiParameters(
    [
      { type: "string" },
      { type: "string" },
      { type: "uint256" },
      { type: "address" },
      { type: "string" },
      { type: "bool" },
    ],
    [name, symbol, supply, creator, metadataURI, metadataMutable],
  );
}

/** One submission. Returns null on success, or why it was refused. */
async function submit(token: Address, args: `0x${string}`, input: string): Promise<string | null> {
  const form = new FormData();
  form.set("compiler_version", COMPILER);
  form.set("license_type", LICENCE);
  // Leading `0x` removed: the explorer wants the words, not a hex literal.
  form.set("constructor_args", args.slice(2));
  form.set("autodetect_constructor_args", "false");
  form.set(
    "files[0]",
    new Blob([input], { type: "application/json" }),
    "VerdantToken.standard.json",
  );

  try {
    const response = await fetch(
      `${EXPLORER}/api/v2/smart-contracts/${token}/verification/via/standard-input`,
      { method: "POST", body: form, signal: AbortSignal.timeout(20_000) },
    );

    if (response.ok) return null;

    const text = await response.text();
    return `${String(response.status)} ${text.slice(0, 200)}`;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * Verify a token, waiting for the explorer to catch up if it has to.
 *
 * Never throws. Every failure is a returned value, because the caller is a detached job
 * whose only options are to log it or to swallow it, and an exception crossing that
 * boundary would be an unhandled rejection in a web server that is otherwise fine.
 */
export async function verifyInstantToken(token: string): Promise<VerifyOutcome> {
  const address = getAddress(token);

  if (await isVerified(address)) return { status: "already" };

  let input: string;
  let args: `0x${string}`;
  try {
    [input, args] = await Promise.all([readFile(STANDARD_INPUT, "utf8"), constructorArgs(address)]);
  } catch (error) {
    return {
      status: "failed",
      attempts: 0,
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  let last = "not attempted";

  for (const [index, delay] of DELAYS_MS.entries()) {
    await sleep(delay);

    // Checked again each round: a second launch of the same token cannot happen, but a
    // parallel job for the same address can, and submitting over a verified contract is
    // an error the explorer reports rather than a no-op.
    if (await isVerified(address)) return { status: "verified", attempts: index + 1 };

    const refused = await submit(address, args, input);
    if (refused === null) {
      // Accepted for processing, which is not the same as done. The status read is what
      // turns "submitted" into "verified".
      await sleep(4_000);
      if (await isVerified(address)) return { status: "verified", attempts: index + 1 };
      last = "accepted, not yet reflected";
      continue;
    }

    last = refused;
  }

  return { status: "failed", reason: last, attempts: DELAYS_MS.length };
}
