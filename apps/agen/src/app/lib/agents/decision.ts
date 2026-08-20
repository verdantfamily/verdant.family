/**
 * The boundary between what a model says and what this system will do.
 *
 * A model returns text. Everything downstream of this file treats that text as
 * hostile: not because the model is adversarial, but because a prompt-injected
 * market description reaches it on the same channel as the mandate, and there is
 * no reliable way to tell those apart inside the model.
 *
 * So the model chooses only from a closed set, and only among things this agent
 * already owns. It picks a *kind* and some *content*. It never names a contract,
 * a recipient, a chain, a wallet, or a byte of calldata — there is no field here
 * capable of carrying one. `claim_revenue` takes a token, but the token is
 * matched against this agent's own succeeded launches and rejected otherwise, so
 * the model is choosing from a list rather than supplying an address.
 *
 * What survives validation is still only a *request*. Permissions, reservations,
 * the treasury reserve and the signer allowlist all run afterwards and can still
 * refuse it. This file narrows; it never authorises.
 */

import { getAddress, type Address } from "viem";

import { AgentError } from "./errors";
import type { AgentStore } from "./store";
import type { AgentPermissions, AgentPolicy, AgentRecord, DecisionKind } from "./types";

/**
 * Kinds an agent may actually carry out today.
 *
 * `reinvest` exists in `DECISION_KINDS` because the schema should be stable, but
 * it is deliberately absent here: reinvestment needs a swap path the agent layer
 * does not have, and inventing one in the same change that introduces autonomy is
 * how an agent ends up able to move funds in a way nobody reviewed. The planner is
 * never told about it, and if a model proposes it anyway, validation refuses.
 */
export const EXECUTABLE_KINDS = [
  "no_action",
  "instant_launch",
  "programmable_build",
  "answer_clarification",
  "claim_revenue",
  "buy_token",
  "sell_token",
] as const satisfies readonly DecisionKind[];

export type ExecutableKind = (typeof EXECUTABLE_KINDS)[number];

interface DecisionBase {
  readonly rationale: string;
  readonly confidence: number;
}

export interface NoActionDecision extends DecisionBase {
  readonly kind: "no_action";
}

export interface InstantLaunchDecision extends DecisionBase {
  readonly kind: "instant_launch";
  readonly name: string;
  readonly symbol: string;
  readonly description: string;
  /** Already clamped to permissions, policy reserve and remaining daily budget. */
  readonly initialBuyWei: bigint;
  readonly boost: boolean;
}

export interface ProgrammableBuildDecision extends DecisionBase {
  readonly kind: "programmable_build";
  readonly prompt: string;
  readonly name: string;
  readonly symbol: string;
}

export interface AnswerClarificationDecision extends DecisionBase {
  readonly kind: "answer_clarification";
  /** Verified to belong to this agent before it gets here. */
  readonly jobId: string;
  readonly answers: readonly { readonly id: string; readonly answer: string }[];
}

export interface ClaimRevenueDecision extends DecisionBase {
  readonly kind: "claim_revenue";
  /** Chosen from this agent's own succeeded Instant launches, never free text. */
  readonly token: Address;
}

/**
 * Buy a token on an existing market.
 *
 * The one decision that carries an address the agent did not create, and worth saying
 * exactly why that is acceptable. It is checked for shape here and proven at execution:
 * `trade.ts` reads the Instant registry and refuses anything that is not one of its
 * markets, so the model is choosing among Instant markets rather than naming a contract.
 * What it cannot do with the address is the point — the router only swaps, and pays the
 * proceeds to `msg.sender` — so the worst a bad choice costs is the capped ether spent on
 * a token nobody wants. That is a trading loss, which is a risk the owner took by funding
 * a trading agent, and not a way to move funds out.
 */
export interface BuyTokenDecision extends DecisionBase {
  readonly kind: "buy_token";
  readonly token: Address;
  /** Already clamped to the per-trade cap, the reserve and the remaining daily budget. */
  readonly amountWei: bigint;
}

/**
 * Sell part or all of a holding.
 *
 * The token is matched against what this agent has traded or launched, so selling is
 * chosen from a list in the way `claim_revenue` is. A fraction rather than an amount
 * because the model does not know the wallet's balance in base units and should not be
 * guessing at eighteen decimal places to get out of a position.
 */
export interface SellTokenDecision extends DecisionBase {
  readonly kind: "sell_token";
  readonly token: Address;
  /** Share of the holding to sell, between 0 and 1. */
  readonly fraction: number;
}

export type ValidatedDecision =
  | NoActionDecision
  | InstantLaunchDecision
  | ProgrammableBuildDecision
  | AnswerClarificationDecision
  | ClaimRevenueDecision
  | BuyTokenDecision
  | SellTokenDecision;

export interface DecisionContext {
  readonly store: AgentStore;
  readonly agent: AgentRecord;
  readonly permissions: AgentPermissions;
  readonly policy: AgentPolicy;
  /** Treasury minus the owner's reserve, minus what today's budget has left. */
  readonly spendableWei: bigint;
}

const NAME_MAX = 32;
const SYMBOL_MAX = 10;
const DESCRIPTION_MAX = 500;
const PROMPT_MAX = 4_000;
const RATIONALE_MAX = 1_000;
const ANSWER_MAX = 1_000;
const MAX_ANSWERS = 20;

/**
 * Turn one raw model reply into something executable, or refuse it.
 *
 * Refusal is not an error condition in the product sense — a model that returns
 * nonsense should cost the agent a cycle, not produce a launch.
 */
export function validateDecision(raw: unknown, context: DecisionContext): ValidatedDecision {
  const object = asObject(raw, "decision");
  const kind = asString(object.kind, "kind");

  if (!(EXECUTABLE_KINDS as readonly string[]).includes(kind)) {
    throw new AgentError("MODEL_REFUSED", `An agent may not decide to "${kind}".`, {
      details: { kind, allowed: EXECUTABLE_KINDS },
    });
  }

  const rationale = clamp(asString(object.rationale ?? "", "rationale"), RATIONALE_MAX);
  const confidence = asConfidence(object.confidence);

  switch (kind as ExecutableKind) {
    case "no_action":
      return { kind: "no_action", rationale, confidence };
    case "instant_launch":
      return instantLaunch(object, context, rationale, confidence);
    case "programmable_build":
      return programmableBuild(object, rationale, confidence);
    case "answer_clarification":
      return answerClarification(object, context, rationale, confidence);
    case "claim_revenue":
      return claimRevenue(object, context, rationale, confidence);
    case "buy_token":
      return buyToken(object, context, rationale, confidence);
    case "sell_token":
      return sellToken(object, context, rationale, confidence);
  }
}

function buyToken(
  object: Record<string, unknown>,
  context: DecisionContext,
  rationale: string,
  confidence: number,
): BuyTokenDecision {
  const token = asAddressLike(object.token);

  // Clamped rather than refused, exactly as a launch's opening buy is: an inflated request
  // becomes a smaller trade, so a model with a poor sense of scale costs the agent a worse
  // entry and never an overspend.
  const requestedWei = asEthWei(object.amountEth);
  const ceiling = min(context.permissions.maxEthPerTradeWei, context.spendableWei);
  const amountWei = min(requestedWei, ceiling < 0n ? 0n : ceiling);

  if (amountWei <= 0n) {
    throw new AgentError(
      "MODEL_REFUSED",
      "There is nothing spendable for a buy, so this agent cannot trade this cycle.",
      { details: { spendableWei: context.spendableWei.toString() } },
    );
  }

  return { kind: "buy_token", token, amountWei, rationale, confidence };
}

function sellToken(
  object: Record<string, unknown>,
  context: DecisionContext,
  rationale: string,
  confidence: number,
): SellTokenDecision {
  const requested = asAddressLike(object.token).toLowerCase();

  // Identity rather than format, like `claim_revenue`: a token this agent has never bought
  // or launched is not a position, and selling one is not a thing to attempt on chain to
  // find out.
  const held = context.store
    .heldTokenCandidates(context.agent.id)
    .find((token) => token.toLowerCase() === requested);

  if (held === undefined) {
    throw new AgentError("MODEL_REFUSED", "This agent has no position in that token.", {
      details: { token: requested },
    });
  }

  const fraction = asFraction(object.fraction);
  return { kind: "sell_token", token: held, fraction, rationale, confidence };
}

function instantLaunch(
  object: Record<string, unknown>,
  context: DecisionContext,
  rationale: string,
  confidence: number,
): InstantLaunchDecision {
  const name = clamp(asString(object.name, "name").trim(), NAME_MAX);
  const symbol = clamp(asString(object.symbol, "symbol").trim().toUpperCase(), SYMBOL_MAX);
  const description = clamp(asString(object.description ?? "", "description").trim(), DESCRIPTION_MAX);

  if (name === "") throw new AgentError("MODEL_REFUSED", "A market needs a name.");
  if (!/^[A-Z0-9]{2,10}$/.test(symbol)) {
    throw new AgentError("MODEL_REFUSED", "That symbol is not 2–10 uppercase letters or digits.", {
      details: { symbol },
    });
  }

  // The model asks for an amount; it does not get to set one. The request is
  // clamped to what the owner's permissions, reserve and remaining daily budget
  // already allow, so an inflated number becomes a smaller launch, not a refusal
  // and not an overspend.
  const requestedWei = asEthWei(object.initialBuyEth);
  const ceiling = min(context.permissions.maxEthPerLaunchWei, context.spendableWei);
  const initialBuyWei = min(requestedWei, ceiling < 0n ? 0n : ceiling);

  // Boost is an owner permission, not a model choice. A model asking for it when
  // the owner has not allowed it simply does not get it.
  const boost = context.policy.boostAllowed && object.boost === true;

  return { kind: "instant_launch", name, symbol, description, initialBuyWei, boost, rationale, confidence };
}

function programmableBuild(
  object: Record<string, unknown>,
  rationale: string,
  confidence: number,
): ProgrammableBuildDecision {
  const prompt = clamp(asString(object.prompt, "prompt").trim(), PROMPT_MAX);
  const name = clamp(asString(object.name, "name").trim(), NAME_MAX);
  const symbol = clamp(asString(object.symbol, "symbol").trim().toUpperCase(), SYMBOL_MAX);

  if (prompt.length < 20) {
    throw new AgentError("MODEL_REFUSED", "A Programmable build needs a real description of the market.");
  }
  if (name === "" || !/^[A-Z0-9]{2,10}$/.test(symbol)) {
    throw new AgentError("MODEL_REFUSED", "That build is missing a usable name or symbol.");
  }

  return { kind: "programmable_build", prompt, name, symbol, rationale, confidence };
}

function answerClarification(
  object: Record<string, unknown>,
  context: DecisionContext,
  rationale: string,
  confidence: number,
): AnswerClarificationDecision {
  const jobId = asString(object.jobId, "jobId");

  // The job must be one this agent started. Without this an injected instruction
  // could steer the agent into answering somebody else's build.
  if (context.store.buildOwner(jobId) !== context.agent.id) {
    throw new AgentError("MODEL_REFUSED", "That build does not belong to this agent.", {
      details: { jobId },
    });
  }

  const list = Array.isArray(object.answers) ? object.answers : [];
  if (list.length === 0 || list.length > MAX_ANSWERS) {
    throw new AgentError("MODEL_REFUSED", "That clarification reply answers nothing, or far too much.");
  }

  const answers = list.map((entry) => {
    const item = asObject(entry, "answer");
    return {
      id: asString(item.id, "answer.id"),
      answer: clamp(asString(item.answer, "answer.answer"), ANSWER_MAX),
    };
  });

  return { kind: "answer_clarification", jobId, answers, rationale, confidence };
}

function claimRevenue(
  object: Record<string, unknown>,
  context: DecisionContext,
  rationale: string,
  confidence: number,
): ClaimRevenueDecision {
  const requested = asString(object.token, "token").toLowerCase();

  // Not "is this a valid address" — "is this one of ours". The model is picking
  // from a list it was shown, and anything else is refused by identity rather
  // than by format.
  const owned = context.store
    .listLaunches(context.agent.id)
    .find(
      (launch) =>
        launch.kind === "instant" &&
        launch.status === "succeeded" &&
        launch.token !== null &&
        launch.token.toLowerCase() === requested,
    );

  if (owned?.token === undefined || owned.token === null) {
    throw new AgentError("MODEL_REFUSED", "That token is not one of this agent's markets.", {
      details: { token: requested },
    });
  }

  return { kind: "claim_revenue", token: getAddress(owned.token), rationale, confidence };
}

/** What gets written to `agent_decisions.payload`. Wei become strings, as everywhere else. */
export function decisionPayload(decision: ValidatedDecision): Record<string, unknown> {
  switch (decision.kind) {
    case "no_action":
      return {};
    case "instant_launch":
      return {
        name: decision.name,
        symbol: decision.symbol,
        description: decision.description,
        initialBuyWei: decision.initialBuyWei.toString(),
        boost: decision.boost,
      };
    case "programmable_build":
      return { prompt: decision.prompt, name: decision.name, symbol: decision.symbol };
    case "answer_clarification":
      return { jobId: decision.jobId, answers: decision.answers };
    case "claim_revenue":
      return { token: decision.token };
    case "buy_token":
      return { token: decision.token, amountWei: decision.amountWei.toString() };
    case "sell_token":
      return { token: decision.token, fraction: decision.fraction };
  }
}

/**
 * Rebuild a decision from its stored payload.
 *
 * An approval can arrive hours after the run that proposed it, so the stored row
 * has to be re-validated rather than trusted — the agent's launches, permissions
 * and budget have all had time to change since the model chose.
 */
export function decisionFromPayload(
  kind: DecisionKind,
  payload: Record<string, unknown>,
  rationale: string,
  confidence: number,
  context: DecisionContext,
): ValidatedDecision {
  const raw: Record<string, unknown> = { ...payload, kind, rationale, confidence };
  if (kind === "instant_launch") {
    raw.initialBuyEth = weiToEthString(BigInt(String(payload.initialBuyWei ?? "0")));
  }
  if (kind === "buy_token") {
    // Back through the same clamp the model's request went through, so an approval that
    // arrives after the budget has moved buys what is affordable now rather than what was
    // affordable when it was proposed.
    raw.amountEth = weiToEthString(BigInt(String(payload.amountWei ?? "0")));
  }
  return validateDecision(raw, context);
}

function weiToEthString(wei: bigint): string {
  const whole = wei / 10n ** 18n;
  const fraction = (wei % 10n ** 18n).toString().padStart(18, "0").replace(/0+$/, "");
  return fraction === "" ? whole.toString() : `${whole.toString()}.${fraction}`;
}

function asObject(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AgentError("MODEL_REFUSED", `The model's ${what} was not an object.`);
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, what: string): string {
  if (typeof value !== "string") {
    throw new AgentError("MODEL_REFUSED", `The model's ${what} was not text.`);
  }
  return value;
}

function asConfidence(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number.NaN;
  if (!Number.isFinite(parsed)) return 0;
  return Math.min(1, Math.max(0, parsed));
}

/** Accepts a number or a decimal string, and never throws on junk — junk is zero. */
function asEthWei(value: unknown): bigint {
  const text = typeof value === "number" ? value.toString() : typeof value === "string" ? value.trim() : "0";
  if (!/^\d{1,9}(\.\d{1,18})?$/.test(text)) return 0n;

  const [whole = "0", fraction = ""] = text.split(".");
  return BigInt(whole) * 10n ** 18n + BigInt(fraction.padEnd(18, "0").slice(0, 18));
}

/** An address, checksummed. Refused rather than coerced: half an address is not one. */
function asAddressLike(value: unknown): Address {
  const text = asString(value, "token").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(text)) {
    throw new AgentError("MODEL_REFUSED", "That is not a token address.", {
      details: { token: text.slice(0, 64) },
    });
  }
  return getAddress(text);
}

/**
 * A share of a holding.
 *
 * Junk means all of it rather than none: a sell is the agent getting out, and a model that
 * fumbles the field should not end up holding a position it decided to leave. The clamp is
 * to (0, 1] because zero is not a sell.
 */
function asFraction(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 1;
  return Math.min(1, parsed);
}

function clamp(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}

function min(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}
