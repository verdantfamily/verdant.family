/**
 * `launch_instant_from_agent_treasury` — the one tool that spends money.
 *
 * ## Whose money, and under whose rules
 *
 * This posts to `POST /api/v1/me/launches/instant`, the route Agen agents already use. The
 * authenticated agent's own isolated treasury signs, under permissions its owner set: a
 * per-launch ceiling, a daily ceiling, launches per day, a reserve. None of that is enforced
 * here — it is enforced where it always was, on the Agen side, and a refusal arrives as
 * `PERMISSION_DENIED` naming the permission and the numbers.
 *
 * A caller with no API key cannot reach it at all. There is no unauthenticated launch path.
 *
 * ## Why a fee receiver is refused rather than ignored
 *
 * `agentInstantLaunch` builds its draft with `feeReceiver: agent.walletAddress` and rejects
 * any body naming a `creator`, `wallet` or `signer` — an agent does not choose where the money
 * it spends ends up. A `feeReceiver` forwarded here would therefore be discarded in silence,
 * and the agent would go on to report a destination the market does not have. Refusing is the
 * only honest answer, and it names the tool that does support one.
 *
 * ## Not retried
 *
 * See `clients/http.ts`. A timeout here means the answer did not arrive, not that the
 * transaction did not land, and the difference is a real token. Call `get_launch_status`.
 */

import { AgenMcpError } from "../errors.js";
import { INSTANT_SUPPLY_TOKENS } from "../schemas.js";
import { explorerUrl, marketUrl, runTool, type ToolContext, type ToolResult } from "./context.js";

export interface TreasuryLaunchInput {
  readonly name: string;
  readonly symbol: string;
  readonly imageUrl: string;
  readonly signer?: string | undefined;
  readonly feeReceiver?: string | undefined;
  readonly initialBuyEth?: string | undefined;
  readonly totalSupply?: string | undefined;
  readonly description?: string | undefined;
  readonly boostCapable?: boolean | undefined;
  readonly linkX?: string | undefined;
  readonly website?: string | undefined;
  readonly telegram?: string | undefined;
}

export function launchInstantFromAgentTreasury(
  context: ToolContext,
  input: TreasuryLaunchInput,
): Promise<ToolResult> {
  return runTool({ name: "launch_instant_from_agent_treasury", context, input }, async ({ requestId }) => {
    if (input.feeReceiver !== undefined) {
      throw new AgenMcpError(
        "PERMISSION_DENIED",
        "An Agen agent cannot redirect the fees of a launch its own treasury pays for. " +
          "Omit feeReceiver to pay the agent's wallet, or use prepare_instant_launch to launch " +
          "from your own wallet with any fee receiver.",
        { source: "mcp", permission: "feeReceiver" },
      );
    }
    if (input.signer !== undefined) {
      throw new AgenMcpError(
        "PERMISSION_DENIED",
        "An Agen agent signs with its own treasury and cannot be pointed at another signer. " +
          "Use prepare_instant_launch to choose the signer.",
        { source: "mcp", permission: "signer" },
      );
    }

    const result = await context.agen.launchInstant(
      {
        name: input.name,
        symbol: input.symbol,
        imageUrl: input.imageUrl,
        ...(input.description === undefined ? {} : { description: input.description }),
        ...(input.initialBuyEth === undefined ? {} : { initialBuy: input.initialBuyEth }),
        ...(input.boostCapable === undefined ? {} : { boostCapable: input.boostCapable }),
        ...(input.linkX === undefined ? {} : { linkX: input.linkX }),
        ...(input.website === undefined ? {} : { website: input.website }),
        ...(input.telegram === undefined ? {} : { telegram: input.telegram }),
      },
      requestId,
    );

    // The creator and the fee receiver are the agent's wallet by construction. Read rather
    // than assumed, so the answer states the address the market actually names.
    const identity = await context.agen.me(requestId).catch(() => null);
    const wallet = identity?.agent.walletAddress ?? null;

    return {
      execution_status: "confirmed",
      requires_signature: false,
      requires_broadcast: false,
      signedBy: "agen_agent_treasury",

      chainId: context.env.AGEN_CHAIN_ID,
      token: result.token,
      tokenAddressIsPredicted: false,
      pool: result.pool,
      txHash: result.txHash,
      launchId: result.launchId,
      creator: wallet,
      feeReceiver: wallet,
      feePayoutAddress: wallet,
      name: input.name,
      symbol: input.symbol,
      supplyTokens: INSTANT_SUPPLY_TOKENS.toString(),
      initialBuyWei: result.spendWei,
      metadataURI: null,
      urls: {
        market: marketUrl(context.env, result.token),
        explorerTx: explorerUrl(context.env, "tx", result.txHash),
        explorerToken: explorerUrl(context.env, "address", result.token),
      },
      nextStep:
        "The market exists and is tradable. Call get_launch_status with this launchId to confirm the indexer has it.",
    };
  });
}
