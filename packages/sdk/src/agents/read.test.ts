import { describe, expect, it } from "vitest";
import {
  encodeFunctionData,
  type Abi,
  type AbiFunction,
  type AbiParameter,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";

import {
  agentExecutionModuleAbi,
  agentIdentityRegistryAbi,
  agentMandateAbi,
  agentRevenueRouterAbi,
  agentServiceRegistryAbi,
  agentTreasuryAbi,
} from "../abi/index.js";
import * as read from "./read.js";

/**
 * That every call these read functions build is a call the contracts accept.
 *
 * The bug this exists for was real and shipped: `readTreasury` asked
 * `spentInPeriod(asset, timestamp)` for one argument instead of two. Nothing in
 * TypeScript objected — viem's inference gives up on a `contracts` array whose length
 * depends on a runtime list, which is precisely the case in three of these functions —
 * so the arity was checked for the first time at encoding time, against a live node, in
 * a proof rig. The failure was a thrown `AbiEncodingLengthMismatchError` from inside a
 * multicall, half a stack away from the mistake.
 *
 * So the client below is a fake that does the one thing a real node does first:
 * `encodeFunctionData` for every requested call. A wrong function name, a wrong number
 * of arguments or an argument of the wrong type throws here, offline, naming the
 * function. The values it answers with are zeros of the right shape, derived from the
 * ABI's outputs — enough for the function under test to finish assembling its result,
 * and deliberately not enough to assert anything about the numbers, which is the proof
 * rig's job against a chain that has real ones.
 */

const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const ZERO_HASH = `0x${"0".repeat(64)}` as Hex;

/** A zero of whatever shape the ABI says comes back. */
function zeroFor(parameter: AbiParameter): unknown {
  const { type } = parameter;

  if (type.endsWith("[]")) return [];
  if (type === "address") return ZERO;
  if (type === "bool") return false;
  if (type === "string") return "";
  // Narrow integers come back as `number` and wide ones as `bigint`, at viem's own
  // 48-bit boundary. Faithful because it matters: a stub that answered `0n` for a
  // `uint8` would fail this file's own lifecycle narrowing and pass nothing useful on
  // to the code under test.
  if (type.startsWith("uint") || type.startsWith("int")) {
    const bits = Number(type.replace(/^u?int/, "") || "256");
    return bits <= 48 ? 0 : 0n;
  }
  if (type === "bytes") return "0x";
  if (type.startsWith("bytes")) return ZERO_HASH;

  if (type === "tuple") {
    const components = (parameter as { components?: readonly AbiParameter[] }).components ?? [];
    return Object.fromEntries(
      components.map((component) => [component.name ?? "", zeroFor(component)]),
    );
  }

  throw new Error(`no zero value defined for ABI type ${type}`);
}

function answerFor(abi: Abi, functionName: string): unknown {
  const entry = abi.find(
    (item): item is AbiFunction => item.type === "function" && item.name === functionName,
  );
  if (entry === undefined) throw new Error(`${functionName} is not in this ABI`);

  const outputs = entry.outputs;
  if (outputs.length === 0) return undefined;
  if (outputs.length === 1) return zeroFor(outputs[0]!);
  return outputs.map(zeroFor);
}

interface Recorded {
  readonly address: Address;
  readonly functionName: string;
  readonly args: readonly unknown[];
}

/**
 * A client that encodes every call and answers with zeros.
 *
 * `encodeFunctionData` is the whole point: it is the step that failed against a real
 * node, and running it here moves that failure to a unit test.
 */
function stubClient(): { client: PublicClient; calls: Recorded[] } {
  const calls: Recorded[] = [];

  function run({
    abi,
    address,
    functionName,
    args,
  }: {
    abi: Abi;
    address: Address;
    functionName: string;
    args?: readonly unknown[];
  }): unknown {
    // Throws on a wrong name, a wrong arity or an argument of the wrong type — which is
    // exactly what a node would have done, and what nothing before this did.
    encodeFunctionData({ abi, functionName, args: args as never });

    calls.push({ address, functionName, args: args ?? [] });
    return answerFor(abi, functionName);
  }

  const client = {
    readContract: async (parameters: Parameters<typeof run>[0]) => run(parameters),
    multicall: async ({ contracts }: { contracts: readonly Parameters<typeof run>[0][] }) =>
      contracts.map((contract) => run(contract)),
    getBlock: async () => ({ timestamp: 1_700_000_000n }),
  } as unknown as PublicClient;

  return { client, calls };
}

/** Every call recorded against one function name. */
function callsTo(calls: readonly Recorded[], functionName: string): readonly Recorded[] {
  return calls.filter((call) => call.functionName === functionName);
}

const IDENTITY_REGISTRY = "0x1111111111111111111111111111111111111111" as Address;
const SERVICE_REGISTRY = "0x2222222222222222222222222222222222222222" as Address;
const TREASURY = "0x3333333333333333333333333333333333333333" as Address;
const ROUTER = "0x4444444444444444444444444444444444444444" as Address;
const MANDATE = "0x5555555555555555555555555555555555555555" as Address;
const EXECUTION_MODULE = "0x6666666666666666666666666666666666666666" as Address;

const AGENT_ID = `0x${"ab".repeat(32)}` as Hex;
const ASSET = "0x7777777777777777777777777777777777777777" as Address;

describe("the registry reads", () => {
  it("asks agentOf for the id it was given", async () => {
    const { client, calls } = stubClient();

    await read.readAgent(client, { identityRegistry: IDENTITY_REGISTRY, agentId: AGENT_ID });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.functionName).toBe("agentOf");
    expect(calls[0]?.address).toBe(IDENTITY_REGISTRY);
    expect(calls[0]?.args).toEqual([AGENT_ID]);
  });

  it("counts agents and resolves a pool", async () => {
    const { client, calls } = stubClient();

    await read.readAgentCount(client, { identityRegistry: IDENTITY_REGISTRY });
    await read.readAgentByPool(client, {
      identityRegistry: IDENTITY_REGISTRY,
      poolId: ZERO_HASH,
    });

    expect(calls.map((call) => call.functionName)).toEqual(["agentCount", "agentByPool"]);
  });

  it("pages by index, then names each agent by its treasury", async () => {
    const { client, calls } = stubClient();

    await read.readAgentPage(client, {
      identityRegistry: IDENTITY_REGISTRY,
      offset: 2n,
      limit: 3n,
    });

    expect(callsTo(calls, "agentAt").map((call) => call.args)).toEqual([[2n], [3n], [4n]]);

    // And not `agentOf`. `agentAt` returns the whole `Agent`, which does not carry its
    // own id, so the ids come from the registry's reverse index. Feeding a struct back
    // into `agentOf` typechecked and could never have worked.
    expect(callsTo(calls, "agentByTreasury")).toHaveLength(3);
    expect(callsTo(calls, "agentOf")).toHaveLength(0);
  });

  it("asks for nothing at all when the page is empty", async () => {
    const { client, calls } = stubClient();

    const page = await read.readAgentPage(client, {
      identityRegistry: IDENTITY_REGISTRY,
      offset: 0n,
      limit: 0n,
    });

    // A multicall with no calls is a round trip for no answer, and some nodes reject it.
    expect(page).toEqual([]);
    expect(calls).toEqual([]);
  });
});

describe("the mandate read", () => {
  it("asks for the permissions, then the limits of the assets it found", async () => {
    const { client, calls } = stubClient();

    await read.readMandate(client, { mandate: MANDATE });

    // The two-round shape: the approved assets have to come back before their limits
    // can be asked for. The stub returns an empty list, so the second round is empty.
    expect(callsTo(calls, "approvedAssets")).toHaveLength(1);
    expect(callsTo(calls, "approvedTargets")).toHaveLength(1);
    expect(callsTo(calls, "limitFor")).toHaveLength(0);
    expect(calls.every((call) => call.address === MANDATE)).toBe(true);
  });
});

describe("the treasury read", () => {
  it("passes an instant to the period figures and not to the others", async () => {
    const { client, calls } = stubClient();

    await read.readTreasury(client, { treasury: TREASURY, assets: [ASSET], at: 42n });

    // The regression. `spentInPeriod` and `remainingInPeriod` are
    // `(address, uint64)`; the rest are `(address)`. Encoding one with the wrong arity
    // throws inside the stub, so this test would fail before reaching an assertion —
    // but the arguments are checked explicitly too, because passing *an* instant that
    // is not the one asked for would encode perfectly and answer about another period.
    expect(callsTo(calls, "spentInPeriod")[0]?.args).toEqual([ASSET, 42n]);
    expect(callsTo(calls, "remainingInPeriod")[0]?.args).toEqual([ASSET, 42n]);

    for (const undated of ["balanceOf", "unrecognised", "totalRecognised", "totalSpent", "periodStartedAt"]) {
      expect(callsTo(calls, undated)[0]?.args, undated).toEqual([ASSET]);
    }
  });

  it("takes the chain's clock when it is not given one", async () => {
    const { client, calls } = stubClient();

    await read.readTreasury(client, { treasury: TREASURY, assets: [ASSET] });

    // The block's timestamp, not `Date.now()`. A reader's clock that is a minute fast
    // reports a period as rolled before the chain agrees, and every remaining-limit
    // figure derived from it is then wrong in the permissive direction.
    expect(callsTo(calls, "spentInPeriod")[0]?.args).toEqual([ASSET, 1_700_000_000n]);
  });

  it("asks for every asset it was given, once per figure", async () => {
    const { client, calls } = stubClient();
    const second = "0x8888888888888888888888888888888888888888" as Address;

    const snapshot = await read.readTreasury(client, {
      treasury: TREASURY,
      assets: [ASSET, second],
      at: 1n,
    });

    expect(snapshot.assets.map((asset) => asset.asset)).toEqual([ASSET, second]);
    expect(callsTo(calls, "balanceOf").map((call) => call.args)).toEqual([[ASSET], [second]]);
    // Seven figures per asset plus `paused`, which is not per asset.
    expect(calls).toHaveLength(7 * 2 + 1);
  });
});

describe("the execution module read", () => {
  it("asks who may act and what the replay state is", async () => {
    const { client, calls } = stubClient();

    await read.readExecution(client, { executionModule: EXECUTION_MODULE });

    expect(calls.map((call) => call.functionName)).toEqual([
      "operator",
      "nextNonce",
      "lastActionAt",
    ]);
  });

  it("asks about one request at a time", async () => {
    const { client, calls } = stubClient();

    await read.readRequestSettled(client, {
      executionModule: EXECUTION_MODULE,
      requestId: ZERO_HASH,
    });

    // One argument. The request id alone identifies a settlement — the service is not
    // part of the key, because a request is payable once across every service.
    expect(calls[0]?.functionName).toBe("isRequestSettled");
    expect(calls[0]?.args).toEqual([ZERO_HASH]);
  });
});

describe("the revenue read", () => {
  it("asks every per-leg figure for all four legs, per asset", async () => {
    const { client, calls } = stubClient();

    const snapshot = await read.readRevenue(client, { router: ROUTER, asset: ASSET });

    for (const perLeg of ["destinationOf", "totalAllocated", "totalSettled", "pending"]) {
      expect(callsTo(calls, perLeg), perLeg).toHaveLength(4);
    }

    // The legs come back in the library's canonical order, which is the order every
    // event reports and every column is named after.
    expect(snapshot.legs.map((leg) => leg.name)).toEqual([
      "operations",
      "buybacks",
      "developer",
      "protocol",
    ]);
    expect(snapshot.legs.map((leg) => leg.leg)).toEqual([0, 1, 2, 3]);

    // Every per-leg figure is asked about the asset as well as the leg. A call missing
    // the asset would answer about whichever one the router happened to key on.
    expect(callsTo(calls, "totalAllocated").map((call) => call.args)).toEqual([
      [ASSET, 0n],
      [ASSET, 1n],
      [ASSET, 2n],
      [ASSET, 3n],
    ]);
    expect(callsTo(calls, "destinationOf").map((call) => call.args)).toEqual([
      [0n],
      [1n],
      [2n],
      [3n],
    ]);
  });
});

describe("the service reads", () => {
  it("derives an id from the agent and a name", async () => {
    const { client, calls } = stubClient();

    await read.readServiceId(client, {
      serviceRegistry: SERVICE_REGISTRY,
      agentId: AGENT_ID,
      name: ZERO_HASH,
    });

    expect(calls[0]?.args).toEqual([AGENT_ID, ZERO_HASH]);
  });

  it("reads a listing's record, its payee and its effective activity", async () => {
    const { client, calls } = stubClient();
    const serviceId = `0x${"cd".repeat(32)}` as Hex;

    await read.readServiceListings(client, {
      serviceRegistry: SERVICE_REGISTRY,
      serviceIds: [serviceId],
    });

    // Three reads per service, and the second two are the point: neither the payee nor
    // the effective `active` is a field on the record, and using `service.active` would
    // preflight a payment as fine that the chain then refuses.
    expect(callsTo(calls, "serviceOf")).toHaveLength(1);
    expect(callsTo(calls, "payeeOf")).toHaveLength(1);
    expect(callsTo(calls, "isActive")).toHaveLength(1);
  });

  it("asks for nothing when there are no services", async () => {
    const { client, calls } = stubClient();

    const listings = await read.readServiceListings(client, {
      serviceRegistry: SERVICE_REGISTRY,
      serviceIds: [],
    });

    expect(listings.size).toBe(0);
    expect(calls).toEqual([]);
  });
});

describe("the whole-agent snapshot", () => {
  it("reads one clock and gives every period figure the same instant", async () => {
    const { client, calls } = stubClient();

    const snapshot = await read.readAgentSnapshot(client, {
      identityRegistry: IDENTITY_REGISTRY,
      agentId: AGENT_ID,
    });

    // Carried on the snapshot rather than discarded, so a consumer comparing an
    // interval or an expiry compares against the clock the treasury answered from.
    expect(snapshot.at).toBe(1_700_000_000n);

    expect(callsTo(calls, "agentOf")).toHaveLength(1);
    expect(callsTo(calls, "approvedAssets")).toHaveLength(1);
    expect(callsTo(calls, "operator")).toHaveLength(1);
  });

  it("holds together with no approved assets, which is not a state the contracts allow", async () => {
    const { client } = stubClient();

    // The stub's mandate approves nothing, which `AgentMandate` refuses to deploy. It is
    // worth passing anyway: a snapshot that divided by the asset count, or indexed
    // `assets[0]`, would throw here rather than on the one agent that produced it.
    const snapshot = await read.readAgentSnapshot(client, {
      identityRegistry: IDENTITY_REGISTRY,
      agentId: AGENT_ID,
    });

    expect(snapshot.treasury.assets).toEqual([]);
    expect(snapshot.revenue).toEqual([]);
  });
});

describe("hasMarket", () => {
  it("is false for the zero hash and true for anything else", () => {
    const base = { poolId: ZERO_HASH } as read.AgentRecord;

    expect(read.hasMarket(base)).toBe(false);
    expect(read.hasMarket({ ...base, poolId: `0x${"01".repeat(32)}` as Hex })).toBe(true);
  });
});
