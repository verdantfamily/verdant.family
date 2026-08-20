import "server-only";

/**
 * What the bot says, and the one line of copy that is a promise.
 *
 * Kept apart from the engine because it is product copy rather than logic, and because the
 * launch reply is checked by a test against the exact wording the brief specifies. A reply is
 * the only thing most people will ever see of this feature — the market exists whether or not
 * the reply lands, but as far as the creator is concerned the reply *is* the launch.
 *
 * ## "You earn 1% of every trade"
 *
 * That is a statement about `InstantFees.creatorPpm`, and it is true: 1.00% of every buy and
 * every sell, paid in ether to the market's fee recipient, which for these launches is the
 * seat derived from the creator's X id. The percentage is read from the fee constants rather
 * than typed here, so a change to the fee schedule cannot leave the bot promising a number the
 * chain stopped honouring.
 */

import type { AgentHoldings } from "../agents/holdings";
import { INSTANT_FEE_PERCENTS } from "../instant";
import { XError, speakable, type XErrorCode } from "./errors";
import { ethText, tokenText, type XTradeResult } from "./trade";

/**
 * Where a market lives on the site.
 *
 * The existing token page, addressed by token address, exactly as every other Agen surface
 * links it. A URL invented for X launches would be a second address for the same market and
 * one of the two would rot.
 */
export function marketUrl(token: string): string {
  const origin = process.env.NEXT_PUBLIC_SITE_URL?.trim().replace(/\/+$/, "");
  const base = origin === undefined || origin === "" ? "https://agen.space" : origin;
  return `${base}/markets/${token}`;
}

/**
 * The percentage as the reply says it.
 *
 * `1` rather than `1.0`, because that is how the copy reads and how a person would say it, and
 * a trailing zero appearing the day somebody edits a constant would be worse than either.
 */
function creatorPercent(): string {
  const value = INSTANT_FEE_PERCENTS.creator;
  return Number.isInteger(value) ? value.toFixed(0) : value.toFixed(2).replace(/0+$/, "");
}

/**
 * The launch reply.
 *
 * Three lines, in the order the brief sets: what happened, what it means for the person who
 * asked, and where to look. The ticker carries its `$` because that is how a ticker is written
 * on X and the whole reply is read at a glance.
 */
export function launchReply({
  ticker,
  token,
}: {
  readonly ticker: string;
  readonly token: string;
}): string {
  return [
    `$${ticker} is live on Robinhood.`,
    "",
    `You earn ${creatorPercent()}% of every trade. Happy trenching!`,
    "",
    marketUrl(token),
  ].join("\n");
}

/**
 * What a trade says.
 *
 * The figures first, because that is what the person is waiting for, and the market link last
 * so they can see the position they now hold. No congratulation and no emoji: they spent their
 * own money on a token, and the bot's job is to confirm the numbers.
 */
export function tradeReply(result: XTradeResult): string {
  const { outcome } = result;
  const amount = tokenText(result.tokenAmount);
  const ether = ethText(outcome.quoteWei);

  const first =
    outcome.side === "buy"
      ? `Bought ${amount} $${outcome.symbol} for ${ether} ETH.`
      : `Sold ${amount} $${outcome.symbol} for ${ether} ETH.`;

  return [first, "", marketUrl(outcome.token)].join("\n");
}

/**
 * Where to send money, and nothing else.
 *
 * The wording the brief asked for, kept to the two things that matter — the sentence and the
 * address — because this reply is read in order to copy an address out of it. The balance is
 * included when there is one, since "top up" reads oddly to somebody who has funded the wallet
 * and is short by gas.
 */
export function topUpReply(wallet: string, balanceWei = 0n): string {
  const lines = [`Please top up your wallet: ${wallet}`];
  if (balanceWei > 0n) {
    lines.push("", `It holds ${ethText(balanceWei)} ETH, which won't cover that buy plus gas.`);
  }
  return lines.join("\n");
}

/**
 * What the wallet is and what is in it.
 *
 * The address is always there, because the most common reason to ask is to fund it. Positions
 * are listed rather than summed: a value in ether would be a price this reply cannot vouch for
 * a second after posting, and a quantity is a fact.
 */
export function walletReply(holdings: AgentHoldings): string {
  const lines = [`Your Agen wallet: ${holdings.address}`, "", `${ethText(holdings.ethWei)} ETH`];

  const positions = holdings.positions.slice(0, 4);
  for (const position of positions) {
    lines.push(`${tokenText(position.amount)} $${position.symbol}`);
  }

  if (holdings.positions.length > positions.length) {
    lines.push(`+${String(holdings.positions.length - positions.length)} more`);
  }

  if (holdings.ethWei === 0n && holdings.positions.length === 0) {
    lines.push("", "Send ETH there and I can buy for you.");
  }

  return lines.join("\n");
}

/**
 * What to say when a launch was refused.
 *
 * Silence for anything a scripted account could learn from — see `speakable` in `errors.ts` —
 * and a plain sentence otherwise. Returning null rather than a vague apology is deliberate: a
 * reply of "something went wrong" to somebody who hit a rate limit is noise in a public
 * thread, and it invites the retry that the limit exists to prevent.
 *
 * Short, and no apology. These are the one place Agen speaks without a model in front of it, so
 * they are written in the same voice `persona.ts` asks the model for: say what happened, say what
 * to do about it, stop. "I'm sorry, but unfortunately I was unable to" is three clauses of
 * throat-clearing in a public thread where the person can already see nothing launched.
 */
export function refusalReply(error: XError): string | null {
  if (!speakable(error.code)) return null;

  // The one refusal composed from the error's own details rather than from copy: an unfunded
  // wallet has to name *which* wallet, and only the thrower knows that.
  if (error.code === "WALLET_UNFUNDED") {
    const wallet = error.details.wallet;
    if (typeof wallet === "string" && wallet !== "") {
      const balance = error.details.balanceWei;
      return topUpReply(wallet, typeof balance === "string" ? BigInt(balance) : 0n);
    }
  }

  return sentenceFor(error.code) ?? error.message;
}

function sentenceFor(code: XErrorCode): string | null {
  switch (code) {
    case "AMOUNT_MISSING":
      return "How much? Say it like 'buy 0.01 ETH of $TICKER'.";
    case "TOKEN_NOT_FOUND":
      return "I can't find that market. Give me the contract address and I'll trade it.";
    case "TOKEN_AMBIGUOUS":
      return "More than one market goes by that ticker. Send the contract address instead.";
    case "NOTHING_TO_SELL":
      return "Your wallet doesn't hold any of that.";
    case "TRADING_DISABLED":
      return "Trading is off right now. Try again later.";
    case "TRADE_REVERTED":
      return "The chain refused that trade. Only gas was spent.";
    case "TRADE_FAILED":
      // Deliberately not "nothing was spent": this code means the outcome is unknown, and a
      // reassurance that turned out to be wrong is worse than asking somebody to look.
      return "I couldn't confirm that trade. Check your wallet before trying it again.";
    case "NO_SOURCE_POST":
      // Both ways of asking, because the person who hit this has done neither and there is no
      // way to tell which one they meant.
      return "Tell me what to launch — 'launch Internet Dog $IDOG' — or tag me under the post you want launched.";
    case "SOURCE_UNAVAILABLE":
      return "Can't read the post above this one, so there's nothing to launch.";
    case "SOURCE_TOO_THIN":
      return "Nothing in that post to build a token around.";
    case "NO_IMAGE":
      return "No picture in that post to use as the logo.";
    case "LAUNCHES_DISABLED":
      return "Launches are paused. Try again later.";
    case "LAUNCH_REVERTED":
      return "Launch didn't go through. Nothing created, nothing charged.";
    default:
      return null;
  }
}
