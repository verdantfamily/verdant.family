/**
 * Carrying out a decision the owner's rules already allowed.
 *
 * This file is deliberately thin, and its thinness is the point. Every branch
 * ends in a Phase 1 function that was already the only way to do that thing:
 * `agentInstantLaunch`, `startAgentBuild`, `answerAgentBuild`,
 * `claimAgentRevenue`. Those still run every permission check, still take the
 * spending reservation, still record the launch and the activity, and still reach
 * the chain through the same allowlisted signer.
 *
 * Nothing here builds a transaction, chooses a contract, or touches a key. An
 * autonomous launch and a launch made with an API key are the same code below
 * this line; the only difference is who asked. That is what keeps "the agent can
 * now act on its own" from being a new attack surface rather than a new caller.
 */

import { AGENT_PROGRAMMABLE_LAUNCHABLE } from "../programmable";
import type { ValidatedDecision } from "./decision";
import { AgentError } from "./errors";
import { instantLaunchBlocker } from "./permissions";
import { answerAgentBuild, startAgentBuild } from "./programmable";
import { agentInstantLaunch, claimAgentRevenue } from "./service";
import type { AgentStore } from "./store";
import { executeAgentBuy, executeAgentSell, type AgentTradeOutcome } from "./trade";
import type { AgentRecord } from "./types";

export interface ExecutionResult {
  readonly summary: string;
  readonly detail: Record<string, unknown>;
}

export async function executeDecision(
  store: AgentStore,
  agent: AgentRecord,
  decision: ValidatedDecision,
): Promise<ExecutionResult> {
  switch (decision.kind) {
    case "no_action":
      return { summary: "Did nothing.", detail: {} };

    case "instant_launch": {
      // The market carries the agent's own picture. Normally the planner will not
      // have offered this action at all when there is no picture to use, so
      // reaching here means an approval made before the picture was removed. Same
      // sentence either way.
      const blocker = instantLaunchBlocker(agent);
      if (blocker !== null) throw new AgentError("VALIDATION_FAILED", blocker);

      const result = await agentInstantLaunch(store, agent, null, {
        name: decision.name,
        symbol: decision.symbol,
        imageUrl: agent.imageUrl,
        description: decision.description,
        initialBuy: formatEth(decision.initialBuyWei),
        boostCapable: decision.boost,
      });

      return { summary: `Created ${decision.symbol} on Instant.`, detail: result };
    }

    case "programmable_build": {
      const job = await startAgentBuild(store, agent, {
        prompt: decision.prompt,
        name: decision.name,
        symbol: decision.symbol,
      });

      // Starting a build is not launching one, and the agent gate stays shut
      // regardless. Said here so the record explains itself later.
      return {
        summary: AGENT_PROGRAMMABLE_LAUNCHABLE
          ? `Started a Programmable build for ${decision.symbol}.`
          : `Started a Programmable build for ${decision.symbol}. Launching stays held.`,
        detail: { jobId: job.id, stage: job.stage },
      };
    }

    case "answer_clarification": {
      const job = await answerAgentBuild(store, agent.id, decision.jobId, decision.answers);
      return {
        summary: `Answered ${String(decision.answers.length)} question(s) on a build.`,
        detail: { jobId: job.id, stage: job.stage },
      };
    }

    case "claim_revenue": {
      // `asOwner: false`, always. An autonomous claim is the agent acting, so it
      // must pass `canClaimCreatorFees` exactly as an API-key claim would.
      const result = await claimAgentRevenue(store, { agent, asOwner: false }, decision.token);
      return { summary: "Claimed creator fees.", detail: result };
    }

    case "buy_token": {
      const result = await executeAgentBuy(store, agent, {
        token: decision.token,
        amountWei: decision.amountWei,
      });

      return {
        summary: `Bought ${result.symbol} for ${formatEth(result.quoteWei)} ETH.`,
        detail: tradeDetail(result),
      };
    }

    case "sell_token": {
      const result = await executeAgentSell(store, agent, {
        token: decision.token,
        fraction: decision.fraction,
      });

      return {
        summary: `Sold ${result.symbol} for ${formatEth(result.quoteWei)} ETH.`,
        detail: tradeDetail(result),
      };
    }
  }
}

/** Wei as strings, as every other stored decision result does it. */
function tradeDetail(result: AgentTradeOutcome): Record<string, unknown> {
  return {
    side: result.side,
    token: result.token,
    symbol: result.symbol,
    quoteWei: result.quoteWei.toString(),
    tokenAmount: result.tokenAmount.toString(),
    priceImpactBps: result.priceImpactBps,
    txHash: result.txHash,
    ...(result.approvalTxHash === null ? {} : { approvalTxHash: result.approvalTxHash }),
  };
}

function formatEth(wei: bigint): string {
  if (wei === 0n) return "";
  const whole = wei / 10n ** 18n;
  const fraction = (wei % 10n ** 18n).toString().padStart(18, "0").replace(/0+$/, "");
  return fraction === "" ? whole.toString() : `${whole.toString()}.${fraction}`;
}
