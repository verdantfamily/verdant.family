/**
 * Programmable launches for an agent, through the production compiler.
 *
 * A prompt enters `startBuild`. Clarifications go through `answerBuildQuestions`.
 * A launch is `prepareLaunch` with the agent wallet as creator, then the same
 * factory calldata a human would sign. Nothing about being an agent skips a
 * stage, and a job that is not `deployment_ready` cannot be launched.
 */

import { agen } from "@verdant/sdk";
import { parseEther, type Address, type Hex } from "viem";

import {
  answerBuildQuestions,
  jobStore,
  publicView,
  startBuild,
  type PublicJob,
} from "../builds";
import { LaunchError, prepareLaunch } from "../launch";
import { recordLaunch } from "../launched";
import { AGENT_PROGRAMMABLE_HELD, AGENT_PROGRAMMABLE_LAUNCHABLE } from "../programmable";
import { AgentError } from "./errors";
import { assertMainnetSigning } from "./mainnet";
import { sendApproved } from "./signer";
import type { AgentStore } from "./store";
import type { AgentRecord } from "./types";

const LIMITS = {
  promptMin: 12,
  promptMax: 4_000,
  nameMax: 64,
  symbolMax: 12,
} as const;

export function parseBuildRequest(body: Record<string, unknown>): {
  readonly prompt: string;
  readonly name: string;
  readonly symbol: string;
} {
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const symbol = typeof body.symbol === "string" ? body.symbol.trim().toUpperCase() : "";
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";

  if (name.length === 0) throw new AgentError("VALIDATION_FAILED", "A token name is required.");
  if (name.length > LIMITS.nameMax) {
    throw new AgentError("VALIDATION_FAILED", `The name must be under ${String(LIMITS.nameMax)} characters.`);
  }
  if (symbol.length === 0) throw new AgentError("VALIDATION_FAILED", "A ticker is required.");
  if (symbol.length > LIMITS.symbolMax) {
    throw new AgentError("VALIDATION_FAILED", `The ticker must be under ${String(LIMITS.symbolMax)} characters.`);
  }
  if (prompt.length < LIMITS.promptMin) {
    throw new AgentError("VALIDATION_FAILED", "Describe how the market should behave, in a sentence or more.");
  }
  if (prompt.length > LIMITS.promptMax) {
    throw new AgentError("VALIDATION_FAILED", `The description must be under ${String(LIMITS.promptMax)} characters.`);
  }

  return { prompt, name, symbol };
}

export async function startAgentBuild(
  store: AgentStore,
  agent: AgentRecord,
  body: Record<string, unknown>,
): Promise<PublicJob> {
  const request = parseBuildRequest(body);
  const started = await startBuild(request);
  if (!started.ok || started.jobId === undefined) {
    throw new AgentError("CONFIG_MISSING", started.error ?? "A build could not be started.");
  }

  store.linkBuild({
    jobId: started.jobId,
    agentId: agent.id,
    createdAt: Math.floor(Date.now() / 1000),
  });

  const job = await jobStore().read(started.jobId);
  if (job === null) throw new AgentError("BUILD_NOT_FOUND", "The build was accepted but could not be read back.");
  return publicView(job);
}

export async function readAgentBuild(store: AgentStore, agentId: string, jobId: string): Promise<PublicJob> {
  const owner = store.buildOwner(jobId);
  if (owner !== agentId) throw new AgentError("BUILD_NOT_FOUND", "There is no build with that id for this agent.");

  const job = await jobStore().read(jobId);
  if (job === null) throw new AgentError("BUILD_NOT_FOUND", "There is no build with that id.");

  if (job.stage === "awaiting_clarification") {
    store.recordActivity({
      agentId,
      type: "clarification_requested",
      payload: { jobId, questions: job.specification === null ? 0 : 1 },
    });
  }
  if (job.stage === "deployment_ready") {
    store.recordActivity({ agentId, type: "build_ready", payload: { jobId } });
  }

  return publicView(job);
}

export async function answerAgentBuild(
  store: AgentStore,
  agentId: string,
  jobId: string,
  answers: readonly { readonly id: string; readonly answer?: string }[],
): Promise<PublicJob> {
  const owner = store.buildOwner(jobId);
  if (owner !== agentId) throw new AgentError("BUILD_NOT_FOUND", "There is no build with that id for this agent.");

  const started = await answerBuildQuestions(jobId, answers);
  if (!started.ok) {
    throw new AgentError("BUILD_NOT_FOUND", started.error ?? "That build could not be answered.");
  }

  store.recordActivity({
    agentId,
    type: "clarification_answered",
    payload: { jobId, answers: answers.length },
  });

  const job = await jobStore().read(jobId);
  if (job === null) throw new AgentError("BUILD_NOT_FOUND", "There is no build with that id.");
  return publicView(job);
}

export interface ProgrammableLaunchResult {
  readonly token: Address;
  readonly hook: Address;
  readonly txHash: Hex;
  readonly buyTxHash: Hex | null;
  readonly spendWei: bigint;
  readonly jobId: string;
}

export async function launchAgentBuild(
  store: AgentStore,
  agent: AgentRecord,
  jobId: string,
  initialBuy: string,
  send: typeof sendApproved = sendApproved,
): Promise<ProgrammableLaunchResult> {
  assertMainnetSigning();
  if (!AGENT_PROGRAMMABLE_LAUNCHABLE) {
    throw new AgentError("PROGRAMMABLE_HELD", AGENT_PROGRAMMABLE_HELD);
  }

  const owner = store.buildOwner(jobId);
  if (owner !== agent.id) throw new AgentError("BUILD_NOT_FOUND", "There is no build with that id for this agent.");

  let buyWei = 0n;
  if (initialBuy.trim() !== "") {
    try {
      buyWei = parseEther(initialBuy.trim());
    } catch {
      throw new AgentError("VALIDATION_FAILED", "The initial buy is not an amount.");
    }
  }

  let prepared;
  try {
    prepared = await prepareLaunch({
      jobId,
      creator: agent.walletAddress,
      feeReceiver: agent.walletAddress,
      devBuyWei: buyWei,
    });
  } catch (error) {
    if (error instanceof LaunchError) {
      throw new AgentError(
        error.status === 409 ? "BUILD_NOT_READY" : "VALIDATION_FAILED",
        error.message,
        { status: error.status },
      );
    }
    throw error;
  }

  const sent = await send(store, agent.id, {
    to: prepared.transaction.to,
    data: prepared.transaction.data,
    value: BigInt(prepared.transaction.value),
  });

  const record = await recordLaunch(jobId, sent.hash);

  let buyTxHash: Hex | null = null;
  if (prepared.initialBuy !== undefined) {
    const buy = agen.buildAgenBuy({
      router: prepared.initialBuy.router,
      poolKey: {
        currency0: prepared.initialBuy.poolKey.currency0,
        currency1: prepared.initialBuy.poolKey.currency1,
        fee: prepared.initialBuy.poolKey.fee,
        tickSpacing: prepared.initialBuy.poolKey.tickSpacing,
        hooks: prepared.initialBuy.poolKey.hooks,
      },
      amountIn: BigInt(prepared.initialBuy.amountWei),
      minAmountOut: 0n,
    });
    const bought = await send(store, agent.id, buy);
    buyTxHash = bought.hash;
  }

  return {
    token: record.token,
    hook: record.hook,
    txHash: sent.hash,
    buyTxHash,
    spendWei: buyWei,
    jobId,
  };
}
