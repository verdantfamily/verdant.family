/**
 * The Agen Agent API, as typed calls.
 *
 * Every method here is one existing route. Nothing is composed, cached or recalculated:
 * where a field looks like it needs deriving, it is because the route already derives it.
 * If this file ever grows a calculation, the calculation belongs upstream.
 *
 * Routes documented in `docs/agents-api.md`.
 */

import type { Logger } from "../logger.js";
import { HttpClient } from "./http.js";

export interface AgentIdentity {
  readonly id: string;
  readonly username: string;
  readonly name: string;
  readonly walletAddress: string;
  readonly status: "active" | "paused" | "archived";
  readonly createdAt: number;
  readonly permissions?: Record<string, unknown>;
}

/** `AgentLaunchRecord`, as `/me/launches` serialises it. */
export interface AgentLaunch {
  readonly id: string;
  readonly agentId: string;
  readonly agentWallet: string;
  readonly kind: "instant" | "programmable";
  readonly token: string | null;
  readonly pool: string | null;
  readonly txHash: string | null;
  readonly jobId: string | null;
  readonly name: string | null;
  readonly symbol: string | null;
  readonly spendWei: string;
  readonly feeRecipient: string | null;
  readonly status: "requested" | "submitted" | "succeeded" | "failed";
  readonly createdAt: number;
  readonly error: string | null;
}

export interface InstantLaunchResponse {
  readonly launchId: string;
  readonly kind: "instant";
  readonly token: string;
  readonly pool: string;
  readonly txHash: string;
  readonly spendWei: string;
}

/** `POST /api/v1/instant/quote`. */
export interface InstantQuoteResponse {
  readonly chainId: number;
  readonly factory: string;
  /** Unix seconds, and the block the simulation was pinned to. */
  readonly quotedAt: number;
  readonly blockNumber: string | null;
  readonly supplyTokens: string;
  readonly supplyBaseUnits: string;
  readonly decimals: number;
  readonly initialTick: number;
  readonly startingMarketCapWei: string;
  readonly feeRecipient: string;
  readonly feePayoutAddress: string;
  readonly boostEscrowRequired: boolean;
  readonly feePpm: {
    readonly total: number;
    readonly creator: number;
    readonly platform: number;
    readonly denominator: number;
  };
  readonly initialBuy: {
    readonly amountWei: string;
    readonly creatorFeeWei: string;
    readonly platformFeeWei: string;
    readonly totalFeeWei: string;
    readonly tokensBaseUnits: string | null;
    readonly tokens: string | null;
    readonly ownershipBps: number | null;
    readonly ownershipPercent: number | null;
    readonly openingPriceWeiPerToken: string;
    readonly effectivePriceWeiPerToken: string | null;
    readonly priceImpactBps: number | null;
  };
  readonly pool: {
    readonly liquidity: string | null;
    readonly etherLiquidityAtOpenWei: string;
    readonly pooledSupplyPercent: number;
  };
  readonly problems: readonly string[];
  readonly simulated: boolean;
  readonly simulationError: string | null;
}

export interface UnsignedTransaction {
  readonly to: string;
  readonly data: string;
  readonly value: string;
  readonly chainId: number;
}

/** `POST /api/v1/instant/prepare`. */
export interface InstantPrepareResponse {
  readonly chainId: number;
  readonly signer: string;
  readonly transaction: UnsignedTransaction;
  readonly escrowTransaction: UnsignedTransaction | null;
  readonly token: string;
  readonly salt: string;
  readonly metadataURI: string;
  readonly feeRecipient: string;
  readonly feePayoutAddress: string;
  readonly name: string;
  readonly symbol: string;
  readonly supplyTokens: string;
  readonly initialBuyWei: string;
}

export interface TreasuryView {
  readonly address: string;
  readonly ethWei: string;
  readonly eth: string;
}

export interface AllowanceView {
  readonly permissions: Record<string, unknown>;
  readonly allowance: {
    readonly day: string;
    readonly launchesUsed: number;
    readonly launchesRemaining: number;
    readonly spentWei: string;
    readonly spendRemainingWei: string;
  };
}

export interface AgenClientOptions {
  readonly baseUrl: string;
  readonly apiKey?: string | undefined;
  readonly timeoutMs: number;
  readonly launchTimeoutMs: number;
  readonly maxRetries: number;
  readonly logger: Logger;
  readonly fetchImpl?: typeof fetch | undefined;
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
}

export class AgenClient {
  private readonly http: HttpClient;
  private readonly launchTimeoutMs: number;
  readonly hasApiKey: boolean;

  constructor(options: AgenClientOptions) {
    this.http = new HttpClient({
      baseUrl: options.baseUrl,
      source: "agen-api",
      timeoutMs: options.timeoutMs,
      maxRetries: options.maxRetries,
      logger: options.logger,
      apiKey: options.apiKey,
      fetchImpl: options.fetchImpl,
      sleep: options.sleep,
    });
    this.launchTimeoutMs = options.launchTimeoutMs;
    this.hasApiKey = options.apiKey !== undefined;
  }

  me(requestId: string): Promise<{ readonly agent: AgentIdentity }> {
    return this.http.request({
      path: "/api/v1/me",
      authenticated: true,
      retry: true,
      requestId,
    });
  }

  treasury(requestId: string): Promise<TreasuryView> {
    return this.http.request({
      path: "/api/v1/me/treasury",
      authenticated: true,
      retry: true,
      requestId,
    });
  }

  limits(requestId: string): Promise<AllowanceView> {
    return this.http.request({
      path: "/api/v1/me/limits",
      authenticated: true,
      retry: true,
      requestId,
    });
  }

  quote(body: Record<string, unknown>, requestId: string): Promise<InstantQuoteResponse> {
    return this.http.request({
      method: "POST",
      path: "/api/v1/instant/quote",
      body,
      authenticated: true,
      // A quote writes nothing, so repeating it is free.
      retry: true,
      requestId,
    });
  }

  prepare(body: Record<string, unknown>, requestId: string): Promise<InstantPrepareResponse> {
    return this.http.request({
      method: "POST",
      path: "/api/v1/instant/prepare",
      body,
      authenticated: true,
      // Not retried. It stores a metadata document and mines a salt; a repeat would leave a
      // second document behind and answer with a different token address than the first.
      retry: false,
      requestId,
    });
  }

  /**
   * The launch. One attempt, ever.
   *
   * See `http.ts`: a timeout here does not mean the transaction was not broadcast.
   */
  launchInstant(body: Record<string, unknown>, requestId: string): Promise<InstantLaunchResponse> {
    return this.http.request({
      method: "POST",
      path: "/api/v1/me/launches/instant",
      body,
      authenticated: true,
      retry: false,
      timeoutMs: this.launchTimeoutMs,
      requestId,
    });
  }

  launches(requestId: string): Promise<{ readonly launches: readonly AgentLaunch[] }> {
    return this.http.request({
      path: "/api/v1/me/launches",
      authenticated: true,
      retry: true,
      requestId,
    });
  }

  launch(id: string, requestId: string): Promise<{ readonly launch: AgentLaunch }> {
    return this.http.request({
      path: `/api/v1/me/launches/${encodeURIComponent(id)}`,
      authenticated: true,
      retry: true,
      requestId,
    });
  }
}
