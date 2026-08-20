/**
 * The tool layer: what Agen can do, declared once.
 *
 * A tool declares its parameters, and that one declaration produces both halves of the contract —
 * the description the model reads and the validator the arguments must pass. They cannot drift
 * apart, which is the failure this shape exists to prevent: a prompt that promises a `limit`
 * argument and a validator that has never heard of one produces a tool that fails every time the
 * model does what it was told.
 *
 * ## The model names a tool; it never builds a call
 *
 * Arguments arrive as a JSON *string* the model wrote, and nothing downstream trusts it. It is
 * parsed here, checked against the declared parameters here, and reduced to primitives here.
 * Anything unrecognised is dropped rather than forwarded. A tool therefore receives a
 * `Record<string, string | number | boolean>` and nothing else — no nested objects, no arrays, no
 * addresses it has not itself validated.
 *
 * That is what keeps the execution tools safe. A model cannot express calldata through this
 * interface, cannot name a destination contract, and cannot reach a second chain, because none of
 * those are primitives a parameter can hold. The launch tool takes the same values a person types
 * into a form, and the transaction is built afterwards by code that has never seen the model's
 * output. Every guarantee in `lib/x/sponsor.ts` is still in front of it.
 */

import type { Availability, Tool, ToolArguments, ToolCategory, ToolParameter } from "./types";

/**
 * A tool refused its arguments, or could not do the job.
 *
 * Thrown rather than returned because the loop treats it as a *recoverable* step: the message goes
 * back to the model as that step's result, and the model gets another turn to fix the call or give
 * up. So the message is written for the model — "`token` must be a 0x address" — and not for a
 * user, who should never see it.
 */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolError";
  }
}

export interface ToolRegistry<Deps> {
  readonly tools: readonly Tool<Deps>[];
  get(name: string): Tool<Deps> | null;
  /** The tools this deployment can actually run, with the rest reported as unavailable. */
  usable(deps: Deps): {
    readonly ready: readonly Tool<Deps>[];
    readonly unavailable: readonly { readonly name: string; readonly reason: string }[];
  };
}

/**
 * Assemble a registry.
 *
 * Duplicate names throw at construction. It would otherwise be a silent shadowing that shows up as
 * one tool mysteriously never being called, months later, on a surface nobody was testing.
 */
export function registry<Deps>(tools: readonly Tool<Deps>[]): ToolRegistry<Deps> {
  const byName = new Map<string, Tool<Deps>>();
  for (const tool of tools) {
    if (byName.has(tool.name)) throw new Error(`Two tools are called ${tool.name}.`);
    if (!/^[a-z][a-z0-9_]*$/.test(tool.name)) {
      throw new Error(`Tool names are snake_case; ${tool.name} is not.`);
    }
    byName.set(tool.name, tool);
  }

  return {
    tools,
    get: (name) => byName.get(name) ?? null,
    usable: (deps) => {
      const ready: Tool<Deps>[] = [];
      const unavailable: { name: string; reason: string }[] = [];

      for (const tool of tools) {
        let verdict: Availability;
        try {
          verdict = tool.available(deps);
        } catch (cause) {
          // A capability check that throws is an unavailable capability, not a failed request.
          // Reporting it as unavailable keeps one misconfigured tool from taking down every
          // answer the runtime could otherwise still give.
          verdict = cause instanceof Error ? cause.message : "unavailable";
        }
        if (verdict === true) ready.push(tool);
        else unavailable.push({ name: tool.name, reason: verdict });
      }

      return { ready, unavailable };
    },
  };
}

/** Identity helper, for the type inference. Reads better than a bare object literal at the top of a file. */
export function defineTool<Deps>(tool: Tool<Deps>): Tool<Deps> {
  return tool;
}

const CATEGORY_HEADINGS: Record<ToolCategory, string> = {
  social: "The social network — posts, threads, accounts, who follows whom",
  web: "The open web",
  page: "One named document",
  market: "Agen's own markets (first-party, authoritative)",
  chain: "Direct chain reads (exact, never stale)",
  other: "Other",
};

const CATEGORY_ORDER: readonly ToolCategory[] = ["market", "chain", "social", "web", "page", "other"];

/**
 * Which source owns which kind of fact.
 *
 * Generated from the categories actually present rather than written out, so it never advertises a
 * source this deployment cannot reach. That mattered more than it sounds: the previous version of
 * this advice named tools directly, and on a deployment without a web-search key it was telling the
 * model to go and search the web, which produced a confident answer from memory instead of "I can't
 * check that".
 *
 * The last line is the one that earns its place. A model handed a rack of tools will use them, and
 * the failure mode of a research agent is not laziness — it is four lookups to answer a question
 * about arithmetic.
 */
export function routingFor<Deps>(tools: readonly Tool<Deps>[]): string {
  const present = new Set(tools.filter((tool) => tool.kind === "read").map((tool) => tool.category ?? "other"));
  const lines: string[] = [];

  if (present.has("market")) {
    lines.push(
      "  A token, ticker, pool or agen.space market — go to Agen's own market tools first. They are",
      "  first-party and current; the web will quote you a price from a different chain.",
    );
  }
  if (present.has("chain")) {
    lines.push("  A wallet, a balance, a contract — read the chain. Nothing else is authoritative about it.");
  }
  if (present.has("social")) {
    lines.push(
      "  What people are saying, sentiment, who posted something, whether one account follows",
      "  another, what a thread argued — the network itself. Not a web search about the network.",
    );
  }
  if (present.has("web")) {
    lines.push(
      "  News, companies, products, regulation, people, anything that happened recently — search the",
      "  web. Prefer the primary source over commentary about it, and say when a claim has one origin.",
    );
  }
  if (present.has("page")) {
    lines.push(
      "  A link that is already in front of you, or one a search returned — read the page rather than",
      "  guessing from its title. `read this` and `summarise this` mean the link in the context.",
      "  If it turns out to be an index or a hub, do not summarise the menu — open the one entry that",
      "  answers the question and read that. A list of section names is not a summary of anything.",
    );
  }
  if (present.has("social") && present.has("web")) {
    lines.push(
      "  Breaking events are worth both: the network for what people are claiming right now, the web",
      "  for whether it is confirmed. They disagree often, and that disagreement is the answer.",
    );
  }

  lines.push(
    "",
    "  Evergreen questions — how something works, maths, code, history, explaining a concept — you",
    "  already know. Answer from knowledge and reach for a tool only if the answer turns on a",
    "  current fact or a specific document. Retrieval you did not need is slower and no more true.",
  );

  // The laziness rule. Observed failure: asked whether a named company had announced a named thing,
  // the model replied "which announcement do you mean?" without searching once. Every word it needed
  // was in the question. Asking a person to restate a claim you could have looked up in one turn is
  // the worst available answer — it costs them a round trip and returns nothing — and it is a
  // specific trap for anything told to ask when it is unsure, which is why this sits next to the
  // permission to ask rather than in the voice.
  if (present.size > 0) {
    lines.push(
      "",
      "  Search before you ask, and search before you decline. If the question names something you",
      "  could look up — a company, a person, a token, a product, an event, a statistic, a claim about",
      "  any of them — go and look it up, even if the wording is loose and even if you are not certain",
      "  which thing they mean. Then ask about whatever is still genuinely ambiguous, and ask it while",
      "  telling them what you did find.",
      "",
      "  'which one do you mean?' and 'i cannot verify that' are both answers you have to earn. Said",
      "  on the first turn, without a single retrieval, they hand the work back to the person who asked",
      "  and return nothing. Only a question with nothing searchable in it at all — no name, no link,",
      "  no picture, no post above it — is answered by asking what they meant.",
    );
  }

  return ["SOURCE ROUTING", "", ...lines].join("\n");
}

/** The catalogue as the model reads it, grouped so the routing advice above has something to point at. */
export function describeTools<Deps>(tools: readonly Tool<Deps>[]): string {
  if (tools.length === 0) return "(no tools are available on this deployment)";

  const groups = CATEGORY_ORDER.map(
    (category) =>
      [category, tools.filter((tool) => (tool.category ?? "other") === category)] as const,
  ).filter(([, members]) => members.length > 0);

  // One flat list when everything landed in one group, which is every small deployment and every
  // test. Headings over a single group are noise the model has to read past.
  if (groups.length <= 1) return describeGroup(tools);

  return groups
    .map(([category, members]) => `  — ${CATEGORY_HEADINGS[category]}\n\n${describeGroup(members)}`)
    .join("\n\n");
}

function describeGroup<Deps>(tools: readonly Tool<Deps>[]): string {
  return tools
    .map((tool) => {
      const params =
        tool.parameters.length === 0
          ? "    (no arguments)"
          : tool.parameters
              .map((parameter) => `    ${describeParameter(parameter)}`)
              .join("\n");

      const marker = tool.kind === "execute" ? " [EXECUTES — spends money or changes state]" : "";
      return `  ${tool.name}${marker}\n    ${tool.summary}\n${params}`;
    })
    .join("\n\n");
}

function describeParameter(parameter: ToolParameter): string {
  const need = parameter.required ? "required" : "optional";
  const choices =
    parameter.choices === undefined ? "" : `, one of: ${parameter.choices.join(" | ")}`;
  return `- ${parameter.name} (${parameter.type}, ${need}${choices}): ${parameter.description}`;
}

/**
 * Turn what the model wrote into arguments a tool can be trusted with.
 *
 * Strict in the directions that matter and forgiving in the ones that do not. A missing required
 * argument is refused, an unknown key is dropped, and a number sent as `"12"` is accepted as 12 —
 * because models do that constantly and refusing it would burn a turn to teach the model something
 * this function can simply know.
 */
export function readArguments(
  parameters: readonly ToolParameter[],
  raw: string,
): ToolArguments {
  const source = parseObject(raw);
  const out: Record<string, string | number | boolean> = {};

  for (const parameter of parameters) {
    const value = source[parameter.name];

    if (value === undefined || value === null) {
      if (parameter.required) {
        throw new ToolError(`${parameter.name} is required: ${parameter.description}`);
      }
      continue;
    }

    out[parameter.name] = coerce(parameter, value);
  }

  return out;
}

function parseObject(raw: string): Record<string, unknown> {
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed === "null") return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new ToolError("Arguments must be a JSON object, e.g. {\"token\":\"0xabc…\"}.");
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ToolError("Arguments must be a JSON object, not an array or a bare value.");
  }

  return parsed as Record<string, unknown>;
}

function coerce(parameter: ToolParameter, value: unknown): string | number | boolean {
  switch (parameter.type) {
    case "string": {
      // Numbers and booleans are accepted and stringified. A token address written without
      // quotes is a mistake worth absorbing rather than a turn worth spending.
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        const text = String(value).trim();
        if (parameter.choices !== undefined && !parameter.choices.includes(text)) {
          throw new ToolError(
            `${parameter.name} must be one of: ${parameter.choices.join(", ")}.`,
          );
        }
        // A long argument is either a mistake or an attempt to smuggle a payload through a
        // parameter. Neither is worth forwarding, and no legitimate argument here is prose.
        if (text.length > 400) throw new ToolError(`${parameter.name} is too long.`);
        return text;
      }
      throw new ToolError(`${parameter.name} must be a string.`);
    }
    case "number": {
      const parsed = typeof value === "number" ? value : Number(String(value).trim());
      if (!Number.isFinite(parsed)) throw new ToolError(`${parameter.name} must be a number.`);
      return parsed;
    }
    case "boolean": {
      if (typeof value === "boolean") return value;
      const text = String(value).trim().toLowerCase();
      if (text === "true") return true;
      if (text === "false") return false;
      throw new ToolError(`${parameter.name} must be true or false.`);
    }
  }
}

/**
 * Run a tool under a deadline, and never let it throw something unrecognisable.
 *
 * The timeout is here rather than in each tool because forgetting it in one tool is how a mention
 * holds a poll open for a minute. `Promise.race` leaves the slow work running — there is no way to
 * cancel a promise — and that is accepted: the result is discarded, and every tool this package
 * ships wraps a request that carries its own abort.
 */
export async function runTool<Deps>(
  tool: Tool<Deps>,
  args: ToolArguments,
  deps: Deps,
  timeoutMs: number,
): Promise<ToolOutcomeOrError> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    const outcome = await Promise.race([
      tool.run(args, deps),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new ToolError(`${tool.name} took too long and was given up on.`)),
          timeoutMs,
        );
      }),
    ]);
    return { ok: true, text: outcome.text, ...(outcome.detail === undefined ? {} : { detail: outcome.detail }) };
  } catch (cause) {
    // Everything becomes a readable failure the model can react to. A tool that throws a
    // TypeError is a bug in the tool, and the right behaviour is still to tell the model that
    // this route did not work rather than to abandon the person's question.
    const message =
      cause instanceof ToolError
        ? cause.message
        : cause instanceof Error
          ? `failed: ${cause.message}`
          : "failed";
    return { ok: false, text: message };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export interface ToolOutcomeOrError {
  readonly ok: boolean;
  readonly text: string;
  readonly detail?: Readonly<Record<string, unknown>>;
}
