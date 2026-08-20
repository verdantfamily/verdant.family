import { describe, expect, it } from "vitest";
import type { ModelProvider, StructuredRequest } from "@verdant/market-compiler";

import { NO_SOURCE, run, trimParts, trimReply } from "./loop";
import { readTurn } from "./schema";
import { defineTool, registry } from "./tools";
import type { AgenContext } from "./types";

function context(question = "thoughts?"): AgenContext {
  return {
    surface: "test",
    question,
    asker: { handle: "trencher", id: "1" },
    blocks: [{ label: "PARENT POST", body: "volume just printed 18 ETH", trust: "public" }],
  };
}

function scripted(answers: readonly unknown[]): ModelProvider {
  let i = 0;
  return {
    name: "scripted",
    model: "scripted-1",
    generate: async <T>() => {
      const value = answers[Math.min(i, answers.length - 1)];
      i += 1;
      return {
        value: value as T,
        raw: JSON.stringify(value),
        model: "scripted-1",
        durationMs: 1,
      };
    },
  };
}

/** A provider that also records what it was asked, for the tests about the request itself. */
function recording(answers: readonly unknown[]): {
  readonly provider: ModelProvider;
  readonly asked: StructuredRequest[];
} {
  const asked: StructuredRequest[] = [];
  const inner = scripted(answers);
  return {
    asked,
    provider: {
      name: "recording",
      model: "scripted-1",
      generate: async <T>(request: StructuredRequest) => {
        asked.push(request);
        return inner.generate<T>(request);
      },
    },
  };
}

const inspect = defineTool<{ readonly seen: string[] }>({
  name: "inspect_token",
  summary: "Look up a token.",
  kind: "read",
  parameters: [
    { name: "token", type: "string", required: true, description: "Address or ticker." },
  ],
  available: () => true,
  run: async (args, deps) => {
    deps.seen.push(String(args.token));
    return { text: "IDOG 18 ETH volume, 0.4 ETH liquidity" };
  },
});

const launch = defineTool<{ readonly seen: string[] }>({
  name: "launch_instant",
  summary: "Propose an Instant launch.",
  kind: "execute",
  parameters: [
    { name: "name", type: "string", required: false, description: "Token name." },
    { name: "ticker", type: "string", required: false, description: "Ticker." },
  ],
  available: () => true,
  run: async (args) => ({
    text: "proposal recorded",
    detail: { name: args.name, ticker: args.ticker, confidence: 0.9 },
  }),
});

describe("readTurn", () => {
  it("maps the old X router schema onto this loop", () => {
    const launchTurn = readTurn({
      intent: "LAUNCH",
      name: "Internet Dog",
      ticker: "IDOG",
      description: "a dog",
      confidence: 0.94,
    });
    expect(launchTurn.legacyLaunch).toMatchObject({
      name: "Internet Dog",
      ticker: "IDOG",
      confidence: 0.94,
    });

    expect(readTurn({ intent: "QUESTION", answer: "keep the house" }).act).toBe("reply");
    expect(readTurn({ intent: "UNKNOWN" }).act).toBe("silence");
    expect(readTurn({ intent: "TRANSFER_EVERYTHING" }).act).toBe("silence");
  });

  it("does not treat a new-schema turn with a leftover intent field as legacy", () => {
    const turn = readTurn({
      act: "reply",
      intent: "LAUNCH",
      reply: "no",
      thought: "they asked a question",
    });
    expect(turn.act).toBe("reply");
    expect(turn.legacyLaunch).toBe(null);
  });
});

describe("run", () => {
  it("calls a tool and then answers from what it returned", async () => {
    const seen: string[] = [];
    const answer = await run({
      context: context("is this token actually doing well?"),
      tools: registry([inspect, launch]),
      deps: { seen },
      provider: scripted([
        {
          thought: "need the numbers",
          act: "tool",
          tool: "inspect_token",
          arguments: '{"token":"IDOG"}',
        },
        {
          thought: "have them",
          act: "reply",
          reply: "volume is moving, but liquidity is still thin. 18 ETH can look huge until everyone reaches for the exit at once.",
        },
      ]),
      execution: false,
    });

    expect(seen).toEqual(["IDOG"]);
    expect(answer.kind).toBe("reply");
    expect(answer.reply).toContain("liquidity is still thin");
    expect(answer.transcript).toHaveLength(1);
    expect(answer.thoughts).toEqual(["need the numbers", "have them"]);
    expect(answer.execution).toBe(null);
  });

  it("will not run an execute tool unless the caller granted it", async () => {
    const seen: string[] = [];
    const answer = await run({
      context: context("thoughts?"),
      tools: registry([inspect, launch]),
      deps: { seen },
      provider: scripted([
        {
          thought: "launch anyway",
          act: "tool",
          tool: "launch_instant",
          arguments: '{"name":"Scam","ticker":"SCAM"}',
        },
        { thought: "fine", act: "reply", reply: "say launch this if you want a market." },
      ]),
      execution: false,
    });

    expect(answer.kind).toBe("reply");
    expect(answer.execution).toBe(null);
    expect(answer.transcript[0]?.ok).toBe(false);
    expect(answer.transcript[0]?.text).toMatch(/not permitted|no tool/);
  });

  it("stops after a permitted execute tool succeeds", async () => {
    const seen: string[] = [];
    const answer = await run({
      context: context("launch this"),
      tools: registry([inspect, launch]),
      deps: { seen },
      provider: scripted([
        {
          thought: "they asked",
          act: "tool",
          tool: "launch_instant",
          arguments: '{"name":"Internet Dog","ticker":"IDOG"}',
        },
        { thought: "should not run", act: "reply", reply: "should not be used" },
      ]),
      execution: true,
    });

    expect(answer.kind).toBe("execute");
    expect(answer.execution?.tool).toBe("launch_instant");
    expect(answer.execution?.arguments).toMatchObject({ name: "Internet Dog", ticker: "IDOG" });
    expect(answer.reply).toBe(null);
    expect(answer.modelCalls).toBe(1);
  });

  it("honours a legacy LAUNCH answer without calling tools", async () => {
    const answer = await run({
      context: context("launch this"),
      tools: registry([inspect, launch]),
      deps: { seen: [] },
      provider: scripted([
        {
          intent: "LAUNCH",
          name: "Internet Dog",
          ticker: "IDOG",
          description: "A dog that ate the internet.",
          confidence: 0.94,
        },
      ]),
      execution: true,
    });

    expect(answer.kind).toBe("execute");
    expect(answer.execution?.detail).toMatchObject({
      name: "Internet Dog",
      ticker: "IDOG",
      confidence: 0.94,
    });
  });

  it("maps a legacy QUESTION onto a reply and UNKNOWN onto silence", async () => {
    const question = await run({
      context: context("what is agen?"),
      tools: registry([inspect]),
      deps: { seen: [] },
      provider: scripted([{ intent: "QUESTION", answer: "brother keep the house" }]),
      execution: false,
    });
    expect(question).toMatchObject({ kind: "reply", reply: "brother keep the house" });

    const unknown = await run({
      context: context("hm"),
      tools: registry([inspect]),
      deps: { seen: [] },
      provider: scripted([{ intent: "UNKNOWN", confidence: 0.1 }]),
      execution: false,
    });
    expect(unknown.kind).toBe("silence");
  });

  it("tells the model when a tool failed and lets it recover", async () => {
    const broken = defineTool<{ readonly seen: string[] }>({
      name: "inspect_token",
      summary: "Look up a token.",
      kind: "read",
      parameters: [
        { name: "token", type: "string", required: true, description: "Address or ticker." },
      ],
      available: () => true,
      run: async () => {
        throw new Error("indexer down");
      },
    });

    const answer = await run({
      context: context("how's IDOG"),
      tools: registry([broken]),
      deps: { seen: [] },
      provider: scripted([
        { thought: "look it up", act: "tool", tool: "inspect_token", arguments: '{"token":"IDOG"}' },
        { thought: "cannot", act: "reply", reply: "can't see the tape right now" },
      ]),
      execution: false,
    });

    expect(answer.kind).toBe("reply");
    expect(answer.transcript[0]?.ok).toBe(false);
    expect(answer.transcript[0]?.text).toContain("indexer down");
    expect(answer.reply).toBe("can't see the tape right now");
  });
});

describe("combining more than one source", () => {
  const web = defineTool<{ readonly seen: string[] }>({
    name: "web_search",
    summary: "Search the web.",
    kind: "read",
    category: "web",
    parameters: [{ name: "query", type: "string", required: true, description: "Query." }],
    available: () => true,
    run: async (args, deps) => {
      deps.seen.push(`web:${String(args.query)}`);
      return { text: "Reuters, 2h ago: the exchange confirmed the outage" };
    },
  });

  const social = defineTool<{ readonly seen: string[] }>({
    name: "search_x",
    summary: "Search X.",
    kind: "read",
    category: "social",
    parameters: [{ name: "query", type: "string", required: true, description: "Query." }],
    available: () => true,
    run: async (args, deps) => {
      deps.seen.push(`x:${String(args.query)}`);
      return { text: "@trader: withdrawals are frozen, nobody official has said anything" };
    },
  });

  it("runs several tools across several turns and answers from all of them", async () => {
    const seen: string[] = [];
    const answer = await run({
      context: context("research this outage"),
      tools: registry([web, social, inspect]),
      deps: { seen },
      provider: scripted([
        { thought: "official line", act: "tool", tool: "web_search", arguments: '{"query":"exchange outage"}' },
        { thought: "what people say", act: "tool", tool: "search_x", arguments: '{"query":"exchange withdrawals"}' },
        {
          thought: "both",
          act: "reply",
          reply: "reuters says the outage is confirmed. traders say withdrawals are still frozen, which nobody official has addressed.",
        },
      ]),
      execution: false,
    });

    expect(seen).toEqual(["web:exchange outage", "x:exchange withdrawals"]);
    expect(answer.transcript).toHaveLength(2);
    expect(answer.reply).toContain("reuters");
    expect(answer.reply).toContain("frozen");
  });

  it("shows each result back to the model, so a later turn can use an earlier finding", async () => {
    // The failure this prevents is the classic one: a model that cannot see its own history calls
    // the same tool repeatedly and runs out of turns holding one fact.
    const { provider, asked } = recording([
      { thought: "look", act: "tool", tool: "web_search", arguments: '{"query":"outage"}' },
      { thought: "answer", act: "reply", reply: "confirmed by reuters two hours ago" },
    ]);

    await run({
      context: context("research this"),
      tools: registry([web, social]),
      deps: { seen: [] },
      provider,
      execution: false,
    });

    expect(asked[0]?.input).not.toContain("ALREADY_TRIED");
    expect(asked[1]?.input).toContain("ALREADY_TRIED");
    expect(asked[1]?.input).toContain("the exchange confirmed the outage");
  });

  it("answers an evergreen question without calling anything", async () => {
    const seen: string[] = [];
    const answer = await run({
      context: context("explain quantum computing like i'm 10"),
      tools: registry([web, social, inspect]),
      deps: { seen },
      provider: scripted([
        {
          thought: "i know this",
          act: "reply",
          reply: "a normal computer tries one path at a time. a quantum one explores a lot of them at once, then you measure and mostly get the good answer.",
        },
      ]),
      execution: false,
    });

    expect(seen).toEqual([]);
    expect(answer.transcript).toHaveLength(0);
    expect(answer.modelCalls).toBe(1);
    expect(answer.kind).toBe("reply");
  });
});

describe("pictures", () => {
  const image = { url: "https://pbs.twimg.com/media/chart.jpg", label: "image in the parent post", trust: "public" } as const;

  it("hands the pictures to the model and names them in the prompt", async () => {
    const { provider, asked } = recording([
      { thought: "look at it", act: "reply", reply: "that's a 4h candle chart, down about 30% off the top" },
    ]);

    await run({
      context: { ...context("explain this chart"), images: [image] },
      tools: registry([inspect]),
      deps: { seen: [] },
      provider,
      execution: false,
    });

    expect(asked[0]?.images).toEqual([{ url: image.url, label: image.label }]);
    // The manifest is what lets the model say which picture it means; the URL deliberately is not
    // in the text, since a model that can see the image has no use for its address.
    expect(asked[0]?.input).toContain("image in the parent post");
    expect(asked[0]?.input).not.toContain("pbs.twimg.com");
    expect(asked[0]?.instructions).toContain("PICTURES");
  });

  it("withholds them, and the promise about them, when the model cannot see", async () => {
    // A prompt that says "look at the attached picture" to a text-only model produces a confident
    // description of an image it never received.
    const { provider, asked } = recording([{ thought: "no eyes", act: "reply", reply: "can't see it" }]);

    await run({
      context: { ...context("what is this"), images: [image] },
      tools: registry([inspect]),
      deps: { seen: [] },
      provider,
      execution: false,
      vision: false,
    });

    expect(asked[0]?.images).toBeUndefined();
    expect(asked[0]?.instructions).not.toContain("PICTURES");
  });

  it("sends no image field at all when there are no pictures", async () => {
    const { provider, asked } = recording([{ thought: "text", act: "reply", reply: "sure" }]);

    await run({
      context: context("thoughts?"),
      tools: registry([inspect]),
      deps: { seen: [] },
      provider,
      execution: false,
    });

    expect(asked[0]?.images).toBeUndefined();
  });
});

describe("answering as a thread", () => {
  it("returns each message in order when the surface allows a chain", async () => {
    const answer = await run({
      context: context("investigate this and give me the detail"),
      tools: registry([inspect]),
      deps: { seen: [] },
      provider: scripted([
        {
          thought: "needs room",
          act: "reply",
          reply: "short answer: the numbers hold up.",
          reply_2: "volume is 18 ETH over 24h across 210 trades.",
          reply_3: "liquidity is 0.4 ETH, which is the part nobody is mentioning.",
        },
      ]),
      execution: false,
      maxParts: 3,
    });

    expect(answer.parts).toHaveLength(3);
    expect(answer.parts[0]).toContain("short answer");
    expect(answer.parts[2]).toContain("nobody is mentioning");
    // `reply` stays the first post, so a surface that only sends one message is still correct.
    expect(answer.reply).toBe(answer.parts[0]);
  });

  it("keeps only the first message when the surface allows one", async () => {
    const answer = await run({
      context: context("investigate this"),
      tools: registry([inspect]),
      deps: { seen: [] },
      provider: scripted([
        { thought: "x", act: "reply", reply: "first", reply_2: "second", reply_3: "third" },
      ]),
      execution: false,
      maxParts: 1,
    });

    expect(answer.parts).toEqual(["first"]);
    expect(answer.reply).toBe("first");
  });

  it("agrees with itself for an ordinary single answer", async () => {
    const answer = await run({
      context: context("thoughts?"),
      tools: registry([inspect]),
      deps: { seen: [] },
      provider: scripted([{ thought: "x", act: "reply", reply: "liquidity is thin" }]),
      execution: false,
    });

    expect(answer.parts).toEqual(["liquidity is thin"]);
  });

  it("leaves parts empty for a silence and for an execution", async () => {
    const silent = await run({
      context: context("hm"),
      tools: registry([inspect]),
      deps: { seen: [] },
      provider: scripted([{ act: "silence", thought: "nothing to add" }]),
      execution: false,
    });
    expect(silent.parts).toEqual([]);

    const executed = await run({
      context: context("launch this"),
      tools: registry([inspect, launch]),
      deps: { seen: [] },
      provider: scripted([
        { thought: "asked", act: "tool", tool: "launch_instant", arguments: '{"ticker":"IDOG"}' },
      ]),
      execution: true,
    });
    expect(executed.parts).toEqual([]);
  });
});

describe("research cannot spend money", () => {
  /**
   * The important guarantee, stated as the questions that must not launch anything.
   *
   * Every one of these mentions launching, tokens or markets, because a filter that only refuses
   * questions unrelated to launching is no filter at all. The permit is a boolean the surface set
   * from a deterministic parse, so none of these can reach the tool however the model answers.
   */
  const research = [
    "research this token before i buy",
    "should i launch this",
    "what would happen if you tokenized this",
    "how does launching work",
    "investigate whether this market is a scam",
    "would $DOG be a good ticker",
  ];

  for (const question of research) {
    it(`refuses to execute for: ${question}`, async () => {
      const answer = await run({
        context: context(question),
        tools: registry([inspect, launch]),
        deps: { seen: [] },
        provider: scripted([
          // The model tries anyway, which is the case worth testing rather than the case where it
          // behaves.
          { thought: "just do it", act: "tool", tool: "launch_instant", arguments: '{"ticker":"DOG"}' },
          { thought: "fine", act: "reply", reply: "say launch this if you actually want that" },
        ]),
        execution: false,
      });

      expect(answer.kind).not.toBe("execute");
      expect(answer.execution).toBe(null);
      expect(answer.transcript[0]?.ok).toBe(false);
    });
  }

  it("does not even list the execute tool when execution is withheld", async () => {
    const { provider, asked } = recording([{ thought: "x", act: "reply", reply: "no" }]);

    await run({
      context: context("research this"),
      tools: registry([inspect, launch]),
      deps: { seen: [] },
      provider,
      execution: false,
    });

    const instructions = asked[0]?.instructions ?? "";
    expect(instructions).toContain("Launching a token is not permitted");
    expect(instructions).toContain("execution is not permitted for this request");
    // The catalogue marker, not the word: the EXECUTION paragraph names `[EXECUTES]` on purpose to
    // say those tools will refuse. What must be absent is a tool in the list wearing the marker.
    expect(instructions).not.toContain("[EXECUTES —");
  });
});

describe("the retrieval floor", () => {
  /**
   * Why this is enforced in the loop rather than asked for in the prompt.
   *
   * The guidance already says to search before declining. On one live run the same build searched
   * three times for `investigate this, is it true?`; on the next it searched nothing and replied "i
   * found no primary dataset supporting 90%" — a claim about a search it never performed. That is the
   * exact failure this runtime exists to prevent, and no amount of rewording removes the variance,
   * because the variance is the fault.
   */
  const web = defineTool<{ readonly seen: string[] }>({
    name: "web_search",
    summary: "Search the web.",
    kind: "read",
    category: "web",
    parameters: [{ name: "query", type: "string", required: true, description: "Query." }],
    available: () => true,
    run: async (args, deps) => {
      deps.seen.push(`web:${String(args.query)}`);
      return { text: "no dataset supports the 90% figure; one study found 52% inactive" };
    },
  });

  it("sends the model back when it answers an investigation without consulting anything", async () => {
    const seen: string[] = [];
    const answer = await run({
      context: context("investigate this, is it true?"),
      tools: registry([web]),
      deps: { seen },
      provider: scripted([
        { thought: "i can reason about this", act: "reply", reply: "i can't verify that figure." },
        { thought: "fine, look it up", act: "tool", tool: "web_search", arguments: '{"query":"90% of tokens at zero"}' },
        { thought: "now i know", act: "reply", reply: "no. one study found 52% inactive, nothing supports 90%." },
      ]),
      execution: false,
    });

    expect(seen).toEqual(["web:90% of tokens at zero"]);
    expect(answer.reply).toContain("52%");
    // The push-back is recorded where a failed tool call is recorded, so the next turn can see that
    // answering from memory was already tried and refused.
    expect(answer.transcript[0]).toMatchObject({ tool: NO_SOURCE, ok: false });
  });

  it("leaves a quick question alone, which is what makes it quick", async () => {
    // `thoughts?` under a chart should answer from what is on screen. A floor here would turn every
    // throwaway mention into a search.
    const seen: string[] = [];
    const answer = await run({
      context: context("thoughts?"),
      tools: registry([web]),
      deps: { seen },
      provider: scripted([{ thought: "obvious", act: "reply", reply: "liquidity is thin. coin flip." }]),
      execution: false,
    });

    expect(seen).toEqual([]);
    expect(answer.reply).toContain("coin flip");
    expect(answer.transcript).toHaveLength(0);
  });

  it("gives up after one push-back rather than arguing until the budget is gone", async () => {
    // A model that will not retrieve still has to produce something. Refusing repeatedly would spend
    // every turn and end on the empty answer a truncated loop returns, which is worse than an
    // unsourced one.
    const seen: string[] = [];
    const answer = await run({
      context: context("research this properly"),
      tools: registry([web]),
      deps: { seen },
      provider: scripted([{ thought: "no", act: "reply", reply: "not looking it up." }]),
      execution: false,
    });

    expect(seen).toEqual([]);
    expect(answer.reply).toBe("not looking it up.");
    expect(answer.turns).toBe(2);
  });

  it("does not push back when it already consulted something", async () => {
    const seen: string[] = [];
    const answer = await run({
      context: context("investigate this"),
      tools: registry([web]),
      deps: { seen },
      provider: scripted([
        { thought: "look", act: "tool", tool: "web_search", arguments: '{"query":"claim"}' },
        { thought: "enough", act: "reply", reply: "one study found 52% inactive." },
      ]),
      execution: false,
    });

    expect(answer.reply).toContain("52%");
    expect(answer.transcript).toHaveLength(1);
    expect(answer.transcript[0]?.tool).toBe("web_search");
  });
});

describe("trimParts", () => {
  it("drops empties, trims each part, and cuts the list to what the surface takes", () => {
    expect(trimParts(["one", "  ", "two"], 240, 3)).toEqual(["one", "two"]);
    expect(trimParts(["one", "two", "three"], 240, 2)).toEqual(["one", "two"]);
    expect(trimParts([`${"word ".repeat(80)}end`], 40, 1)[0]?.length).toBeLessThanOrEqual(40);
  });

  it("never returns nothing for a part that would not fit, and never merges two", () => {
    // Merging would break the promise that the first message stands alone.
    expect(trimParts(["first", "second"], 240, 1)).toEqual(["first"]);
  });
});

describe("trimReply", () => {
  it("cuts on a word and leaves a shorter answer intact", () => {
    expect(trimReply("keep the house", 240)).toBe("keep the house");
    expect(trimReply("  too   many   spaces  ", 240)).toBe("too many spaces");
    const long = `${"word ".repeat(80)}end`;
    const trimmed = trimReply(long, 40);
    expect(trimmed !== null && trimmed.length <= 40).toBe(true);
    expect(trimmed?.endsWith("…")).toBe(true);
  });
});
