/**
 * What a specification means, with everything a model chose freely stripped out.
 *
 * Written to answer one question honestly: asked the same thing twice, did Agen understand the
 * same market? The first attempt at that compared names and counts, and it could not tell the
 * difference between a run that renamed a rule and a run that changed a fee — so it reported
 * eleven of twelve prompts as unstable, which is both alarming and useless. Almost all of it was
 * wording.
 *
 * So a specification is reduced to what a trader would notice. Two things follow from that, and
 * they pull in opposite directions on purpose:
 *
 *   - Names carry nothing. A rule called `sell-fee` and one called `launch-token-sell-tax` are the
 *     same rule; `buyStreak` and `consecutiveBuys` are the same counter. Models never word these
 *     the same way twice and nothing downstream depends on them being stable.
 *   - Numbers carry everything. A fee, a threshold, a window, a ceiling — these are the market. A
 *     comparison that lets a 0.5% become a 0.3% because both are "a sell fee" is worse than no
 *     comparison, because it produces confidence rather than information.
 *
 * ## Not a validator
 *
 * Nothing in the pipeline reads this. It exists so a run of the benchmark can say whether the
 * interpretation stage is stable, and it is deliberately allowed to say "these differ" about two
 * markets that a careful reader might call equivalent. Overstating divergence costs an afternoon
 * of reading; understating it is how a pipeline gets called repeatable when it is not.
 */

import type { MarketSpecification, Rule } from "./spec.js";

/** A market's behaviour, in a form two of them can be compared in. */
export interface Behaviour {
  /** The pool fee and the ceiling the hook is held to, in ppm. */
  readonly fees: { readonly base: number | null; readonly max: number | null };
  /**
   * What happens on each trigger, one entry per rule, keyed by side rather than by rule.
   *
   * Keyed this way because the same market arrives structured two ways: EMBR's first run wrote a
   * sell rule charging 3% and a buy rule charging 1%, and its second wrote one rule on any trade
   * carrying both rates. Compared rule by rule those are two different markets; compared by what a
   * buyer and a seller experience they are the same one, which is the truth. A rule on any trade is
   * expanded into both sides, taking each side's own rate where it names them separately.
   */
  readonly effects: readonly string[];
  /** The fee-affecting rules in the order they are listed, for where order is behaviour. */
  readonly order: readonly string[];
  readonly invariants: readonly string[];
  readonly phases: readonly string[];
  /** Which triggers change stored state, without the names or counts anyone chose for it. */
  readonly transitions: readonly string[];
}

/** Reduce a specification to what it does. */
export function behaviour(specification: MarketSpecification): Behaviour {
  const entries = (specification.rules ?? []).flatMap((rule) => sidedEntries(rule));

  return {
    fees: {
      base: specification.baseFeePpm ?? null,
      max: specification.maxFeePpm ?? null,
    },
    effects: [...new Set(entries)].sort(),
    order: entries.filter((entry) => /charge-fee|waive-fee/.test(entry)),
    invariants: [
      ...new Set((specification.invariants ?? []).map((invariant) => meaningOf(invariant.statement))),
    ].sort(),
    /*
     * A phase is when it starts and what it changes, never its name and never its description.
     *
     * "early", "launch window" and "phase-1" are one phase to everyone except the model that named
     * it, and TESTC's second run was called divergent over two phases whose descriptions were
     * paraphrases of its first run's. What can be compared is the boundary: the numbers.
     */
    phases: [
      ...new Set(
        (specification.phases ?? []).map((phase) =>
          [
            classifyPhase(phase as unknown as Record<string, unknown>),
            numbersIn(phase as unknown as Record<string, unknown>).join(","),
          ]
            .filter((part) => part.length > 0)
            .join(":"),
        ),
      ),
    ].sort(),
    transitions: [
      ...new Set(
        (specification.rules ?? []).flatMap((rule) =>
          transitionsOf(rule, gatedByState(specification)),
        ),
      ),
    ].sort(),
  };
}

/**
 * Whether anything in this market behaves differently depending on stored state.
 *
 * True for a streak, a phase, a threshold or a window; false for a market that charges the same fee
 * on every trade and keeps a total for the record.
 */
function gatedByState(specification: MarketSpecification): boolean {
  return (
    (specification.phases ?? []).length > 0 ||
    (specification.rules ?? []).some((rule) =>
      (rule.conditions ?? []).some((clause) => canonicalClause(clause) !== "other"),
    )
  );
}

/**
 * A rule as one entry per side it can fire on.
 *
 * The expansion is the whole trick. `trade` means both sides, so it becomes two entries, and where
 * an effect names the sides separately — `{ sellFeePpm: 5000, buyFeePpm: 0 }`, the shape that also
 * defeated the fee reader — each side takes its own number. What comes out is comparable against a
 * market that wrote the two rules out longhand.
 */
function sidedEntries(rule: Rule): readonly string[] {
  const trigger = triggerOf(rule);
  const sides = trigger === "trade" ? (["sell", "buy"] as const) : ([null] as const);

  return sides.map((side) => {
    /*
     * A condition that classifies as nothing and carries no number is prose.
     *
     * SPEC's first run gated its rule on "treat a swap whose input is the launch token as a sell",
     * which is the trigger restated; its second run put that in the trigger and left the rule
     * unconditional. Comparing them, one market fired "if something" and the other "always", and
     * the something could not be compared at all. A clause nothing can be read out of is dropped
     * rather than counted as a difference nobody can check.
     */
    const conditions = [...(rule.conditions ?? []).map((clause) => canonicalClause(clause))]
      .filter((clause) => clause.length > 0 && clause !== "other")
      .sort();

    const effects = (rule.then ?? [])
      .map((effect) => consequence(effect, side))
      .filter((entry): entry is Consequence => entry !== null);

    /*
     * What the rule does, as consequences rather than as steps.
     *
     * Where the fee ends up is behaviour; how many effects it took to get there is bookkeeping. One
     * run of SIMPLE wrote "take 1% into the hook" and "forward it to the receiver" as two effects,
     * the next wrote "charge 1% to the receiver" as one, and compared step by step those were two
     * markets. They are one market, and this is the difference between comparing what a trader
     * experiences and comparing how a model chose to write it down.
     */
    const rates = (() => {
      const all = [...new Set(effects.flatMap((entry) => entry.rates))].sort();
      // A rate of zero next to a real one is the ceiling, the floor or the untaxed side restated;
      // what is charged here is the non-zero rate. A rule whose only rate is zero keeps it, because
      // "this side pays nothing" is a fact worth comparing.
      return all.some((rate) => rate !== "r0") ? all.filter((rate) => rate !== "r0") : all;
    })();
    const destinations = [...new Set(effects.flatMap((entry) => entry.destinations))].sort();
    const kinds = [...new Set(effects.map((entry) => entry.kind))].sort();

    const qualifiers = [
      rule.onceOnly === true ? "once" : "",
      (rule.activeInPhases ?? []).length > 0 ? "phased" : "",
    ].filter((part) => part.length > 0);

    return [
      `on ${side ?? trigger}`,
      conditions.length === 0 ? "always" : `if ${conditions.join("+")}`,
      `do ${kinds.join("+") || "nothing"}`,
      rates.length === 0 ? "" : `at ${rates.join(",")}`,
      destinations.length === 0 ? "" : `to ${destinations.join(",")}`,
      ...qualifiers,
    ]
      .filter((part) => part.length > 0)
      .join(" ");
  });
}

/** One effect, reduced to what someone trading the market would be able to tell. */
interface Consequence {
  readonly kind: string;
  readonly rates: readonly string[];
  /** Where value ends up, with the places it merely passes through left out. */
  readonly destinations: readonly string[];
}

function consequence(effect: Rule["then"][number], side: "sell" | "buy" | null): Consequence | null {
  const canonical = canonicalEffect(effect, side);
  if (canonical === null) return null;

  const kind = canonical.split(/[(-]|->/)[0]!;
  const cls = canonical.startsWith("waive-fee")
    ? "waive-fee"
    : canonical.startsWith("charge-fee")
      ? "charge-fee"
      : canonical.startsWith("write-state")
        ? "write-state"
        : kind;

  const destination = canonical.includes("->") ? canonical.split("->")[1]! : null;

  return {
    kind: cls,
    rates: numbersIn((effect.parameters ?? {}) as Record<string, unknown>, side),
    /*
     * The hook and the pool are where a fee passes through, not where it lands, and whether a run
     * mentioned that step is not a property of the market — every one of these markets has an
     * invariant saying the hook keeps nothing.
     */
    destinations: destination === null || destination === "hook" || destination === "pool" ? [] : [destination],
  };
}

/** The trade side or event a rule fires on, in the few words that mean anything. */
function triggerOf(rule: Rule): string {
  const kind = (rule.when?.kind ?? "").toLowerCase();
  const said = `${kind} ${(rule.when?.description ?? "").toLowerCase()}`;

  // A sided trigger is the one distinction that changes who pays, so it is read from the
  // description as well as the kind: `swap` where the launch token is the input is a sell.
  if (/\bsell/.test(kind) || /launch token as (?:its )?input|token is the input|selling/.test(said)) {
    return "sell";
  }
  if (/\bbuy/.test(kind) || /launch token as (?:its )?output|buying/.test(said)) return "buy";
  if (/swap|trade/.test(kind)) return "trade";
  if (/time|window|hour|epoch|interval|tick/.test(kind)) return "time";
  if (/claim|withdraw|harvest/.test(kind)) return "claim";
  if (/threshold|volume|milestone|reach/.test(kind)) return "threshold";
  if (/fee/.test(kind)) return "fee-taken";

  return kind.replaceAll(/[^a-z]+/g, "-") || "unknown";
}

/**
 * A condition as what it tests and the numbers it tests against.
 *
 * Classified into a handful of kinds rather than tokenised, and this was the second-largest source
 * of false divergence: a condition's description is a sentence, sentences are never repeated
 * verbatim, and comparing their words made "ten consecutive buys with no intervening sell" and "at
 * least ten buys since the last sell" two different conditions. They test the same thing against
 * the same number, and the number is the part that can be wrong.
 */
function canonicalClause(clause: {
  readonly kind?: string;
  readonly description?: string;
  readonly parameters?: Record<string, unknown> | null;
}): string {
  const said = `${clause.kind ?? ""} ${clause.description ?? ""}`.toLowerCase();
  const numbers = numbersIn(clause.parameters ?? {});

  const kind = /streak|consecutive|in a row|since the last/.test(said)
    ? "streak"
    : /size|amount|larger|greater than|more than|percent of (?:the )?(?:liquidity|supply|pool)/.test(said)
      ? "trade-size"
      : /volume|cumulative|milestone|total/.test(said)
        ? "volume"
        : /hold|balance|owns|wallet/.test(said)
          ? "holding"
          : /time|window|hour|minute|elapsed|since|epoch|cooldown/.test(said)
            ? "time"
            : /phase|stage|window direction|mode/.test(said)
              ? "phase"
              : /first|once|initial/.test(said)
                ? "first-time"
                : "other";

  return `${kind}${numbers.length === 0 ? "" : `(${numbers.join(",")})`}`;
}

/**
 * An effect as its class, its rate and where the value goes.
 *
 * The class matters and the model's word for it does not: `chargeInputFee`, `takeSellTax` and
 * `applyFee` are one thing. Where the value goes is kept because "to the vault" and "to the
 * creator's wallet" are different markets, and normalised to a role because the identifier for
 * that vault is different every run.
 */
function canonicalEffect(effect: Rule["then"][number], side: "sell" | "buy" | null): string | null {
  const kind = (effect.kind ?? "").toLowerCase();
  const said = `${kind} ${(effect.description ?? "").toLowerCase()}`;
  const parameters = (effect.parameters ?? {}) as Record<string, unknown>;

  const cls = /waive|exempt|free|no.?fee|skip/.test(kind)
    ? "waive-fee"
    : /fee|tax|charge|skim|toll|cut/.test(kind)
      ? "charge-fee"
      : /mint/.test(kind)
        ? "mint"
        : /burn/.test(kind)
          ? "burn"
          : /transfer|send|pay|credit|distribut|payout|claim/.test(kind)
            ? "move-value"
            : /set|update|increment|decrement|toggle|reset|record|track|store/.test(kind)
              ? "write-state"
              : /event|emit/.test(kind)
                ? "emit"
                : kind.replaceAll(/[^a-z]+/g, "-") || "unknown";

  /*
   * An effect that only emits or records is not behaviour anyone can observe from a trade, and
   * whether a run bothered to write one down is not a difference in the market. Dropped, because
   * keeping them made a market that mentioned its event log differ from the same market that did
   * not.
   */
  if (cls === "emit") return null;

  const numbers = numbersIn(parameters, side);
  const destination = roleOf(
    [
      ...Object.entries(parameters)
        .filter(([key]) => /destination|recipient|receiver|to\b|beneficiary|target|vault|pool/i.test(key))
        .map(([, value]) => String(value)),
      said,
    ].join(" "),
  );

  return [
    cls,
    numbers.length === 0 ? "" : `(${numbers.join(",")})`,
    destination === null ? "" : `->${destination}`,
  ].join("");
}

/**
 * Who ends up with the value, as a role rather than a name.
 *
 * Ordered from most specific to least: a vault owned by the fee receiver is a vault, and reading
 * it as "receiver" would make a market that hands fees straight to a wallet look like a market
 * that escrows them.
 */
function roleOf(text: string): string | null {
  const said = text.toLowerCase();

  if (/vault|escrow|custody/.test(said)) return "vault";
  if (/reward|jackpot|prize|drift|pot\b/.test(said)) return "reward-pool";
  if (/buyback|burn address|treasury/.test(said)) return "treasury";
  if (/creator|deployer|owner/.test(said)) return "creator";
  if (/fee.?receiver|receiver/.test(said)) return "receiver";
  if (/holder|trader|wallet|caller|user/.test(said)) return "participants";
  if (/liquidity|pool|lp\b/.test(said)) return "pool";
  if (/hook|contract itself/.test(said)) return "hook";

  return null;
}

/**
 * Which triggers change stored state.
 *
 * Derived from what the effects do rather than from the `writes` annotation, which is advisory,
 * frequently left empty, and filtered elsewhere for naming state that does not exist — so one run
 * listing it and another not was reported as a difference in the machine when it was a difference
 * in diligence. Counts are left out for the same reason: whether a counter and its timestamp are
 * one slot or two is a choice about representation.
 */
function transitionsOf(rule: Rule, gated: boolean): readonly string[] {
  /*
   * Only for a market whose behaviour depends on state.
   *
   * A plain sell-fee market writes a running total somewhere, and whether a run wrote that down is
   * invisible to anyone trading it — SIMPLE was reported as divergent on exactly that. A market
   * with a streak, a phase or a threshold is a different case: there the machine is the market, and
   * two runs disagreeing about which trades advance it are describing different things.
   */
  if (!gated) return [];

  const writes = (rule.then ?? []).some(
    (effect) =>
      canonicalEffect(effect, null)?.startsWith("write-state") === true ||
      (effect.writes ?? []).length > 0,
  );

  return writes ? [`${triggerOf(rule)} changes state`] : [];
}

/** What a phase's boundary is, in the terms a boundary can be. */
function classifyPhase(phase: Record<string, unknown>): string {
  const said = JSON.stringify(phase).toLowerCase();

  if (/volume|cumulative|marketcap|market cap/.test(said)) return "volume";
  if (/time|hour|day|minute|second|duration|window/.test(said)) return "time";
  if (/holder|wallet|buyer/.test(said)) return "participation";
  if (/supply|liquidity/.test(said)) return "supply";

  return "other";
}

/**
 * What an invariant claims, as the relation and the numbers in it.
 *
 * Statements are free text and no two runs write one the same way: "the fee can never exceed
 * 0.5%", "fee <= 5000 ppm", "no swap is charged more than half a percent". All three are one
 * claim, and they share a relation, a subject and a number — which is what is kept.
 */
export function meaningOf(statement: string): string {
  const said = statement.toLowerCase();

  /*
   * A ceiling is stated more ways than any other claim, and one of them was missed: "no swap is
   * ever charged more than 50 bps" puts words between the negation and the comparison, so a
   * pattern expecting "no more than" read it as an unclassified claim and two identical ceilings
   * compared as different markets. The negation and the comparison are allowed to be apart.
   */
  const ceiling =
    /never (?:exceed|be more|be greater|go above)|at most|no more than|<=|cannot exceed|\bmax/.test(said) ||
    /\b(?:never|no|not|cannot|can ?not|won'?t)\b[^.]{0,40}\b(?:more than|greater than|above|exceed)/.test(
      said,
    );

  const relation = ceiling
    ? "bounded-above"
    : /never (?:decrease|go down|shrink)|monotonic|only (?:increase|grow)|non.?decreasing|>=/.test(said)
      ? "monotonic"
      : /never (?:hold|keep|retain|custody)|holds no|does not hold|zero balance/.test(said)
        ? "holds-nothing"
        : /conserved|sums? to|equals the sum|no (?:tokens? )?(?:created|lost)|accounted/.test(said)
          ? "conserved"
          : /irreversible|cannot be undone|one.?way|permanent/.test(said)
            ? "irreversible"
            : /free|untaxed|no fee|zero fee/.test(said)
              ? "free"
              : /always|must equal|exactly|==/.test(said)
                ? "equals"
                : "other";

  /*
   * One subject, not every noun in the sentence.
   *
   * An earlier version collected all of them, which produced fingerprints like
   * `other:fee+balance+custody+sells` — effectively the sentence again, and every run writes a
   * different sentence. The claim is about one thing; the rest of the words are describing where
   * that thing lives.
   */
  const subject = /fee|tax|charge|rate/.test(said)
    ? "fee"
    : /supply|mint|burn/.test(said)
      ? "supply"
      : /counter|streak|count\b|consecutive/.test(said)
        ? "counter"
        : /vault|treasury|custody|escrow/.test(said)
          ? "custody"
          : /balance|reserve|holding|accrued|pool/.test(said)
            ? "balance"
            : /phase|window|epoch|state/.test(said)
              ? "state"
              : "";

  /*
   * No numbers.
   *
   * A statement mentions every rate in the market — "the fee is 0.5% and never exceeds the 0.8%
   * ceiling on a 0.3% pool" — and which of them a run happened to mention is not what the invariant
   * claims. Scraping them made one ceiling read `fee:3000,10000,13000` and the identical ceiling in
   * the next run read `fee:13000`. The rates themselves are compared where they are authoritative,
   * in the rules; here the claim is the relation and what it is about.
   */
  return `${relation}:${subject || "unspecified"}`;
}

/**
 * Every number a parameter bag carries, with rates converted to ppm.
 *
 * Sorted and stripped of keys, because the key is a name and the value is the market. A threshold
 * of ten buys is the same threshold whether it arrived as `buys`, `streakLength` or `n`.
 */
function numbersIn(parameters: Record<string, unknown>, side: "sell" | "buy" | null = null): readonly string[] {
  const found = new Set<string>();
  const other = side === "sell" ? "buy" : side === "buy" ? "sell" : null;

  for (const [key, value] of Object.entries(parameters)) {
    if (typeof value !== "number") continue;

    const name = key.toLowerCase();

    // Expanding a two-sided rule into two sides means taking the side's own number and leaving the
    // other side's out of it. `{ sellFeePpm: 5000, buyFeePpm: 0 }` is a 0.5% sell and a free buy,
    // and reading both numbers into both sides would make it neither.
    if (other !== null && name.includes(other)) continue;

    const share = /share|split|portion|allocation|payout/.test(name);
    const ppm = name.includes("ppm")
      ? value
      : name.includes("bps") || name.includes("basispoint")
        ? value * 100
        : name.includes("percent") || name.includes("pct")
          ? value * 10_000
          : null;

    /*
     * A rate is recorded as a rate so that 50 bps and 5000 ppm compare equal; a number with no unit
     * is recorded as itself, because a window of 21600 is not a rate; and a share of a fee is
     * recorded in its own namespace, because "the creator gets all of it" is not a 100% trade fee.
     *
     * Deduplicated, which matters more than it sounds: an effect commonly carries the rate twice —
     * once as the fee and again as its own ceiling — and one run writing `{ feePpm: 5000 }` where
     * another writes `{ feePpm: 5000, maximumFeePpm: 5000 }` is not two markets.
     */
    /*
     * A share is scaled like a rate before it is recorded. One run wrote the creator's cut as
     * `creatorSharePercent: 100` and the next as `creatorShareBps: 10000` — the same "all of it",
     * recorded unscaled as two different numbers, and two runs of EMBR were called divergent for it.
     */
    const scaled = ppm ?? value * 10_000;

    /*
     * A share of all of it is not a fact about the market.
     *
     * "100% of the fee goes to the fee receiver" says only what the destination already says, and
     * four prompts were reported divergent because one run wrote it and the next did not. A share
     * below 100% is kept: that is a fee being divided, which is behaviour.
     */
    if (share && scaled === 1_000_000) continue;

    /*
     * Zero is zero, however the key that carried it was named. `{ buyFee: 0 }` and
     * `{ buyFeePpm: 0 }` are the same free side, and recording them as `n0` and `r0` made SPEC's
     * two runs differ on the one thing they agreed about.
     */
    found.add(value === 0 ? "r0" : share ? `s${String(scaled)}` : ppm === null ? `n${String(value)}` : `r${String(ppm)}`);
  }

  return [...found].sort();
}

/** The meaning-bearing words in a phrase, with everything a model chose freely dropped. */
function tokensOf(text: string): string {
  const NOISE = new Set([
    "the", "a", "an", "and", "or", "of", "to", "for", "on", "in", "is", "are", "be", "this",
    "that", "it", "its", "any", "all", "every", "when", "if", "then", "with", "by", "at", "from",
    "as", "has", "have", "will", "must", "should", "current", "new", "value", "amount", "token",
    "launch", "market", "hook", "swap", "trade", "rule", "state", "set", "using", "into", "each",
  ]);

  return [
    ...new Set(
      text
        // camelCase and snake_case are one word split two ways; both become the same words.
        .replaceAll(/([a-z])([A-Z])/g, "$1 $2")
        .toLowerCase()
        .split(/[^a-z]+/)
        .filter((word) => word.length > 2 && !NOISE.has(word)),
    ),
  ]
    .sort()
    .join("-");
}

/** A behavioural difference between two readings of the same prompt, in words. */
export interface Divergence {
  readonly what: string;
  readonly detail: string;
}

/**
 * Where two readings of the same prompt describe different markets.
 *
 * Empty means equivalent: the two specifications may share not one sentence and still be the same
 * market, which is the normal and acceptable outcome of asking a model twice.
 */
export function divergences(left: Behaviour, right: Behaviour): readonly Divergence[] {
  const found: Divergence[] = [];
  const rate = (ppm: number | null) => (ppm === null ? "none" : `${(ppm / 10_000).toFixed(3)}%`);

  if (left.fees.base !== right.fees.base) {
    found.push({ what: "pool fee", detail: `${rate(left.fees.base)} vs ${rate(right.fees.base)}` });
  }
  if (left.fees.max !== right.fees.max) {
    found.push({ what: "fee ceiling", detail: `${rate(left.fees.max)} vs ${rate(right.fees.max)}` });
  }

  for (const [what, [ours, theirs]] of Object.entries({
    "what a trade does": [left.effects, right.effects],
    phases: [left.phases, right.phases],
    "state transitions": [left.transitions, right.transitions],
  }) as [string, [readonly string[], readonly string[]]][]) {
    const onlyOurs = ours.filter((entry) => !theirs.includes(entry));
    const onlyTheirs = theirs.filter((entry) => !ours.includes(entry));
    if (onlyOurs.length === 0 && onlyTheirs.length === 0) continue;

    found.push({
      what,
      detail: [
        onlyOurs.length === 0 ? "" : `only in the first: ${onlyOurs.join(" | ")}`,
        onlyTheirs.length === 0 ? "" : `only in the second: ${onlyTheirs.join(" | ")}`,
      ]
        .filter((part) => part.length > 0)
        .join("; "),
    });
  }

  /*
   * Order, but only where order is behaviour.
   *
   * Two rules that both charge on the same trigger are evaluated in the order they are listed, and
   * swapping them can change what a trade pays. Two rules on different triggers cannot, and
   * reporting their order as a difference would call every run divergent for nothing.
   */
  if (found.length === 0) {
    const contested = (entries: readonly string[]): readonly string[] =>
      entries.filter((entry) => entry.includes("charge-fee") || entry.includes("waive-fee"));

    const ours = contested(left.order);
    const theirs = contested(right.order);

    if (ours.length > 1 && ours.join(" >> ") !== theirs.join(" >> ")) {
      found.push({
        what: "rule order",
        detail: "the same fee rules are evaluated in a different order",
      });
    }
  }

  return found;
}

/**
 * Where two readings of the same prompt promise different things about it.
 *
 * Reported apart from `divergences` because an invariant is a claim about behaviour rather than
 * behaviour itself: a market that charges 0.5% on sells behaves identically whether or not its
 * specification also asserts that the hook keeps nothing. What changes is how much the build is
 * held to — the suite has to prove every one of these — so a run that promises less is a weaker
 * build of the same market, and worth seeing without it being called a different market.
 */
export function claimDifferences(left: Behaviour, right: Behaviour): readonly Divergence[] {
  const onlyLeft = left.invariants.filter((entry) => !right.invariants.includes(entry));
  const onlyRight = right.invariants.filter((entry) => !left.invariants.includes(entry));

  if (onlyLeft.length === 0 && onlyRight.length === 0) return [];

  return [
    {
      what: "invariants",
      detail: [
        `${String(left.invariants.length)} vs ${String(right.invariants.length)}`,
        onlyLeft.length === 0 ? "" : `only in the first: ${onlyLeft.join(" | ")}`,
        onlyRight.length === 0 ? "" : `only in the second: ${onlyRight.join(" | ")}`,
      ]
        .filter((part) => part.length > 0)
        .join("; "),
    },
  ];
}

/** Whether two readings of one prompt describe the same market. */
export function equivalent(left: MarketSpecification, right: MarketSpecification): boolean {
  return divergences(behaviour(left), behaviour(right)).length === 0;
}
