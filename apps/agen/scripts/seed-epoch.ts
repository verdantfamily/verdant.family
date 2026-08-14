#!/usr/bin/env node
/**
 * A second market, structurally unlike the first.
 *
 * The discovery page ranks markets by how unusual their mechanics are, and a shelf
 * cannot be judged with one market on it. This one is periodic and competitive where
 * the other is reactive and per-trade: an hourly leaderboard, a reward pool, and a rule
 * that fires when nothing happens.
 *
 * Same caveat as `seed-build.ts`: the Solidity is a stand-in for generator output, the
 * model is scripted, and this is a development tool rather than anything the product
 * depends on.
 */

import { resolve } from "node:path";

import { fileJobStore, runBuild, scriptedProvider } from "@verdant/market-compiler";

const REPO_ROOT = resolve(process.cwd(), "../..");
const GENERATED_ROOT = resolve(REPO_ROOT, "generated");

const HOOK = `// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// A stand-in for generated output. See the note at the top of seed-epoch.ts.
contract RegentHook {
    uint256 public constant EPOCH_LENGTH = 3_600;
    uint256 public constant QUIET_PERIOD = 900;

    uint256 public currentEpoch;
    uint256 public epochStartedAt;
    address public epochLeader;
    uint256 public epochLeaderVolume;
    uint256 public rewardPool;
    uint256 public lastBuyAt;
    address public lastBuyer;

    mapping(address => uint256) public claimable;

    /// @notice The only address allowed to report trades.
    /// @dev Every other contract in this market trusts what the hook records, so an
    /// unguarded reporting function would let a stranger name themselves the leader of
    /// an epoch they never traded in.
    address public immutable poolManager;

    error NotPoolManager(address caller);

    constructor(address poolManager_) {
        poolManager = poolManager_;
        epochStartedAt = block.timestamp;
    }

    function onBuy(address buyer, uint256 amount, uint256 feeTaken) external {
        if (msg.sender != poolManager) revert NotPoolManager(msg.sender);

        _settleIfDue();

        rewardPool += feeTaken / 5;
        lastBuyer = buyer;
        lastBuyAt = block.timestamp;

        if (amount > epochLeaderVolume) {
            epochLeader = buyer;
            epochLeaderVolume = amount;
        }
    }

    function claim() external returns (uint256 owed) {
        owed = claimable[msg.sender];
        claimable[msg.sender] = 0;
    }

    function _settleIfDue() private {
        bool hourOver = block.timestamp >= epochStartedAt + EPOCH_LENGTH;
        bool wentQuiet = lastBuyAt != 0 && block.timestamp >= lastBuyAt + QUIET_PERIOD;
        if (!hourOver && !wentQuiet) return;

        address winner = hourOver ? epochLeader : lastBuyer;
        if (winner != address(0)) {
            claimable[winner] += rewardPool;
        }

        rewardPool = 0;
        epochLeader = address(0);
        epochLeaderVolume = 0;
        epochStartedAt = block.timestamp;
        currentEpoch += 1;
    }
}
`;

const TESTS = `// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {RegentHook} from "../contracts/RegentHook.sol";

contract RegentHookTest is Test {
    RegentHook hook;
    address alice = address(0xA11CE);
    address bob = address(0xB0B);

    function setUp() public {
        hook = new RegentHook(address(this));
    }

    function test_feeCeiling_poolNeverExceedsWhatWasPaidIn(uint96 fee) public {
        hook.onBuy(alice, 1 ether, fee);
        assertLe(hook.rewardPool(), uint256(fee));
    }

    function test_theLargestBuyerBecomesLeader() public {
        hook.onBuy(alice, 1 ether, 100);
        hook.onBuy(bob, 2 ether, 100);
        assertEq(hook.epochLeader(), bob);
    }

    function test_aSmallerBuyDoesNotTakeTheLead() public {
        hook.onBuy(bob, 2 ether, 100);
        hook.onBuy(alice, 1 ether, 100);
        assertEq(hook.epochLeader(), bob);
    }

    function test_poolConserved_creditsTheLeaderWhenTheHourEnds() public {
        hook.onBuy(alice, 1 ether, 1_000);
        uint256 pool = hook.rewardPool();

        vm.warp(block.timestamp + 3_601);
        hook.onBuy(bob, 1 ether, 0);

        assertEq(hook.claimable(alice), pool);
        assertEq(hook.rewardPool(), 0);
    }

    function test_oneKing_quietMarketPaysTheLastBuyer() public {
        hook.onBuy(alice, 1 ether, 1_000);
        uint256 pool = hook.rewardPool();

        vm.warp(block.timestamp + 901);
        hook.onBuy(bob, 1 ether, 0);

        assertEq(hook.claimable(alice), pool);
    }
}
`;

/** Everything in a specification except the half the first call answers. */
function frameOf<T extends { summary: unknown; rules: unknown }>(whole: T) {
  const { summary: _summary, rules: _rules, ...frame } = whole;
  return frame;
}

const specification = {
  summary: "The largest buyer each hour claims a fifth of that hour's fees",
  baseFeePpm: 10_000,
  maxFeePpm: 10_000,
  phases: [],
  state: [
    { name: "currentEpoch", type: "counter", description: "Hours since the market opened", writeOnce: false },
    { name: "epochStartedAt", type: "timer", description: "When the current hour began", writeOnce: false },
    { name: "epochLeader", type: "address", description: "Largest buyer this hour", writeOnce: false },
    { name: "rewardPool", type: "accumulator", description: "Fees set aside for this hour", writeOnce: false },
    { name: "lastBuyer", type: "address", description: "Who bought most recently", writeOnce: false },
    { name: "lastBuyAt", type: "timer", description: "When the most recent buy happened", writeOnce: false },
  ],
  rules: [
    {
      id: "fee-to-pool",
      title: "REWARD POOL",
      when: { kind: "swap", description: "Any trade happens", parameters: null },
      conditions: [],
      then: [
        {
          kind: "routeFee",
          description: "A fifth of the fee joins this hour's reward pool",
          parameters: [
            { key: "destination", value: "rewardPool" },
            { key: "share", value: 20 },
          ],
          writes: ["rewardPool"],
        },
      ],
      activeInPhases: [],
      onceOnly: false,
    },
    {
      id: "leaderboard",
      title: "HOURLY KING",
      when: { kind: "buy", description: "Someone buys from the pool", parameters: null },
      conditions: [
        {
          kind: "tradeSizeAbsolute",
          description: "The buy is larger than the current leader's",
          parameters: [{ key: "state", value: "epochLeaderVolume" }],
          combinator: null,
        },
      ],
      then: [
        {
          kind: "setLeader",
          description: "The buyer becomes King for the rest of the hour",
          parameters: null,
          writes: ["epochLeader", "lastBuyer", "lastBuyAt"],
        },
      ],
      activeInPhases: [],
      onceOnly: false,
    },
    {
      id: "epoch-settlement",
      title: "HOUR ENDS",
      when: {
        kind: "timeElapsed",
        description: "An hour passes",
        parameters: [{ key: "seconds", value: 3_600 }],
      },
      conditions: [],
      then: [
        {
          kind: "creditReward",
          description: "The hour's pool becomes claimable by the King",
          parameters: null,
          writes: ["rewardPool", "currentEpoch", "epochStartedAt", "epochLeader"],
        },
      ],
      activeInPhases: [],
      onceOnly: false,
    },
    {
      id: "inactivity-payout",
      title: "QUIET MARKET",
      when: {
        kind: "inactivity",
        description: "Fifteen minutes pass with no buy",
        parameters: [{ key: "seconds", value: 900 }],
      },
      conditions: [],
      then: [
        {
          kind: "creditReward",
          description: "The pool becomes claimable by the last buyer instead",
          parameters: null,
          writes: ["rewardPool", "currentEpoch", "epochStartedAt", "epochLeader"],
        },
      ],
      activeInPhases: [],
      onceOnly: false,
    },
  ],
  invariants: [
    { id: "fee-ceiling", statement: "The pool never holds more than was paid into it", expression: null },
    { id: "pool-conserved", statement: "Everything entering the pool is claimable or still in it", expression: null },
    { id: "one-king", statement: "An hour has at most one King", expression: null },
  ],
  externalDependencies: [],
  assumptions: [
    // A seed stands for a market whose readings have already been agreed to, so none of
    // them asks for confirmation — otherwise the build would pause on a question with
    // nobody there to answer it.
    {
      id: "largest-buyer",
      term: "buys the most",
      interpretation: "The largest single buy in the hour, not the cumulative total",
      why: "Both readings are ordinary English and they crown different wallets.",
      parameters: null,
      importance: "medium",
      requiresConfirmation: false,
    },
    {
      id: "settlement-trigger",
      term: "at the end of each hour",
      interpretation:
        "Settled on the first trade after the hour ends, because the EVM cannot wake itself on a timer",
      why: "Nothing on chain runs on a clock, so the hour has to end on somebody's trade.",
      parameters: null,
      importance: "medium",
      requiresConfirmation: false,
    },
  ],
  ambiguities: [],
  unsupported: [],
};

const plan = {
  approach:
    "One hook holding the epoch clock, the leaderboard and a reward pool, settling lazily on " +
    "the first trade after an hour ends and paying by claim rather than by transfer.",
  components: [
    {
      id: "regentToken",
      contractName: "RegentToken",
      role: "token",
      origin: "generate",
      purpose: "The traded token",
      requiredBy: [],
      dependsOn: [],
      hookPermissions: [],
      custodial: false,
      implementationNotes: [],
    },
    {
      id: "regentHook",
      contractName: "RegentHook",
      role: "hook",
      origin: "extend",
      purpose: "Tracks the hourly leader and the reward pool",
      requiredBy: ["hourly-leader"],
      dependsOn: [],
      hookPermissions: ["beforeSwap", "afterSwap"],
      custodial: true,
      implementationNotes: ["Settle lazily; nothing can schedule a call on chain"],
    },
  ],
  dependencies: [],
  adaptations: [
    {
      requested: "at the end of each hour, pay the King",
      implemented: "settle on the first trade after the hour ends",
      reason: "the EVM cannot wake itself on a timer, so the work happens on the next interaction",
    },
    {
      requested: "the King can claim what the pool collected",
      implemented: "rewards are credited to a claimable balance the winner withdraws",
      reason: "pushing a transfer inside a swap would let a hostile recipient revert the trade",
    },
  ],
};

/**
 * How the bundle is deployed. The hook takes the pool manager and nothing else; its
 * rewards are claimed by whoever won them, so no single address controls it.
 */
const deployment = {
  components: [
    {
      componentId: "regentToken",
      constructorArguments: [{ name: "recipient", type: "address", source: "INFRA:INSTALLER" }],
      immutable: ["recipient"],
      wiring: [],
      controller: null,
    },
    {
      componentId: "regentHook",
      constructorArguments: [
        { name: "poolManager_", type: "address", source: "INFRA:POOL_MANAGER" },
      ],
      immutable: ["poolManager_"],
      wiring: [],
      controller: null,
    },
  ],
  pool: { feeMode: "dynamic", lpFee: "8388608" },
  custodyComponentId: "regentHook",
  feeClaimComponentId: "regentHook",
  oneTimeInitialization: [],
};

const job = await runBuild(
  {
    prompt:
      "Every hour, whoever buys the most becomes the King for that hour. 20% of all trading " +
      "fees go into a reward pool, and at the end of each hour the King can claim what the " +
      "pool collected during it. If nobody buys for 15 minutes, the current pool becomes " +
      "claimable by the last buyer instead, and the hour restarts.",
    name: "Regent",
    symbol: "KING",
  },
  {
    provider: scriptedProvider([
      // Interpretation is four calls: what the market does, the rules formalising it,
      // the frame around them, and the critique that runs beside the frame.
      { behaviours: specification.rules.map((rule) => rule.title.toLowerCase()) },
      { summary: specification.summary, rules: specification.rules },
      frameOf(specification),
      { suggestions: [] },
      // Planning is two calls: what is already solved, then what to build.
      { reuse: [{ catalogueId: "base-hook", why: "it needs a hook" }], novel: [] },
      { plan, deployment },
      // One answer per generated component; the token is written by Agen, not scripted.
      { content: HOOK, notes: [] },
      { files: [{ path: "test/RegentHook.t.sol", content: TESTS }], notes: [] },
    ]),
    store: fileJobStore(resolve(GENERATED_ROOT, "_jobs")),
    vendorRoot: resolve(REPO_ROOT, "packages/contracts/vendor"),
    generatedRoot: GENERATED_ROOT,
  },
);

console.log(`stage: ${job.stage}`);
if (job.failure !== null) console.log(`failed: ${job.failure.code} — ${job.failure.detail}`);
console.log(`tests: ${String(job.testOutcomes.filter((o) => o.passed).length)} passing`);
