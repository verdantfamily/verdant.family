/**
 * Failures this project has already met, and what to do about each one.
 *
 * Every entry here was paid for. A market was built, something went wrong, three repair
 * attempts spent themselves rediscovering it from a message that names a symptom rather
 * than a cause, and the build was reported undeployable while the market itself was
 * fine. Four builds went that way in one evening — a stacked `vm.prank`, a pool opened
 * at the wrong fee, a helper called with an unwrapped address, a router that had never
 * been approved — and not one of them was a problem with the mechanic anybody asked for.
 *
 * ## Why recognition is deterministic and the fix usually is not
 *
 * The recognising is a regular expression over a compiler diagnostic or a revert reason,
 * and that part is cheap, certain and free. What follows mostly is not: "you stacked two
 * pranks" has no single edit that fixes it, because where the second one belongs depends
 * on what the test was trying to prove. So an entry carries the remedy as text meant for
 * whoever repairs next — and the point is that the text is *exact*, written once by
 * somebody who understood the failure, rather than inferred again on every build from a
 * message like "cannot overwrite a prank until it is applied at least once".
 *
 * Where a failure genuinely has one mechanical answer, the entry says so with
 * `automatic`, and no model is asked at all. `stack too deep` is the clearest case: the
 * fix is a compiler backend, not a rewrite, and asking a model to shorten a function
 * instead is both slower and worse.
 *
 * ## What belongs here
 *
 * A failure class earns an entry once it has been seen and understood. Not a guess about
 * what might go wrong — an entry for a failure nobody has met is a rule nobody has
 * tested, and it will match something it should not on a build that would otherwise have
 * been repaired correctly. Order matters: the first match wins, so the specific ones come
 * before the general ones.
 */

import type { Diagnostic, TestOutcome } from "./foundry";

/**
 * Which artefact has to change.
 *
 * The distinction is the whole reason a failing test is evidence rather than an
 * instruction. A suite that misuses the harness is a suite to fix; a suite that
 * correctly reports a market charging the wrong fee is a market to fix; and a repairer
 * told the wrong one will change a correct contract until an incorrect test passes,
 * which is the one outcome worse than failing.
 */
export const Blame = {
  /** The generated market is wrong. */
  Contract: "contract",
  /** The generated test is wrong about how to drive the market. */
  Test: "test",
  /** The test misuses AgenTest — a harness call, not the mechanic. */
  HarnessMisuse: "harness_misuse",
  /** Canonical deployment, constructor, wiring or pool setup failed before behavior ran. */
  HarnessInfrastructure: "harness_infrastructure",
  /** Neither: the compiler, the toolchain or the environment. */
  Toolchain: "toolchain",
  /** The market cannot be built as described. A person has to decide something. */
  Specification: "specification",
  Unknown: "unknown",
} as const;

export type Blame = (typeof Blame)[keyof typeof Blame];

/** A fix that needs no model. */
export const AutomaticFix = {
  /** Recompile through the IR backend, which has no stack-slot limit. */
  IrBackend: "ir_backend",
} as const;

export type AutomaticFix = (typeof AutomaticFix)[keyof typeof AutomaticFix];

export interface PlaybookEntry {
  readonly id: string;
  /** What a person would call this failure. Shown to nobody; used in logs and tests. */
  readonly title: string;
  readonly blame: Blame;
  /**
   * Matched against compiler messages and revert reasons. First entry to match wins,
   * so an entry must be specific enough not to claim a failure it cannot explain.
   */
  readonly matches: readonly RegExp[];
  /**
   * Given to the repairer verbatim, ahead of the diagnostics themselves.
   *
   * Written as an instruction rather than an explanation: the repairer does not need to
   * know the history, it needs to know what to write instead.
   */
  readonly remedy: string;
  /** Where the failure has one mechanical answer, the answer. */
  readonly automatic?: AutomaticFix;
  /**
   * True where the failure is a property of the request rather than of the code, so no
   * amount of repairing will help and a person has to decide something.
   */
  readonly terminal?: boolean;
}

/**
 * The entries, most specific first.
 *
 * Grouped by where they are met rather than by severity, because that is the order
 * somebody debugging one of these would want to read them in.
 */
export const PLAYBOOK: readonly PlaybookEntry[] = [
  // --- The compiler ---------------------------------------------------------------

  {
    id: "stack_too_deep",
    title: "Stack too deep",
    blame: Blame.Toolchain,
    matches: [/stack too deep/i],
    automatic: AutomaticFix.IrBackend,
    remedy:
      "Do not restructure the contract for this. It is a limit of the legacy code " +
      "generator, not a fault in the code, and the build retries through the IR " +
      "backend which does not have it.",
  },

  {
    id: "hook_miner_import",
    title: "Imported HookMiner, which is not vendored",
    blame: Blame.Test,
    matches: [/HookMiner/],
    remedy:
      "Delete the HookMiner import and every use of it. It is not in this project's " +
      "vendored tree, and generated behavior tests never deploy hooks. MarketTestBase " +
      "already launches the mined hook through AgenFactory; use its typed hook field.",
  },

  /**
   * Placed above `overload_lookup`, and split out of it, because the two share a phrase
   * and want opposite advice.
   *
   * A PULSE build died on `Member "delta0" not found ... in BalanceDelta` after four
   * repair attempts. Every one of them was handed the overload remedy — wrap the
   * arguments in `Currency`, pass `IHooks` — which is sound guidance for a helper called
   * with bare addresses and no guidance at all for a member that does not exist. The
   * ladder climbed as designed and carried the same wrong answer up every rung, which is
   * the failure mode a playbook has that a bare retry does not: confident misdirection
   * costs more than silence.
   *
   * The real names are listed here rather than described, because the whole cause is a
   * model guessing at them.
   */
  /**
   * The same compiler sentence as `invented_member`, about a different mistake, and it
   * has to be matched first because it is the more specific of the two.
   *
   * A fresh PULSE build asked FeeVault for `feeReceiver()`. The vault has never had one:
   * the fee destination is `owner()`, and what arrived is `credited(currency)`. The
   * reason the model reached for a name that does not exist is that nothing had ever told
   * it the ones that do — the API listing went to the contract generator and not to the
   * test writer, and it omitted public state, which is most of what FeeVault is.
   *
   * That listing is fixed at the source now. This entry is what catches the next one,
   * and its whole job is to say: the contract is right, read the list.
   */
  {
    id: "invented_contract_member",
    title: "Called a method a contract in this build does not have",
    blame: Blame.Test,
    matches: [
      /Member "[^"]+" not found or not visible after argument-dependent lookup in contract/i,
    ],
    remedy:
      "The contract does not have that method and the contract is not what is wrong. " +
      "Agen's own contracts are fixed, and a generated one has already compiled and " +
      "passed its gates, so adding the member to make a test compile is changing a " +
      "working market to match a guess.\n" +
      "Read what it actually offers. Public state is callable: FeeVault keeps the fee " +
      "destination in owner(), what has arrived in credited(currency), what has left in " +
      "withdrawn(currency) — there is no feeReceiver(), recipient() or beneficiary(). " +
      "RewardAccumulator answers pending(account), claimable(account), shares(account) " +
      "and totalShares. EpochAccounting answers currentEpoch(), epochIsDue() and " +
      "epochsElapsed().\n" +
      "If the value you want to assert on has no getter, assert on it indirectly: a " +
      "balance, or an event the contract emits.",
  },

  /**
   * The third way a suite gets an API wrong: the right name, the wrong shape.
   *
   * Worth its own entry because the obvious fix is the wrong one. Solidity permits
   * overloads, so a model asked to make `credit(currency)` compile against
   * `credit(address,uint256)` can add a one-argument version to the contract and every
   * error goes away — leaving a market with a function nobody reviewed, reachable by
   * anyone, doing whatever the test happened to need.
   */
  {
    id: "wrong_arity",
    title: "Called a real method with the wrong arguments",
    blame: Blame.Test,
    matches: [
      /Wrong argument count for function call/i,
      /Exactly \d+ arguments? expected/i,
      /expected \d+ arguments?, but provided/i,
    ],
    remedy:
      "The method exists and the call does not match it. Fix the call. Do not add an " +
      "overload to the contract and do not change the existing signature: both make a " +
      "reviewed market answer to a shape nobody designed, and the second breaks every " +
      "other caller. Check the declaration and pass what it asks for.",
  },

  {
    id: "invented_member",
    title: "Read a field off a Uniswap type that has no fields",
    blame: Blame.Test,
    matches: [/Member "[^"]+" not found or not visible after argument-dependent lookup/i],
    remedy:
      "That member does not exist. Uniswap's types are packed integers rather than " +
      "structs — BalanceDelta is one int256, Slot0 is one bytes32 — so they have " +
      "accessor functions and no fields at all, and .delta0, .amount0 without the " +
      "parentheses, .tick as a field and the like are inventions. The real ones:\n" +
      "    BalanceDelta:     delta.amount0(), delta.amount1()            -> int128\n" +
      "    BeforeSwapDelta:  BeforeSwapDeltaLibrary.getSpecifiedDelta(d)\n" +
      "                      BeforeSwapDeltaLibrary.getUnspecifiedDelta(d)\n" +
      "    Slot0:            slot0.tick(), slot0.lpFee(), slot0.protocolFee()\n" +
      "    Currency:         currency.balanceOf(who), Currency.unwrap(currency)\n" +
      "    PoolKey:          key.toId()\n" +
      "BalanceDelta, Slot0, Currency and PoolKey attach their library globally, so the " +
      "call works from the type alone. BeforeSwapDelta does not: name the library, or " +
      "add `using BeforeSwapDeltaLibrary for BeforeSwapDelta;`.\n" +
      "This is the test's mistake. Do not change the market's contracts to grow the " +
      "field the test asked for.",
  },

  {
    id: "overload_lookup",
    title: "Harness helper called with unwrapped types",
    blame: Blame.HarnessMisuse,
    matches: [/No matching declaration found after argument-dependent lookup/i],
    remedy:
      "The argument types are wrong, not the market. Generated behavior tests inherit " +
      "MarketTestBase and use its typed component fields plus buy, buyAs, sell, sellAs " +
      "and tokenBalance. Do not construct PoolKey values or call the low-level AgenTest " +
      "launch helpers; check the supplied behavior-helper signature.",
  },

  {
    id: "undeclared_identifier",
    title: "Used something the harness does not have",
    blame: Blame.Test,
    matches: [/Undeclared identifier/i, /Identifier not found or not unique/i],
    remedy:
      "The name does not exist. Do not invent a helper and do not reimplement one: use " +
      "only the fields and behavior helpers listed for this build's MarketTestBase. " +
      "Deployment, PoolKey construction, liquidity, wiring, funding and approvals are " +
      "not test APIs. If the name was meant to be a contract of this market, use the " +
      "typed component field already supplied by the base.",
  },

  {
    id: "override_not_virtual",
    title: "Overrode a function the base did not mark virtual",
    blame: Blame.Contract,
    matches: [
      /overriding function is missing "override" specifier/i,
      /Trying to override non-virtual function/i,
      /Overriding function is missing/i,
    ],
    remedy:
      "The base contract decides what may be overridden. Override the hook callback the " +
      "base declares virtual — _beforeSwap, _afterSwap, _afterInitialize and their kin " +
      "on AgenBaseHook — rather than the public IHooks entry point, which is final so " +
      "that the manager's caller check cannot be bypassed.",
  },

  {
    id: "implicit_conversion",
    title: "Type mismatch against a Uniswap type",
    blame: Blame.Contract,
    matches: [
      /Type .* is not implicitly convertible to expected type/i,
      /invalid implicit conversion/i,
    ],
    remedy:
      "Convert explicitly at the boundary rather than changing the surrounding logic. " +
      "Currency wraps an address, PoolId wraps a bytes32, BalanceDelta packs two int128, " +
      "and int24/uint24/uint160 do not widen for free. Check what the function actually " +
      "returns before assuming the arithmetic is wrong.",
  },

  // --- The pool manager, at run time -----------------------------------------------

  {
    id: "manager_locked",
    title: "Called a hook callback outside unlock()",
    blame: Blame.HarnessInfrastructure,
    matches: [/ManagerLocked/],
    remedy:
      "The test called a hook callback directly. Everything that moves value has to " +
      "happen inside manager.unlock(), so a hook that touches the pool manager from a " +
      "directly-invoked callback always reverts this way — the market is not broken. " +
      "Drive it through MarketTestBase.buy/buyAs or sell/sellAs and assert on balances. " +
      "The canonical environment already owns pool initialization, liquidity and settlement.",
  },

  {
    id: "currency_not_settled",
    title: "Took value without a matching delta",
    blame: Blame.Contract,
    matches: [/CurrencyNotSettled/],
    remedy:
      "The hook moved value and did not account for it. Every take() needs a matching " +
      "BeforeSwapDelta or afterSwap delta so the manager's books balance at the end of " +
      "the unlock. Return the delta for what was taken rather than removing the take.",
  },

  {
    id: "hook_address_invalid",
    title: "Hook deployed at an address that does not match its permissions",
    blame: Blame.HarnessInfrastructure,
    matches: [/HookAddressNotValid/, /NotHook\(\)/, /InvalidHookResponse/],
    remedy:
      "The canonical factory deployment mines the hook address from the settled plan. " +
      "Do not change the generated behavior tests or deploy a second hook; report this " +
      "as test infrastructure so the plan/permission parity can be corrected.",
  },

  {
    id: "fee_mode_rejected",
    title: "Pool opened at a fee the hook refuses",
    blame: Blame.HarnessInfrastructure,
    matches: [/InvalidBaseFee/, /InvalidFee\(/, /UnexpectedFee/],
    remedy:
      "The canonical deployment must derive PoolKey.fee from the compiled hook before " +
      "the pool opens. Do not relax the hook and do not construct another PoolKey in a " +
      "test; report this as deployment/test infrastructure.",
  },

  // --- Foundry itself ---------------------------------------------------------------

  {
    id: "prank_overwrite",
    title: "Two vm.pranks with nothing between them",
    blame: Blame.Test,
    matches: [/cannot overwrite a prank until it is applied at least once/i],
    remedy:
      "One vm.prank sets the caller for exactly one external call and must be spent " +
      "before another is set. Either put the call it was meant for immediately after it, " +
      "or use vm.startPrank/vm.stopPrank around the group. MarketTestBase.buyAs and " +
      "sellAs already select the actor internally, so do not wrap those helpers in a prank.",
  },

  {
    id: "missing_allowance",
    title: "Moved tokens through a router that was never approved",
    blame: Blame.HarnessInfrastructure,
    matches: [
      /InsufficientAllowance/,
      /insufficient allowance/i,
      /TRANSFER_FROM_FAILED/,
      /ERC20InsufficientAllowance/,
    ],
    remedy:
      "MarketTestBase owns every standard actor's AgenRouter allowance. Do not add approve " +
      "calls to generated behavior tests and do not weaken transferFrom; report a missing " +
      "allowance from the supplied buy/sell helpers as test infrastructure.",
  },

  {
    id: "unbounded_fuzz_size",
    title: "Fuzzed a trade the market cannot contain",
    blame: Blame.Test,
    matches: [/sell size exceeds what this market can supply/i, /clamp the fuzzed amount/i],
    remedy:
      "A uint128 fuzz parameter is up to 3.4e38 and no market holds that many tokens, so " +
      "the sale asked for cannot happen and nothing about the fee it would have paid can be " +
      "asserted. Clamp the size before trading and assert against what was traded: buy first " +
      "with _tradeSize(size, MIN_TRADE, MAX_TRADE), sell what that bought, and compute the " +
      "expected fee from lastSellTokens rather than from the fuzzed input. This is what the " +
      "read-only core suite does; copy it. Do not use vm.assume to discard the large cases — " +
      "it rejects almost every run and the fuzzer gives up.",
  },

  {
    id: "insufficient_balance",
    title: "Traded with an account holding nothing",
    blame: Blame.Test,
    matches: [/InsufficientBalance/, /transfer amount exceeds balance/i, /ERC20InsufficientBalance/],
    remedy:
      "The launch supply is locked exactly as it is in production, so a seller starts " +
      "with no token. Acquire it through MarketTestBase.buy or buyAs before selling. " +
      "The helpers fund native input themselves; do not transfer launch supply or call vm.deal.",
  },

  // --- Assembling the deployment -----------------------------------------------------

  {
    id: "fee_constraint_unreadable",
    title: "Fee requirement written in a form the launcher cannot read",
    blame: Blame.Contract,
    matches: [
      /cannot be split/i,
      /can decompose/i,
      /constrains the pool's fee in a way Agen cannot read/i,
    ],
    remedy:
      "The hook is correct and the way it states its requirement is not. Agen has to " +
      "know the pool's fee before it opens the pool, so it reads that requirement out of " +
      "the compiled hook, and it can only read a plain one. State it as a single guard " +
      "at the top of the initialize callback, comparing key.fee against one constant:\n" +
      "    if (key.fee != BASE_LP_FEE) revert InvalidBaseFee(key.fee);\n" +
      "Take the fee check out of any compound condition, any ternary and any helper, and " +
      "leave the rest of the callback alone. Do not change which fee the market requires " +
      "— only how the requirement is written. A hook that means to accept the dynamic fee " +
      "should say so with LPFeeLibrary.DYNAMIC_FEE_FLAG.",
  },

  {
    id: "token_sort_order",
    title: "Launched token does not sort above the quote asset",
    blame: Blame.Contract,
    matches: [/sort above/i, /currency0 must be/i, /token must sort/i],
    remedy:
      "A Uniswap pool orders its two currencies by address, and Agen launches every " +
      "market with the quote asset as currency0. The token's address is mined to satisfy " +
      "that, so this means something in the market fixed an address or an ordering of its " +
      "own. Let the deployer place the token and read the ordering from the pool key " +
      "rather than assuming it.",
  },

  {
    id: "constructor_argument",
    title: "Constructor argument the factory cannot supply",
    blame: Blame.Contract,
    matches: [/nothing known about the constructor argument/i],
    remedy:
      "The factory can only supply arguments it knows: the pool manager, the installer, " +
      "the creator, the fee receiver, the launched token and other components of this " +
      "same market. Take the value through one of those, or set it after deployment " +
      "with an onlyInstaller wiring call, rather than asking for it at construction.",
  },

  {
    id: "hook_permission_parity",
    title: "Declared permissions disagree with the mined address",
    blame: Blame.Contract,
    matches: [/permission/i, /getHookPermissions/],
    remedy:
      "getHookPermissions must name exactly the callbacks the contract implements. A " +
      "permission declared and not implemented, or implemented and not declared, gives " +
      "an address the manager reads differently from the code behind it. Make the two " +
      "agree; do not change the address.",
  },
] as const;

/**
 * The first entry that recognises this failure, or `null`.
 *
 * Compiler messages and revert reasons are searched together and deliberately: the same
 * mistake shows up as a diagnostic when the suite will not build and as a revert when it
 * does, and an entry that only matched one of those would miss half its own class.
 */
export function recognise(
  diagnostics: readonly Diagnostic[] = [],
  failingTests: readonly TestOutcome[] = [],
  extra: readonly string[] = [],
): PlaybookEntry | null {
  const text = [
    ...diagnostics.map((d) => `${d.type} ${d.message} ${d.excerpt ?? ""}`),
    ...failingTests.map((t) => `${t.name} ${t.reason ?? ""}`),
    ...extra,
  ];

  if (text.length === 0) return null;

  for (const entry of PLAYBOOK) {
    for (const pattern of entry.matches) {
      if (text.some((line) => pattern.test(line))) return entry;
    }
  }

  return null;
}

/** Every entry recognised, for diagnostics that carry more than one known problem. */
export function recogniseAll(
  diagnostics: readonly Diagnostic[] = [],
  failingTests: readonly TestOutcome[] = [],
  extra: readonly string[] = [],
): readonly PlaybookEntry[] {
  const text = [
    ...diagnostics.map((d) => `${d.type} ${d.message} ${d.excerpt ?? ""}`),
    ...failingTests.map((t) => `${t.name} ${t.reason ?? ""}`),
    ...extra,
  ];

  return PLAYBOOK.filter((entry) =>
    entry.matches.some((pattern) => text.some((line) => pattern.test(line))),
  );
}

/**
 * The remedies, as one block for a repair prompt.
 *
 * Every recognised entry rather than only the first, because a suite that stacked a
 * prank has often also forgotten an allowance, and fixing one at a time costs a whole
 * attempt per mistake out of a budget of three.
 */
export function remedyBrief(entries: readonly PlaybookEntry[]): string | null {
  if (entries.length === 0) return null;

  return [
    "This failure has been seen before. What follows is known to be the cause and the",
    "correct fix; apply it rather than deriving a different one from the message.",
    "",
    ...entries.map((entry) => `${entry.title}:\n  ${entry.remedy}`),
  ].join("\n");
}
