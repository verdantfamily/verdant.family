/**
 * `get_launch_status` — where a launch has got to.
 *
 * ## Two sources, because they answer different questions
 *
 * Agen's launch record (`GET /api/v1/me/launches[/:id]`) knows whether a launch was
 * requested, submitted, succeeded or failed, and it is the only thing that knows about a
 * launch that failed — a transaction that reverted leaves nothing on chain to find. The
 * Instant indexer knows whether the market is visible to the rest of the product. A caller
 * needs both, so both are asked and `source` says which answered.
 *
 * ## Why the stages are booleans and not a ladder
 *
 * `InstantFactory.create` deploys the token, initialises the pool, mints the locked position
 * and runs the creator's first buy in a single transaction. There is no moment at which the
 * token exists and the pool does not, so `deployed`, `poolCreated` and `tradable` become true
 * together when the transaction confirms. Presenting them as sequential stages would invite
 * an agent to poll for a transition that never happens.
 *
 * `indexed` is the only one that genuinely lags, and `indexerPending` names that case so a
 * caller retries instead of concluding the launch failed.
 */

import type { AgentLaunch } from "../clients/agen.js";
import { AgenMcpError } from "../errors.js";
import { runTool, type ToolContext, type ToolResult } from "./context.js";

export interface GetLaunchStatusInput {
  readonly launchId?: string | undefined;
  readonly token?: string | undefined;
  readonly txHash?: string | undefined;
}

type Status = "pending" | "submitted" | "confirmed" | "failed" | "not_found";

/** Agen's four record states, as the five this tool reports. */
function statusOf(record: AgentLaunch): Status {
  switch (record.status) {
    case "requested":
      return "pending";
    case "submitted":
      return "submitted";
    case "succeeded":
      return "confirmed";
    case "failed":
      return "failed";
  }
}

export function getLaunchStatus(context: ToolContext, input: GetLaunchStatusInput): Promise<ToolResult> {
  return runTool({ name: "get_launch_status", context, input }, async ({ requestId }) => {
    if (input.launchId === undefined && input.token === undefined && input.txHash === undefined) {
      throw new AgenMcpError(
        "INVALID_INPUT",
        "Give one of launchId, token or txHash.",
        { source: "mcp" },
      );
    }

    const record = await findRecord(context, input, requestId);

    /*
     * The indexer, asked only when there is an address to ask about.
     *
     * A launch still awaiting its receipt has no token, and a launch that failed has no token
     * that will ever exist — neither is a reason to call the feed, and a 404 from it would be
     * reported as an absence rather than as the pending state it actually is.
     */
    const token = record?.token ?? input.token ?? null;
    const indexed =
      token === null || !context.feed.configured
        ? null
        : await context.feed.market(token, requestId).catch(() => null);

    if (record === null && indexed === null) {
      return {
        status: "not_found" satisfies Status,
        stages: blank(),
        launchId: input.launchId ?? null,
        token: input.token ?? null,
        pool: null,
        txHash: input.txHash ?? null,
        creator: null,
        feeReceiver: null,
        name: null,
        symbol: null,
        spendWei: null,
        createdAt: null,
        error: null,
        indexerPending: false,
        source: context.feed.configured ? ("both" as const) : ("agen-api" as const),
      };
    }

    /*
     * An indexed market is a confirmed launch even without a record.
     *
     * Launch records belong to the agent that made them, so a token launched from somebody's
     * own wallet — the `unsigned_transaction` path — has none. The chain is still the
     * authority on whether the market exists.
     */
    const status: Status = record === null ? "confirmed" : statusOf(record);
    const confirmed = status === "confirmed" || indexed !== null;
    const failed = status === "failed";

    return {
      status,
      stages: {
        submitted: confirmed || status === "submitted",
        confirmed,
        deployed: confirmed,
        poolCreated: confirmed,
        indexed: indexed !== null,
        tradable: confirmed,
        failed,
      },
      launchId: record?.id ?? null,
      token: indexed?.token ?? record?.token ?? input.token ?? null,
      pool: indexed?.poolId ?? record?.pool ?? null,
      txHash: indexed?.createdTx ?? record?.txHash ?? input.txHash ?? null,
      creator: indexed?.creator ?? record?.agentWallet ?? null,
      feeReceiver: indexed?.vault ?? record?.feeRecipient ?? null,
      name: indexed?.name ?? record?.name ?? null,
      symbol: indexed?.symbol ?? record?.symbol ?? null,
      spendWei: record?.spendWei ?? null,
      createdAt: indexed?.createdAt ?? record?.createdAt ?? null,
      error: record?.error ?? null,
      indexerPending: confirmed && indexed === null && context.feed.configured,
      source: record !== null && indexed !== null ? ("both" as const) : record !== null ? ("agen-api" as const) : ("instant-feed" as const),
    };
  });
}

/**
 * The launch record, by whichever identifier was given.
 *
 * `launchId` is a direct read. A token or a transaction hash needs the agent's own list,
 * because Agen indexes launch records by id and by token but has no route from a hash — and
 * scanning one agent's own launches is cheaper and narrower than adding one.
 *
 * Missing is not a failure: a token launched from somebody's own wallet has no record here
 * and is still a real market. `UNAUTHORIZED` is the exception, because a caller with no key
 * should be told that rather than told the launch does not exist.
 */
async function findRecord(
  context: ToolContext,
  input: GetLaunchStatusInput,
  requestId: string,
): Promise<AgentLaunch | null> {
  if (!context.agen.hasApiKey) return null;

  try {
    if (input.launchId !== undefined) {
      const { launch } = await context.agen.launch(input.launchId, requestId);
      return launch;
    }

    const { launches } = await context.agen.launches(requestId);
    const wanted = {
      token: input.token?.toLowerCase(),
      txHash: input.txHash?.toLowerCase(),
    };

    return (
      launches.find(
        (entry) =>
          (wanted.token !== undefined && entry.token?.toLowerCase() === wanted.token) ||
          (wanted.txHash !== undefined && entry.txHash?.toLowerCase() === wanted.txHash),
      ) ?? null
    );
  } catch (error) {
    if (error instanceof AgenMcpError && error.code === "UNAUTHORIZED") throw error;
    return null;
  }
}

function blank(): Record<string, boolean> {
  return {
    submitted: false,
    confirmed: false,
    deployed: false,
    poolCreated: false,
    indexed: false,
    tradable: false,
    failed: false,
  };
}
