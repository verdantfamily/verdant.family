import { describe, expect, it, vi } from "vitest";

import type { StructuredRequest } from "./model.js";
import {
  array,
  bounded,
  fallbackProvider,
  ModelError,
  object,
  openAiProvider,
  optional,
  scriptedProvider,
  text,
} from "./model.js";

const REQUEST: StructuredRequest = {
  stage: "interpret",
  instructions: "You formalise market mechanics.",
  input: "charge 2% on large sells",
  schemaName: "market_specification",
  schema: object({ summary: text("one line") }),
  timeoutMs: 5_000,
};

function respond(
  body: unknown,
  init?: { status?: number; statusText?: string; headers?: Record<string, string> },
) {
  return vi.fn(async () =>
    new Response(JSON.stringify(body), {
      status: init?.status ?? 200,
      statusText: init?.statusText ?? "OK",
      headers: { "content-type": "application/json", ...init?.headers },
    }),
  );
}

describe("the strict-mode schema dialect", () => {
  it("requires every property, because strict mode does", () => {
    const schema = object({ a: text("a"), b: text("b") });
    expect(schema.required).toEqual(["a", "b"]);
    expect(schema.additionalProperties).toBe(false);
  });

  it("spells optional as nullable", () => {
    expect(optional(text("maybe")).type).toEqual(["string", "null"]);
    expect(optional(array(text("x"))).type).toEqual(["array", "null"]);
  });

  it("puts numeric bounds in the description, where the model can read them", () => {
    // Strict mode drops `minimum`/`maximum` outright, so a schema that carried them
    // would be silently lying about what was enforced.
    const schema = bounded("the extra fee", 0, 30_000);
    expect(schema).not.toHaveProperty("minimum");
    expect(schema.description).toContain("between 0 and 30000");
  });
});

describe("the Responses provider", () => {
  it("asks for a strict json_schema and returns the parsed value", async () => {
    const fetch = respond({
      output_text: JSON.stringify({ summary: "Large sells pay more" }),
      usage: { input_tokens: 120, output_tokens: 30 },
    });

    const provider = openAiProvider({ apiKey: "sk-test", model: "gpt-5", fetch });
    const result = await provider.generate<{ summary: string }>(REQUEST);

    expect(result.value.summary).toBe("Large sells pay more");
    expect(result.usage).toEqual({ inputTokens: 120, outputTokens: 30 });

    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("https://api.openai.com/v1/responses");

    const body = JSON.parse((init as RequestInit).body as string) as Record<string, any>;
    expect(body["text"].format).toMatchObject({
      type: "json_schema",
      name: "market_specification",
      strict: true,
    });
    // Instructions and input stay separate: one is ours, the other is the creator's.
    expect(body["instructions"]).toBe(REQUEST.instructions);
    expect(body["input"]).toBe(REQUEST.input);
  });

  it("reads content from the output array when there is no aggregate field", async () => {
    // What a reasoning model returns: a reasoning item first, then the message.
    const fetch = respond({
      output: [
        { type: "reasoning", content: [] },
        { type: "message", content: [{ type: "output_text", text: '{"summary":"from output"}' }] },
      ],
    });

    const provider = openAiProvider({ apiKey: "sk-test", model: "gpt-5", fetch });
    const result = await provider.generate<{ summary: string }>(REQUEST);

    expect(result.value.summary).toBe("from output");
  });

  it("marks rate limits and gateway failures retryable, and rejections not", async () => {
    const rateLimited = openAiProvider({
      apiKey: "sk-test",
      model: "gpt-5",
      fetch: respond({}, { status: 429, statusText: "Too Many Requests" }),
    });
    await expect(rateLimited.generate(REQUEST)).rejects.toMatchObject({ retryable: true });

    const refused = openAiProvider({
      apiKey: "sk-test",
      model: "gpt-5",
      fetch: respond({}, { status: 400, statusText: "Bad Request" }),
    });
    await expect(refused.generate(REQUEST)).rejects.toMatchObject({ retryable: false });
  });

  it("resolves a role to a model, so a stage never names one", async () => {
    const fetch = respond({ output_text: '{"summary":"ok"}' });
    const provider = openAiProvider({
      apiKey: "sk-test",
      model: "gpt-5.1",
      fastModel: "gpt-5-mini",
      fetch,
    });

    await provider.generate({ ...REQUEST, role: "fast" });
    await provider.generate({ ...REQUEST, role: "strong" });
    // An explicit model still wins, for pinning one stage while comparing.
    await provider.generate({ ...REQUEST, role: "fast", model: "gpt-4.1" });

    const sent = fetch.mock.calls.map(
      ([, init]) => (JSON.parse(String((init as RequestInit).body)) as { model: string }).model,
    );
    expect(sent).toEqual(["gpt-5-mini", "gpt-5.1", "gpt-4.1"]);
  });

  it("runs every role on the one model when no fast model was configured", async () => {
    // A provider that has not been told about a cheaper model should not invent one.
    const fetch = respond({ output_text: '{"summary":"ok"}' });
    const provider = openAiProvider({ apiKey: "sk-test", model: "gpt-5.1", fetch });

    await provider.generate({ ...REQUEST, role: "fast" });

    const [, init] = fetch.mock.calls[0]!;
    expect((JSON.parse(String((init as RequestInit).body)) as { model: string }).model).toBe("gpt-5.1");
  });

  it("tells an empty balance apart from a rate limit, though both arrive as 429", async () => {
    // A cold build spent ninety-three seconds backing off and retrying before reporting
    // that the model was unreachable. The account was simply out of credits, which no
    // amount of waiting was going to change.
    const provider = openAiProvider({
      apiKey: "sk-test",
      model: "gpt-5",
      fetch: respond(
        { error: { type: "insufficient_quota", code: "credit_balance_exhausted" } },
        { status: 429, statusText: "Too Many Requests" },
      ),
    });

    const error = await provider.generate(REQUEST).catch((thrown: unknown) => thrown);

    expect(error).toMatchObject({ retryable: false });
    expect((error as Error).message).toContain("no credits left");
  });

  it("honours the wait a provider asks for when it is rate limiting", async () => {
    const provider = openAiProvider({
      apiKey: "sk-test",
      model: "gpt-5",
      fetch: respond(
        { error: { type: "rate_limit_exceeded" } },
        { status: 429, statusText: "Too Many Requests", headers: { "retry-after": "30" } },
      ),
    });

    await expect(provider.generate(REQUEST)).rejects.toMatchObject({
      retryable: true,
      retryAfterMs: 30_000,
    });
  });

  it("never puts the provider's response body in the error", async () => {
    // A provider error page can echo the request, which here means echoing a
    // creator's prompt into a log line.
    const fetch = respond(
      { error: { message: "your prompt was: charge 2% on large sells" } },
      { status: 400, statusText: "Bad Request" },
    );

    const provider = openAiProvider({ apiKey: "sk-test", model: "gpt-5", fetch });
    const error = await provider.generate(REQUEST).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ModelError);
    expect((error as ModelError).message).not.toContain("charge 2%");
    expect((error as ModelError).message).toContain("400");
  });

  it("never puts the api key anywhere but the authorization header", async () => {
    const fetch = respond({ output_text: '{"summary":"ok"}' });
    const provider = openAiProvider({ apiKey: "sk-secret-value", model: "gpt-5", fetch });

    await provider.generate(REQUEST);

    const [url, init] = fetch.mock.calls[0]!;
    const request = init as RequestInit;
    expect(String(url)).not.toContain("sk-secret-value");
    expect(request.body as string).not.toContain("sk-secret-value");
    expect((request.headers as Record<string, string>)["authorization"]).toBe(
      "Bearer sk-secret-value",
    );
  });

  it("says a truncated answer was truncated rather than malformed", async () => {
    const fetch = respond({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" } });
    const provider = openAiProvider({ apiKey: "sk-test", model: "gpt-5", fetch });

    await expect(provider.generate(REQUEST)).rejects.toThrow(/stopped early: max_output_tokens/);
  });

  it("times out rather than holding a build stage open", async () => {
    const provider = openAiProvider({
      apiKey: "sk-test",
      model: "gpt-5",
      fetch: vi.fn(
        (_url: unknown, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
            });
          }),
      ) as unknown as typeof globalThis.fetch,
    });

    const failure = provider.generate({ ...REQUEST, timeoutMs: 20 });
    await expect(failure).rejects.toThrow(/did not answer within 20ms/);
    await expect(failure).rejects.toMatchObject({ retryable: true });
  });
});

describe("one provider standing behind another", () => {
  it("uses the second when the first cannot answer at all", async () => {
    const exhausted = scriptedProvider([
      new ModelError("openai", "interpret", "the OpenAI account has no credits left", {
        retryable: false,
      }),
    ]);
    const spare = scriptedProvider([{ summary: "answered by the spare" }], { model: "spare-1" });

    const failovers: string[] = [];
    const provider = fallbackProvider(exhausted, spare, {
      onFailover: (error) => failovers.push(error.message),
    });

    const result = await provider.generate<{ summary: string }>(REQUEST);

    expect(result.value.summary).toBe("answered by the spare");
    expect(failovers).toHaveLength(1);
  });

  it("does not ask the second a question the first already answered badly", async () => {
    // A rejected artefact is a property of the request, not of the vendor. Asking
    // somebody else the same badly-posed question spends a second call to arrive in the
    // same place; the pipeline's own repair loops are what handle this.
    const refused = scriptedProvider([
      new ModelError("openai", "interpret", "the model provider answered 400 Bad Request", {
        retryable: false,
      }),
    ]);
    const spare = scriptedProvider([{ summary: "never asked" }]);

    const provider = fallbackProvider(refused, spare);

    await expect(provider.generate(REQUEST)).rejects.toThrow(/400 Bad Request/);
    expect(spare.calls).toHaveLength(0);
  });

  it("reports the first provider's failure when the second cannot help either", async () => {
    // The primary is the one an operator has to go and fix.
    const down = scriptedProvider([
      new ModelError("openai", "interpret", "the model provider could not be reached", {
        retryable: true,
      }),
    ]);
    const alsoDown = scriptedProvider([
      new ModelError("spare", "interpret", "the spare is down too", { retryable: true }),
    ]);

    await expect(fallbackProvider(down, alsoDown).generate(REQUEST)).rejects.toThrow(
      /could not be reached/,
    );
  });
});

describe("the scripted provider", () => {
  it("answers in order and records what it was asked", async () => {
    const provider = scriptedProvider([{ step: "one" }, { step: "two" }]);

    expect((await provider.generate<{ step: string }>(REQUEST)).value.step).toBe("one");
    expect((await provider.generate<{ step: string }>({ ...REQUEST, stage: "plan" })).value.step).toBe(
      "two",
    );

    expect(provider.calls.map((call) => call.stage)).toEqual(["interpret", "plan"]);
  });

  it("throws scripted failures, so the loop's error paths are testable", async () => {
    const provider = scriptedProvider([new ModelError("scripted", "plan", "provider is down")]);
    await expect(provider.generate(REQUEST)).rejects.toThrow(/provider is down/);
  });

  it("complains loudly when the loop asks for more turns than the test scripted", async () => {
    const provider = scriptedProvider([{ only: "one" }]);
    await provider.generate(REQUEST);

    await expect(provider.generate({ ...REQUEST, stage: "repair" })).rejects.toThrow(
      /script ran out after 1 calls; stage "repair"/,
    );
  });
});
