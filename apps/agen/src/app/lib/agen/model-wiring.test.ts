/**
 * Does the model package this app actually loads have the features this app depends on?
 *
 * ## Why this test is here and not in `market-compiler`
 *
 * That package's own tests import `./model.js` — a relative path, transformed from TypeScript
 * source. This app imports `@verdant/market-compiler`, a bare specifier that resolves through the
 * package's `exports` map to `dist/index.js`. Those are two different implementations of the same
 * module, and for one afternoon they disagreed: image support was written, reviewed and covered by
 * passing unit tests in `src`, while every request the running app made went through a `dist` built
 * before the feature existed.
 *
 * Nothing failed. `images` was an unrecognised property on a request object, so the older code
 * ignored it in silence, and @useagen told real people "the image isn't rendering for me, repost
 * it" — a confident, plausible, completely wrong explanation. A green suite proved only that the
 * source was correct.
 *
 * So these tests deliberately exercise the *resolution path production uses*, and they assert
 * behaviour rather than inspecting the file: a test that reads `dist/model.js` looking for a string
 * would pass on a build that emitted the code and then failed to wire it up.
 */

import { describe, expect, it, vi } from "vitest";
// The bare specifier, on purpose. Rewriting this to a relative path defeats the entire test.
import { anthropicProvider, object, openAiProvider, text } from "@verdant/market-compiler";
import type { StructuredRequest } from "@verdant/market-compiler";

const REQUEST: StructuredRequest = {
  stage: "wiring",
  instructions: "You answer in the given shape.",
  input: "what is in the picture?",
  schemaName: "wiring_probe",
  schema: object({ answer: text("one line") }),
  timeoutMs: 5_000,
};

function responds(body: unknown) {
  // Typed as the platform's own `fetch` so it is assignable to the provider's injection point
  // without a cast, which is the only reason the parameters are named at all.
  return vi.fn<typeof globalThis.fetch>(async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
}

function bodyOf(fetch: ReturnType<typeof responds>): Record<string, unknown> {
  return JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
}

describe("the model package the app resolves at runtime", () => {
  it("sends attached pictures to the model", async () => {
    const fetch = responds({ output_text: JSON.stringify({ answer: "a chart" }) });

    await openAiProvider({ apiKey: "sk-test", model: "gpt-5", fetch }).generate({
      ...REQUEST,
      images: [{ url: "https://pbs.twimg.com/media/one.jpg", label: "the picture" }],
    });

    const input = bodyOf(fetch)["input"];
    expect(Array.isArray(input), "images must force the structured input form").toBe(true);

    const parts = (input as { content: { type: string; image_url?: string }[] }[])[0]!.content;
    expect(parts.map((part) => part.type)).toContain("input_image");
    expect(parts.find((part) => part.type === "input_image")?.image_url).toBe(
      "https://pbs.twimg.com/media/one.jpg",
    );
    // The question has to survive the change of shape, or the model gets a picture and no prompt.
    expect(parts.find((part) => part.type === "input_text")).toMatchObject({ text: REQUEST.input });
  });

  it("leaves an ordinary text request exactly as it was", async () => {
    // The other half of the guarantee: every stage of the market pipeline sends no images, and this
    // feature must not have changed the request they make.
    const fetch = responds({ output_text: JSON.stringify({ answer: "fine" }) });
    await openAiProvider({ apiKey: "sk-test", model: "gpt-5", fetch }).generate(REQUEST);

    expect(typeof bodyOf(fetch)["input"]).toBe("string");
  });

  it("sends pictures on the second vendor too, since either may be the one answering", async () => {
    const fetch = responds({
      content: [{ type: "tool_use", name: "wiring_probe", input: { answer: "a chart" } }],
    });

    await anthropicProvider({ apiKey: "sk-ant-test", model: "claude-sonnet-4", fetch }).generate({
      ...REQUEST,
      images: [{ url: "https://pbs.twimg.com/media/one.jpg" }],
    });

    const content = (bodyOf(fetch)["messages"] as { content: { type: string }[] }[])[0]!.content;
    expect(content.map((part) => part.type)).toContain("image");
  });

  it("picks one of several completed messages instead of concatenating them", async () => {
    // The second P0. A reasoning model that writes twice produced `{…}{…}`, which is not JSON, and
    // the agent runtime reported "the model did not answer" while holding a good answer. Guarded
    // here as well as in the package, because this is the copy the bot runs.
    const fetch = responds({
      output: [
        { type: "reasoning" },
        { type: "message", content: [{ text: JSON.stringify({ answer: "draft" }) }] },
        { type: "reasoning" },
        { type: "message", content: [{ text: JSON.stringify({ answer: "final" }) }] },
      ],
    });

    const result = await openAiProvider({ apiKey: "sk-test", model: "gpt-5", fetch }).generate<{
      answer: string;
    }>(REQUEST);

    expect(result.value.answer).toBe("final");
  });
});
