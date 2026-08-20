/**
 * One turn of the loop, as a schema and as a value.
 *
 * The model is forced into this shape on every call. It can name a tool or it can finish; it
 * cannot do both, and it cannot invent a third kind of act. That is what keeps the loop a loop
 * rather than a conversation the model is free to wander out of.
 *
 * ## Compatibility
 *
 * Scripted tests — and any caller that still speaks the old X router schema of
 * `LAUNCH` / `QUESTION` / `UNKNOWN` — are accepted by {@link readTurn} and mapped onto the same
 * four acts. Production prompts never mention those words. The mapping exists so a change of
 * runtime does not silently break every test that pinned a model's answer.
 */

import { object, optional, text, type JsonSchema } from "@verdant/market-compiler";

export const TURN_SCHEMA: JsonSchema = object(
  {
    thought: text(
      "One private line about what you are doing and why. Never shown. Do not put the answer here.",
    ),
    act: {
      type: "string",
      enum: ["tool", "reply", "refuse", "silence"],
      description:
        "tool: call one tool. reply: send the final answer. refuse: will not help. " +
        "silence: nothing useful to say, send nothing.",
    },
    tool: optional(text("The tool to call, exactly as named in TOOLS. Null unless act is tool.")),
    arguments: optional(
      text(
        "A JSON object of the tool's arguments, as a string. Example: {\"token\":\"0xabc\"}. " +
          "Null unless act is tool.",
      ),
    ),
    reply: optional(
      text("The text to send. Null unless act is reply. Do not include reasoning or tool names."),
    ),
    // A second and third message rather than an array, because strict mode arrays of strings are
    // accepted but arrive unbounded — and an unbounded list is how a 240-character surface gets
    // handed nine posts. Two extra named fields cap the thread in the schema itself, where the
    // model can see the cap rather than being told about it in prose it may ignore.
    reply_2: optional(
      text(
        "Only if one message genuinely cannot hold the answer, and only if THREAD SIZE allows " +
          "more than one. The second message. Null otherwise.",
      ),
    ),
    reply_3: optional(
      text("The third message, on the same terms as reply_2. Null otherwise."),
    ),
    reason: optional(text("One line, for refuse. Null otherwise.")),
  },
  "One turn: call a tool, or finish.",
);

export type Act = "tool" | "reply" | "refuse" | "silence";

export interface Turn {
  readonly thought: string;
  readonly act: Act;
  readonly tool: string | null;
  readonly arguments: string;
  readonly reply: string | null;
  /**
   * The reply as one or more messages, in order.
   *
   * Empty unless the act is `reply`. The first element is `reply`; the loop trims each part and
   * drops the ones the surface has no room for, so this being longer than the surface allows is
   * handled rather than an error.
   */
  readonly parts: readonly string[];
  readonly reason: string | null;
  /**
   * A launch the old schema already decided, so the loop can finish without calling a tool.
   *
   * Only set when a scripted provider answered `intent: LAUNCH`. Production turns never carry
   * this: they call `launch_instant` like any other execute tool.
   */
  readonly legacyLaunch: LegacyLaunch | null;
}

export interface LegacyLaunch {
  readonly name: string;
  readonly ticker: string;
  readonly description: string;
  readonly confidence: number;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/**
 * What the model wrote, reduced to a turn this loop understands.
 *
 * Unknown acts become silence rather than a guess at execution. A launch is never inferred
 * from a missing field: it has to be `act: tool` naming an execute tool, or the legacy
 * `intent: LAUNCH` that scripted tests still send.
 */
export function readTurn(value: unknown): Turn {
  const raw =
    typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : {};

  const legacy = readLegacy(raw);
  if (legacy !== null) return legacy;

  const act = readAct(raw.act);
  const parts =
    act === "reply"
      ? [raw.reply, raw.reply_2, raw.reply_3]
          .map((value) => asString(value))
          .filter((value): value is string => value !== null)
      : [];

  return {
    thought: asString(raw.thought) ?? "",
    act,
    tool: act === "tool" ? (asString(raw.tool)?.trim() ?? null) : null,
    arguments: act === "tool" ? (asString(raw.arguments) ?? "{}") : "{}",
    reply: act === "reply" ? asString(raw.reply) : null,
    parts,
    reason: act === "refuse" ? asString(raw.reason) : null,
    legacyLaunch: null,
  };
}

function readAct(value: unknown): Act {
  return value === "tool" || value === "reply" || value === "refuse" || value === "silence"
    ? value
    : "silence";
}

/**
 * The old X router shape, mapped onto this loop.
 *
 * Kept so `engine.test.ts` can keep pinning `{ intent: "LAUNCH", name, ticker, … }` and still
 * exercise the launch path. A value that names an unknown intent is silence, matching the
 * original router's refusal to guess.
 */
function readLegacy(raw: Record<string, unknown>): Turn | null {
  const intent = raw.intent;
  if (typeof intent !== "string") return null;
  if (raw.act !== undefined) return null;

  if (intent === "LAUNCH") {
    return {
      thought: "legacy launch",
      act: "tool",
      tool: "launch_instant",
      arguments: "{}",
      reply: null,
      parts: [],
      reason: null,
      legacyLaunch: {
        name: asString(raw.name) ?? "",
        ticker: asString(raw.ticker) ?? "",
        description: asString(raw.description) ?? "",
        confidence: clamp01(asNumber(raw.confidence) ?? 0),
      },
    };
  }

  if (intent === "QUESTION") {
    const answer = asString(raw.answer);
    return {
      thought: "legacy question",
      act: "reply",
      tool: null,
      arguments: "{}",
      reply: answer,
      parts: answer === null ? [] : [answer],
      reason: null,
      legacyLaunch: null,
    };
  }

  return {
    thought: "legacy unknown",
    act: "silence",
    tool: null,
    arguments: "{}",
    reply: null,
    parts: [],
    reason: null,
    legacyLaunch: null,
  };
}
