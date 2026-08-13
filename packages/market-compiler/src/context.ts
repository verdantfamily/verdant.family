/**
 * What the generator is told about this repository, as opposed to what it remembers.
 *
 * A model asked to write a Uniswap v4 hook will produce something that looks right and
 * imports `BaseHook` from a path that does not exist here, overrides a callback whose
 * signature changed between v4 release candidates, and returns a fee without the
 * override flag. None of that is stupidity: v4's API moved repeatedly, the training data
 * contains every version of it, and the model has no way to know which one is vendored
 * in this project.
 *
 * So the facts are assembled here and sent every time. The rule is that anything with a
 * version, a path or a signature is stated rather than assumed — and where it can be
 * read off the repository instead of transcribed, it is, because a context file that
 * drifts from the code is worse than no context file: it is confidently wrong.
 *
 * ## Why this is not one long string
 *
 * Different stages need different parts. Planning needs to know what a hook may and may
 * not do; generation needs the import paths and the exact callback signatures; test
 * generation needs the test framework's conventions and the fact that `ffi` is off.
 * Sending all of it to every stage costs tokens and, worse, buries the part that
 * matters for the stage in the part that does not.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { overridePoints, preludeApi, PRELUDE_CONTRACTS, wiredApi } from "./prelude.js";
import { TOOLCHAIN } from "./workspace.js";

export interface ChainFacts {
  readonly name: string;
  readonly chainId: number;
  /** Where the deployed PoolManager lives, when there is one. */
  readonly poolManager: string | null;
  readonly notes: readonly string[];
}

/**
 * Robinhood Chain, as this repository understands it.
 *
 * The `block.number` warning is the one that matters and is easy to get wrong: this is
 * an Arbitrum Orbit chain, so `block.number` is the L1 block and advances roughly a
 * hundred times slower than wall-clock. A generated mechanic counting blocks for a
 * ten-minute window would run for a day.
 */
export const ROBINHOOD: ChainFacts = {
  name: "Robinhood Chain",
  chainId: 4663,
  poolManager: null,
  notes: [
    "This is an Arbitrum Orbit chain. `block.number` is the L1 block number and advances " +
      "far more slowly than wall-clock time, so never use it to measure a duration. Use " +
      "`block.timestamp`.",
    "EIP-1153 transient storage is available; Uniswap v4 is deployed here and depends on it.",
    "The maximum gas for a single transaction is 32 million, and a market launch already " +
      "spends around 4 million of it.",
  ],
};

export interface ContextOptions {
  /** `packages/contracts/vendor`, so import paths can be verified rather than recalled. */
  readonly vendorRoot: string;
  readonly chain?: ChainFacts;
}

/**
 * The import paths a generated contract may use.
 *
 * Stated as a list because the remappings in a job workspace are not the ones a model
 * has seen elsewhere: `v4-core/src/...` here is `@uniswap/v4-core/contracts/...` in
 * older material, and an import that does not resolve costs a whole repair round to
 * discover.
 */
/**
 * The mistakes that actually cost repair rounds.
 *
 * Each line here is a compiler error a live build hit, sent back to the model, and paid a
 * repair round to fix. They are v4 facts rather than reasoning failures — the model
 * cannot know which version of a fast-moving library it is compiling against — so they
 * are cheaper to state once than to discover three times per build.
 */
export const V4_GOTCHAS = `
The compiler is Solidity ${TOOLCHAIN.solcVersion} exactly, pinned to match the vendored v4 tree
and Agen's audited contracts. Language features added after it do not exist here, and the
parser's complaint when you use one does not mention versions — a generated hook declared
\`bytes32 private transient x;\` and spent three repair rounds on "Expected ';' but got
identifier". Transient state variables need 0.8.28. For per-transaction scratch state,
use a normal storage variable and clear it before the call returns, which refunds most of
the cost and works everywhere.

This v4 commit specifically, where a reasonable guess is wrong:

  - toBeforeSwapDelta(deltaSpecified, deltaUnspecified) is a FREE FUNCTION, not a member
    of BeforeSwapDeltaLibrary. Import it by name from v4-core/src/types/BeforeSwapDelta.sol.
    BeforeSwapDeltaLibrary provides ZERO_DELTA, getSpecifiedDelta and getUnspecifiedDelta.
  - Currency and PoolId are user-defined value types. \`==\` works; \`!=\` does not.
    Compare with Currency.unwrap(a) != Currency.unwrap(b) or PoolId.unwrap(a) != PoolId.unwrap(b).
  - There is no afterSwapReturnHookDelta field on Hooks.Permissions. The field for taking
    value in afterSwap is afterSwapReturnDelta.
  - int128 does not convert directly to uint256. Widen first, then cast:
    uint256(int256(value)), having checked the sign.
  - Interfaces cannot be declared inside a contract body. Declare them at file scope, or
    import the one that already exists.
`.trim();

export const IMPORTS = [
  { path: "v4-core/src/interfaces/IHooks.sol", provides: "IHooks" },
  { path: "v4-core/src/interfaces/IPoolManager.sol", provides: "IPoolManager" },
  { path: "v4-core/src/libraries/Hooks.sol", provides: "Hooks (including Hooks.Permissions)" },
  { path: "v4-core/src/libraries/LPFeeLibrary.sol", provides: "LPFeeLibrary.OVERRIDE_FEE_FLAG" },
  { path: "v4-core/src/types/PoolKey.sol", provides: "PoolKey" },
  { path: "v4-core/src/types/PoolId.sol", provides: "PoolId, PoolIdLibrary" },
  { path: "v4-core/src/types/BalanceDelta.sol", provides: "BalanceDelta" },
  {
    path: "v4-core/src/types/BeforeSwapDelta.sol",
    provides: "BeforeSwapDelta, BeforeSwapDeltaLibrary.ZERO_DELTA",
  },
  { path: "v4-core/src/types/PoolOperation.sol", provides: "SwapParams, ModifyLiquidityParams" },
  { path: "v4-core/src/types/Currency.sol", provides: "Currency, CurrencyLibrary" },
  { path: "forge-std/Test.sol", provides: "Test, assertEq, vm (tests only)" },
] as const;

/**
 * The callback signatures, exactly.
 *
 * Written out because getting one wrong does not fail loudly at the point of the
 * mistake: Solidity happily compiles a function that does not match `IHooks`, and the
 * result is a hook the PoolManager calls and reverts against on the first swap.
 */
export const HOOK_SIGNATURES = `
function beforeInitialize(address sender, PoolKey calldata key, uint160 sqrtPriceX96)
    external returns (bytes4);

function afterInitialize(address sender, PoolKey calldata key, uint160 sqrtPriceX96, int24 tick)
    external returns (bytes4);

function beforeAddLiquidity(
    address sender, PoolKey calldata key, ModifyLiquidityParams calldata params, bytes calldata hookData
) external returns (bytes4);

function beforeSwap(
    address sender, PoolKey calldata key, SwapParams calldata params, bytes calldata hookData
) external returns (bytes4, BeforeSwapDelta, uint24);

function afterSwap(
    address sender, PoolKey calldata key, SwapParams calldata params, BalanceDelta delta, bytes calldata hookData
) external returns (bytes4, int128);
`.trim();

/**
 * The facts about swaps that every market mechanic depends on.
 *
 * `zeroForOne` is the one worth stating twice. Whether it means a buy or a sell depends
 * on which currency sorted lower, and a hook that assumes the wrong direction implements
 * every rule backwards while compiling perfectly and passing any test that made the same
 * assumption.
 */
export const SWAP_SEMANTICS = `
A Verdant pool is (currency0 = quote asset, currency1 = the launched token), because the
factory requires the token's address to sort above the quote asset. Therefore:

  params.zeroForOne == true   spends the quote asset to receive the token: a BUY.
  params.zeroForOne == false  spends the token to receive the quote asset: a SELL.

params.amountSpecified is negative for an exact-input swap and positive for exact-output.
Take its absolute value before comparing it to anything.

Returning a fee from beforeSwap requires the override flag:
    return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA,
            feePpm | LPFeeLibrary.OVERRIDE_FEE_FLAG);
Without OVERRIDE_FEE_FLAG the pool keeps its stored fee and the rule silently does nothing.

Fees are in hundredths of a basis point: 10_000 is 1%, 5_000 is 0.5%.
`.trim();

/**
 * How a hook takes value, which is the hardest thing a generated market has to do.
 *
 * Every mechanic past a dynamic fee — jackpots, buyback reserves, reward pools, round
 * prizes — needs part of a trade diverted into a contract that holds it. A hook that
 * only increments a counter has built a ledger, not a market: the number goes up and
 * nobody can withdraw anything.
 *
 * Written out in full, with the sign conventions and the exact-output case, because
 * this is where a model working from memory of older v4 will produce something that
 * compiles and reverts. The two details that are counter-intuitive — that an
 * exact-input trader pays no extra, and that the delta and the `take` must agree or the
 * whole swap fails at settlement — are stated rather than implied, and both were
 * learned by getting them wrong in a test rather than by reading the documentation.
 */
export const CUSTODY = `
To take value from a trade, a hook needs the beforeSwapReturnDelta permission and must do
two things that agree with each other:

  1. poolManager.take(currency, recipient, amount)
     Moves the currency out of the manager to the recipient, and records that the hook
     now owes the manager that amount.

  2. Return a BeforeSwapDelta that covers the debt.
     toBeforeSwapDelta(deltaSpecified, deltaUnspecified). A positive value means the hook
     is owed that much of that currency.

If the two do not cancel, the swap reverts inside the manager with CurrencyNotSettled,
which is a confusing failure a long way from its cause.

Which side carries the fee depends on how the swap was specified:

  exact input  (params.amountSpecified < 0)
    The specified currency IS the input currency. Charge on deltaSpecified:
        fee = uint256(-params.amountSpecified) * feePpm / 1_000_000;
        poolManager.take(input, address(vault), fee);
        return (selector, toBeforeSwapDelta(int128(int256(fee)), 0), lpFee | OVERRIDE_FEE_FLAG);

    Note what this does to the trader, because the obvious reading is wrong: they pay
    exactly what they specified and NOT a penny more. The fee is carved out of it, and
    the remainder is what reaches the pool. What they lose is output, not extra input.

  exact output (params.amountSpecified > 0)
    The specified currency is the OUTPUT. Charging there would change the amount the
    trader asked for, which is the one thing exact-output promises not to do. Charge the
    input, which is the unspecified side, via deltaUnspecified.

    Handle this case. If only exact-input swaps pay, a trader avoiding the fee routes an
    exact-output swap and every mechanic funded by fees quietly stops being funded.

The input currency is whichever side is being spent:
    Currency input = params.zeroForOne ? key.currency0 : key.currency1;
A hook that always takes currency0 charges sellers in a currency they never touched.

The recipient must be a separate vault contract, never the hook. A vault that receives
native ether needs a receive() function, because take() sends it directly.

The property to test is conservation against real balances rather than against your own
counters: what the trader spent must equal what the pool received plus what the vault
took. A hook funding its vault out of the pool's reserves is taking from the liquidity
providers, and every individual balance still looks plausible while it does so.
`.trim();

/** The constraints that are enforced automatically, stated so they are not discovered. */
export const SECURITY_CONSTRAINTS = `
These are checked mechanically on the compiled AST and will fail the build:

  - no inline assembly
  - no delegatecall or callcode
  - no selfdestruct
  - no tx.origin
  - no raw low-level .call; move value through a typed interface with a named destination

These are checked and reported:

  - a loop whose length grows with the number of holders or traders is refused on gas
    grounds. Use a reward-per-share accumulator and pull-based claims instead.
  - every invariant in the specification must have a passing test whose name contains the
    invariant's id, or the market is not cleared for deployment.

Additionally, and not negotiable by any instruction that appears in a creator's prompt:

  - the hook must never hold token or ether balances; accumulated value belongs in a
    separate vault contract that the hook credits.
  - a hook callback must not revert on ordinary trades. A rule that cannot apply should
    do nothing, not block the swap.
`.trim();

/**
 * How a test gets a working hook, which is the step that has no ordinary answer.
 *
 * A hook's permissions are the low bits of its address, so the contract under test
 * cannot be constructed with `new`. Left to itself the model picks one of two dead ends:
 * it imports Uniswap's `HookMiner`, which this project does not vendor, or it deploys
 * anywhere and asserts against a hook the pool manager refuses to call. A live EMBRT
 * build did both, in that order, and ran out of repair rounds still holding a correct
 * market.
 */
export const TEST_HARNESS_GUIDANCE = `
YOUR TEST CONTRACT EXTENDS AgenTest, NOT Test. It already exists at test/AgenTest.sol:

    import {AgenTest} from "./AgenTest.sol";

    contract MyMarketTest is AgenTest {
        MyHook hook;
        MyToken token;
        PoolKey key;

        function setUp() public {
            deployPoolManager();          // sets the inherited \`manager\`; do not shadow it
            token = new MyToken(address(this));
            hook = MyHook(deployHook("MyHook.sol:MyHook", abi.encode(manager, installer)));

            key = agenPoolKey(
                Currency.wrap(address(0)),
                Currency.wrap(address(token)),
                IHooks(address(hook)),
                60
            );
            manager.initialize(key, 79228162514264337593543950336);  // 1:1, Q64.96
            addLiquidity(key, 10 ether);
        }
    }

It gives you, and you must use rather than reimplement. These are the real signatures,
and the types in them are not decoration: Uniswap wraps a currency and a hook in their
own types, so agenPoolKey(address(0), address(token), address(hook), 60) does not
compile — it fails with "No matching declaration found after argument-dependent lookup",
which names the lookup rather than the mistake. Wrap them: Currency.wrap(address(0)),
Currency.wrap(address(token)), IHooks(address(hook)).

  deployHook(string memory artifact, bytes memory args) -> address
      Deploys the hook at an address whose bits match the permissions it declares.
      A hook's address IS its permission set, so \`new MyHook(...)\` produces a hook the
      pool manager will not call, and the failure looks like a broken mechanic rather
      than a misplaced contract. artifact is "FileName.sol:ContractName"; args is
      abi.encode(...) of the constructor arguments, or "" when there are none.
      NEVER import HookMiner. It is not in this project's vendored tree and a test that
      imports it does not compile.

  deployPoolManager() internal -> IPoolManager
      The real Uniswap PoolManager, plus swapRouter and liquidityRouter. Do NOT write a
      fake one: IPoolManager is large, a partial implementation is rejected as abstract,
      and one that compiles agrees with your hook about behaviour neither has checked
      against v4.

WIRE THE COMPONENTS IN setUp, THE WAY THE DEPLOYMENT WILL.

At launch the factory deploys every component and then makes the wiring calls that let
them recognise each other, because two contracts that each need the other's address
cannot both learn it at construction. Your setUp is that deployment, so it has to make
the same calls — nothing does it for you.

A vault is the usual case. FeeVault starts with no hook and rejects every caller until it
is given one:

    vault = new FeeVault(creator);
    hook = MyHook(deployHook("MyHook.sol:MyHook", abi.encode(manager, address(vault))));
    vault.setHook(address(hook));          // <- without this line every swap reverts

Skip it and the market looks broken in a way that says nothing about the market: the swap
fails inside beforeSwap, v4 wraps the failure, and the whole suite reports
\`WrappedError(0x…, 0x575e24b4, 0xa570b990…, 0xa9e35b2f)\` — which is
\`NotHook\` raised by the vault, nested two deep and spelled in hex. A live build lost
three repair rounds to exactly that. Wire it in setUp and the tests describe the mechanic
instead.

DO NOT REDECLARE ANYTHING AgenTest ALREADY HAS.

Your contract inherits these. Writing your own version of one does not replace it, it
collides with it, and solc rejects the file with "Overriding function is missing
\`override\` specifier" — a compile error about inheritance in a suite whose actual
problem is that a helper was rewritten instead of called. These names are taken:

    deployHook   deployPoolManager   addLiquidity   swapExactIn
    agenPoolKey  approveSwapRouter   permissionFlags
    manager      swapRouter          liquidityRouter

Call them. If one does not do what your market needs, work around it in your test body
rather than shadowing it — a redefined helper is a compile failure, and a redefined
helper marked \`override\` is worse, because it silently replaces the one thing standing
between your test and v4's locking rules.

THE TEST CONTRACT MUST HOLD THE SUPPLY.

The generated token mints its entire supply to one recipient named at construction. At
launch that is the factory, which puts it straight into locked liquidity. In a test there
is no factory, so the recipient has to be the test itself:

    token = new MyToken(address(this));    // NOT the factory, NOT address(0)

The test is what adds the liquidity and what funds the wallets it pranks, so a suite that
names anything else holds nothing and dies in setUp with
\`InsufficientBalance(0, …)\` before a single assertion runs.

  addLiquidity(PoolKey memory key, int256 amount)
  swapExactIn(PoolKey memory key, bool zeroForOne, uint256 amount) -> BalanceDelta
      How a test exercises the market. NEVER call hook.beforeSwap(...) or
      hook.afterSwap(...) directly — two reasons, and the first one is fatal:

        1. Everything that moves value must happen inside manager.unlock(). A hook
           calling poolManager.take() from a directly-invoked callback reverts with
           ManagerLocked, and the test reports it as a broken market.
        2. A direct call skips settlement, which is exactly where a hook that takes
           value goes wrong. take() without a matching BeforeSwapDelta reverts the swap
           inside the manager with CurrencyNotSettled — a real swap finds that and an
           arithmetic check never can.

      So: initialize the pool, addLiquidity, then swapExactIn, then assert on balances.
      zeroForOne == true spends currency0, which in an Agen pool is a BUY.

      The BalanceDelta it returns is a packed pair, not a struct: read it with
      delta.amount0() and delta.amount1(). There is no .delta0 and no .delta1.

      A pool with no liquidity fills nothing, so a suite that skips addLiquidity sees
      every fee come back zero and concludes the mechanic does not work.

      addLiquidity grants the test contract's own allowances to both routers, so do not
      write approve() for the test contract — it is already done, in setUp, before you
      could need it.

  approveSwapRouter(address trader, Currency currency)
      The allowance for a swap made by somebody else. A test that does
      vm.prank(trader); swapExactIn(...) still needs the trader to have approved the
      router, and the trader is not the test contract. Call this first, then prank and
      swap. Do not hand-roll it as vm.prank(trader); token.approve(...) immediately
      before another prank — that is two pranks in a row and fails.

  agenPoolKey(Currency quote, Currency token, IHooks hook, int24 tickSpacing) -> PoolKey
      Built in Agen's order, quote below token, with the dynamic-fee flag set.

  agenPoolKey(Currency quote, Currency token, IHooks hook, int24 tickSpacing, uint24 fee)
      -> PoolKey
      The same, at a stated fee, for a hook that requires a fixed one.

  DYNAMIC_FEE
      What a pool's fee must be for a hook's returned fee to take effect. A pool
      initialised with a fixed fee such as 3000 ignores beforeSwap's fee entirely, and a
      test that does this reports every dynamic-fee market as returning nothing.

Open the pool at the fee the hook under test actually demands, which is not always the
dynamic one. A hook whose afterInitialize checks key.fee against a constant of its own
must be given that constant through the five-argument form; handed DYNAMIC_FEE it
reverts in setUp before a single rule has been exercised, and no amount of repairing the
test can satisfy it. Agen launches such a market perfectly well — the build works out
the fee the pool needs and opens it that way — so a suite that cannot express it is
testing something the deployment will never be.

When a hook takes value, the vault must be wired to it before any swap — the vault
rejects an uninitialised hook, and a suite that skips this sees NotHook on every test
and concludes the market cannot collect fees.
`.trim();

/**
 * The accessors on Uniswap's value types, listed because they cannot be guessed.
 *
 * Every one of these is `type X is int256` or `type X is bytes32` — a single packed
 * integer wearing a name, with a library of functions that shift bits out of it. Nothing
 * about the call site says so. `delta.amount0()` looks exactly like a struct field read
 * with parentheses on it, which is why a model that has never seen the declaration writes
 * `delta.delta0` and gets a message naming argument-dependent lookup, a Solidity concept
 * that has nothing to do with the mistake.
 *
 * A PULSE build spent four repair rounds on precisely that. The names are cheap to state
 * and impossible to derive, so they are stated — to the generator as well as the test
 * writer, because a hook reads its own swap deltas the same way.
 */
export const VALUE_TYPE_ACCESSORS = `
Uniswap's value types are packed integers, not structs. They have no fields, only
library functions, and inventing a field produces "Member ... not found or not visible
after argument-dependent lookup" — which names the lookup rule rather than the mistake.
The complete set you may use:

  BalanceDelta        delta.amount0()  delta.amount1()            -> int128
                      the two sides of a swap or a liquidity change. Signed: negative is
                      paid in, positive is taken out, from the caller's point of view.

  BeforeSwapDelta     BeforeSwapDeltaLibrary.getSpecifiedDelta(d)  -> int128
                      BeforeSwapDeltaLibrary.getUnspecifiedDelta(d)
                      Build one with toBeforeSwapDelta(specified, unspecified).

  Slot0               slot0.tick()  slot0.lpFee()  slot0.protocolFee()
                      sqrtPriceX96 comes back beside it from StateLibrary, not from here.

  Currency            currency.balanceOf(who)  currency.balanceOfSelf()
                      currency.isAddressZero()  Currency.unwrap(currency) -> address
                      Currency.wrap(address)   -> Currency

  PoolKey             key.toId() -> PoolId. PoolKey is a real struct, so key.fee,
                      key.tickSpacing, key.currency0, key.currency1 and key.hooks are
                      fields and are read directly.

BalanceDelta, Slot0, Currency and PoolKey attach their libraries globally: importing the
type is enough for the call. BeforeSwapDelta does not — name the library, or add
\`using BeforeSwapDeltaLibrary for BeforeSwapDelta;\` at file scope.
`.trim();

/**
 * How a market learns which wallet is trading.
 *
 * The single most consequential thing a generated hook can get wrong, because getting it
 * wrong does not fail: a streak that counts the router's trades compiles, deploys, passes
 * its own tests and awards its jackpot to a contract. So the rule is stated as a rule
 * rather than as an option, and the two helpers are described by the question they
 * answer rather than by their signatures.
 */
export const TRADER_IDENTITY = `
WHO IS TRADING. Uniswap tells a hook the *caller*, and for any trade through a router
that is the router — the same address for every wallet in the world. A market that
counts a wallet's buys, rewards a holder, tracks a streak or applies a per-wallet
cooldown cannot be built on that, and will not fail while getting it wrong: it compiles,
deploys, passes its tests, and credits everything to one contract.

Agen's answer is AgenRouter, which writes the trader into the trade, plus AgenRouted,
which reads it only after checking the trade came from that router. Both are already in
contracts/. Inherit AgenRouted; never decode hookData yourself, and never trust an
address out of it without the check — hookData is a field anyone can fill, so a hook
that trusts it unconditionally is a faucet.

    import {AgenRouted} from "./AgenRouted.sol";

    contract MyHook is AgenBaseHook, AgenRouted {
        constructor(IPoolManager poolManager_, address agenRouter_)
            AgenBaseHook(poolManager_)
            AgenRouted(agenRouter_)
        {}
    }

Name the constructor argument agenRouter_ and the deployment supplies the real address.
NEVER hardcode one: an address written into generated Solidity is wrong on every chain
but the one it was copied from, and immutable once deployed.

The two ways to ask, and the choice is about the mechanic:

  _requireTrader(sender, hookData) -> address
      The trader, or the trade reverts. Use this whenever attributing a trade to the
      wrong address would corrupt what the market means: per-wallet counters, streaks,
      largest-buyer, wallet cooldowns, per-user volume, holder rewards, anything whose
      state is keyed by an address. Such a market trades only through AgenRouter. That is
      correct, not a limitation.

  _traderOr(sender, hookData) -> address
      The trader if the trade named one, otherwise the caller. Use this when the market
      prefers an identity but stays correct without one — a fee charged the same either
      way, a global counter of trades, an accumulating pool with no wallet attribution.
      A market using this keeps trading through any router.

  _tradeExtra(sender, hookData) -> bytes calldata
      The market's own data, when a trade carried any. Empty otherwise. Only for a
      mechanic that genuinely needs a parameter per trade; most do not.

A market that needs neither should inherit neither. Do not add AgenRouted to a hook whose
rules are global — an unused base is a constructor argument the deployment has to supply
and a reader has to account for.
`.trim();

export const TEST_CONVENTIONS = `
Tests are Foundry tests using forge-std. Conventions:

  - one contract per file under test/, named <Thing>Test, inheriting AgenTest
  - setUp() constructs the contracts under test
  - test_* for unit tests; testFuzz_* for fuzz tests; invariant_* for invariant tests
  - assertEq, assertLe, assertGe, assertTrue; vm.warp for time, vm.prank for callers
  - vm.ffi is DISABLED and any test using it will fail
  - bound(x, min, max) to constrain fuzz inputs rather than vm.assume where possible

One vm.prank sets the caller for exactly one external call, and setting a second before
the first has been spent fails the test with "cannot overwrite a prank until it is
applied at least once". So do not stack them, and do not open one before a block that
makes no external call at all. Where several calls need the same caller, use
vm.startPrank and vm.stopPrank around them. Note that calling a helper on this contract
— deployHook, addLiquidity, swapExactIn — does not consume the prank by itself: the
first external call the helper makes does, and every call after that is back to being
made by the test.

For every invariant in the specification, write a test whose name contains the
invariant's id in some recognisable form, because a claimed invariant with no test
bearing its id blocks deployment.
`.trim();

export interface CuratedContext {
  /** For planning: what a market may be made of and what the hook may not do. */
  readonly architecture: string;
  /** For code generation: imports, signatures, semantics, constraints. */
  readonly generation: string;
  /** For test generation. */
  readonly testing: string;
}

/**
 * Build the context, checking the parts that can be checked.
 *
 * The import list is verified against the vendored tree rather than trusted. A path that
 * has moved is exactly the failure this file exists to prevent, and discovering it here
 * — at build time, in one place — is better than discovering it once per generated
 * market in a repair loop.
 */
/**
 * How a market finishes assembling itself, and the two ways generation gets it wrong.
 *
 * Given to the planner and to the generator both. It started life in the architecture
 * context alone, which was the reason a hook could be planned correctly — "wire the vault
 * through an installer-only one-time setter", in the plan, in those words — and then
 * written by a generator that had never been told AgenWired existed. It inherited the
 * base without calling its constructor and referred to a member it had invented.
 *
 * A planner deciding to use something and a generator knowing how are different needs,
 * and the seam between two context sections is exactly where that gets lost.
 */
function wiringGuidance(): string {
  return `WIRING TWO CONTRACTS THAT NEED EACH OTHER. Constructor arguments cannot do it in both
directions: an argument is part of the init code, the init code determines the CREATE2
address, so each address would have to be known before the other. One side is therefore
told afterwards, by the factory, through a setter.

AgenWired is exactly this, and has nothing else on it:

${wiredApi()}

So the setter is written:

    contract MyHook is AgenBaseHook, AgenWired {
        FeeVault public feeVault;

        constructor(IPoolManager manager, address installer_)
            AgenBaseHook(manager) AgenWired(installer_) {}

        function setFeeVault(address vault) external onlyInstaller {
            _wireOnce(address(feeVault));
            feeVault = FeeVault(vault);
        }
    }

Both base constructors must be called — a generated hook that inherited AgenWired and
passed it nothing did not compile, and a repair round then invented a member called
\`wired\` that does not exist. The names above are all there are.

Never leave it permissionless. "Callable only once" is not a guard, it is the whole
attack: until the factory calls it the slot is unclaimed, and whoever claims it keeps it
forever. A generated market shipped a permissionless setFeeVault on exactly this
reasoning, and anybody watching the mempool could have redirected every fee that market
would ever collect.

A HOOK CANNOT BE TOLD ITS OWN POOL. Do not take a PoolId or a PoolKey as a constructor
argument: the id is derived from the key, the key names the hook, and the hook is the
contract being constructed, so the value cannot exist when it would be needed. A
generated hook asked for a \`bytes32 designatedPoolId_\` and was undeployable for this
reason after passing every other check. Take the pool as it arrives in each callback. If
the market must be bound to exactly one pool, record the first key seen in
afterInitialize and reject any other thereafter.`;
}

export async function buildContext(options: ContextOptions): Promise<CuratedContext> {
  const chain = options.chain ?? ROBINHOOD;
  const verified = await verifyImports(options.vendorRoot);
  const structs = await structShapes(options.vendorRoot);
  const WIRING = wiringGuidance();

  // The exact callable surface of Agen's contracts. A market that calls one of them
  // through an interface it declared itself compiles whether or not the function is
  // really there, and the first thing that notices is a deployment.
  const PRELUDE_API = `
WHAT AGEN'S CONTRACTS ACTUALLY EXPOSE. These are the only functions on them. If you need
something else, your contract implements it — do not declare a local interface with the
method you wish existed and cast to it. That compiles and then reverts on a live chain: a
generated market called release(address,uint256) on the fee vault, which offers
withdraw(address,address,uint256), and its reward was uncollectable.

${preludeApi()}`.trim();

  const importList = verified
    .map((entry) => `  import from "${entry.path}"  ->  ${entry.provides}${entry.exists ? "" : "  [MISSING]"}`)
    .join("\n");

  const chainNotes = chain.notes.map((note) => `  - ${note}`).join("\n");

  const architecture = `
AGEN PROVIDES THESE CONTRACTS ALREADY. Compose from them first and design something new
only when the mechanic genuinely needs it. They are acceleration, not a menu: a market
that needs a contract nobody anticipated should have one generated.

  AgenBaseHook       every hook extends it. Pins the v4 imports and callback signatures,
                     and restricts every entry point to the pool manager.
  FeeVault           holds value a hook diverts, per currency, with a credited ledger and
                     an owner-restricted withdrawal. Use for jackpots, buyback reserves,
                     prize pools — anything that accumulates.
  RewardAccumulator  reward-per-share with pull-based claims. Use whenever value is owed
                     to many wallets in proportion to something they did. Never loop over
                     holders; that stops working exactly when the market succeeds.
  EpochAccounting    fixed-length periods that close lazily, and correctly when several
                     have elapsed. Use for rounds, hours, seasons.
  OracleAdapter      an external price with a staleness bound and a stated failure
                     behaviour. readPrice never reverts.
  KeeperAdapter      permissionless upkeep with a minimum interval, for work that needs
                     an outside trigger.
  AgenWired          inherit it in any contract that has to be told an address after
                     deployment. Gives you an immutable installer, an onlyInstaller
                     modifier and _wireOnce.
  AgenRouted         inherit it in the hook when any rule is keyed by a wallet. See
                     below; this is a decision to make now rather than during coding.

DOES THIS MARKET NEED TO KNOW WHICH WALLET IS TRADING?

Decide it in the plan, because it changes the hook's constructor and cannot be added
afterwards. A hook is told which contract called the pool manager, not which wallet is
behind it, and for every routed trade that is one shared address. So:

  Needs it — any rule keyed by a wallet. Per-wallet counters, streaks, consecutive buys
  by the same buyer, wallet cooldowns, largest buyer, per-user volume, holder-specific
  rewards, "the same wallet", "each buyer", "in a row". Give the hook AgenRouted and an
  agenRouter_ constructor argument, and say so in the component's implementationNotes.

  Does not need it — rules that are true of the market rather than of a trader. A global
  sell fee, a total trade counter, a timer or epoch, a pool that accumulates without
  attributing to anybody. Do not inherit AgenRouted for these: it is a constructor
  argument and a base class for nothing.

Getting this wrong in the first direction is the expensive one. A per-wallet mechanic
built without an identity compiles, deploys, passes its tests and quietly attributes
every trade in the market to one router.

The creator is never asked about this. It follows from what they described.

In the plan, name a component "reused" in its implementationNotes when it is one of
these, and describe only what your market adds on top.

${WIRING}


This market is built on Uniswap v4 on ${chain.name} (chain ${String(chain.chainId)}).

${chainNotes}

A market is a bundle of contracts, not necessarily one:

  - exactly one hook, which the pool names and which observes swaps. Uniswap reads the
    hook's permissions from the low bits of its ADDRESS, so the callbacks declared in
    getHookPermissions are the callbacks that will exist. Declaring one you do not
    implement makes swaps revert; omitting one you rely on makes the rule silently never
    run.
  - a vault for any value that accumulates, because the hook must not hold balances.
  - an accounting contract with a claim function for anything owed to many wallets.
  - an adapter for any input the pool cannot know by itself, with an explicit policy for
    what happens when it is stale or unavailable.

Contracts are deployed by AgenFactory from a manifest, in dependency order, using CREATE2
so every address is known before anything is sent. A contract that needs the address of
another may take it as a constructor argument only if that other contract is deployed
first; a genuine cycle is broken by predicting the address instead.
`.trim();

  const generation = `
Solidity ${TOOLCHAIN.solcVersion}, EVM ${TOOLCHAIN.evmVersion}, optimizer on with ${String(
    TOOLCHAIN.optimizerRuns,
  )} runs.
Files go under contracts/. One contract per file, named after the contract.

THE HOOK MUST EXTEND AgenBaseHook, which already exists at contracts/AgenBaseHook.sol.
Do not write it, do not import Uniswap's IHooks yourself, and do not reimplement the
callbacks. It pins the import paths and signatures for the exact v4 commit this project
builds against — guessing at those is the single most common way generated markets fail
to compile, and it costs a repair round every time.

    import {AgenBaseHook} from "./AgenBaseHook.sol";

    contract MyHook is AgenBaseHook {
        constructor(IPoolManager manager) AgenBaseHook(manager) {}

        function getHookPermissions() public pure override returns (Hooks.Permissions memory) { ... }

        function _beforeSwap(address, PoolKey calldata key, SwapParams calldata params, bytes calldata)
            internal override returns (BeforeSwapDelta, uint24)
        { ... }
    }

Override only these, whichever your market needs, and declare exactly those in
getHookPermissions. These are the internal override points and they are NOT the external
callback signatures — an override that returns the callback's bytes4 selector does not
compile. Copy them as written:

${overridePoints()
  .map((point) => `    ${point}`)
  .join("\n")}

Every entry point is already restricted to the pool manager, so do not add your own caller
check to the callbacks.

${V4_GOTCHAS}

AgenBaseHook also provides isBuy(params), swapAmount(params), inputCurrency(key, params)
and takeInto(currency, recipient, amount). Use them rather than rewriting them.

Available imports, as remapped in this workspace:

${importList}

Hook callback signatures, exactly as IHooks declares them:

${HOOK_SIGNATURES}

${SWAP_SEMANTICS}

${VALUE_TYPE_ACCESSORS}

${TRADER_IDENTITY}

${CUSTODY}

${WIRING}

${PRELUDE_API}

${SECURITY_CONSTRAINTS}
`.trim();

  const testing = `
${TEST_CONVENTIONS}

${TEST_HARNESS_GUIDANCE}

${VALUE_TYPE_ACCESSORS}

The contracts under test are in contracts/ and import as "../contracts/<Name>.sol".

${PRELUDE_API}

A test asserts against Agen's contracts more often than a market calls them — custody is
checked by reading the vault, not by trusting the hook — so the list above is the one
thing a suite cannot guess at. The fee destination is FeeVault's owner(); what arrived is
credited(currency); what has left is withdrawn(currency); the balance is the vault's own.
There is no feeReceiver(), no recipient(), no beneficiary(). If the assertion you want
needs a getter that is not listed, assert on a balance or an event instead.

${structs}

A helper contract that inherits one of the market's contracts inherits everything its
bases declare, including Agen's. Do not declare an error, event or function on such a
helper without checking the name is free — ${PRELUDE_CONTRACTS.join(", ")} are in that
chain. Solidity reports a redeclaration at the inherited declaration, so the error names
a file you cannot edit and the fix is always to rename yours. A live build lost three
repair rounds to a test wrapper declaring \`error NotPoolManager()\` when AgenBaseHook
already had one; prefix test-local names, as in \`error TestNotPoolManager()\`.

${SWAP_SEMANTICS}
`.trim();

  return { architecture, generation, testing };
}

interface VerifiedImport {
  readonly path: string;
  readonly provides: string;
  readonly exists: boolean;
}

/**
 * Check each import resolves in the vendored tree.
 *
 * Mirrors the remapping rules in `workspace.ts`. A missing path is reported rather than
 * thrown on: the vendored tree is fetched by a script and may legitimately be absent on
 * a fresh clone, and a context builder that refuses to produce anything in that case
 * turns a missing optional dependency into a broken package.
 */
/**
 * The v4 structs a test has to build, quoted from the vendored source.
 *
 * Read rather than written down. These are the shapes a generated test gets wrong most
 * often, and they are wrong in a way nothing catches until the suite fails to compile:
 * a live build produced `SwapParams` with a `recipient` field, which v4 has not had for
 * some time but every older example on the internet still shows. Describing them here by
 * hand would work until the vendored commit moved and then be a confident lie, so the
 * text comes out of the files the compiler will use.
 *
 * Returns an empty string when the tree is absent, which is legitimate on a fresh clone
 * before the vendor script has run. A missing section is better than a made-up one.
 */
async function structShapes(vendorRoot: string): Promise<string> {
  const core = join(vendorRoot, "v4-periphery", "lib", "v4-core", "src", "types");

  const wanted: readonly { readonly file: string; readonly names: readonly string[] }[] = [
    { file: "PoolKey.sol", names: ["PoolKey"] },
    { file: "PoolOperation.sol", names: ["SwapParams", "ModifyLiquidityParams"] },
  ];

  const blocks: string[] = [];

  for (const { file, names } of wanted) {
    const text = await readFile(join(core, file), "utf8").catch(() => null);
    if (text === null) continue;

    for (const name of names) {
      // Comments stripped: the field names and their order are the whole point, and the
      // natspec around them triples the size of a section the model reads on every call.
      const match = new RegExp(`struct ${name} \\{[\\s\\S]*?\\n\\}`).exec(text);
      if (match === null) continue;

      blocks.push(
        match[0]
          .split("\n")
          .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("///"))
          .join("\n"),
      );
    }
  }

  if (blocks.length === 0) return "";

  return `
The v4 structs you will construct, exactly as this commit defines them. Field order is
what a positional literal depends on, and there are no other fields:

${blocks.join("\n\n")}

SwapParams has no recipient and no deadline; the caller of the swap router is the
recipient. PoolKey takes five fields, currency0 sorted below currency1.`.trim();
}

async function verifyImports(vendorRoot: string): Promise<readonly VerifiedImport[]> {
  const v4 = join(vendorRoot, "v4-periphery");
  const core = join(v4, "lib", "v4-core");

  const resolve = (path: string): string | null => {
    if (path.startsWith("v4-core/")) return join(core, path.slice("v4-core/".length));
    if (path.startsWith("v4-periphery/")) return join(v4, path.slice("v4-periphery/".length));
    if (path.startsWith("forge-std/")) {
      return join(vendorRoot, "forge-std", "src", path.slice("forge-std/".length));
    }
    return null;
  };

  return Promise.all(
    IMPORTS.map(async (entry) => {
      const target = resolve(entry.path);
      const exists =
        target === null ? false : await readFile(target, "utf8").then(() => true, () => false);
      return { path: entry.path, provides: entry.provides, exists };
    }),
  );
}
