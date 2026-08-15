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
 *   # one wallet
 *   SEED_PRIVATE_KEY=0x… pnpm --filter @verdant/agen seed:instant -- --count 20
 *
 *   # many wallets, one key per line in a file that is gitignored
 *   SEED_KEYS_FILE=scripts/seed-keys.local pnpm --filter @verdant/agen seed:instant -- --forever
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
  /**
   * How many to launch before stopping. `0` or `--forever` means keep going until every
   * wallet hits the floor — a run that is meant to seed a shelf, not a rehearsal of three.
   */
  count: process.argv.includes("--forever")
    ? 0
    : Number(flag("count") ?? process.env["SEED_COUNT"] ?? 20),
  /**
   * Seconds between launches, before jitter.
   *
   * Six and a half minutes. Jitter of ±12% lands each gap in roughly 6–7 minutes, which
   * is frequent enough to fill a shelf and sparse enough that two tokens do not appear
   * to have been minted by the same hand in the same minute.
   */
  every: Number(flag("every") ?? process.env["SEED_EVERY"] ?? 390),
  /** The creator's own first buy, in ether. Zero opens the pool without buying. */
  buy: flag("buy") ?? process.env["SEED_BUY"] ?? "0",
  /** Never spend below this. Checked before every launch, not just at the start. */
  floor: flag("floor") ?? process.env["SEED_FLOOR"] ?? "0.01",
  /** A directory of images to pick from. Falls back to a generated mark. */
  images: flag("images") ?? process.env["SEED_IMAGES"],
  dryRun: process.argv.includes("--dry-run"),
} as const;

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

const KEY_SHAPE = /^0x[0-9a-fA-F]{64}$/;

/**
 * Every key this run may spend, from the three places a person actually puts them.
 *
 * A file of one key per line is the ordinary case once there is more than one wallet —
 * a comma-separated environment variable is how a process manager passes the same list
 * without writing it to disk. A single `SEED_PRIVATE_KEY` still works. Comments and
 * blank lines in the file are ignored. The keys themselves are never printed.
 */
async function loadKeys(): Promise<readonly Hex[]> {
  const fromFile = process.env["SEED_KEYS_FILE"];
  const listed = process.env["SEED_PRIVATE_KEYS"];
  const single = process.env["SEED_PRIVATE_KEY"];

  const raw: string[] = [];

  if (fromFile !== undefined && fromFile !== "") {
    const body = await readFile(resolve(fromFile), "utf8").catch(() => {
      console.error(`Could not read SEED_KEYS_FILE at ${fromFile}.`);
      process.exit(1);
    });
    raw.push(...body.split(/\r?\n/));
  }

  if (listed !== undefined && listed !== "") {
    raw.push(...listed.split(/[\s,]+/));
  }

  if (single !== undefined && single !== "") raw.push(single);

  const keys = [
    ...new Set(
      raw
        .map((line) => line.trim())
        .filter((line) => line !== "" && !line.startsWith("#"))
        .map((line) => (line.startsWith("0x") ? line : `0x${line}`)),
    ),
  ];

  const bad = keys.filter((line) => !KEY_SHAPE.test(line));
  if (bad.length > 0) {
    console.error(`${String(bad.length)} key(s) are not 32-byte hex. Nothing was printed.`);
    process.exit(1);
  }

  if (keys.length === 0) {
    console.error(
      "Set SEED_PRIVATE_KEY, SEED_PRIVATE_KEYS, or SEED_KEYS_FILE. Keys are never printed.",
    );
    process.exit(1);
  }

  return keys as Hex[];
}

const keys = await loadKeys();
const chain = { ...robinhoodMainnet, rpcUrls: { default: { http: [settings.rpc] } } };
const publicClient = createPublicClient({ chain, transport: http(settings.rpc) });

interface Wallet {
  readonly account: ReturnType<typeof privateKeyToAccount>;
  readonly client: ReturnType<typeof createWalletClient>;
}

const wallets: readonly Wallet[] = keys.map((secret) => {
  const account = privateKeyToAccount(secret);
  return {
    account,
    client: createWalletClient({ account, chain, transport: http(settings.rpc) }),
  };
});

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
  "Ivory", "Marble", "Nimbus", "Orbit", "Pebble", "Quill", "Ridge", "Sable", "Thorn", "Umbra",
];

const SECOND = [
  "Fox", "Wolf", "Crane", "Otter", "Falcon", "Bear", "Lynx", "Heron", "Stag", "Raven",
  "Koi", "Moth", "Ibis", "Hare", "Seal", "Wren", "Pike", "Asp", "Dace", "Jay",
];

const BLURBS = [
  (name: string) =>
    `${name} is a standard Instant token: one billion supply, all of it in a locked Uniswap v4 position, 1.00% of every trade to its creator in ETH.`,
  (name: string) =>
    `${name} launched on agen.space Instant — fixed supply, locked liquidity, creator fees in ETH.`,
  (name: string) =>
    `Trade ${name} from the first block. Instant v4, one billion tokens, liquidity locked for the life of the market.`,
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
    blurb: pick(BLURBS)(name),
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

async function launchOne(index: number, wallet: Wallet, of: string): Promise<void> {
  const { name, symbol, blurb } = identity();
  const buyWei = parseEther(settings.buy);
  const creator = wallet.account.address;

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
    creator,
  });

  const mined = launchSdk.mineTokenSalt({
    deployer: record.deployer as Address,
    creator,
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
      feeRecipient: creator,
      salt: mined.salt,
      initialBuyAmount: buyWei,
      initialBuyMinTokens: 0n,
    },
  });

  console.log(`\n[${String(index + 1)}/${of}] ${name} ($${symbol})`);
  console.log(`   from          ${creator}`);
  console.log(`   token will be ${mined.token}`);
  console.log(`   metadata      ${metadataURI}`);

  if (settings.dryRun) {
    console.log("   dry run: nothing sent");
    return;
  }

  const hash = await wallet.client.sendTransaction({
    account: wallet.account,
    chain,
    to: call.to,
    data: call.data,
    value: call.value,
  });
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

async function funded(wallet: Wallet): Promise<boolean> {
  if (settings.dryRun) return true;

  const balance = await publicClient.getBalance({ address: wallet.account.address });
  const need = parseEther(settings.floor) + parseEther(settings.buy);
  return balance > need;
}

async function nextWallet(from: number): Promise<Wallet | null> {
  for (let step = 0; step < wallets.length; step += 1) {
    const wallet = wallets[(from + step) % wallets.length]!;
    if (await funded(wallet)) return wallet;
  }
  return null;
}

async function main(): Promise<void> {
  const unlimited = settings.count === 0;
  const of = unlimited ? "∞" : String(settings.count);

  console.log(`Seeding Instant on ${String(chain.id)}`);
  console.log(`  site      ${settings.site}`);
  console.log(`  wallets   ${String(wallets.length)}`);
  console.log(
    `  launches  ${unlimited ? "until the wallets hit the floor" : of}, every ~${String(settings.every)}s`,
  );
  console.log(`  first buy ${settings.buy} ETH · floor ${settings.floor} ETH`);
  if (settings.dryRun) console.log("  DRY RUN — nothing will be sent");

  for (const [index, wallet] of wallets.entries()) {
    const balance = await publicClient.getBalance({ address: wallet.account.address });
    console.log(`  ${String(index + 1)}. ${wallet.account.address}  ${formatEther(balance)} ETH`);
  }

  let cursor = 0;

  for (let index = 0; unlimited || index < settings.count; index += 1) {
    const wallet = await nextWallet(cursor);
    if (wallet === null) {
      console.error("\nEvery wallet is at the floor. Stopping.");
      break;
    }

    cursor = wallets.findIndex((entry) => entry.account.address === wallet.account.address) + 1;

    try {
      await launchOne(index, wallet, of);
    } catch (error) {
      // One failure does not end the run — an upload can time out, a nonce can clash.
      const message = error instanceof Error ? error.message : String(error);
      console.error(`   failed: ${message}`);
    }

    if (!unlimited && index >= settings.count - 1) break;

    // ±12% around the interval, so a 390s setting lands in roughly 6–7 minutes.
    const wait = settings.every * (0.88 + Math.random() * 0.24);
    console.log(`   next in ${String(Math.round(wait))}s`);
    await sleep(wait * 1_000);
  }

  console.log("\nDone.");
}

await main();
