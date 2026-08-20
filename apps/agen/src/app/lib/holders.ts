import "server-only";

/**
 * Who holds an Instant token, and how much the creator still has.
 *
 * The Instant indexer does not follow `Transfer`, so `TradingData.holders` has been null
 * on every Instant card since the product launched. Traders decide in a few seconds
 * whether the creator is still in and whether one wallet ate the supply; without those
 * numbers they leave and trade on a screener.
 *
 * ## Why this is a chain replay rather than a new indexer table
 *
 * A holder table on the Instant indexer is the right long-term answer and is the pattern
 * the programmable indexer already has. It also needs a resync from every token's first
 * block before a single page can trust it. This module answers the page today: it reads
 * `Transfer` from the Instant deployment block, replays balances, and caches the result
 * long enough that a busy token page is not a `getLogs` per refresh.
 *
 * When the replay cannot finish — a public RPC that refuses a wide log query, a timeout —
 * the creator's own balance is still read with `balanceOf`. "Dev holds X%" is the one
 * figure that must not go blank just because a top-ten list could not be built.
 */

import { erc20Abi, getAddress, parseAbiItem, type Address } from "viem";

import { EXTERNAL } from "./chain";
import { publicClient } from "./onchain";

const TRANSFER = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)",
);

/** Instant's first market cannot predate the factory. See `deployments.ts`. */
const FROM_BLOCK = 36_378_954n;

const ZERO = "0x0000000000000000000000000000000000000000";
const DEAD = "0x000000000000000000000000000000000000dead";

const CACHE_MS = 45_000;
const LOG_TIMEOUT_MS = 8_000;

export interface HolderRow {
  readonly address: Address;
  /** Whole tokens, same unit the rest of the page uses for supply. */
  readonly tokens: number;
  /** `balance / totalSupply`, 0–100. */
  readonly percent: number;
  /** How this address relates to the market, when we know. */
  readonly role: "creator" | "pool" | "sunk" | null;
}

export interface HolderSheet {
  readonly token: Address;
  readonly holders: number;
  readonly creatorPercent: number | null;
  readonly top: readonly HolderRow[];
  /** False when the list is only the creator/pool snapshot, not a full replay. */
  readonly complete: boolean;
}

interface Cached {
  readonly at: number;
  readonly sheet: HolderSheet;
}

const cache = new Map<string, Cached>();

function roleOf(address: string, creator: string): HolderRow["role"] {
  const who = address.toLowerCase();
  if (who === creator.toLowerCase()) return "creator";
  if (who === EXTERNAL.poolManager.toLowerCase()) return "pool";
  if (who === DEAD) return "sunk";
  return null;
}

function asTokens(amount: bigint, decimals: number): number {
  const scale = 10n ** BigInt(decimals);
  return Number(amount / scale) + Number(amount % scale) / Number(scale);
}

function row(
  address: Address,
  balance: bigint,
  supply: bigint,
  decimals: number,
  creator: string,
): HolderRow {
  const percent = supply === 0n ? 0 : Number((balance * 10_000n) / supply) / 100;
  return {
    address,
    tokens: asTokens(balance, decimals),
    percent,
    role: roleOf(address, creator),
  };
}

/**
 * Replay every `Transfer` into a balance map.
 *
 * Mint from `address(0)` and burn to it are both transfers, so a launch that mints the
 * whole supply into the locker/pool shows up as one row rather than as a mystery gap.
 */
function replay(
  logs: readonly { from: Address; to: Address; value: bigint }[],
): Map<string, bigint> {
  const balances = new Map<string, bigint>();

  const credit = (who: string, amount: bigint): void => {
    if (who === ZERO) return;
    balances.set(who, (balances.get(who) ?? 0n) + amount);
  };
  const debit = (who: string, amount: bigint): void => {
    if (who === ZERO) return;
    const next = (balances.get(who) ?? 0n) - amount;
    if (next === 0n) balances.delete(who);
    else balances.set(who, next);
  };

  for (const log of logs) {
    const value = log.value;
    debit(log.from.toLowerCase(), value);
    credit(log.to.toLowerCase(), value);
  }

  return balances;
}

async function creatorSnapshot(
  token: Address,
  creator: Address,
): Promise<{ supply: bigint; creator: bigint; pool: bigint; decimals: number } | null> {
  const client = publicClient();

  try {
    const [supply, creatorBal, poolBal, decimals] = await Promise.all([
      client.readContract({ address: token, abi: erc20Abi, functionName: "totalSupply" }),
      client.readContract({
        address: token,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [creator],
      }),
      client.readContract({
        address: token,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [EXTERNAL.poolManager],
      }),
      client.readContract({ address: token, abi: erc20Abi, functionName: "decimals" }),
    ]);

    return { supply, creator: creatorBal, pool: poolBal, decimals: Number(decimals) };
  } catch {
    return null;
  }
}

function fromSnapshot(
  token: Address,
  creator: Address,
  snap: { supply: bigint; creator: bigint; pool: bigint; decimals: number },
): HolderSheet {
  const top: HolderRow[] = [];
  if (snap.pool > 0n) {
    top.push(row(EXTERNAL.poolManager, snap.pool, snap.supply, snap.decimals, creator));
  }
  if (snap.creator > 0n) {
    top.push(row(creator, snap.creator, snap.supply, snap.decimals, creator));
  }

  const creatorPercent =
    snap.supply === 0n ? null : Number((snap.creator * 10_000n) / snap.supply) / 100;

  return {
    token,
    holders: top.filter((entry) => entry.role !== "pool" && entry.role !== "sunk").length,
    creatorPercent,
    top,
    complete: false,
  };
}

function fromReplay(
  token: Address,
  creator: Address,
  balances: Map<string, bigint>,
  supply: bigint,
  decimals: number,
): HolderSheet {
  const living = [...balances.entries()]
    .filter(([, amount]) => amount > 0n)
    .sort((a, b) => (a[1] === b[1] ? a[0].localeCompare(b[0]) : a[1] > b[1] ? -1 : 1));

  const wallets = living.filter(([address]) => roleOf(address, creator) === null || roleOf(address, creator) === "creator");

  const creatorBal = balances.get(creator.toLowerCase()) ?? 0n;
  const creatorPercent =
    supply === 0n ? null : Number((creatorBal * 10_000n) / supply) / 100;

  return {
    token,
    holders: wallets.length,
    creatorPercent,
    top: living.slice(0, 8).map(([address, amount]) =>
      row(getAddress(address), amount, supply, decimals, creator),
    ),
    complete: true,
  };
}

/**
 * Who holds `token`, newest observation we have.
 *
 * Null only when even `balanceOf` failed — the page then keeps the section off rather
 * than drawing a zero that looks like a measurement.
 */
export async function holdersOf(
  token: string,
  creator: string | null,
): Promise<HolderSheet | null> {
  if (creator === null) return null;

  let tokenAddr: Address;
  let creatorAddr: Address;
  try {
    tokenAddr = getAddress(token);
    creatorAddr = getAddress(creator);
  } catch {
    return null;
  }

  const key = tokenAddr.toLowerCase();
  const hit = cache.get(key);
  if (hit !== undefined && Date.now() - hit.at < CACHE_MS) return hit.sheet;

  const snap = await creatorSnapshot(tokenAddr, creatorAddr);
  if (snap === null) return hit?.sheet ?? null;

  let sheet = fromSnapshot(tokenAddr, creatorAddr, snap);

  try {
    const client = publicClient();
    const logs = await Promise.race([
      client.getLogs({
        address: tokenAddr,
        event: TRANSFER,
        fromBlock: FROM_BLOCK,
        toBlock: "latest",
      }),
      new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(new Error("holder logs timed out"));
        }, LOG_TIMEOUT_MS);
      }),
    ]);

    const transfers = logs
      .map((log) => log.args)
      .filter(
        (args): args is { from: Address; to: Address; value: bigint } =>
          args.from !== undefined && args.to !== undefined && args.value !== undefined,
      );

    if (transfers.length > 0) {
      sheet = fromReplay(tokenAddr, creatorAddr, replay(transfers), snap.supply, snap.decimals);
    }
  } catch {
    // The snapshot still answers "does the creator still hold any".
  }

  cache.set(key, { at: Date.now(), sheet });
  return sheet;
}

/** Exported for the replay test; not a public API. */
export const holdersForTest = { replay, fromReplay, TRANSFER };
