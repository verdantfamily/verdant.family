/**
 * What happened to the markets the agent already made.
 *
 * Until this file existed, a launch was the last the agent ever heard of a token. The
 * planner was given a list of names, symbols and dates — nothing about price, depth or
 * whether a single person had traded one — so an agent could not tell the market that
 * did forty ether of volume from the one nobody ever touched, and every cycle reasoned
 * as if it were the first. That is the whole gap this closes: results come back in, so
 * the next decision can be made by something that knows how the last one went.
 *
 * The figures are the same ones the market pages show, read through `marketSource()`,
 * because an agent being told a different number than its owner can see would be worse
 * than telling it nothing. Which means the rule the launchpad holds to holds here too:
 * a figure nobody measured is `null`, never `0`. Zero volume is a real and interesting
 * answer — it is how an agent learns that a market died — and conflating it with "the
 * indexer did not reply" would teach the agent something false about its own work.
 *
 * Nothing here writes to the chain, spends anything, or decides anything.
 */

import { INSTANT_VALUATION_WEI } from "../instant";
import { marketSource } from "../markets";
import type { AgentStore } from "./store";
import type { AgentMemory, AgentRecord, LaunchKind } from "./types";

/**
 * What an Instant market is worth the moment it opens, in ether.
 *
 * The one number that makes a valuation comparable between two of an agent's markets. A
 * price per token cannot be: supply is a billion, so every market quotes some figure with
 * six leading zeros, and a rung set anywhere in that range would be arbitrary. A multiple
 * of the opening is not arbitrary — every Instant market starts at exactly this, by a
 * constant of the factory rather than by a choice anybody made at launch.
 */
const OPENING_VALUATION_ETH = Number(INSTANT_VALUATION_WEI) / 1e18;

/**
 * How long the feed gets before a cycle goes ahead without it.
 *
 * Same trade as the chat's chain read: an agent that thinks on a six-hour timer must not
 * be stalled by a wedged indexer, and a cycle that proceeds without outcome data is only
 * as blind as every cycle was before this file. Losing the enrichment is cheap; losing
 * the cycle is not.
 */
const FEED_TIMEOUT_MS = 4_000;

/** One market the agent created, with whatever the feed currently knows about it. */
export interface LaunchOutcome {
  readonly token: string;
  readonly name: string | null;
  readonly symbol: string | null;
  readonly kind: LaunchKind;
  readonly createdAt: number;
  /** False when the feed answered and had no row for this token. */
  readonly listed: boolean;
  readonly priceEth: number | null;
  readonly marketCapEth: number | null;
  readonly liquidityEth: number | null;
  /** Rolling volume over the last day, Boost buybacks excluded. Organic, as the shelves use. */
  readonly volume24hEth: number | null;
  readonly trades24h: number | null;
  readonly change24hPercent: number | null;
}

/**
 * The agent's own markets, joined to the feed.
 *
 * Returns empty when the feed could not be reached, rather than a list of rows marked
 * unlisted — "the indexer did not answer" and "this token is on no shelf" are different
 * facts and only one of them is the agent's problem. An empty result degrades the planner
 * to the launch list it always had.
 */
export async function readOutcomes(
  store: AgentStore,
  agent: AgentRecord,
): Promise<readonly LaunchOutcome[]> {
  const launches = store
    .listLaunches(agent.id)
    .filter((launch) => launch.status === "succeeded" && launch.token !== null);
  if (launches.length === 0) return [];

  const markets = await Promise.race([
    marketSource().list(),
    new Promise<null>((resolve) => {
      setTimeout(() => resolve(null), FEED_TIMEOUT_MS).unref?.();
    }),
  ]).catch(() => null);
  if (markets === null) return [];

  const byToken = new Map<string, (typeof markets)[number]>();
  for (const market of markets) {
    if (market.tokenAddress !== null) byToken.set(market.tokenAddress.toLowerCase(), market);
  }

  return launches.map((launch) => {
    const token = launch.token as string;
    const market = byToken.get(token.toLowerCase());
    const trading = market?.trading;

    return {
      token,
      name: launch.name,
      symbol: launch.symbol,
      kind: launch.kind,
      createdAt: launch.createdAt,
      listed: market !== undefined,
      priceEth: trading?.price ?? null,
      marketCapEth: trading?.marketCap ?? null,
      liquidityEth: trading?.liquidity ?? null,
      volume24hEth: trading?.volume24h ?? null,
      trades24h: trading?.trades24h ?? null,
      change24hPercent: trading?.change24hPercent ?? null,
    };
  });
}

/**
 * One line about one market, for the planner's state.
 *
 * Written as prose rather than a table because it is read by a model alongside a mandate
 * written in prose, and because the interesting part is usually the absence: "no trades
 * yet" is the sentence that should change what the agent does next.
 */
export function describeOutcome(outcome: LaunchOutcome, now: number): string {
  const title =
    outcome.name === null || outcome.name === "" ? label(outcome) : `${label(outcome)} "${outcome.name}"`;
  const bits: string[] = [`${title} — created ${span(outcome.createdAt, now)} ago`];

  if (!outcome.listed) {
    bits.push("not on the market feed");
    return bits.join(", ");
  }

  if (outcome.volume24hEth === null) {
    bits.push("volume not measured yet");
  } else if (outcome.volume24hEth === 0) {
    bits.push("no trading in the last day");
  } else {
    bits.push(`${eth(outcome.volume24hEth)} ETH traded in the last day`);
    if (outcome.trades24h !== null) bits.push(`${String(outcome.trades24h)} trades`);
  }

  if (outcome.liquidityEth !== null) bits.push(`${eth(outcome.liquidityEth)} ETH of liquidity`);
  if (outcome.marketCapEth !== null) {
    // The multiple, not only the figure. "3 ETH market cap" tells the agent nothing on its
    // own; "2× what it opened at" is the same number said in the units it can act on.
    const cap = `${eth(outcome.marketCapEth)} ETH market cap`;
    bits.push(
      outcome.kind === "instant"
        ? `${cap} (${times(outcome.marketCapEth / OPENING_VALUATION_ETH)} its opening valuation)`
        : cap,
    );
  }
  if (outcome.change24hPercent !== null) {
    const sign = outcome.change24hPercent >= 0 ? "+" : "";
    bits.push(`${sign}${outcome.change24hPercent.toFixed(1)}% on the day`);
  }

  return bits.join(", ");
}

/**
 * Something worth remembering, and a key that identifies it forever.
 *
 * The key exists because memory has no update path and a cycle runs every few hours: a
 * milestone whose text mentions how long it took would be a different string tomorrow,
 * and the agent would accumulate a hundred rows saying the same thing in slightly
 * different words. The key is the stable part, the content is the key plus the detail,
 * and a milestone is written once.
 */
export interface OutcomeMilestone {
  readonly key: string;
  readonly content: string;
  readonly weight: number;
}

/**
 * A day's volume worth marking, in ether.
 *
 * Thresholds rather than a running figure, because the feed reports a rolling day and not
 * a lifetime total: "traded ten ether in a day" is a claim the data supports, and "has
 * traded ten ether in total" is not. Sparse on purpose — four rungs over the life of a
 * market, so what the agent carries forward stays readable by the person who owns it.
 */
const VOLUME_RUNGS: readonly { readonly eth: number; readonly weight: number }[] = [
  { eth: 1, weight: 3 },
  { eth: 10, weight: 4 },
  { eth: 100, weight: 5 },
];

/**
 * A valuation worth marking, as a multiple of what the market opened at.
 *
 * Only ever recorded for a market that has traded, which is not a caution about precision
 * but about meaning. Every Instant market has a price before anybody touches it, because
 * the pool opens with the whole supply on one side — so an untraded market sits at exactly
 * 1× forever, and a rung crossed without a trade would be reporting the factory's constant
 * back to the agent as if it were news about its own judgement.
 */
const VALUATION_RUNGS: readonly { readonly times: number; readonly weight: number }[] = [
  { times: 2, weight: 3 },
  { times: 5, weight: 4 },
  { times: 10, weight: 5 },
  { times: 50, weight: 5 },
];

/** What is true of this market now that was worth writing down. */
export function outcomeMilestones(
  outcome: LaunchOutcome,
  now: number,
  known: readonly string[],
): readonly OutcomeMilestone[] {
  const found: OutcomeMilestone[] = [];
  if (!outcome.listed) return found;

  const name = label(outcome);
  const age = span(outcome.createdAt, now);
  const traded = `${name} traded`;
  const since = `${age} after it was created.`;

  const volume = outcome.volume24hEth;
  const tradingNow = volume !== null && volume > 0;
  // Either it is trading in front of us, or an earlier cycle saw it trade. Both make the
  // price a thing people did rather than the number the pool opened on.
  const everTraded = tradingNow || known.some((content) => content.startsWith(traded));

  if (tradingNow) {
    found.push({
      key: `${traded} for the first time`,
      content: `${traded} for the first time, ${since}`,
      weight: 2,
    });
    for (const rung of VOLUME_RUNGS) {
      if (volume < rung.eth) continue;
      const key = `${traded} ${String(rung.eth)} ETH in a day`;
      found.push({ key, content: `${key}, ${since}`, weight: rung.weight });
    }
  } else if (volume === 0 && everTraded) {
    // Silence only counts as news for a market that was once alive.
    found.push({
      key: `${name} has gone quiet`,
      content: `${name} has gone quiet: nothing traded in the last day, ${since}`,
      weight: 3,
    });
  }

  found.push(...valuationMilestones(outcome, name, since, everTraded));
  return found;
}

/**
 * Where the price got to, in the only units that compare across markets.
 *
 * Instant only. Agen markets happen to open at the same valuation today and that is
 * deliberate, but `lib/instant.ts` owns Instant's constant precisely so a change to the
 * programmable pipeline cannot silently reprice this — and an agent cannot launch an Agen
 * market anyway. Reading one product's opening off the other's constant is the kind of
 * coincidence that is correct until somebody edits it.
 */
function valuationMilestones(
  outcome: LaunchOutcome,
  name: string,
  since: string,
  everTraded: boolean,
): readonly OutcomeMilestone[] {
  const cap = outcome.marketCapEth;
  if (outcome.kind !== "instant" || cap === null || !everTraded) return [];

  const times = cap / OPENING_VALUATION_ETH;
  if (times < 1) {
    return [
      {
        key: `${name} fell below its opening valuation`,
        content: `${name} fell below its opening valuation, worth ${eth(cap)} ETH against the ${eth(OPENING_VALUATION_ETH)} ETH it opened at, ${since}`,
        weight: 4,
      },
    ];
  }

  const found: OutcomeMilestone[] = [];
  for (const rung of VALUATION_RUNGS) {
    if (times < rung.times) continue;
    const key = `${name} reached ${String(rung.times)}× its opening valuation`;
    found.push({ key, content: `${key}, a market cap of ${eth(cap)} ETH, ${since}`, weight: rung.weight });
  }
  return found;
}

/**
 * Write down what changed, once per thing.
 *
 * This is the first code in the product that puts a row in `agent_memory` without an owner
 * having typed it, which is why it is this narrow. Every row is a figure read from the same
 * feed the website renders, phrased as a fact with a date on it — not a conclusion, not a
 * lesson, and nothing the model wrote. Drawing inferences from these ("animal names do
 * better") is the planner's job, in the open, where the owner can read the reasoning and
 * disagree with it. A store of the agent's own conclusions about itself is a decay and
 * contradiction problem, and one that compounds silently; a store of dated observations is
 * just a record.
 */
export function recordOutcomeMemories(
  store: AgentStore,
  agent: AgentRecord,
  outcomes: readonly LaunchOutcome[],
  runId: string | null = null,
  now: number = Math.floor(Date.now() / 1000),
): readonly AgentMemory[] {
  if (outcomes.length === 0) return [];

  const known = store
    .listMemory(agent.id, 500)
    .filter((row) => row.kind === "outcome")
    .map((row) => row.content);

  const written: AgentMemory[] = [];
  for (const outcome of outcomes) {
    for (const milestone of outcomeMilestones(outcome, now, known)) {
      if (known.some((content) => content.startsWith(milestone.key))) continue;
      written.push(
        store.insertMemory({
          agentId: agent.id,
          kind: "outcome",
          content: milestone.content,
          source: "run",
          runId,
          weight: milestone.weight,
        }),
      );
      // So two milestones crossed in the same cycle cannot both be written, and so the
      // quiet rule above sees this cycle's writes as well as earlier ones.
      known.push(milestone.content);
    }
  }

  if (written.length > 0) {
    store.recordActivity({
      agentId: agent.id,
      type: "market_noticed",
      payload: { noticed: written.map((row) => row.content) },
    });
  }

  return written;
}

function label(outcome: LaunchOutcome): string {
  if (outcome.symbol !== null && outcome.symbol !== "") return `$${outcome.symbol}`;
  if (outcome.name !== null && outcome.name !== "") return outcome.name;
  return `${outcome.token.slice(0, 10)}…`;
}

/** A bare duration. Callers add "ago" or "after it was created", which do not both fit one phrasing. */
function span(createdAt: number, now: number): string {
  const elapsed = Math.max(0, now - createdAt);
  const whole = Math.floor(elapsed / 86_400);
  if (whole === 0) return "less than a day";
  return whole === 1 ? "1 day" : `${String(whole)} days`;
}

/** A multiple of the opening, written the way a person says it. */
function times(value: number): string {
  if (value < 1) return `${(value * 100).toFixed(0)}% of`;
  if (value < 10) return `${value.toFixed(1).replace(/\.0$/, "")}×`;
  return `${Math.round(value).toString()}×`;
}

/** Enough digits to tell markets apart, few enough to read. */
function eth(value: number): string {
  if (value === 0) return "0";
  if (value < 0.001) return value.toExponential(1);
  if (value < 1) return value.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
  if (value < 1_000) return value.toFixed(2).replace(/\.?0+$/, "");
  return Math.round(value).toLocaleString("en-US");
}
