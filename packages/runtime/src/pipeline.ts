/**
 * One evaluation of one agent, as an explicit sequence of stages.
 *
 * `runAgent` is deterministic in the sense that matters: given the same chain state,
 * the same config and the same model response, it does the same thing. It performs no
 * scheduling, holds no timers, and never loops. The scheduler calls it; it returns an
 * outcome. That separation is what makes "run this agent once, right now, and tell me
 * exactly what happened" a supported operation rather than a debugging exercise.
 *
 * ## One intent, one transaction
 *
 * A rule worth stating because it is easy to lose. No intent ever becomes a batch. If
 * an action needs three calls on chain, it is three actions across three runs, each
 * with its own decision, its own record and its own pass through every gate. The
 * moment one decision can authorise a sequence, the question "what did the model
 * approve?" stops having a single answer, and the audit trail stops being one.
 *
 * That is why `CLAIM_REVENUE` sends `claimMarketFees` and nothing else. Getting the
 * money the rest of the way — recognise, allocate, settle — is permissionless, anybody
 * can crank it, and folding it in here would mean one approval authorising four
 * transfers.
 *
 * ## The order of the gates
 *
 * Cheap before expensive, and local before remote, but the important ordering is that
 * **the chain is read twice**: once before reasoning to decide whether to spend a model
 * call, and once immediately before signing. Between those two reads a guardian can
 * revoke, a market can be bound, an expiry can pass. The second read is what turns
 * "permitted when we started" into "permitted now".
 */

import type { Address, Hex } from "viem";
import { keccak256, toHex } from "viem";
import { agents } from "@verdant/sdk";

import type { AgentRuntimeConfig } from "./config.js";
import { backoffFor } from "./config.js";
import type { ContextProvider } from "./context.js";
import { collectContext } from "./context.js";
import type { ActionBudget, ChainView, GuardRefusal } from "./guard.js";
import { assertStillPermitted, mayAct, mayActOnChain, mayEvaluate } from "./guard.js";
import type { AgentIntent } from "./intent.js";
import { RuntimeAction, parseIntentJson } from "./intent.js";
import type { AgentModelProvider } from "./model.js";
import { ModelProviderError } from "./model.js";
import type { LaunchPlan } from "./plan.js";
import { buildLaunch, intentMatchesPlan } from "./plan.js";
import { SYSTEM_PROMPT, renderContext } from "./prompt.js";
import type { AgentDecision, AgentExecution, AgentRun, RunOutcome } from "./records.js";
import { RunStatus } from "./records.js";

/** An unsigned call, as the SDK builds them. */
export interface Call {
  readonly to: Address;
  readonly data: Hex;
  readonly value: bigint;
}

export interface SimulationResult {
  readonly ok: boolean;
  /** The revert reason, when there is one. */
  readonly detail?: string;
  readonly gas?: bigint;
}

export interface Receipt {
  readonly status: "success" | "reverted";
  readonly confirmedAt: number;
}

/**
 * Everything `runAgent` needs from the outside world, as one injected object.
 *
 * The pipeline reaches nothing on its own: no clock, no network, no randomness, no
 * database. Every one of those is a method here, which is why the security tests can
 * stage a guardian revoking an agent halfway through a run — something that is
 * essentially untestable when a function fetches its own state.
 */
export interface RuntimeEnvironment {
  /** The chain's clock, in unix seconds. Not the host's. */
  now(): Promise<number>;
  /** Unique ids for the records. Injected so runs are reproducible in tests. */
  newId(): string;

  /** The agent's current on-chain position. Called twice per run, deliberately. */
  readChain(agentId: Hex): Promise<ChainView>;

  /** How many value-moving actions this agent has taken inside the config's window. */
  readBudget(agentId: Hex, periodSeconds: number): Promise<ActionBudget>;

  /** The address the runtime would sign with for this action's credential. */
  signerFor(action: RuntimeAction): Address;
  balanceOf(address: Address): Promise<bigint>;

  /** Everything needed to decide about a launch, verified against the commitment. */
  loadLaunchPlan(agentId: Hex): Promise<LaunchPlan | null>;

  /** Fees sitting in the splitter that `claimMarketFees` would pull in, in wei. */
  readUnclaimedRevenue(agentId: Hex): Promise<bigint>;

  /** Context sources. Ordered; the order is what the model sees. */
  contextProviders(agentId: Hex): Promise<readonly ContextProvider[]>;

  /** The model. Chosen by the service from the config's provider name. */
  modelProvider(config: AgentRuntimeConfig): AgentModelProvider;

  simulate(call: Call, from: Address): Promise<SimulationResult>;
  send(call: Call, from: Address): Promise<Hex>;
  /** Null when the runtime does not wait — the record then stays `SUBMITTED`. */
  waitFor(hash: Hex): Promise<Receipt | null>;

  /** How long the model gets. */
  readonly modelTimeoutMs: number;
}

/** What the scheduler learns, beyond the records. */
export interface RunResult extends RunOutcome {
  /** When this agent should next be considered, in unix seconds. */
  readonly nextRunAt: number;
  /** The failure count to carry forward. */
  readonly consecutiveFailures: number;
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;

/**
 * Evaluate one agent once.
 *
 * Never throws for an expected failure. A provider being down, a chain refusing, a
 * model returning nonsense — all of those are outcomes with statuses, because a
 * scheduler that has to catch exceptions to know what happened will eventually catch
 * one it should not have. The only exceptions that escape are genuine defects, and the
 * caller turns those into `RUNTIME_ERROR`.
 */
export async function runAgent({
  config,
  env,
}: {
  readonly config: AgentRuntimeConfig;
  readonly env: RuntimeEnvironment;
}): Promise<RunResult> {
  const startedAt = await env.now();
  const runId = env.newId();

  const finish = (
    status: RunStatus,
    reason: string | null,
    parts: { decision?: AgentDecision; execution?: AgentExecution } = {},
  ): RunResult => {
    // A skip is not a failure and must not feed the backoff: an agent that is disabled
    // would otherwise accumulate "failures" while sitting still and then be scheduled
    // an hour out the moment somebody enabled it.
    const failed = status === RunStatus.RuntimeError || status === RunStatus.Reverted;
    const consecutiveFailures =
      status === RunStatus.Skipped
        ? config.consecutiveFailures
        : failed
          ? config.consecutiveFailures + 1
          : 0;

    return {
      run: {
        id: runId,
        agentId: config.agentId,
        startedAt,
        completedAt: startedAt,
        status,
        objectiveSnapshot: config.objective,
        contextHash,
        provider: config.provider,
        model: config.model,
        reason,
      },
      decision: parts.decision ?? null,
      execution: parts.execution ?? null,
      nextRunAt:
        startedAt + config.evaluationInterval + backoffFor(consecutiveFailures),
      consecutiveFailures,
    };
  };

  // Filled in once the prompt exists. Before that a run can still end — disabled,
  // revoked — and those records need a value that is honestly "no context was built".
  let contextHash: Hex = keccak256(toHex(""));

  // --- 1..3. the agent, its config, and what the chain says ---------------

  const before = await env.readChain(config.agentId);

  const permitted = mayEvaluate({ config, chain: before, now: startedAt });
  if (!permitted.ok) {
    return finish(RunStatus.Skipped, `${permitted.refusal}: ${permitted.detail}`);
  }

  // --- 4. context ---------------------------------------------------------

  const providers = await env.contextProviders(config.agentId);
  const sections = await collectContext(providers, {
    agentId: config.agentId,
    developer: before.developer,
    router: before.router,
    now: startedAt,
  });

  const user = renderContext(sections);
  contextHash = keccak256(toHex(user));

  // --- 5. reasoning -------------------------------------------------------

  const provider = env.modelProvider(config);

  let raw: string;
  try {
    const response = await provider.generateIntent({
      system: SYSTEM_PROMPT,
      user,
      model: config.model,
      timeoutMs: env.modelTimeoutMs,
    });
    raw = response.raw;
  } catch (error) {
    // A provider failing is ordinary and must back off rather than retry immediately.
    // The message is the provider's own and is kept short; it is not the model's output
    // and does not go near the intent parser.
    const detail =
      error instanceof ModelProviderError
        ? error.message
        : error instanceof Error
          ? error.message
          : "the model provider failed";
    return finish(RunStatus.RuntimeError, `MODEL_PROVIDER_FAILED: ${detail.slice(0, 300)}`);
  }

  // --- 6. schema ----------------------------------------------------------

  const parsed = parseIntentJson(raw);
  if (!parsed.ok) {
    // Rejected, not RuntimeError: the runtime worked perfectly. A model that returns an
    // unknown action is the fail-closed path doing its job, and conflating it with an
    // outage would hide both.
    return finish(RunStatus.Rejected, `${parsed.refusal}: ${parsed.detail}`);
  }

  const intent = parsed.intent;

  const decision: AgentDecision = {
    id: env.newId(),
    runId,
    action: intent.action,
    parameters: parametersOf(intent),
    reasoningSummary: intent.reasoningSummary,
    confidence: intent.confidence,
  };

  if (intent.action === RuntimeAction.NoAction) {
    return finish(RunStatus.NoAction, null, { decision });
  }

  // --- 7. runtime policy --------------------------------------------------

  const budget = await env.readBudget(config.agentId, config.actionPeriod);
  const allowed = mayAct({
    action: intent.action,
    confidence: intent.confidence,
    config,
    budget,
  });
  if (!allowed.ok) {
    return finish(RunStatus.Rejected, reasonOf(allowed.refusal, allowed.detail), {
      decision,
      execution: refusedExecution(env.newId(), decision.id, allowed.refusal, allowed.detail),
    });
  }

  // --- 8. the transaction, built from the plan and not from the intent ----

  const built = await buildFor(intent, config, env, before);
  if (!built.ok) {
    return finish(RunStatus.Rejected, `${built.code}: ${built.detail}`, {
      decision,
      execution: refusedExecution(env.newId(), decision.id, built.code, built.detail),
    });
  }

  const { call } = built;
  const signer = env.signerFor(intent.action);
  const balance = await env.balanceOf(signer);

  // --- 9. policy preflight ------------------------------------------------

  const onChain = mayActOnChain({
    action: intent.action,
    chain: before,
    wallet: signer,
    launchValue: call.value,
    walletBalance: balance,
    config,
  });
  if (!onChain.ok) {
    return finish(RunStatus.Rejected, reasonOf(onChain.refusal, onChain.detail), {
      decision,
      execution: refusedExecution(env.newId(), decision.id, onChain.refusal, onChain.detail),
    });
  }

  // --- 10. simulation -----------------------------------------------------
  //
  // Not a security boundary, and the comment matters more than the code: a passing
  // simulation means the call would not revert against a state that has already moved
  // on by the time it is mined. The contracts remain the authority. What this buys is
  // that the common failures — an unfunded wallet, a market already taken — cost
  // nothing and are legible.

  const simulated = await env.simulate(call, signer);
  if (!simulated.ok) {
    const detail = simulated.detail ?? "the call would revert";
    return finish(RunStatus.SimulationFailed, `SIMULATION_REVERTED: ${detail}`, {
      decision,
      execution: {
        id: env.newId(),
        decisionId: decision.id,
        status: RunStatus.SimulationFailed,
        txHash: null,
        errorCode: "SIMULATION_REVERTED",
        errorMessage: detail.slice(0, 500),
        submittedAt: null,
        confirmedAt: null,
        signer,
        value: call.value,
      },
    });
  }

  // --- 11. is it all still true? -----------------------------------------

  const after = await env.readChain(config.agentId);
  const still = assertStillPermitted({
    action: intent.action,
    before,
    after,
    wallet: signer,
    launchValue: call.value,
    walletBalance: balance,
    config,
  });
  if (!still.ok) {
    return finish(RunStatus.Rejected, reasonOf(still.refusal, still.detail), {
      decision,
      execution: refusedExecution(env.newId(), decision.id, still.refusal, still.detail),
    });
  }

  // --- 12. execute --------------------------------------------------------

  const executionId = env.newId();
  let hash: Hex;
  try {
    hash = await env.send(call, signer);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "the transaction was not accepted";
    return finish(RunStatus.RuntimeError, `SEND_FAILED: ${detail.slice(0, 300)}`, {
      decision,
      execution: {
        id: executionId,
        decisionId: decision.id,
        status: RunStatus.RuntimeError,
        txHash: null,
        errorCode: "SEND_FAILED",
        errorMessage: detail.slice(0, 500),
        submittedAt: startedAt,
        confirmedAt: null,
        signer,
        value: call.value,
      },
    });
  }

  const submittedAt = await env.now();
  const receipt = await env.waitFor(hash);

  if (receipt === null) {
    return finish(RunStatus.Submitted, null, {
      decision,
      execution: {
        id: executionId,
        decisionId: decision.id,
        status: RunStatus.Submitted,
        txHash: hash,
        errorCode: null,
        errorMessage: null,
        submittedAt,
        confirmedAt: null,
        signer,
        value: call.value,
      },
    });
  }

  const reverted = receipt.status === "reverted";

  return finish(
    reverted ? RunStatus.Reverted : RunStatus.Confirmed,
    reverted ? "TRANSACTION_REVERTED" : null,
    {
      decision,
      execution: {
        id: executionId,
        decisionId: decision.id,
        status: reverted ? RunStatus.Reverted : RunStatus.Confirmed,
        txHash: hash,
        errorCode: reverted ? "TRANSACTION_REVERTED" : null,
        errorMessage: null,
        submittedAt,
        confirmedAt: receipt.confirmedAt,
        signer,
        value: call.value,
      },
    },
  );
}

// --- building -------------------------------------------------------------

type BuildResult =
  | { readonly ok: true; readonly call: Call }
  | { readonly ok: false; readonly code: string; readonly detail: string };

/**
 * Turn an intent into a call.
 *
 * The narrowest function in the runtime, and the one to read if you read only one. Note
 * what does *not* happen: nothing from the intent is passed to a builder. The launch
 * comes from the stored plan; the claim comes from the chain's own record of the
 * router. The intent's parameters are only ever compared.
 */
async function buildFor(
  intent: AgentIntent,
  config: AgentRuntimeConfig,
  env: RuntimeEnvironment,
  chain: ChainView,
): Promise<BuildResult> {
  switch (intent.action) {
    case RuntimeAction.LaunchMarket: {
      const plan = await env.loadLaunchPlan(config.agentId);
      if (plan === null) {
        return {
          ok: false,
          code: "NO_LAUNCH_PLAN",
          detail:
            "this agent has no stored launch plan, so there is nothing to launch. A plan " +
            "is the parameters that hash to the market the agent was created expecting.",
        };
      }

      // The plan was verified against the chain's commitment when it was stored, and is
      // verified again by whoever supplies it. What is checked here is narrower and
      // different: that the model was reasoning about *this* market. The token compared
      // against is the registry's `expectation.token` — the chain's, never the intent's.
      const matches = intentMatchesPlan(intent, plan, chain.expectedToken);
      if (!matches.ok) {
        return { ok: false, code: matches.refusal, detail: matches.detail };
      }

      return { ok: true, call: buildLaunch(plan) };
    }

    case RuntimeAction.ClaimRevenue: {
      // The router's address comes from the registry, in the view read at the top of
      // this run — not from the intent, which carries no destination at all. The only
      // thing the intent chose was the moment.
      if (chain.router === ZERO_ADDRESS) {
        return { ok: false, code: "NO_ROUTER", detail: "the agent has no revenue router" };
      }

      // `claimMarketFees()`, and only it. One intent, one transaction: recognise,
      // allocate and settle are permissionless cranks and are not folded in here.
      //
      // Through the SDK builder rather than a selector constant. The first draft of
      // this file hardcoded four bytes and they were the wrong four bytes — it would
      // have sent a call no contract answers to, and the revert would have said
      // nothing about why. The builder encodes against the emitted ABI, so it is wrong
      // only if the ABI is.
      return { ok: true, call: agents.build.buildClaimMarketFees({ router: chain.router }) };
    }

    case RuntimeAction.NoAction:
      return { ok: false, code: "UNREACHABLE", detail: "NO_ACTION does not build a call" };
  }
}

// --- records --------------------------------------------------------------

function refusedExecution(
  id: string,
  decisionId: string,
  code: string,
  detail: string,
): AgentExecution {
  return {
    id,
    decisionId,
    status: RunStatus.Rejected,
    txHash: null,
    errorCode: code,
    errorMessage: detail.slice(0, 500),
    submittedAt: null,
    confirmedAt: null,
    signer: null,
    value: 0n,
  };
}

function reasonOf(refusal: GuardRefusal, detail: string): string {
  return `${refusal}: ${detail}`;
}

/**
 * The intent's own parameters, as JSON.
 *
 * `action`, `confidence` and `reasoningSummary` are columns of their own, so repeating
 * them here would be two copies of one fact that can disagree after a migration.
 */
function parametersOf(intent: AgentIntent): string {
  switch (intent.action) {
    case RuntimeAction.LaunchMarket:
      return JSON.stringify({ token: intent.token, symbol: intent.symbol });
    case RuntimeAction.ClaimRevenue:
      return JSON.stringify({ asset: intent.asset });
    case RuntimeAction.NoAction:
      return "{}";
  }
}
