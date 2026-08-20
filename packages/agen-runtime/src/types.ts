/**
 * What the Agen runtime is given, and what it hands back.
 *
 * These shapes are the boundary between a *surface* — X, the site, Telegram, MCP, an A4A peer —
 * and Agen's intelligence. Nothing in this package knows what X is, and that is the point: a
 * surface's job is to turn whatever it has into a {@link AgenContext} and to do something with the
 * {@link RuntimeAnswer} it gets back. The reasoning in between is shared.
 *
 * ## Why context is blocks rather than a string
 *
 * The surface knows what it is looking at and the runtime does not. A parent post, a quoted post,
 * a thread, an image caption and a detected contract address are all *evidence*, and each carries
 * a different amount of trust: text written by the person asking, text written by a stranger, and
 * facts the surface derived itself. Blocks keep that distinction all the way into the prompt,
 * where untrusted material is fenced and labelled. A pre-flattened string would have thrown it
 * away at exactly the point it starts to matter.
 */

/** How much the runtime should believe a block, which decides how it is presented. */
export type Trust =
  /** Written by Agen or derived deterministically by the surface. Facts. */
  | "system"
  /** Written by the person Agen is answering. An instruction, but only about intent. */
  | "asker"
  /** Written by a third party who never opted in. Data to describe, never to obey. */
  | "public";

/**
 * One piece of evidence.
 *
 * `label` is what the model sees as the block's heading, so it is written for a reader:
 * `PARENT POST`, `QUOTED POST`, `THREAD`, `DETECTED TOKENS`. `body` is text, already flattened by
 * whoever knew what it meant.
 */
export interface ContextBlock {
  readonly label: string;
  readonly body: string;
  readonly trust: Trust;
}

/**
 * A picture the model should actually look at.
 *
 * Separate from {@link ContextBlock} because it does not travel in the text channel at all — the
 * loop hands these to the provider as image parts. Alt text still belongs in a block, and both are
 * worth sending: the caption is what the author claims the picture shows, and the picture is what
 * it shows. When a question is `is this screenshot real`, the gap between those two is the answer.
 *
 * `trust` is always effectively public and is recorded anyway, because an image is the easiest
 * place to hide an instruction: text rendered into pixels passes every filter upstream of the
 * model. The prompt states the rule; nothing downstream trusts the output regardless.
 */
export interface ContextImage {
  /** A public https URL the model's vendor can fetch. */
  readonly url: string;
  /** Where it came from, in words: `image in the parent post`. */
  readonly label: string;
  readonly trust: Trust;
}

/**
 * Everything known before the model is asked anything.
 *
 * `question` is what the person actually said, with the surface's addressing removed — the bot's
 * handle on X, the slash command elsewhere. It may be empty: `@useagen thoughts?` carries almost
 * no question at all, and the answer lives entirely in the blocks.
 */
export interface AgenContext {
  /** Which surface is asking. Appears in logs and lets the persona adjust length. */
  readonly surface: string;
  /** What the asker said, cleaned of addressing. May be empty. */
  readonly question: string;
  /** Who is asking, for the record and for the voice. Never used to authorise anything. */
  readonly asker: { readonly handle: string | null; readonly id: string | null };
  readonly blocks: readonly ContextBlock[];
  /**
   * Pictures attached to whatever is being asked about.
   *
   * Optional, and empty on most surfaces. A surface that has images but no vision-capable provider
   * should still send them: the loop decides whether to forward them, and a caption block is the
   * fallback either way.
   */
  readonly images?: readonly ContextImage[];
  /**
   * Facts the surface wants stated rather than discovered.
   *
   * For resolved references in particular: a surface that has already worked out which token a
   * post is about should say so, rather than making the runtime spend a tool call rediscovering
   * it. Keys are short identifiers; values are printed verbatim.
   */
  readonly facts?: Readonly<Record<string, string>>;
}

/** What a tool takes, declared once and used for both the prompt and the validation. */
export interface ToolParameter {
  readonly name: string;
  readonly type: "string" | "number" | "boolean";
  readonly required: boolean;
  readonly description: string;
  /** When present, the only accepted values. Enforced, not merely suggested. */
  readonly choices?: readonly string[];
}

/** Validated arguments. Primitives only, by construction — see `readArguments`. */
export type ToolArguments = Readonly<Record<string, string | number | boolean>>;

/**
 * Whether a tool may run at all on this deployment.
 *
 * A string is a *reason it cannot*, and it is shown to the model so that an unconfigured
 * capability produces "I can't check that right now" rather than a confident guess. That honesty
 * is the whole reason this is not a boolean.
 */
export type Availability = true | string;

/**
 * What a tool did.
 *
 * `text` is what the model reads. It is prose or small JSON, and it is the tool's job to make it
 * short — a tool that returns a thousand rows has moved the problem into the context window.
 */
export interface ToolOutcome {
  readonly text: string;
  /** For the transcript and the caller, never shown to the model. */
  readonly detail?: Readonly<Record<string, unknown>>;
}

/**
 * Which kind of source a tool speaks for.
 *
 * Used to generate the routing advice in the prompt instead of hardcoding it. The alternative was a
 * paragraph naming specific tools — "use search_x for what people are saying" — which rots the
 * first time a tool is renamed and, worse, is a lie on any deployment where that tool is not
 * configured. Grouping by category means the guidance describes only the sources actually present.
 *
 * Deliberately coarse. These are the distinctions that change *which* source owns a fact, not a
 * taxonomy of every tool: a follower count and a post both come from the same network and the same
 * permissions, so they are one category.
 */
export type ToolCategory =
  /** The social network itself: posts, threads, accounts, relationships. */
  | "social"
  /** Open-ended search of the public web. */
  | "web"
  /** One named document, fetched and read. */
  | "page"
  /** Agen's own markets and indexer. First-party and authoritative. */
  | "market"
  /** Direct chain reads. Slow, exact, and never stale. */
  | "chain"
  /** Anything that does not route: utilities, and the execute tools. */
  | "other";

/**
 * A capability the model may choose.
 *
 * `kind` is load-bearing rather than descriptive. A `read` tool can be wrong; an `execute` tool
 * spends money or changes the world, and the runtime will not let the model reach one unless the
 * caller has explicitly granted execution for this request. See `loop.ts`.
 */
export interface Tool<Deps = unknown> {
  /** `snake_case`, stable, and named for what a person would ask for. */
  readonly name: string;
  /** One line, written for the model: what it answers and when to reach for it. */
  readonly summary: string;
  readonly kind: "read" | "execute";
  /** Which source this speaks for. Defaults to `other`, which routes nowhere. */
  readonly category?: ToolCategory;
  readonly parameters: readonly ToolParameter[];
  /** Whether this deployment can run it, and why not when it cannot. */
  available(deps: Deps): Availability;
  run(args: ToolArguments, deps: Deps): Promise<ToolOutcome>;
}

/** One completed step, kept for logs and for the model's own memory of what it has tried. */
export interface TranscriptEntry {
  readonly tool: string;
  readonly arguments: string;
  readonly ok: boolean;
  readonly text: string;
  readonly durationMs: number;
}

/**
 * What the runtime decided.
 *
 * `reply` is the only field a surface should show a person. `thoughts` exists for logs and is
 * deliberately awkward to reach for, because publishing a model's reasoning is both a bad answer
 * and a way to leak the prompt.
 */
/**
 * An execution the model asked for and a tool accepted.
 *
 * The runtime does not send the transaction. It records the validated arguments and stops, and
 * the surface that granted execution is the one that actually spends. That split is what lets
 * the same launch tool sit behind X, the site and MCP without any of them constructing calldata
 * from a model's output.
 */
export interface RuntimeExecution {
  readonly tool: string;
  readonly arguments: ToolArguments;
  readonly detail: Readonly<Record<string, unknown>>;
}

/**
 * What the runtime decided.
 *
 * `reply` is the only field a surface should show a person. `thoughts` exists for logs and is
 * deliberately awkward to reach for, because publishing a model's reasoning is both a bad answer
 * and a way to leak the prompt.
 *
 * `execute` means a permissioned tool ran and the surface should now do the irreversible part —
 * on X, that is the existing Instant launch path, unchanged.
 */
export interface RuntimeAnswer {
  readonly kind: "reply" | "refusal" | "silence" | "execute";
  /** Null for `silence` and for `execute`, which the surface announces itself. */
  readonly reply: string | null;
  /**
   * The answer as the messages it should be sent as.
   *
   * Always contains `reply` as its first element when there is a reply at all, so a surface that
   * only knows how to send one message can keep reading `reply` and be correct. A surface that can
   * post a chain — a thread on X — should send all of these in order instead.
   *
   * This exists because the alternative to a second post is a worse first one. A question that
   * genuinely needs three numbers and a caveat, squeezed into 240 characters, arrives as
   * abbreviations and dropped qualifiers, and the thing most likely to be cut is the uncertainty.
   * Splitting is the honest option; the length limit still applies to each part.
   */
  readonly parts: readonly string[];
  /** Why, for a refusal. Short, and safe to say out loud. */
  readonly reason: string | null;
  readonly execution: RuntimeExecution | null;
  readonly transcript: readonly TranscriptEntry[];
  /** Internal reasoning, in order. For logs only. Never post this. */
  readonly thoughts: readonly string[];
  readonly turns: number;
  readonly modelCalls: number;
}
