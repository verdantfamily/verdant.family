#!/usr/bin/env node
/**
 * Launches two markets with the SDK, against a real chain, and checks what landed.
 *
 * ## What was missing, and why it mattered
 *
 * `scripts/indexer-proof.sh` proves the contracts and the indexer, and it does that
 * well — but every market it creates is created from Solidity, by `Seed.s.sol`. So
 * nothing in it says a word about the bytes `packages/sdk` produces. Until this file
 * existed, **no create transaction built by the SDK had ever been broadcast
 * anywhere**: the encoder was checked by decoding its own output back in a unit test,
 * which catches a transposed field and cannot catch a wrong ABI, a wrong salt
 * namespace, or a predicted address the token never lands on.
 *
 * A launch is irreversible and its wiring is immutable. The first SDK-built `create`
 * had to happen somewhere, and it should not have been on mainnet.
 *
 * ## It uses the interface's own code, not a copy of it
 *
 * The sequence below is `apps/web/src/components/launch/launch-submit.tsx`'s
 * sequence, and the parameters come from `apps/web/src/lib/launch.ts`'s own `derive`
 * and `launchParams` — a draft, exactly as the form holds one. A reimplementation
 * here would prove that this file agrees with the SDK, which is not the claim
 * anybody needs. The claim is that what the form sends works.
 *
 *   1. `launch.readTokenInitCodeHash` — one read, because the hash is a compiled
 *      artefact's and the SDK does not compile the token.
 *   2. `launch.mineTokenSalt` — a local search for a salt whose CREATE2 address sorts
 *      above the quote asset.
 *   3. `launchParams` + `launch.buildCreate` — the calldata.
 *   4. send it, then ask the chain what happened rather than reading the receipt.
 *
 * Two markets, because they fail differently. An ether-quoted launch clears the salt
 * constraint on its first candidate — the zero address sorts below everything — so a
 * broken search would still look fine. The equity-quoted one is the market where the
 * search *is* the launch.
 *
 * ## The one step this cannot cover
 *
 * The swap below goes through the rig's `PoolSwapTest`, the same router `Seed.s.sol`
 * trades through, because the Universal Router's source is not vendored and this
 * machine has no network to fetch it or its deployed bytecode with. So
 * `trade.buildSwap`'s bytes are built and decoded here but never executed. The
 * closing section says so in the output, and `docs/feed.md` says what closes it.
 *
 * Usage: node apps/web/scripts/assert-sdk-launch.ts
 * Environment: VERDANT_RPC, VERDANT_FACTORY, VERDANT_HOOK, VERDANT_DEPLOYER,
 *              VERDANT_MARKET_REGISTRY, VERDANT_MULTICALL3, VERDANT_POOL_MANAGER,
 *              VERDANT_POSITION_MANAGER, VERDANT_SWAP_ROUTER, VERDANT_EQUITY,
 *              VERDANT_SDK_OUTPUT (optional)
 */

import {
  DYNAMIC_FEE_FLAG,
  EXTERNAL_ADDRESSES,
  ROBINHOOD_MAINNET_ID,
  TICK_SPACING,
} from "@verdant/config";
import { abi, launch, markets, pool, trade } from "@verdant/sdk";
import { writeFileSync } from "node:fs";
import {
  createPublicClient,
  createWalletClient,
  decodeAbiParameters,
  decodeFunctionData,
  defineChain,
  encodeFunctionData,
  erc20Abi,
  http,
  parseEventLogs,
  type Address,
  type Chain,
  type Hex,
  type TransactionReceipt,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import {
  derive,
  emptyDraft,
  launchParams,
  tokenIdentity,
  validate,
  type DerivedLaunch,
  type LaunchDraft,
} from "../src/lib/launch.ts";
import { minimumReceived, permit2Expiration } from "../src/lib/trade.ts";

const RPC = process.env.VERDANT_RPC ?? "http://127.0.0.1:8555";

function requireEnv(name: string): Address {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`${name} must be set`);
  }
  return value.trim() as Address;
}

const FACTORY = requireEnv("VERDANT_FACTORY");
const HOOK = requireEnv("VERDANT_HOOK");
const DEPLOYER = requireEnv("VERDANT_DEPLOYER");
const MARKET_REGISTRY = requireEnv("VERDANT_MARKET_REGISTRY");
const MULTICALL3 = requireEnv("VERDANT_MULTICALL3");
const POOL_MANAGER = requireEnv("VERDANT_POOL_MANAGER");
const POSITION_MANAGER = requireEnv("VERDANT_POSITION_MANAGER");
const SWAP_ROUTER = requireEnv("VERDANT_SWAP_ROUTER");

/** The tokenized equity `Seed.s.sol` deployed, and the model registry has admitted. */
const EQUITY = requireEnv("VERDANT_EQUITY");

/**
 * anvil's first account, which is also the account the rig deploys and seeds from.
 *
 * Written here rather than read from the environment, for the reason
 * `scripts/indexer-proof.sh` gives about its own copy: a configurable key is an
 * invitation to point this at a funded account on a real chain. This file signs
 * `create` transactions, so that invitation would be the expensive kind.
 *
 * The guard in `main` is the other half of it. This refuses to run against anything
 * that is not a loopback address, because every claim below assumes a node this rig
 * owns — it mines salts, launches markets and reads balances back, none of which is
 * safe or meaningful against a chain somebody else is using.
 */
const OPERATOR_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

const account = privateKeyToAccount(OPERATOR_KEY);

/**
 * The chain, described well enough for the SDK's read layer to batch.
 *
 * The id is 4663 because that is what the rig's anvil reports and what
 * `EXTERNAL_ADDRESSES` is written for: the whole point of this file is that the
 * interface's configured addresses are the ones answering. The Multicall3 is the
 * rig's own — anvil predeploys none.
 */
const chain: Chain = defineChain({
  id: ROBINHOOD_MAINNET_ID,
  name: "Verdant proof rig",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
  contracts: { multicall3: { address: MULTICALL3 } },
});

const client = createPublicClient({ chain, transport: http(RPC) });
const wallet = createWalletClient({ account, chain, transport: http(RPC) });

const addresses = { hook: HOOK, marketRegistry: MARKET_REGISTRY };

let failures = 0;
let checks = 0;

function check(what: string, condition: boolean, detail?: string): void {
  checks++;
  if (condition) {
    console.log(`  ok   ${what}`);
    return;
  }
  failures++;
  console.error(`  FAIL ${what}${detail === undefined ? "" : `: ${detail}`}`);
}

function equal(what: string, actual: unknown, expected: unknown): void {
  check(what, actual === expected, `expected ${String(expected)}, got ${String(actual)}`);
}

/** Addresses are compared case-insensitively; nothing here checksums its answers. */
function sameAddress(what: string, actual: string, expected: string): void {
  equal(what, actual.toLowerCase(), expected.toLowerCase());
}

async function send(call: {
  readonly to: Address;
  readonly data: Hex;
  readonly value: bigint;
}): Promise<TransactionReceipt> {
  const hash = await wallet.sendTransaction({
    to: call.to,
    data: call.data,
    value: call.value,
  });
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") {
    throw new Error(`transaction ${hash} reverted`);
  }
  return receipt;
}

/**
 * `PoolSwapTest.swap`, which is rig plumbing rather than anything the interface calls.
 *
 * Restated here in the four fields it needs because the alternative — the Universal
 * Router, which is what the interface really uses — is not available on this node.
 * See the closing section for exactly what that costs this proof.
 */
const poolSwapTestAbi = [
  {
    type: "function",
    name: "swap",
    stateMutability: "payable",
    inputs: [
      {
        name: "key",
        type: "tuple",
        components: [
          { name: "currency0", type: "address" },
          { name: "currency1", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "tickSpacing", type: "int24" },
          { name: "hooks", type: "address" },
        ],
      },
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "zeroForOne", type: "bool" },
          { name: "amountSpecified", type: "int256" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
      {
        name: "testSettings",
        type: "tuple",
        components: [
          { name: "takeClaims", type: "bool" },
          { name: "settleUsingBurn", type: "bool" },
        ],
      },
      { name: "hookData", type: "bytes" },
    ],
    outputs: [{ name: "delta", type: "int256" }],
  },
] as const;

/** `TickMath.MIN_SQRT_PRICE + 1`: buy until the pool runs out rather than until a price. */
const MIN_SQRT_PRICE_LIMIT = 4_295_128_740n;

/** `IV4Router.ExactInputSingleParams`, restated so the SDK's bytes can be decoded. */
const EXACT_INPUT_SINGLE_PARAMS = [
  {
    type: "tuple",
    components: [
      {
        name: "poolKey",
        type: "tuple",
        components: [
          { name: "currency0", type: "address" },
          { name: "currency1", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "tickSpacing", type: "int24" },
          { name: "hooks", type: "address" },
        ],
      },
      { name: "zeroForOne", type: "bool" },
      { name: "amountIn", type: "uint128" },
      { name: "amountOutMinimum", type: "uint128" },
      { name: "hookData", type: "bytes" },
    ],
  },
] as const;

const ACTIONS_AND_PARAMS = [{ type: "bytes" }, { type: "bytes[]" }] as const;

// --- section 1: the periphery the interface reads -----------------------------

/**
 * The two contracts the app addresses by chain id rather than by configuration.
 *
 * `EXTERNAL_ADDRESSES` holds Robinhood mainnet's V4Quoter and Permit2, and neither
 * `apps/web` nor the SDK will take an override for them — the quoter is read from
 * `EXTERNAL.quoter` and Permit2 is a module constant in `trade/approve.ts`. The rig
 * runs at chain id 4663, so unless those exact addresses answer, the interface's own
 * code path cannot be exercised at all: every quote would revert and every allowance
 * read would return zero forever.
 *
 * `scripts/indexer-proof.sh` puts working code at both. What is checked here is that
 * they *behave*, not that they have a non-empty `code` — a wrong copy would satisfy
 * the second and fail every trade.
 */
async function assertPeriphery(): Promise<void> {
  console.log("\nUniswap's periphery, at the addresses the interface looks for");

  const quoterCode = await client.getCode({ address: EXTERNAL_ADDRESSES.v4Quoter });
  check(
    `the configured V4Quoter (${EXTERNAL_ADDRESSES.v4Quoter}) has code`,
    quoterCode !== undefined && quoterCode.length > 2,
    "nothing is deployed there, so every quote the trade panel takes would revert",
  );

  // The immutable that proves the relocation kept its wiring. `poolManager` lives in
  // the quoter's runtime code, so a copy of that code is still bound to the
  // PoolManager the original was constructed with — this rig's, not 4663's.
  const boundTo = await client.readContract({
    address: EXTERNAL_ADDRESSES.v4Quoter,
    abi: [
      {
        type: "function",
        name: "poolManager",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "address" }],
      },
    ] as const,
    functionName: "poolManager",
  });
  sameAddress(
    "and it is bound to the PoolManager this rig deployed",
    boundTo,
    POOL_MANAGER,
  );

  const permit2Code = await client.getCode({ address: EXTERNAL_ADDRESSES.permit2 });
  check(
    `the canonical Permit2 (${EXTERNAL_ADDRESSES.permit2}) has code`,
    permit2Code !== undefined && permit2Code.length > 2,
    "nothing is deployed there, so no ERC-20 quote asset could ever be spent",
  );

  // 9 152 bytes is what V1 in docs/verification.md recorded on 4663 and on 46630.
  // The rig's Permit2 is the precompiled artefact vendored with permit2 itself, so
  // this is not a coincidence to be noted — it is the claim that the rig is running
  // the same contract the chain is.
  equal(
    "and it is the same 9 152 bytes that V1 recorded on 4663",
    permit2Code === undefined ? 0 : (permit2Code.length - 2) / 2,
    9_152,
  );

  // A real read through the SDK's own function, which is the one the trade panel
  // calls. An unallocated address answers `0x` and viem would throw rather than
  // return zeros, so reaching this line at all is most of the check.
  const allowance = await trade.readPermit2Allowance(client, {
    owner: account.address,
    token: EQUITY,
    spender: EXTERNAL_ADDRESSES.universalRouter,
  });
  check(
    "and answers readPermit2Allowance, which is how the panel decides whether to ask for an approval",
    allowance.amount === 0n && allowance.expiration === 0 && allowance.nonce === 0,
    `a fresh triple should be all zeros; got ${allowance.amount} / ${allowance.expiration}`,
  );
}

// --- section 2 and 3: the two launches ----------------------------------------

interface LaunchedMarket {
  readonly label: string;
  readonly draft: LaunchDraft;
  readonly derived: DerivedLaunch;
  readonly mined: launch.MinedSalt;
  readonly poolId: Hex;
  readonly token: Address;
  readonly receipt: TransactionReceipt;
}

/**
 * A draft, as the form would hold one, with the fields this rig cares about set.
 *
 * `emptyDraft` is the form's own starting point, so everything not named here — the
 * supply, the tick, the metadata rules — is what a creator would actually get.
 */
function draftFor({
  name,
  symbol,
  feePercent,
}: {
  readonly name: string;
  readonly symbol: string;
  readonly feePercent: string;
}): LaunchDraft {
  return {
    ...emptyDraft(),
    name,
    symbol,
    metadataUrl: "ipfs://verdant-sdk-proof",
    buyFeePercent: feePercent,
  };
}

/**
 * The launch, in the order `launch-submit.tsx` does it.
 *
 * `quoteAsset` is threaded in rather than taken from `derive`, and only for the
 * equity-quoted market: `derive` resolves a quote asset out of the *reviewed list*
 * in `@verdant/config`, which names Robinhood's real equities, and none of those
 * exist on a local node. Everything else — the model, the stages, the supply, the
 * tick, the fee recipient — is the form's own derivation, untouched.
 */
async function launchWith({
  label,
  draft,
  quoteAsset,
}: {
  readonly label: string;
  readonly draft: LaunchDraft;
  readonly quoteAsset: Address;
}): Promise<LaunchedMarket> {
  console.log(`\n${label}, launched through @verdant/sdk`);

  const derived: DerivedLaunch = { ...derive(draft), quoteAsset };

  const blockers = validate(draft).filter((issue) => issue.blocking);
  check(
    "the form would let this draft be submitted",
    blockers.length === 0,
    blockers.map((issue) => `${issue.field}: ${issue.message}`).join("; "),
  );

  const identity = tokenIdentity(draft, derived, account.address);
  if (identity === null) throw new Error("the draft has no token identity");

  // 1. One read. The hash is of a compiled artefact the SDK does not compile, which
  //    is the whole reason `VerdantDeployer.tokenInitCodeHash` exists rather than a
  //    loop of `predictToken` round trips.
  const initCodeHash = await launch.readTokenInitCodeHash(client, {
    ...identity,
    deployer: DEPLOYER,
  });

  // 2. A local search. For an ether-quoted market the first candidate qualifies; for
  //    an equity-quoted one this is the difference between a launch and a revert.
  const mined = launch.mineTokenSalt({
    deployer: DEPLOYER,
    creator: account.address,
    initCodeHash,
    above: derived.quoteAsset,
  });
  console.log(
    `  predicted ${mined.token} after ${mined.attempts} candidate${mined.attempts === 1 ? "" : "s"}`,
  );

  // 3. The calldata, from the form's own parameters.
  const params = launchParams(draft, derived, {
    creator: account.address,
    salt: mined.salt,
  });
  if (params === null) throw new Error("the draft produced no launch parameters");

  const call = launch.buildCreate({ factory: FACTORY, params });

  const native = derived.quoteAsset === pool.NATIVE_CURRENCY;

  // Stated as checks rather than assumed, because the two quote kinds fund the first
  // buy by different mechanisms and a builder that mixed them up would produce
  // calldata that reverts on one path and silently buys nothing on the other. The
  // factory refuses `msg.value` that is not exactly the buy it was told about, so an
  // ether-quoted launch attaching zero and an equity-quoted launch attaching anything
  // are both launches that cannot be mined.
  equal(
    native
      ? "the launch carries the first buy as value"
      : "the launch carries no value, because the equity is pulled instead",
    call.value,
    native ? params.initialBuyAmount : 0n,
  );
  sameAddress("and is addressed to the factory", call.to, FACTORY);

  // The approval the interface has to make for the same reason: the factory takes the
  // equity with `transferFrom` during the launch. For the exact amount, not unlimited —
  // it funds one buy in one transaction, so a standing allowance would buy nothing and
  // grant something.
  if (!native && params.initialBuyAmount > 0n) {
    await send(
      trade.buildErc20Approval({
        token: derived.quoteAsset,
        spender: FACTORY,
        amount: params.initialBuyAmount,
      }),
    );
  }

  const receipt = await send(call);
  check("it was mined and succeeded", receipt.status === "success");

  // What the launch delivered, from the token's own transfers. This is the assertion
  // that separates a launchpad from a token factory: before the first buy moved inside
  // `create`, this balance was zero after a launch and the opening price belonged to
  // whoever traded first.
  const bought = parseEventLogs({ abi: erc20Abi, eventName: "Transfer", logs: receipt.logs })
    .filter((log) => log.args.to.toLowerCase() === account.address.toLowerCase())
    .reduce((total, log) => total + log.args.value, 0n);

  if (params.initialBuyAmount > 0n) {
    check(
      "the launch delivered the first buy in the same transaction",
      bought > 0n,
      "the creator holds nothing, so the buy did not happen inside the launch",
    );
  }

  const [event] = parseEventLogs({
    abi: abi.verdantFactoryAbi,
    eventName: "MarketCreated",
    logs: receipt.logs,
  });
  if (event === undefined) throw new Error("no MarketCreated event in the receipt");

  // The claim the whole salt search exists to make: the address computed locally,
  // before the transaction was sent, is where the token landed.
  sameAddress(
    "the token landed at the address predictTokenAddress named before it was sent",
    event.args.token,
    mined.token,
  );

  return {
    label,
    draft,
    derived,
    mined,
    poolId: event.args.poolId,
    token: event.args.token,
    receipt,
  };
}

/**
 * What the chain says about a market the SDK just created.
 *
 * Read rather than taken from the receipt wherever a read is possible. A receipt is
 * the transaction's own account of itself, and the failure this rig is looking for —
 * calldata that encodes something other than what the caller asked for — would be
 * reported consistently by a receipt and inconsistently by the registry.
 */
async function assertMarket(created: LaunchedMarket): Promise<void> {
  const { derived, poolId, token } = created;

  // The pool key, derived locally by the same function the interface derives it
  // with. Everything below is asked about *this* key, so if it were wrong the
  // reads would be about a pool that does not exist and would fail rather than lie.
  const key = pool.poolKeyFor(derived.quoteAsset, token, HOOK);

  equal("the pool id the SDK derives is the one the factory emitted", pool.poolIdOf(key), poolId);
  sameAddress("the launch token is currency1", key.currency1, token);
  sameAddress("and the quote asset is currency0", key.currency0, derived.quoteAsset);
  equal("the key carries the dynamic-fee flag rather than a fee", key.fee, DYNAMIC_FEE_FLAG);
  equal("and Verdant's one tick spacing", key.tickSpacing, TICK_SPACING);

  // The registry's record, read through the SDK's read layer — one multicall through
  // the rig's own Multicall3, which is the path the interface takes.
  const snapshot = await markets.readMarket(client, addresses, { poolId });

  sameAddress("the registry has the market under that pool id", snapshot.market.token, token);
  sameAddress("with the quote asset the launch named", snapshot.market.quoteAsset, derived.quoteAsset);
  sameAddress("and the creator who sent it", snapshot.market.creator, account.address);
  equal("and the model the form derived", snapshot.market.model, derived.model);
  equal("the token reports the name the draft asked for", snapshot.token.name, created.draft.name);
  equal("and the symbol", snapshot.token.symbol, created.draft.symbol);
  equal(
    "and the supply, scaled by the token's decimals",
    snapshot.token.totalSupply,
    derived.supplyWei,
  );

  // The pool exists, and it is this key's pool. `configOf` is written by the hook's
  // `afterInitialize`, which the PoolManager calls with the id it computed from the
  // key it was handed — so a non-zero init time at the SDK's pool id is the
  // PoolManager's own statement that it initialised exactly this key.
  check(
    "the pool was initialised: the hook has an init time for that id",
    snapshot.schedule.initTime > 0,
    "the hook has no configuration for this pool id, so no pool with this key exists",
  );

  // The same fact from the other side, and the one an interface would notice: the
  // PoolManager's `Initialize` names every field of the key it opened.
  const [initialize] = parseEventLogs({
    abi: abi.poolManagerAbi,
    eventName: "Initialize",
    logs: created.receipt.logs,
  });
  if (initialize === undefined) throw new Error("no Initialize event in the receipt");

  equal("the PoolManager opened a pool with that id", initialize.args.id, poolId);
  sameAddress("whose currency0 is the quote asset", initialize.args.currency0, key.currency0);
  sameAddress("and whose currency1 is the launch token", initialize.args.currency1, key.currency1);
  sameAddress("and whose hook is Verdant's", initialize.args.hooks, HOOK);
  equal("and whose opening tick is the one the form derived", initialize.args.tick, derived.initialTick);

  // The position is locked. `PositionLocker` holding the NFT is what makes the
  // liquidity unwithdrawable, so this is the check that the market is a market
  // rather than a pool somebody can drain.
  const positionOwner = await client.readContract({
    address: POSITION_MANAGER,
    abi: [
      {
        type: "function",
        name: "ownerOf",
        stateMutability: "view",
        inputs: [{ name: "tokenId", type: "uint256" }],
        outputs: [{ type: "address" }],
      },
    ] as const,
    functionName: "ownerOf",
    args: [snapshot.market.positionTokenId],
  });
  sameAddress("the locked position is held by this market's locker", positionOwner, snapshot.market.locker);

  // The fee. Asked of the hook, at the chain's own time, and required to equal the
  // stage the draft submitted — a market that charges something other than what its
  // creator chose is the single worst outcome of a wrong encoding, because it is
  // immutable and nobody notices until the fees arrive.
  const submitted = derived.stages[0];
  if (submitted === undefined) throw new Error("the draft derived no stages");

  const hookFee = await markets.readHookFee(client, addresses, poolId, snapshot.at);
  equal("the hook charges the fee the draft submitted", hookFee, submitted.feePpm);
  equal("and the SDK's schedule twin agrees with it", snapshot.feePpm, submitted.feePpm);
}

// --- section 4: a quote, and a swap that tests it ------------------------------

/**
 * Quote it through the relocated V4Quoter, then trade and require the same number.
 *
 * The quoter is the only honest source for a Verdant pool — `slot0.lpFee` is stage
 * 0's forever, because the fee is a `beforeSwap` override — and the way to show a
 * quoter is honest is to execute the swap it described and compare to the wei.
 * Nothing touches the pool between the two, so anything other than equality is a
 * disagreement rather than a drift.
 */
async function assertQuoteAgainstSwap(created: LaunchedMarket, amountIn: bigint): Promise<void> {
  const { derived, poolId, token } = created;
  const key = pool.poolKeyFor(derived.quoteAsset, token, HOOK);
  const native = derived.quoteAsset === pool.NATIVE_CURRENCY;

  const quote = await trade.quoteExactIn(client, {
    quoter: EXTERNAL_ADDRESSES.v4Quoter,
    poolKey: key,
    zeroForOne: true,
    exactAmount: amountIn,
  });

  check(
    "the relocated quoter answers a real quoteExactInputSingle on this pool",
    quote.amountOut > 0n,
    "it returned nothing out, which is not a quote",
  );

  const heldBefore = await client.readContract({
    address: token,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [account.address],
  });

  // The rig's test router, because the Universal Router is not on this node. An
  // equity input has to be approved to it first; ether travels with the call.
  if (!native) {
    await send(
      trade.buildErc20Approval({
        token: derived.quoteAsset,
        spender: SWAP_ROUTER,
        amount: amountIn,
      }),
    );
  }

  const swapReceipt = await send({
    to: SWAP_ROUTER,
    data: encodeSwap(key, amountIn),
    value: native ? amountIn : 0n,
  });

  const heldAfter = await client.readContract({
    address: token,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [account.address],
  });

  equal(
    "the swap paid out exactly what the quoter said it would",
    heldAfter - heldBefore,
    quote.amountOut,
  );

  // And the pool charged the scheduled rate on the way. v4 reports the rate it
  // applied in its own `Swap` event, so this is the fee the trade really paid rather
  // than a rate read back out of the schedule that produced it.
  const [swapEvent] = parseEventLogs({
    abi: abi.poolManagerAbi,
    eventName: "Swap",
    logs: swapReceipt.logs,
  });
  if (swapEvent === undefined) throw new Error("no Swap event in the receipt");

  const submitted = derived.stages[0];
  if (submitted === undefined) throw new Error("the draft derived no stages");

  equal("the swap was in this market's pool", swapEvent.args.id, poolId);
  equal("and v4 charged the schedule's rate, not the pool's stored fee", swapEvent.args.fee, submitted.feePpm);
  check(
    "and it was a buy: the trader paid currency0 and received currency1",
    swapEvent.args.amount0 < 0n && swapEvent.args.amount1 > 0n,
    `amount0 ${swapEvent.args.amount0}, amount1 ${swapEvent.args.amount1}`,
  );
}

/**
 * The rig's swap, encoded here rather than by the SDK because the SDK does not build
 * one: `trade.buildSwap` targets the Universal Router, which is what a real trader
 * uses and what this node has not got. Kept short and in one place so that the line
 * between "what the interface sends" and "what the rig does to make a trade happen"
 * stays visible.
 */
function encodeSwap(key: pool.PoolKey, amountIn: bigint): Hex {
  return encodeFunctionData({
    abi: poolSwapTestAbi,
    functionName: "swap",
    args: [
      key,
      { zeroForOne: true, amountSpecified: -amountIn, sqrtPriceLimitX96: MIN_SQRT_PRICE_LIMIT },
      { takeClaims: false, settleUsingBurn: false },
      "0x",
    ],
  });
}

// --- section 5: the approvals an ERC-20 quote asset needs ----------------------

/**
 * The two approvals, built by the SDK and read back through it.
 *
 * They are not interchangeable and doing only the first is the classic mistake: the
 * router pulls its input through Permit2, so a trader with a token approval and no
 * Permit2 approval gets a revert deep inside `SETTLE_ALL` that reads as a broken
 * market. `apps/web`'s panel builds exactly these two calls, in this order, with
 * these amounts.
 *
 * The swap they authorise is the one this rig cannot send. What is proved here is
 * narrower and still worth having: the calls land, and `readPermit2Allowance` — the
 * read the panel gates the trade on — sees what they granted.
 */
async function assertApprovals(): Promise<void> {
  console.log("\nthe approvals an equity-quoted trade needs, built by the SDK");

  const router = EXTERNAL_ADDRESSES.universalRouter;
  const unlimited = (1n << 256n) - 1n;

  const before = await trade.readPermit2Allowance(client, {
    owner: account.address,
    token: EQUITY,
    spender: router,
  });
  equal("Permit2 has granted the router nothing yet", before.amount, 0n);

  await send(
    trade.buildErc20Approval({
      token: EQUITY,
      spender: trade.PERMIT2,
      amount: unlimited,
    }),
  );

  const toPermit2 = await client.readContract({
    address: EQUITY,
    abi: erc20Abi,
    functionName: "allowance",
    args: [account.address, trade.PERMIT2],
  });
  equal(
    "the equity's own approve named Permit2 as spender, and Permit2 can now be asked",
    toPermit2,
    unlimited,
  );

  // The chain's clock, not this process's. Permit2 reads an expiration of zero as
  // "this block only", and on an Orbit chain the reader's clock is not the
  // sequencer's — so the panel takes `at` from a block and so does this.
  const at = Number((await client.getBlock()).timestamp);
  const expiration = permit2Expiration(at);

  await send(
    trade.buildPermit2Approval({
      token: EQUITY,
      spender: router,
      amount: trade.UNLIMITED_PERMIT2_AMOUNT,
      expiration,
    }),
  );

  const after = await trade.readPermit2Allowance(client, {
    owner: account.address,
    token: EQUITY,
    spender: router,
  });
  equal(
    "Permit2 now lets the router take the unlimited amount",
    after.amount,
    trade.UNLIMITED_PERMIT2_AMOUNT,
  );
  equal("with the expiry the panel computed from chain time", after.expiration, expiration);
  check(
    "and that expiry is in the future, which an amount alone does not tell you",
    after.expiration > at,
    `${after.expiration} is not after ${at}`,
  );
}

// --- section 6: the swap this rig cannot send ----------------------------------

/**
 * `trade.buildSwap`, built and taken apart, never sent.
 *
 * The Universal Router is not on this node and cannot be put there: `universal-router`
 * is not among the pinned Solidity dependencies, so there is no source to compile,
 * and with no network there is no way to fetch either the repository or the deployed
 * bytecode from 4663. Stubbing it would be worse than the gap — a swap that "worked"
 * against a contract this repository wrote would prove that Verdant agrees with
 * Verdant.
 *
 * So what is checked is the part that can be: the bytes name the trade the caller
 * asked for. Decoding them here, against a restatement of the router's own parameter
 * layout, catches a transposed currency or a floor of zero. It cannot catch a wrong
 * command byte or an action the deployed router decodes differently, and nothing on
 * this machine can.
 */
async function assertSwapCalldata(created: LaunchedMarket, amountIn: bigint): Promise<void> {
  console.log("\nthe Universal Router swap, built but not sent");

  const { derived, token } = created;
  const key = pool.poolKeyFor(derived.quoteAsset, token, HOOK);

  const quote = await trade.quoteExactIn(client, {
    quoter: EXTERNAL_ADDRESSES.v4Quoter,
    poolKey: key,
    zeroForOne: true,
    exactAmount: amountIn,
  });

  const submitted = derived.stages[0];
  if (submitted === undefined) throw new Error("the draft derived no stages");

  const minOut = minimumReceived({
    amountOut: quote.amountOut,
    slippageBps: 50,
    quotedFeePpm: submitted.feePpm,
    worstFeePpm: submitted.feePpm,
  });

  const call = trade.buildSwap({
    router: EXTERNAL_ADDRESSES.universalRouter,
    poolKey: key,
    zeroForOne: true,
    amountIn,
    minAmountOut: minOut,
    recipient: account.address,
  });

  sameAddress("it is addressed to the Universal Router the config names", call.to, EXTERNAL_ADDRESSES.universalRouter);
  equal(
    "and an ether input travels as the transaction's value",
    call.value,
    derived.quoteAsset === pool.NATIVE_CURRENCY ? amountIn : 0n,
  );

  const decoded = decodeFunctionData({ abi: abi.universalRouterAbi, data: call.data });
  equal("the calldata is the router's execute", decoded.functionName, "execute");

  const [commands, inputs] = decoded.args;
  equal("carrying the single V4_SWAP command", commands, "0x10");
  equal("with one input", inputs.length, 1);

  const first = inputs[0];
  if (first === undefined) throw new Error("the router input is empty");

  const [actions, params] = decodeAbiParameters(ACTIONS_AND_PARAMS, first);
  equal(
    "which is SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL in that order",
    actions,
    "0x060c0f",
  );

  const swapParams = params[0];
  if (swapParams === undefined) throw new Error("the swap action has no parameters");

  const [exactIn] = decodeAbiParameters(EXACT_INPUT_SINGLE_PARAMS, swapParams);
  sameAddress("and the swap names this market's currency0", exactIn.poolKey.currency0, key.currency0);
  sameAddress("and its currency1", exactIn.poolKey.currency1, key.currency1);
  sameAddress("and Verdant's hook", exactIn.poolKey.hooks, HOOK);
  equal("and the amount the caller asked to spend", exactIn.amountIn, amountIn);
  equal("and the floor the panel computed from the quote", exactIn.amountOutMinimum, minOut);
  check(
    "which is a real floor rather than zero",
    exactIn.amountOutMinimum > 0n,
    "a minimum of zero accepts any output, including one a sandwich left behind",
  );
}

async function main(): Promise<void> {
  const host = new URL(RPC).hostname;
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
    throw new Error(
      `this signs launch transactions with a well-known key and will only do it ` +
        `against a loopback node; VERDANT_RPC points at ${host}`,
    );
  }

  const chainId = await client.getChainId();
  if (chainId !== ROBINHOOD_MAINNET_ID) {
    throw new Error(
      `the node reports chain ${chainId}; this proof needs ${ROBINHOOD_MAINNET_ID}, ` +
        `because EXTERNAL_ADDRESSES is resolved by chain id and would name nothing otherwise`,
    );
  }

  await assertPeriphery();

  const etherMarket = await launchWith({
    label: "An ether-quoted market",
    draft: draftFor({ name: "SDK Ether Market", symbol: "SDKETH", feePercent: "2.50" }),
    quoteAsset: pool.NATIVE_CURRENCY,
  });
  await assertMarket(etherMarket);
  await assertQuoteAgainstSwap(etherMarket, 50_000_000_000_000_000n);

  const equityMarket = await launchWith({
    label: "An equity-quoted market",
    draft: draftFor({ name: "SDK Equity Market", symbol: "SDKEQ", feePercent: "0.75" }),
    quoteAsset: EQUITY,
  });

  // The claim the salt search exists to make, and the one an ether-quoted launch
  // cannot make: the zero address sorts below every token, so the constraint is free
  // there and only an equity shows whether the search does anything.
  check(
    "the mined token sorts strictly above the equity, which is why the launch was possible at all",
    BigInt(equityMarket.token) > BigInt(EQUITY),
    `${equityMarket.token} does not sort above ${EQUITY}; the factory would have reverted TokenNotAboveQuote`,
  );

  await assertMarket(equityMarket);
  await assertQuoteAgainstSwap(equityMarket, 50_000_000_000_000_000n);

  await assertApprovals();
  await assertSwapCalldata(equityMarket, 10_000_000_000_000_000n);

  console.log(`\n${checks - failures}/${checks} checks passed`);

  const output = process.env.VERDANT_SDK_OUTPUT;
  if (output !== undefined && output.trim() !== "") {
    writeFileSync(
      output.trim(),
      [
        `SDK_ETHER_TOKEN=${etherMarket.token}`,
        `SDK_ETHER_POOL_ID=${etherMarket.poolId}`,
        `SDK_EQUITY_TOKEN=${equityMarket.token}`,
        `SDK_EQUITY_POOL_ID=${equityMarket.poolId}`,
        "",
      ].join("\n"),
    );
  }

  if (failures > 0) {
    console.error(
      `\n${failures} check(s) failed. A market the SDK built is not the market it ` +
        `described, which means the interface would create something other than what ` +
        `it showed its creator.`,
    );
    process.exit(1);
  }

  console.log(
    "\nthe SDK's calldata creates the market it describes, on a real chain.\n" +
      "\nNOT PROVED HERE: the Universal Router leg of trade.buildSwap. Its source is\n" +
      "not vendored and this machine has no network, so the swaps above went through\n" +
      "the rig's PoolSwapTest instead. Before the trade button is trusted with real\n" +
      "money, run:  bash scripts/fork-test.sh\n",
  );
}

await main();
