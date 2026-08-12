/**
 * Where the reasoning comes from, behind an interface thin enough to be worth having.
 *
 * One method, taking two strings and returning one. That is genuinely all a provider
 * does here, and the narrowness is the design: everything a provider could otherwise
 * be trusted with — which action exists, what a parameter means, whether to sign —
 * lives in code that does not vary by vendor. Swapping OpenAI for Anthropic must not
 * be able to change what the runtime can do, and with this signature it cannot.
 *
 * The response is raw text. It is not parsed here, not repaired here, and not trusted
 * here; `parseIntentJson` is the only thing that reads it. A provider that returned a
 * typed `AgentIntent` would be a provider that could construct one, and then the
 * validation boundary would sit inside the vendor adapter instead of in front of it.
 */

import type { Address } from "viem";

/** What a provider is asked. Two strings, and nothing that can sign anything. */
export interface IntentRequest {
  readonly system: string;
  readonly user: string;
  /** The model name from the agent's config. Meaning is the provider's business. */
  readonly model: string;
  /** Abort budget in milliseconds. A provider that hangs must not hang the scheduler. */
  readonly timeoutMs: number;
}

export interface ModelResponse {
  /** Exactly what came back, unmodified. */
  readonly raw: string;
  /** Whatever the provider knows about cost. For the record, not for control flow. */
  readonly usage?: {
    readonly inputTokens?: number;
    readonly outputTokens?: number;
  };
}

export interface AgentModelProvider {
  readonly name: string;
  generateIntent(request: IntentRequest): Promise<ModelResponse>;
}

/** A provider failing is normal. It is a run outcome, not a crash. */
export class ModelProviderError extends Error {
  readonly provider: string;

  constructor(provider: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ModelProviderError";
    this.provider = provider;
  }
}

// --- the deterministic provider -------------------------------------------

/** What the rules provider needs to decide. Supplied by the pipeline, from chain data. */
export interface RulesInput {
  readonly hasMarket: boolean;
  readonly canAffordLaunch: boolean;
  readonly unclaimedRevenueWei: bigint;
  /**
   * The committed market, echoed back so the response has the same shape a model's
   * would. Not a choice: these are read from the chain's `MarketExpectation` and the
   * launch plan, and `intentMatchesPlan` checks them like any other response's.
   */
  readonly committedToken: Address;
  readonly committedSymbol: string;
  /** The asset whose revenue would be claimed. Native ether in V0. */
  readonly revenueAsset: Address;
}

/**
 * A provider with no model behind it.
 *
 * This exists for three reasons and each one earns it.
 *
 * It makes the runtime **testable end to end without a network**: every pipeline test
 * in this package drives a real decision through a real provider, so the tests exercise
 * the path production uses rather than a mock of it.
 *
 * It makes the runtime **runnable without an API key**, which means the demo works on a
 * laptop with a local anvil and nothing else. A first-run experience that requires a
 * paid account is one most people never have.
 *
 * And it is the **control**: if an LLM-driven agent behaves worse than this — twenty
 * lines of if-statements — that is worth knowing before anybody concludes the model is
 * adding judgement.
 *
 * Its policy is stated plainly: claim revenue when there is revenue to claim, launch
 * the committed market once if it can be afforded, otherwise do nothing. Confidence is
 * fixed per branch rather than invented, because a made-up number that varies would
 * imply a calibration this has none of.
 */
export function rulesProvider(input: RulesInput): AgentModelProvider {
  return {
    name: "rules",
    generateIntent: async () => {
      if (input.unclaimedRevenueWei > 0n) {
        return {
          raw: JSON.stringify({
            action: "CLAIM_REVENUE",
            asset: input.revenueAsset,
            confidence: 1,
            reasoningSummary:
              "The market has unclaimed fees and the split that pays them out is fixed, " +
              "so moving them is safe and needs no judgement.",
          }),
        };
      }

      if (!input.hasMarket && input.canAffordLaunch) {
        return {
          raw: JSON.stringify({
            action: "LAUNCH_MARKET",
            token: input.committedToken,
            symbol: input.committedSymbol,
            confidence: 0.9,
            reasoningSummary:
              "The committed market has not been launched and the first buy is funded. " +
              "The parameters were fixed at agent creation, so the only question was timing.",
          }),
        };
      }

      return {
        raw: JSON.stringify({
          action: "NO_ACTION",
          confidence: 1,
          reasoningSummary: input.hasMarket
            ? "The market is launched and there are no unclaimed fees. Nothing to do."
            : "The committed market is not yet affordable from the runtime wallet.",
        }),
      };
    },
  };
}

// --- an OpenAI-compatible provider ----------------------------------------

export interface OpenAiOptions {
  readonly apiKey: string;
  /** Any OpenAI-compatible endpoint. Defaults to OpenAI's. */
  readonly baseUrl?: string;
  /** Injected so tests can drive the provider without a network. */
  readonly fetch?: typeof globalThis.fetch;
}

/**
 * The JSON schema the provider asks the model to fill.
 *
 * A convenience, not a control. `parseIntent` re-checks all of it and will refuse a
 * response that satisfies this schema but not the runtime's rules — the schema cannot
 * express "the symbol must equal the one committed on chain", and a provider-side
 * schema is in any case something the vendor enforces rather than something we do.
 */
const RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["action", "confidence", "reasoningSummary"],
  properties: {
    action: { type: "string", enum: ["LAUNCH_MARKET", "CLAIM_REVENUE", "NO_ACTION"] },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    reasoningSummary: { type: "string", maxLength: 600 },
    token: { type: "string" },
    symbol: { type: "string" },
    asset: { type: "string" },
  },
} as const;

/**
 * Chat completions over `fetch`, with no vendor SDK.
 *
 * One dependency avoided, and a more useful property gained: any OpenAI-compatible
 * endpoint works, including a local one, so an operator who will not send market data
 * to a third party has a supported path rather than a fork.
 *
 * `temperature: 0`, because two identical evaluations of an identical chain state
 * disagreeing is not creativity here, it is an unreproducible audit trail.
 */
export function openAiProvider(options: OpenAiOptions): AgentModelProvider {
  const doFetch = options.fetch ?? globalThis.fetch;
  const baseUrl = options.baseUrl ?? "https://api.openai.com/v1";

  return {
    name: "openai",
    generateIntent: async (request) => {
      // The provider's own clock, because a hung request holds a scheduler slot and the
      // lock that goes with it. Every provider must be cancellable for the scheduler's
      // concurrency guarantees to mean anything.
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), request.timeoutMs);

      try {
        const response = await doFetch(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${options.apiKey}`,
          },
          signal: abort.signal,
          body: JSON.stringify({
            model: request.model,
            temperature: 0,
            messages: [
              { role: "system", content: request.system },
              { role: "user", content: request.user },
            ],
            response_format: {
              type: "json_schema",
              json_schema: { name: "agent_intent", strict: false, schema: RESPONSE_SCHEMA },
            },
          }),
        });

        if (!response.ok) {
          // The body is read but not included: a provider error page can be long, can
          // echo the request, and is written by a third party. The status is what an
          // operator acts on.
          throw new ModelProviderError(
            "openai",
            `the model provider answered ${response.status} ${response.statusText}`,
          );
        }

        const body = (await response.json()) as {
          choices?: { message?: { content?: string } }[];
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        };

        const content = body.choices?.[0]?.message?.content;
        if (typeof content !== "string" || content.length === 0) {
          throw new ModelProviderError("openai", "the model returned no content");
        }

        // Assembled key by key because `exactOptionalPropertyTypes` distinguishes "the
        // provider did not report tokens" from "the provider reported undefined
        // tokens", and only the first of those is a thing that happens.
        const usage: { inputTokens?: number; outputTokens?: number } = {};
        if (typeof body.usage?.prompt_tokens === "number") {
          usage.inputTokens = body.usage.prompt_tokens;
        }
        if (typeof body.usage?.completion_tokens === "number") {
          usage.outputTokens = body.usage.completion_tokens;
        }

        return { raw: content, usage };
      } catch (error) {
        if (error instanceof ModelProviderError) throw error;
        if (error instanceof Error && error.name === "AbortError") {
          throw new ModelProviderError(
            "openai",
            `the model provider did not answer within ${request.timeoutMs}ms`,
          );
        }
        throw new ModelProviderError("openai", "the model provider could not be reached", {
          cause: error,
        });
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
