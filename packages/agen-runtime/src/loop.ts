/**
 * UNDERSTAND → PLAN → USE TOOLS → RESPOND OR EXECUTE
 *
 * One function, one loop. The model is asked what to do; if it names a tool the tool runs and
 * the model is asked again, with what it already learned. It stops when it answers, refuses,
 * goes silent, or an execute tool succeeds.
 *
 * ## What this file will not do
 *
 * It will not send a transaction. An execute tool that succeeds is reported to the caller as
 * `kind: "execute"` with the validated arguments. The surface that granted `execution: true`
 * is the one that may spend, and it spends through whatever deterministic path it already
 * has — on X, `lib/x/launch.ts`.
 *
 * It will not let the model reach an execute tool unless the caller said so. Conversational
 * messages cannot accidentally become transactions because the permit is a boolean the
 * *surface* set, usually from a deterministic parse, not a judgement the model made.
 *
 * It will not show `thoughts` to anyone. They stay on the answer object for logs.
 */

import type { ModelProvider, StructuredRequest } from "@verdant/market-compiler";

import { depthFor, planFor } from "./depth";
import { inputFor, instructionsFor } from "./prompt";
import { readTurn, TURN_SCHEMA } from "./schema";
import {
  readArguments,
  runTool,
  type ToolRegistry,
} from "./tools";
import type {
  AgenContext,
  RuntimeAnswer,
  RuntimeExecution,
  Tool,
  TranscriptEntry,
} from "./types";

/**
 * The transcript entry recorded when the model was sent back for answering without looking.
 *
 * Exported so a surface can tell it apart from a real tool call. It sits in the transcript because
 * that is the channel the model reads, but it is not something that ran, and reporting it in a list
 * of tools used would misdescribe both what happened and what the answer rests on.
 */
export const NO_SOURCE = "(no source consulted)";

export const DEFAULT_MAX_TURNS = 6;
export const DEFAULT_MAX_REPLY_CHARS = 240;
export const DEFAULT_TIMEOUT_MS = 45_000;
export const DEFAULT_TOOL_TIMEOUT_MS = 12_000;

export interface RunRequest<Deps> {
  readonly context: AgenContext;
  readonly tools: ToolRegistry<Deps>;
  readonly deps: Deps;
  readonly provider: ModelProvider;
  /** Whether execute tools may run. The surface decides; the model cannot grant this. */
  readonly execution: boolean;
  /**
   * The turn ceiling. Also the upper bound on what depth may ask for.
   *
   * A surface passes what it can actually afford — a poll that has to finish inside a request
   * cannot sit through twelve model calls — and `investigate` chooses within it.
   */
  readonly maxTurns?: number;
  readonly maxReplyChars?: number;
  /** How many messages the surface can send as a chain. One unless it says otherwise. */
  readonly maxParts?: number;
  /**
   * Whether to forward `context.images` to the model.
   *
   * Defaults to true, because a surface that attached images meant them to be looked at. Set false
   * where the configured model has no vision: the captions in the blocks still arrive, and the
   * prompt then makes no promise about pictures the model cannot see.
   */
  readonly vision?: boolean;
  readonly timeoutMs?: number;
  readonly toolTimeoutMs?: number;
}

/**
 * Cut a reply on a word so it fits the surface.
 *
 * A reply the API then refuses is a question the person never heard answered. Surfaces pass
 * their own ceiling — 240 on X, more elsewhere — and this is the last check, because the
 * prompt's request is a request.
 */
export function trimReply(value: string | null, maxChars: number): string | null {
  if (value === null) return null;
  const collapsed = value.replace(/\s+/g, " ").trim();
  if (collapsed === "") return null;
  if (collapsed.length <= maxChars) return collapsed;

  const cut = collapsed.slice(0, maxChars - 1);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > Math.floor(maxChars * 0.75) ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/**
 * Trim a thread to what the surface will take.
 *
 * Each part is trimmed on a word to the character limit, empties are dropped, and the whole thing
 * is cut to `maxParts`. Order is preserved and nothing is merged: a part that would not fit is
 * discarded rather than glued onto its neighbour, because the prompt requires the first message to
 * stand alone, so losing a later one costs detail and never the answer.
 */
export function trimParts(
  values: readonly string[],
  maxChars: number,
  maxParts: number,
): readonly string[] {
  const out: string[] = [];
  for (const value of values) {
    if (out.length >= Math.max(1, maxParts)) break;
    const trimmed = trimReply(value, maxChars);
    if (trimmed !== null) out.push(trimmed);
  }
  return out;
}

function emptyAnswer(partial: {
  readonly kind: RuntimeAnswer["kind"];
  readonly reply?: string | null;
  readonly parts?: readonly string[];
  readonly reason?: string | null;
  readonly execution?: RuntimeExecution | null;
  readonly transcript: readonly TranscriptEntry[];
  readonly thoughts: readonly string[];
  readonly turns: number;
  readonly modelCalls: number;
}): RuntimeAnswer {
  const reply = partial.reply ?? null;
  // `parts` always agrees with `reply`, so a surface can read either and be correct. Deriving the
  // default here rather than at every call site is what keeps that true.
  const parts = partial.parts ?? (reply === null ? [] : [reply]);

  return {
    kind: partial.kind,
    reply,
    parts,
    reason: partial.reason ?? null,
    execution: partial.execution ?? null,
    transcript: partial.transcript,
    thoughts: partial.thoughts,
    turns: partial.turns,
    modelCalls: partial.modelCalls,
  };
}

/**
 * Run the loop to a decision.
 *
 * Throws only when the model itself is unreachable. Every other failure — a bad tool call, a
 * tool that timed out, a turn that named nothing — is a step the model is shown, or a silence
 * if there are no turns left. A person asking a question should not get an exception because
 * a search failed.
 */
export async function run<Deps>(request: RunRequest<Deps>): Promise<RuntimeAnswer> {
  const maxReplyChars = request.maxReplyChars ?? DEFAULT_MAX_REPLY_CHARS;
  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const toolTimeoutMs = request.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;

  // How hard to work, read off the person's own words and then held to whatever the surface said it
  // could afford. `thoughts?` gets four turns; `investigate this` gets twelve, if the caller allows.
  const plan = planFor(depthFor(request.context.question), {
    ...(request.maxTurns === undefined ? {} : { maxTurns: request.maxTurns }),
    ...(request.maxParts === undefined ? {} : { maxParts: request.maxParts }),
  });
  const maxTurns = plan.maxTurns;
  const maxParts = plan.maxParts;

  const images = (request.vision ?? true) ? (request.context.images ?? []) : [];

  const usable = request.tools.usable(request.deps);
  const ready = request.execution
    ? usable.ready
    : usable.ready.filter((tool) => tool.kind === "read");
  const hidden = request.execution
    ? usable.unavailable
    : [
        ...usable.unavailable,
        ...usable.ready
          .filter((tool) => tool.kind === "execute")
          .map((tool) => ({
            name: tool.name,
            reason: "execution is not permitted for this request",
          })),
      ];

  const instructions = instructionsFor({
    tools: ready,
    unavailable: hidden,
    maxTurns,
    maxReplyChars,
    execution: request.execution,
    depth: plan.guidance,
    maxParts,
    images: images.length,
  });

  const transcript: TranscriptEntry[] = [];
  const thoughts: string[] = [];
  let modelCalls = 0;

  /*
   * Has the model been sent back once for answering without looking?
   *
   * The guidance asks it to retrieve before declining, and the guidance is not reliably obeyed. Asked
   * `investigate this, is it true?` about a statistic, the same build searched three times on one run
   * and not at all on the next, where it replied "i found no primary dataset supporting 90%" having
   * called no tool — a claim about a search it never ran, which is the one failure mode this runtime
   * exists to prevent. Wording alone cannot fix that, because the variance *is* the problem.
   *
   * So the floor is enforced rather than requested, and only where the person's own words asked for
   * work: `research` and `investigate` depth. `thoughts?` under a chart still answers from what is on
   * screen, which is what makes it quick.
   *
   * Bounded to a single push-back. Refusing repeatedly would spend the whole budget arguing and end
   * on the empty answer that a truncated loop produces, which is worse than an unsourced one; after
   * one nudge, a model that still wants to answer from memory is allowed to.
   */
  let pushedBack = false;
  const wantsRetrieval = plan.depth !== "quick" && ready.some((tool) => tool.kind === "read");


  for (let turn = 1; turn <= maxTurns; turn += 1) {
    const last = turn >= maxTurns;
    const response = await ask(request.provider, {
      stage: `agen.turn.${String(turn)}`,
      instructions,
      input: inputFor({
        context: request.context,
        transcript,
        turn,
        maxTurns,
      }),
      schemaName: "agen_turn",
      schema: TURN_SCHEMA,
      timeoutMs,
      role: "strong",
      effort: "low",
      ...(images.length === 0
        ? {}
        : {
            images: images.map((image) => ({ url: image.url, label: image.label })),
          }),
    });
    modelCalls += 1;

    const decided = readTurn(response.value);
    if (decided.thought !== "") thoughts.push(decided.thought);

    if (decided.legacyLaunch !== null) {
      if (!request.execution) {
        return emptyAnswer({
          kind: "reply",
          reply: trimReply(
            "say launch this if you want a market. i'm not going to do that from a maybe.",
            maxReplyChars,
          ),
          transcript,
          thoughts,
          turns: turn,
          modelCalls,
        });
      }
      return emptyAnswer({
        kind: "execute",
        execution: {
          tool: "launch_instant",
          arguments: {
            name: decided.legacyLaunch.name,
            ticker: decided.legacyLaunch.ticker,
            description: decided.legacyLaunch.description,
          },
          detail: { ...decided.legacyLaunch },
        },
        transcript,
        thoughts,
        turns: turn,
        modelCalls,
      });
    }

    if (decided.act === "silence") {
      return emptyAnswer({ kind: "silence", transcript, thoughts, turns: turn, modelCalls });
    }

    if (decided.act === "refuse") {
      return emptyAnswer({
        kind: "refusal",
        reply: trimReply(decided.reason, maxReplyChars),
        reason: decided.reason,
        transcript,
        thoughts,
        turns: turn,
        modelCalls,
      });
    }

    // Answering a question that asked for work, having consulted nothing. Sent back once, with the
    // refusal recorded in the transcript so the next turn can see it was already tried — the same
    // channel a failed tool call uses, because to the model this is the same kind of fact.
    if (decided.act === "reply" && !last && wantsRetrieval && transcript.length === 0 && !pushedBack) {
      pushedBack = true;
      transcript.push({
        tool: NO_SOURCE,
        arguments: "",
        ok: false,
        // Nothing ran, so nothing took any time. Recorded as zero rather than omitted, because the
        // entry has to be the same shape as a real one for the transcript to read as one list.
        durationMs: 0,
        text:
          "You tried to answer this without retrieving anything, and the question asked you to look. " +
          "Discard that draft and call a tool first. If the claim is vague, search the nearest thing " +
          "that can actually be measured; if you cannot find it, say so afterwards — but you may not " +
          "say you looked and found nothing until you have looked.",
      });
      continue;
    }

    if (decided.act === "reply" || last) {
      // On the last turn the model may still have set act to 'tool'; there is no turn left to run
      // it in, so whatever it wrote is taken as the answer. `parts` is empty in that case, hence
      // the fall back to the single fields.
      const written = decided.parts.length > 0 ? decided.parts : [decided.reply ?? decided.reason ?? ""];
      const parts = trimParts(written, maxReplyChars, maxParts);
      if (parts.length === 0) {
        return emptyAnswer({ kind: "silence", transcript, thoughts, turns: turn, modelCalls });
      }
      return emptyAnswer({
        kind: "reply",
        reply: parts[0] ?? null,
        parts,
        transcript,
        thoughts,
        turns: turn,
        modelCalls,
      });
    }

    const used = await callTool({
      name: decided.tool,
      rawArguments: decided.arguments,
      ready,
      tools: request.tools,
      deps: request.deps,
      execution: request.execution,
      timeoutMs: toolTimeoutMs,
    });
    transcript.push(used.entry);

    if (used.execution !== null) {
      return emptyAnswer({
        kind: "execute",
        execution: used.execution,
        transcript,
        thoughts,
        turns: turn,
        modelCalls,
      });
    }
  }

  return emptyAnswer({
    kind: "silence",
    transcript,
    thoughts,
    turns: maxTurns,
    modelCalls,
  });
}

async function ask(
  provider: ModelProvider,
  request: StructuredRequest,
): Promise<{ readonly value: unknown }> {
  return provider.generate<unknown>(request);
}

async function callTool<Deps>({
  name,
  rawArguments,
  ready,
  tools,
  deps,
  execution,
  timeoutMs,
}: {
  readonly name: string | null;
  readonly rawArguments: string;
  readonly ready: readonly Tool<Deps>[];
  readonly tools: ToolRegistry<Deps>;
  readonly deps: Deps;
  readonly execution: boolean;
  readonly timeoutMs: number;
}): Promise<{
  readonly entry: TranscriptEntry;
  readonly execution: RuntimeExecution | null;
}> {
  const started = Date.now();

  if (name === null) {
    return {
      entry: {
        tool: "(none)",
        arguments: rawArguments,
        ok: false,
        text: "You set act to tool but named no tool.",
        durationMs: 0,
      },
      execution: null,
    };
  }

  const tool = tools.get(name);
  if (tool === null || !ready.some((entry) => entry.name === name)) {
    return {
      entry: {
        tool: name,
        arguments: rawArguments,
        ok: false,
        text: `There is no tool called ${name} available on this turn.`,
        durationMs: Date.now() - started,
      },
      execution: null,
    };
  }

  if (tool.kind === "execute" && !execution) {
    return {
      entry: {
        tool: name,
        arguments: rawArguments,
        ok: false,
        text: "Execution is not permitted for this request.",
        durationMs: Date.now() - started,
      },
      execution: null,
    };
  }

  let args;
  try {
    args = readArguments(tool.parameters, rawArguments);
  } catch (cause) {
    return {
      entry: {
        tool: name,
        arguments: rawArguments,
        ok: false,
        text: cause instanceof Error ? cause.message : "arguments were not valid",
        durationMs: Date.now() - started,
      },
      execution: null,
    };
  }

  const outcome = await runTool(tool, args, deps, timeoutMs);
  const entry: TranscriptEntry = {
    tool: name,
    arguments: JSON.stringify(args),
    ok: outcome.ok,
    text: outcome.text,
    durationMs: Date.now() - started,
  };

  if (!outcome.ok || tool.kind !== "execute") {
    return { entry, execution: null };
  }

  return {
    entry,
    execution: {
      tool: name,
      arguments: args,
      detail: outcome.detail ?? {},
    },
  };
}
