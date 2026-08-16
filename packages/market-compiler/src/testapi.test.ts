/**
 * Calls a generated suite makes that nothing will answer.
 *
 * The three shapes here are the ones that have cost real builds: a method invented on one
 * of Agen's own contracts, a field invented on a Uniswap value type, and a real method
 * called with the wrong arity. All three are the test's mistake and none of them is
 * evidence about the market, which is the distinction every assertion below is protecting.
 */

import { describe, expect, it } from "vitest";

import {
  apiBrief,
  apiIndex,
  receiverBrief,
  unknownMembers,
  unknownReceivers,
} from "./testapi";
import { preludeApi, preludeSources, publicGetters } from "./prelude";
import { recognise, Blame } from "./playbook";
import { classify, FailureCategory } from "./recovery";
import { Stage } from "./job";
import type { Diagnostic } from "./foundry";
import type { GeneratedSource } from "./workspace";

function diagnostic(message: string): Diagnostic {
  return {
    severity: "error",
    type: "TypeError",
    code: "9582",
    message,
    file: "test/Pulse1Test.sol",
    line: 84,
    column: 9,
    excerpt: null,
  };
}

const MARKET: readonly GeneratedSource[] = [
  {
    path: "contracts/PulseHook.sol",
    content: `contract PulseHook {
    uint256 public round;
    mapping(address => uint256) public buys;

    function recordBuy(address who, uint256 amount) external {}
    function settle() external {}
}`,
  },
];

function test(body: string): readonly GeneratedSource[] {
  return [{ path: "test/PulseTest.sol", content: `contract PulseTest {\n${body}\n}` }];
}

describe("the members Agen's own contracts really have", () => {
  it("counts public state as callable, because to a test it is", () => {
    const vault = preludeSources().find((source) => source.path.endsWith("FeeVault.sol"))!;
    const getters = publicGetters(vault.content);

    expect(getters).toContain("owner()");
    expect(getters).toContain("hook()");
    // A mapping is a function of its key, which is the part a suite gets wrong.
    expect(getters).toContain("credited(address)");
    expect(getters).toContain("withdrawn(address)");
  });

  it("lists them where the model will actually read them", () => {
    const listed = preludeApi();

    // The omission that caused the failure: the vault appeared to offer three methods,
    // none of which answers "where does the fee go".
    expect(listed).toContain("credited(address)");
    expect(listed).toContain("owner()");
    expect(listed).toContain("pending(address account)");
    expect(listed).toContain("currentEpoch()");
  });

  it("unpacks a nested mapping into both of its keys", () => {
    expect(publicGetters("    mapping(address => mapping(address => uint256)) public allowance;")).toEqual(
      ["allowance(address, address)"],
    );
  });

  it("does not mistake a function or an event for state", () => {
    const getters = publicGetters(`
    function epochIsDue() public view returns (bool) {}
    event Credited(address indexed currency, uint256 amount);
    error NotHook(address caller);
`);

    expect(getters).toEqual([]);
  });
});

describe("A — a method invented on one of Agen's contracts", () => {
  const suite = test(`
    FeeVault vault;
    function test_fees() public {
        assertEq(vault.feeReceiver(), address(this));
    }
`);

  it("is caught before the compiler is asked", () => {
    const found = unknownMembers([...preludeSources(), ...MARKET], suite);

    expect(found).toHaveLength(1);
    expect(found[0]!.contract).toBe("FeeVault");
    expect(found[0]!.member).toBe("feeReceiver");
  });

  it("comes with the names that would have worked", () => {
    const brief = apiBrief(unknownMembers([...preludeSources(), ...MARKET], suite));

    expect(brief).toContain("FeeVault has no feeReceiver()");
    expect(brief).toContain("owner");
    expect(brief).toContain("credited");
    // The instruction that keeps a correct contract correct.
    expect(brief).toContain("do not add the missing member to a");
  });

  it("is routed to the test rather than to the market when the compiler reports it", () => {
    const found = classify({
      stage: Stage.TestRepair,
      diagnostics: [
        diagnostic(
          'Member "feeReceiver" not found or not visible after argument-dependent lookup in contract FeeVault.',
        ),
      ],
    });

    expect(found.category).toBe(FailureCategory.TypeApiMismatch);
    expect(found.blame).toBe(Blame.Test);
    expect(found.playbook).toBe("invented_contract_member");
  });

  it("gets contract advice, not the advice meant for Uniswap's packed types", () => {
    const entry = recognise([
      diagnostic(
        'Member "feeReceiver" not found or not visible after argument-dependent lookup in contract FeeVault.',
      ),
    ]);

    expect(entry?.id).toBe("invented_contract_member");
    expect(entry?.remedy).toContain("owner()");
    expect(entry?.remedy).toContain("credited(currency)");
    // The remedy that used to answer this, and is about something else entirely.
    expect(entry?.remedy).not.toContain("BalanceDelta");
  });
});

describe("B — a field invented on a Uniswap value type", () => {
  it("still goes to the value-type remedy, which the contract one must not have stolen", () => {
    const entry = recognise([
      diagnostic(
        'Member "delta0" not found or not visible after argument-dependent lookup in BalanceDelta.',
      ),
    ]);

    expect(entry?.id).toBe("invented_member");
    expect(entry?.remedy).toContain("delta.amount0()");
  });

  it("is blamed on the test in both cases, since neither is the market's doing", () => {
    for (const message of [
      'Member "delta0" not found or not visible after argument-dependent lookup in BalanceDelta.',
      'Member "feeReceiver" not found or not visible after argument-dependent lookup in contract FeeVault.',
    ]) {
      expect(classify({ stage: Stage.TestRepair, diagnostics: [diagnostic(message)] }).blame).toBe(
        Blame.Test,
      );
    }
  });
});

describe("C — a real method called wrongly", () => {
  it("is recognised as the test's mistake rather than a missing function", () => {
    const entry = recognise([
      diagnostic("Wrong argument count for function call: 1 arguments given but expected 2."),
    ]);

    expect(entry?.id).toBe("wrong_arity");
    expect(entry?.blame).toBe(Blame.Test);
    expect(entry?.remedy).toContain("Do not add an overload");
  });

  it("does not fall through to a category that would rewrite the market", () => {
    const found = classify({
      stage: Stage.TestRepair,
      diagnostics: [
        diagnostic("Wrong argument count for function call: 1 arguments given but expected 2."),
      ],
    });

    expect(found.category).toBe(FailureCategory.TypeApiMismatch);
    expect(found.blame).toBe(Blame.Test);
  });
});

describe("what the reader refuses to guess about", () => {
  it("says nothing about a call whose receiver it cannot type", () => {
    const found = unknownMembers(MARKET, test(`
    function test_x() public {
        somethingUntyped.whatever();
    }
`));

    expect(found).toEqual([]);
  });

  it("says nothing when the inheritance chain leaves this build", () => {
    const external: readonly GeneratedSource[] = [
      { path: "contracts/Odd.sol", content: "contract Odd is SomethingVendored { }" },
    ];

    const found = unknownMembers(external, test(`
    Odd odd;
    function test_x() public { odd.whatever(); }
`));

    expect(found).toEqual([]);
  });

  it("accepts a member a contract inherits from one of Agen's bases", () => {
    const wired: readonly GeneratedSource[] = [
      ...preludeSources(),
      { path: "contracts/Ledger.sol", content: "contract Ledger is AgenWired { }" },
    ];

    const found = unknownMembers(wired, test(`
    Ledger ledger;
    function test_x() public { ledger.installer(); }
`));

    expect(found).toEqual([]);
  });

  it("accepts a generated contract's own methods and getters", () => {
    const found = unknownMembers([...preludeSources(), ...MARKET], test(`
    PulseHook hook;
    function test_x() public {
        hook.settle();
        hook.round();
        hook.buys(address(this));
    }
`));

    expect(found).toEqual([]);
  });

  it("leaves low-level address members alone", () => {
    const found = unknownMembers([...preludeSources(), ...MARKET], test(`
    PulseHook hook;
    function test_x() public { hook.call(""); }
`));

    expect(found).toEqual([]);
  });

  it("indexes what a contract inherits so the chain can be walked", () => {
    const index = apiIndex([
      { path: "contracts/A.sol", content: "contract A is B, C(1) { function f() external {} }" },
    ]);

    expect(index.get("A")?.bases).toEqual(["B", "C"]);
    expect(index.get("A")?.own.has("f")).toBe(true);
  });
});

/**
 * A name a test reaches the market through that the fixture never declared.
 *
 * Three of one run's fifteen markets died here, all with correct contracts: HRBR asked for
 * `vault`, then `components.vault`, then `vault.credited()`, against a fixture declaring
 * `component_feeVault`. Solidity says "Undeclared identifier" and lists nothing, so every round
 * guessed a different plausible name until the budget ran out.
 */
describe("the names a fixture actually declares", () => {
  const FIXTURE: GeneratedSource = {
    path: "test/MarketTestBase.sol",
    content: `contract MarketTestBase {
    PoolKey internal key;
    HarbourToken internal token;
    FeeVault internal component_feeVault;
    HarbourHook internal hook;

    // A sell fee can land in a vault, or in an accounting contract.
    function buy(uint128 amountIn) internal returns (uint256) {}
}`,
  };

  const suite = (body: string): readonly GeneratedSource[] => [
    { path: "test/Harbour.t.sol", content: `contract HarbourTest is MarketTestBase {\n${body}\n}` },
  ];

  it("reports a receiver nothing declares, and says what there is instead", () => {
    const found = unknownReceivers({
      tests: suite(`    function test_x() public { vault.credited(address(token)); }`),
      fixture: FIXTURE,
    });

    expect(found).toHaveLength(1);
    expect(found[0]?.receiver).toBe("vault");
    expect(found[0]?.available).toContain("component_feeVault");
    expect(receiverBrief(found)).toContain("component_feeVault");
  });

  it("says nothing about the fields the fixture does declare", () => {
    expect(
      unknownReceivers({
        tests: suite(`    function test_x() public {
        component_feeVault.credited(address(token));
        hook.consecutiveBuys();
        token.balanceOf(address(this));
    }`),
        fixture: FIXTURE,
      }),
    ).toEqual([]);
  });

  it("says nothing about a variable the test declared itself, or about a cheatcode", () => {
    expect(
      unknownReceivers({
        tests: suite(`    function test_x() public {
        IERC20 quote = IERC20(address(1));
        quote.balanceOf(address(this));
        vm.expectRevert();
        uint256[] memory amounts = new uint256[](1);
        amounts.length;
    }`),
        fixture: FIXTURE,
      }),
    ).toEqual([]);
  });

  /** A name mentioned anywhere in the fixture is given the benefit of the doubt. */
  it("stays quiet when the fixture is not understood", () => {
    expect(
      unknownReceivers({
        tests: suite(`    function test_x() public { vault.credited(0); }`),
        fixture: { path: "test/MarketTestBase.sol", content: "contract MarketTestBase {}" },
      }),
    ).toEqual([]);
  });
});
