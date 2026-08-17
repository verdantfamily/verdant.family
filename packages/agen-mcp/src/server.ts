/**
 * The tool surface.
 *
 * ## Reading, preparing and spending are three different things
 *
 * 1. **Annotations.** Every read carries `readOnlyHint: true`. Neither launch tool does —
 *    including `prepare_instant_launch`, which holds no key and spends nothing but does
 *    store a metadata document and consume a launch allowance, and a client auto-approving
 *    it on a read-only hint would be approving that. Both carry `destructiveHint: false`:
 *    they create a market rather than alter one, and a client treating "not read-only" as
 *    "may delete" would gate them wrongly. `openWorldHint` is true throughout: both backends
 *    are outside this process.
 * 2. **Idempotency.** The reads claim `idempotentHint`. Neither launch tool does: preparing
 *    twice mines two salts and stores two documents, and launching twice is two markets.
 * 3. **Code.** The reads reach the indexer, which has no write path at all. Exactly one file
 *    in this package can reach an Agen route that spends anything, and it is the treasury
 *    tool.
 *
 * The split used to be one tool with an `execution` parameter. It is two tools now because
 * the difference is *who holds the key*, and a client reading a tool list should be able to
 * see that without reading an enum's description.
 *
 * ## Descriptions are the documentation
 *
 * An agent should not have to read Agen's source to use this. So each description states what
 * the tool does, what it cannot do, and the constants that are not negotiable — a fixed
 * supply, a fixed opening valuation, an immutable fee receiver. Those refusals are the part
 * an agent is most likely to get wrong.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { AgenClient } from "./clients/agen.js";
import { FeedClient } from "./clients/feed.js";
import type { Env } from "./env.js";
import type { Logger } from "./logger.js";
import {
  getInstantMetricsOutput,
  getLaunchQuoteInput,
  getLaunchQuoteOutput,
  getLaunchStatusInput,
  getLaunchStatusOutput,
  getLaunchesInput,
  getLaunchesOutput,
  getPoolOutput,
  getTokenOutput,
  prepareInstantLaunchInput,
  prepareInstantLaunchOutput,
  tokenLookupInput,
  treasuryLaunchInput,
  treasuryLaunchOutput,
} from "./schemas.js";
import type { ToolContext } from "./tools/context.js";
import { launchInstantFromAgentTreasury } from "./tools/launch-instant-from-agent-treasury.js";
import { prepareInstantLaunch } from "./tools/prepare-instant-launch.js";
import { getLaunchQuote } from "./tools/get-launch-quote.js";
import { getLaunchStatus } from "./tools/get-launch-status.js";
import { getInstantMetrics, getLaunches, getPool, getToken } from "./tools/reads.js";

export const SERVER_NAME = "agen-instant";
export const SERVER_VERSION = "0.1.0";

const READ_ONLY = { readOnlyHint: true, idempotentHint: true, openWorldHint: true } as const;

export interface BuildOptions {
  readonly env: Env;
  readonly logger: Logger;
  /** Injected in tests, so nothing here ever reaches a real backend by accident. */
  readonly fetchImpl?: typeof fetch | undefined;
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
}

export function buildContext(options: BuildOptions): ToolContext {
  const { env, logger } = options;

  return {
    env,
    logger,
    agen: new AgenClient({
      baseUrl: env.AGEN_API_URL,
      apiKey: env.AGEN_API_KEY,
      timeoutMs: env.AGEN_MCP_TIMEOUT_MS,
      launchTimeoutMs: env.AGEN_MCP_LAUNCH_TIMEOUT_MS,
      maxRetries: env.AGEN_MCP_MAX_RETRIES,
      logger,
      fetchImpl: options.fetchImpl,
      sleep: options.sleep,
    }),
    feed: new FeedClient({
      baseUrl: env.AGEN_INSTANT_FEED_URL,
      timeoutMs: env.AGEN_MCP_TIMEOUT_MS,
      maxRetries: env.AGEN_MCP_MAX_RETRIES,
      logger,
      fetchImpl: options.fetchImpl,
      sleep: options.sleep,
    }),
  };
}

export function buildServer(options: BuildOptions): { readonly server: McpServer; readonly context: ToolContext } {
  const context = buildContext(options);
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        "Agen Instant launches on Robinhood Chain. Every Instant token has a fixed 1,000,000,000 supply, " +
        "18 decimals, an ether-quoted Uniswap v4 pool with the entire supply in one locked position, no " +
        "creator allocation, no vesting, immutable metadata, and a 1.50% trading fee split 1.00% to the " +
        "creator and 0.50% to the platform. Supply, opening valuation and fee are contract constants and " +
        "cannot be set. Quote before launching. This server holds no private key. prepare_instant_launch " +
        "returns unsigned calldata for the caller's own wallet to sign and broadcast; only " +
        "launch_instant_from_agent_treasury spends anything, and it spends the authenticated Agen agent's own " +
        "treasury under permissions its owner set.",
    },
  );

  // --- preparing: builds calldata, signs nothing ----------------------------

  server.registerTool(
    "prepare_instant_launch",
    {
      title: "Prepare an Instant launch for your own wallet to sign",
      description:
        "Build the unsigned transaction for an Agen Instant launch and return it. Nothing is signed, sent or " +
        "spent: the response is execution_status=prepared with requires_signature and requires_broadcast both " +
        "true, and your own wallet does both. Sending it deploys the ERC-20, opens its ether-quoted Uniswap v4 " +
        "pool, locks the entire supply as one position and makes the creator's first buy, in one transaction. " +
        "Supply is fixed at 1000000000 and is not a parameter. feeReceiver may be any address here and is " +
        "immutable once launched. Send `transaction` from `signer` — the token address is derived from the " +
        "sender, so another sender produces another address. If escrowTransaction is present, send it first. " +
        "Call get_launch_quote before this.",
      inputSchema: prepareInstantLaunchInput,
      outputSchema: prepareInstantLaunchOutput,
      annotations: {
        /*
         * Not read-only, despite holding no key and spending nothing.
         *
         * `readOnlyHint` is a claim about the environment, not about money: this stores a
         * metadata document, mines a salt and counts against the launch rate limit. Marking
         * it read-only would let a client auto-approve it silently, and an agent in a loop
         * would write documents and exhaust an allowance nobody agreed to spend. What it
         * cannot do is stated in the response instead, where it is exact.
         */
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    (input) => prepareInstantLaunch(context, input),
  );

  // --- spending: the only tool that moves money -----------------------------

  server.registerTool(
    "launch_instant_from_agent_treasury",
    {
      title: "Launch from the Agen agent's own treasury",
      description:
        "Launch immediately, signed and paid for by the authenticated Agen agent's own isolated treasury, " +
        "under the permissions its owner set: per-launch and daily ETH ceilings, launches per day, reserve. " +
        "This spends real money and cannot be undone. Fees accrue to the agent's own wallet and cannot be " +
        "redirected: feeReceiver and signer are refused rather than ignored — use prepare_instant_launch to " +
        "choose either. Requires an API key. Returns execution_status=confirmed with the transaction hash and " +
        "the market's addresses. Call get_launch_quote first.",
      inputSchema: treasuryLaunchInput,
      outputSchema: treasuryLaunchOutput,
      annotations: {
        readOnlyHint: false,
        // Creates a new market; alters nothing that already exists.
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    (input) => launchInstantFromAgentTreasury(context, input),
  );

  // --- read-only -----------------------------------------------------------

  server.registerTool(
    "get_launch_quote",
    {
      title: "Quote an Instant launch",
      description:
        "What a launch would cost and produce, simulated against the deployed InstantFactory with eth_call. " +
        "Returns the tokens the creator's first buy would receive, the ownership share, price impact against " +
        "the opening price, the protocol and creator fee split, the fixed supply and opening market cap, and " +
        "whether a one-off Boost escrow transaction is needed first. `problems` lists anything that would " +
        "stop the launch. Writes nothing and needs no balance.",
      inputSchema: getLaunchQuoteInput,
      outputSchema: getLaunchQuoteOutput,
      annotations: READ_ONLY,
    },
    (input) => getLaunchQuote(context, input),
  );

  server.registerTool(
    "get_launch_status",
    {
      title: "Status of an Instant launch",
      description:
        "Progress of a launch by launchId, token address or transaction hash. Instant deploys the token, " +
        "creates the pool and makes it tradable in one transaction, so those stages become true together on " +
        "confirmation. Only `indexed` lags: when `indexerPending` is true the market exists on chain and the " +
        "indexer has not caught up, so retry rather than treating it as a failure.",
      inputSchema: getLaunchStatusInput,
      outputSchema: getLaunchStatusOutput,
      annotations: READ_ONLY,
    },
    (input) => getLaunchStatus(context, input),
  );

  server.registerTool(
    "get_token",
    {
      title: "Canonical Agen data for a token",
      description:
        "Everything Agen knows about an Instant token: supply and circulating supply, creator, fee vault, " +
        "pool, price, market cap, all-time and 24h volume with Boost buybacks separated out, accrued creator " +
        "and platform fees, trade count and creation transaction. All wei amounts are decimal strings.",
      inputSchema: tokenLookupInput,
      outputSchema: getTokenOutput,
      annotations: READ_ONLY,
    },
    (input) => getToken(context, input),
  );

  server.registerTool(
    "get_pool",
    {
      title: "Pool and liquidity for an Instant token",
      description:
        "The Uniswap v4 pool behind an Instant token. Ether is always currency0 and the token always " +
        "currency1. Includes the locked position's id and liquidity, the locker and fee vault addresses, the " +
        "dynamic-fee flag the hook overrides per swap, and the fee split in parts per million.",
      inputSchema: tokenLookupInput,
      outputSchema: getPoolOutput,
      annotations: READ_ONLY,
    },
    (input) => getPool(context, input),
  );

  server.registerTool(
    "get_launches",
    {
      title: "Discover Instant launches",
      description:
        "List Instant launches from Agen's indexer. Sort by newest, volume, organicVolume (volume excluding " +
        "Boost buybacks, the honest activity ranking), trades, liquidity or fees; filter by creator; or pass " +
        "a token to look up one. There is no trending sort because Agen has not defined a trending ranking, " +
        "and inventing one here would misreport it as Agen's.",
      inputSchema: getLaunchesInput,
      outputSchema: getLaunchesOutput,
      annotations: READ_ONLY,
    },
    (input) => getLaunches(context, input),
  );

  server.registerTool(
    "get_instant_metrics",
    {
      title: "Agen Instant platform metrics",
      description:
        "Platform-wide Instant totals: markets, distinct creators, trades, volume split into organic and " +
        "Boost, fees accrued to creators and the platform, 24h figures, Boost activity, and the last launch " +
        "time. Also returns the contract constants every Instant market shares. Fees are accrued, not claimed.",
      outputSchema: getInstantMetricsOutput,
      annotations: READ_ONLY,
    },
    () => getInstantMetrics(context),
  );

  return { server, context };
}
