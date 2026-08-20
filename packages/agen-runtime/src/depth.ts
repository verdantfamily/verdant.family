/**
 * How much work a question is asking for.
 *
 * `thoughts?` and `investigate this` are the same length and want completely different amounts of
 * effort. One wants a sentence from what is already on screen; the other wants several sources and
 * a note about where they disagree. Spending twelve turns on the first is slow and expensive, and
 * spending one on the second produces the confident single-source answer this runtime exists to
 * avoid.
 *
 * ## Why this is a regex and not a model call
 *
 * Asking the model how hard to think costs a round trip before any work starts, and the answer
 * would be a guess about a phrase that is right there in the text. The cues are explicit and
 * imperative — people write `research this` when they want research — so reading them is a match,
 * not a judgement.
 *
 * Note what this deliberately does *not* look at: the topic. Nothing here knows what a token, a
 * chart or a news story is, and adding that would turn a depth cue into the hardcoded question
 * classifier the whole design is trying not to be. Which *sources* to use is the model's decision,
 * made from the tools it can see. This only decides how long it may keep going.
 *
 * ## A ceiling, not a quota
 *
 * Depth raises the turn budget; it never obliges the model to spend it. `research this token` on a
 * market the surface already resolved should still answer in one turn if one lookup settles it. The
 * guidance says so, because a model told it has eight turns will otherwise find eight turns of work.
 */

/** How far to go. Ordered: each level is a superset of the one before. */
export type Depth = "quick" | "research" | "investigate";

export interface Plan {
  readonly depth: Depth;
  /** Turn ceiling for the loop, including the turn that answers. */
  readonly maxTurns: number;
  /** How many messages the answer may be split across, if the surface allows more than one. */
  readonly maxParts: number;
  /** The paragraph the prompt shows for this depth. */
  readonly guidance: string;
}

/**
 * Phrases that ask for a second opinion rather than an answer.
 *
 * `is this true` and `is this real` are here rather than in {@link RESEARCH} because a claim to be
 * checked is the one case where a single source is actively misleading: the first result for a
 * viral falsehood is usually the falsehood.
 */
const INVESTIGATE = [
  /\binvestigate\b/i,
  /\bdeep[ -]?dive\b/i,
  /\bdig into\b/i,
  /\bdue diligence\b/i,
  /\bfact[ -]?check\b/i,
  /\bcross[ -]?check\b/i,
  /\bdebunk\b/i,
  // A noun may sit between the pronoun and the claim — "is this screenshot real", "is this chart
  // accurate" — so a couple of words are allowed through. Bounded rather than `.*` because an
  // unbounded gap matches most of a paragraph and would read half the ordinary questions as
  // investigations.
  /\bis (?:this|that|it) (?:\w+ ){0,2}(?:true|real|legit|fake|accurate|a scam|a fake)\b/i,
  /\bare (?:these|those) (?:\w+ ){0,2}(?:real|legit|fake|accurate)\b/i,
  /\bthorough(?:ly)?\b/i,
  /\bfull (?:analysis|breakdown|report)\b/i,
];

/** Phrases that ask for sources, not just an opinion. */
const RESEARCH = [
  /\bresearch\b/i,
  /\blook into\b/i,
  /\bsources?\b/i,
  /\bcite\b/i,
  /\bwhat(?:'s| is| are)? .{0,20}\bsaying\b/i,
  /\bwrite[ -]?up\b/i,
  /\bbrief me\b/i,
  /\bin detail\b/i,
  /\bcompare\b/i,
  /\bsummari[sz]e (?:this )?(?:thread|conversation|article|paper)\b/i,
  /\bbackground on\b/i,
];

/**
 * Read the depth cue out of what the person wrote.
 *
 * Checked strongest-first, so `investigate this and cite sources` is an investigation rather than
 * whichever list happened to be tested first.
 */
export function depthFor(question: string): Depth {
  const text = question.trim();
  if (text === "") return "quick";
  if (INVESTIGATE.some((pattern) => pattern.test(text))) return "investigate";
  if (RESEARCH.some((pattern) => pattern.test(text))) return "research";
  return "quick";
}

const QUICK = [
  "DEPTH: quick",
  "",
  "They want an answer, not a report. Use what is already in front of you and answer in one turn",
  "if you can. Reach for a tool only when the answer turns on a fact you do not have — a current",
  "number, a page you have not read, a post you cannot see. One good tool call beats three.",
].join("\n");

const RESEARCH_GUIDANCE = [
  "DEPTH: research",
  "",
  "They asked you to actually go and look. Gather from more than one place before answering, and",
  "prefer different *kinds* of source over the same kind twice — a search plus the primary page it",
  "found beats two searches. Name what you found rather than summarising it into mush.",
  "",
  "This is a ceiling, not a quota. If the first source settles it, say so and stop.",
  "But one source is the floor: they asked you to look, so do not answer this from memory alone.",
].join("\n");

const INVESTIGATE_GUIDANCE = [
  "DEPTH: investigate",
  "",
  "They want it checked, not repeated. Get the claim from more than one independent place and say",
  "explicitly where they agree and where they do not. If every source traces back to the same",
  "original post, that is not corroboration and you should say so.",
  "",
  "Separate what you verified from what you are inferring. If you could not check the load-bearing",
  "part, lead with that — an honest 'the only source for this is the screenshot itself' is worth",
  "more than a confident summary of one rumour.",
  "",
  "That last point is earned, not assumed. 'i cannot verify this' is a finding you report after",
  "searching, never a reason to skip searching, and a vaguely worded claim is a reason to go looking",
  "for the real number rather than to dismiss it. Never answer at this depth without retrieving:",
  "if the claim is too loose to check as written, check the nearest thing that is measurable, then",
  "say what the actual figure was and where the wording falls apart.",
].join("\n");

/**
 * Turn a depth into a budget.
 *
 * `limits` is the surface's own ceiling and always wins: X will not take a nine-post thread and a
 * poll cannot sit open for twelve model calls, so a surface passes what it can actually deliver and
 * the depth chooses within that. Without this the runtime would hand a caller a plan it had already
 * been told it could not honour.
 */
export function planFor(
  depth: Depth,
  limits?: { readonly maxTurns?: number; readonly maxParts?: number },
): Plan {
  const table: Record<Depth, { turns: number; parts: number; guidance: string }> = {
    quick: { turns: 4, parts: 1, guidance: QUICK },
    research: { turns: 8, parts: 2, guidance: RESEARCH_GUIDANCE },
    investigate: { turns: 12, parts: 3, guidance: INVESTIGATE_GUIDANCE },
  };

  const chosen = table[depth];
  return {
    depth,
    maxTurns: Math.max(1, Math.min(chosen.turns, limits?.maxTurns ?? chosen.turns)),
    maxParts: Math.max(1, Math.min(chosen.parts, limits?.maxParts ?? chosen.parts)),
    guidance: chosen.guidance,
  };
}
