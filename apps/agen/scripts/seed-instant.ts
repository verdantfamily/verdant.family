#!/usr/bin/env node
/**
 * A wallet that launches Instant tokens on a schedule.
 *
 * For seeding your own launchpad: real tokens, real transactions, real fees, paid for by a
 * key you control. Everything it does is what a creator does through `/launch/instant`, in
 * the same order and through the same endpoints, so a token it makes is indistinguishable
 * from a hand-made one *because it is one* — not because anything is being disguised.
 *
 * ## What it deliberately does not do
 *
 * It does not trade. It launches, optionally with the creator's own first buy, and stops.
 * Volume between wallets you own is not volume, and a chart shaped by it tells a stranger
 * something untrue about how much interest a token has — which is the one thing a
 * launchpad cannot be caught doing. Seeding a shelf with tokens is a content decision;
 * seeding a market with trades is a claim about demand.
 *
 * ## Safety rails, because this spends money in a loop
 *
 *   - A balance floor it will not go below, checked before every launch.
 *   - A maximum number of launches per run, so a runaway loop has a stopping point.
 *   - `--dry-run`, which does everything except send the transaction.
 *   - Interval jitter, so launches do not land on a metronome.
 *
 * It reads its key from the environment and never prints it. Verification of each token is
 * triggered through the site's own endpoint, which needs no key at all.
 *
 * ## Usage
 *
 *   SEED_PRIVATE_KEY=0x… \
 *   SEED_RPC_URL=https://… \
 *   node apps/agen/scripts/seed-instant.ts --count 5 --every 900 --buy 0.002
 *
 * Every option has an environment equivalent; see `settings` below.
 */

import { createHash, randomBytes } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { deflateSync } from "node:zlib";
import { extname, resolve } from "node:path";

import { BOUNDS, instantFor, robinhoodMainnet, ROBINHOOD_MAINNET_ID } from "@verdant/config";
import { abi, instant as instantSdk, launch as launchSdk } from "@verdant/sdk";
import {
  createPublicClient,
  createWalletClient,
  formatEther,
  http,
  parseEther,
  parseEventLogs,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

// --- what to do -------------------------------------------------------------------

function flag(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at < 0 ? undefined : process.argv[at + 1];
}

const settings = {
  /** Where the site is. Uploads go here, and so does the verification trigger. */
  site: (flag("site") ?? process.env["SEED_SITE"] ?? "https://agen.space").replace(/\/+$/, ""),
  rpc: process.env["SEED_RPC_URL"] ?? robinhoodMainnet.rpcUrls.default.http[0]!,
  /** How many to launch before stopping. A run always terminates. */
  count: Number(flag("count") ?? process.env["SEED_COUNT"] ?? 3),
  /** Seconds between launches, before jitter. */
  every: Number(flag("every") ?? process.env["SEED_EVERY"] ?? 900),
  /** The creator's own first buy, in ether. Zero opens the pool without buying. */
  buy: flag("buy") ?? process.env["SEED_BUY"] ?? "0",
  /** Never spend below this. Checked before every launch, not just at the start. */
  floor: flag("floor") ?? process.env["SEED_FLOOR"] ?? "0.01",
  /** A directory of images to pick from. Falls back to a generated mark. */
  images: flag("images") ?? process.env["SEED_IMAGES"],
  dryRun: process.argv.includes("--dry-run"),
} as const;

const key = process.env["SEED_PRIVATE_KEY"];
if (key === undefined || !/^0x[0-9a-fA-F]{64}$/.test(key)) {
  console.error("Set SEED_PRIVATE_KEY to a 32-byte hex key. It is never printed or sent.");
  process.exit(1);
}

/**
 * The deployment, or an exit.
 *
 * A function rather than a bare check, so the result is non-null to the type checker
 * inside the closures below — narrowing a module-level `const` does not reach them.
 */
function deployment(): NonNullable<ReturnType<typeof instantFor>> {
  const found = instantFor(ROBINHOOD_MAINNET_ID);
  if (found === null) {
    console.error("No Instant deployment is recorded for 4663.");
    process.exit(1);
  }
  return found;
}

const record = deployment();

const account = privateKeyToAccount(key as Hex);
const chain = { ...robinhoodMainnet, rpcUrls: { default: { http: [settings.rpc] } } };
const publicClient = createPublicClient({ chain, transport: http(settings.rpc) });
const wallet = createWalletClient({ account, chain, transport: http(settings.rpc) });

// --- what to call them ------------------------------------------------------------

/**
 * Names, assembled rather than listed.
 *
 * Two short words and a suffix gives a few thousand combinations, which is enough that a
 * run does not repeat itself and few enough that they read as a family. The symbol is
 * derived from the name so the two always agree.
 */
const FIRST = [
  "Solar", "Ember", "Tidal", "Nova", "Quartz", "Vector", "Cobalt", "Lumen", "Onyx", "Zephyr",
  "Prism", "Halcyon", "Vertex", "Basalt", "Aurora", "Cinder", "Drift", "Flux", "Grove", "Helix",
];

const SECOND = [
  "Fox", "Wolf", "Crane", "Otter", "Falcon", "Bear", "Lynx", "Heron", "Stag", "Raven",
  "Koi", "Moth", "Ibis", "Hare", "Seal",
];

function pick<T>(list: readonly T[]): T {
  return list[Math.floor(Math.random() * list.length)]!;
}

function identity(): { name: string; symbol: string; blurb: string } {
  const first = pick(FIRST);
  const second = pick(SECOND);
  const name = `${first} ${second}`;

  // Four to five characters, letters and digits only, which is what the form allows.
  const symbol = `${first.slice(0, 3)}${second.slice(0, 2)}`.toUpperCase();

  return {
    name,
    symbol,
    blurb: `${name} is a standard Instant token: one billion supply, all of it in a locked Uniswap v4 position, 1.00% of every trade to its creator in ETH.`,
  };
}

// --- a picture ---------------------------------------------------------------------

/** A PNG chunk: length, type, payload, CRC. */
function chunk(type: string, body: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length);

  const typed = Buffer.concat([Buffer.from(type, "ascii"), body]);

  const table = Array.from({ length: 256 }, (_, index) => {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xed_b8_83_20 ^ (value >>> 1) : value >>> 1;
    }
    return value >>> 0;
  });

  let crc = 0xff_ff_ff_ff;
  for (const byte of typed) crc = table[(crc ^ byte) & 0xff]! ^ (crc >>> 8);

  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE((crc ^ 0xff_ff_ff_ff) >>> 0);

  return Buffer.concat([length, typed, checksum]);
}

/**
 * A mark, generated from the token's name.
 *
 * Only used when no image directory is given. Deterministic in the name, so a token's
 * picture is at least *its own* rather than random noise — but a real image is better and
 * `--images` is why that option exists.
 */
function generateMark(name: string): Buffer {
  const size = 320;
  const seed = createHash("sha256").update(name).digest();

  const hue = seed[0]! / 255;
  const shade = (offset: number, at: number): [number, number, number] => {
    const wave = (channel: number) =>
      Math.round(140 + 100 * Math.sin(2 * Math.PI * (hue + channel / 3) + offset + at * 1.4));
    return [wave(0), wave(1), wave(2)];
  };

  const rows: Buffer[] = [];
  for (let y = 0; y < size; y += 1) {
    const row = Buffer.alloc(1 + size * 3);
    for (let x = 0; x < size; x += 1) {
      const ring = Math.hypot(x - size / 2, y - size / 2) / (size / 2);
      const [red, green, blue] = shade(ring * 2.2, y / size);
      row[1 + x * 3] = red;
      row[2 + x * 3] = green;
      row[3 + x * 3] = blue;
    }
    rows.push(row);
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 2;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

async function anImage(name: string): Promise<{ body: Buffer; type: string }> {
  if (settings.images === undefined) {
    return { body: generateMark(name), type: "image/png" };
  }

  const directory = resolve(settings.images);
  const files = (await readdir(directory)).filter((file) => extname(file).toLowerCase() in TYPES);

  if (files.length === 0) {
    return { body: generateMark(name), type: "image/png" };
  }

  const chosen = pick(files);
  return {
    body: await readFile(resolve(directory, chosen)),
    type: TYPES[extname(chosen).toLowerCase()]!,
  };
}

// --- the launch ---------------------------------------------------------------------

/** Upload through the site's own routes, so the picture lands where a real one would. */
async function store(name: string, symbol: string, blurb: string): Promise<string> {
  const picture = await anImage(name);

  const uploaded = await fetch(`${settings.site}/api/images`, {
    method: "POST",
    headers: { "content-type": picture.type },
    body: new Uint8Array(picture.body),
  });
  if (!uploaded.ok) throw new Error(`image upload answered ${String(uploaded.status)}`);
  const { url: imagePath } = (await uploaded.json()) as { url: string };

  const stored = await fetch(`${settings.site}/api/metadata`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name,
      symbol,
      description: blurb,
      image: `${settings.site}${imagePath}`,
      links: {},
    }),
  });
  if (!stored.ok) throw new Error(`metadata upload answered ${String(stored.status)}`);
  const { url: metadataPath } = (await stored.json()) as { url: string };

  return `${settings.site}${metadataPath}`;
}

async function launchOne(index: number): Promise<void> {
  const { name, symbol, blurb } = identity();
  const buyWei = parseEther(settings.buy);

  // Not checked on a dry run: the point of one is to exercise uploads, salt mining and
  // encoding, none of which spend anything, and requiring a funded key to rehearse would
  // make the rehearsal need the thing it exists to avoid.
  if (!settings.dryRun) {
    const balance = await publicClient.getBalance({ address: account.address });
    const floorWei = parseEther(settings.floor);

    if (balance <= floorWei + buyWei) {
      throw new Error(
        `balance ${formatEther(balance)} is at the floor of ${settings.floor} (plus a ${settings.buy} buy)`,
      );
    }
  }

  const metadataURI = await store(name, symbol, blurb);

  // The factory holds the supply as a constant; this is the interface's copy of it, used
  // only to predict the address the token will land on.
  const supplyTokens = BOUNDS.token.defaultTotalSupplyTokens;
  const initCodeHash = await launchSdk.readTokenInitCodeHash(publicClient, {
    deployer: record.deployer as Address,
    name,
    symbol,
    supplyTokens,
    metadataURI,
    metadataMutable: false,
    creator: account.address,
  });

  const mined = launchSdk.mineTokenSalt({
    deployer: record.deployer as Address,
    creator: account.address,
    initCodeHash,
    // Ether sorts below every token, so the first candidate always clears.
    above: "0x0000000000000000000000000000000000000000",
    // Fresh entropy per launch, so two runs never mine the same address.
    seed: `0x${randomBytes(32).toString("hex")}` as Hex,
  });

  const call = instantSdk.buildInstantCreate({
    factory: record.factory as Address,
    params: {
      name,
      symbol,
      metadataURI,
      feeRecipient: account.address,
      salt: mined.salt,
      initialBuyAmount: buyWei,
      initialBuyMinTokens: 0n,
    },
  });

  console.log(`\n[${String(index + 1)}/${String(settings.count)}] ${name} ($${symbol})`);
  console.log(`   token will be ${mined.token}`);
  console.log(`   metadata      ${metadataURI}`);

  if (settings.dryRun) {
    console.log("   dry run: nothing sent");
    return;
  }

  const hash = await wallet.sendTransaction({ to: call.to, data: call.data, value: call.value });
  console.log(`   sent          ${hash}`);

  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error("the launch reverted");

  const [created] = parseEventLogs({
    abi: abi.instantFactoryAbi,
    eventName: "MarketCreated",
    logs: receipt.logs,
  });

  if (created === undefined) throw new Error("mined, but no market was created");

  console.log(`   live          ${settings.site}/markets/${created.args.token}`);

  // Source verification, through the site's own endpoint. Never fatal: an unverified token
  // is a live token, and this loop has more launches to do.
  void fetch(`${settings.site}/api/instant/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: created.args.token }),
  }).catch(() => undefined);
}

// --- the loop -------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

async function main(): Promise<void> {
  console.log(`Seeding Instant on ${String(chain.id)} as ${account.address}`);
  console.log(`  site      ${settings.site}`);
  console.log(`  launches  ${String(settings.count)}, every ~${String(settings.every)}s`);
  console.log(`  first buy ${settings.buy} ETH · floor ${settings.floor} ETH`);
  if (settings.dryRun) console.log("  DRY RUN — nothing will be sent");

  const balance = await publicClient.getBalance({ address: account.address });
  console.log(`  balance   ${formatEther(balance)} ETH`);

  for (let index = 0; index < settings.count; index += 1) {
    try {
      await launchOne(index);
    } catch (error) {
      // One failure does not end the run — an upload can time out, a nonce can clash — but
      // a balance floor is a stop condition rather than a hiccup.
      const message = error instanceof Error ? error.message : String(error);
      console.error(`   failed: ${message}`);
      if (message.includes("floor")) break;
    }

    if (index < settings.count - 1) {
      // Jittered by ±25%, so launches do not arrive on a metronome.
      const wait = settings.every * (0.75 + Math.random() * 0.5);
      console.log(`   next in ${String(Math.round(wait))}s`);
      await sleep(wait * 1_000);
    }
  }

  console.log("\nDone.");
}

await main();
