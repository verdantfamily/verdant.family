/**
 * The tool surface, as a client discovers it.
 *
 * A client decides whether to ask a human before running a tool by reading `readOnlyHint`. So
 * the split between reading and launching is not only a code boundary — it is metadata on the
 * wire, and a tool registered with the wrong hint would be auto-approved by a client that had
 * every right to expect otherwise. That is what this file guards.
 *
 * Driven through an in-memory client pair rather than by inspecting internals, so it tests the
 * protocol output rather than the registration call.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { loadEnv } from "./env.js";
import { silentLogger } from "./logger.js";
import { buildServer } from "./server.js";

const READS = ["get_launch_quote", "get_launch_status", "get_token", "get_pool", "get_launches", "get_instant_metrics"];

/** Neither is read-only. Only the second can spend anything. */
const PREPARE = "prepare_instant_launch";
const TREASURY = "launch_instant_from_agent_treasury";
const WRITES = [PREPARE, TREASURY];

let tools: Awaited<ReturnType<Client["listTools"]>>["tools"];

/**
 * A real client over a real protocol pair, with `env` overrides and no network.
 *
 * The client matters: it validates `structuredContent` against each tool's declared
 * `outputSchema`, which is the check that a hand-rolled caller would skip.
 */
async function connect(
  overrides: Record<string, string | undefined> = {},
  fetchImpl: typeof fetch = () => {
    throw new Error("this test must not make a network request");
  },
): Promise<Client> {
  const { server } = buildServer({
    env: loadEnv({ AGEN_API_KEY: "agn_testkeytestkeytestkey", AGEN_INSTANT_FEED_URL: "https://feed.test", ...overrides }),
    logger: silentLogger(),
    fetchImpl,
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
}

beforeAll(async () => {
  tools = (await (await connect()).listTools()).tools;
});

describe("the advertised surface", () => {
  it("is exactly the eight v1 tools", () => {
    expect(tools.map((tool) => tool.name).sort()).toEqual([...READS, ...WRITES].sort());
  });

  it("no longer offers the combined create_instant_launch", () => {
    expect(tools.map((tool) => tool.name)).not.toContain("create_instant_launch");
  });

  it("marks every read read-only and idempotent", () => {
    for (const name of READS) {
      const tool = tools.find((entry) => entry.name === name);
      expect(tool?.annotations?.readOnlyHint, name).toBe(true);
      expect(tool?.annotations?.idempotentHint, name).toBe(true);
    }
  });

  /**
   * Preparing holds no key and spends nothing, but it stores a metadata document and consumes
   * a launch allowance. A read-only hint would let a client auto-approve that.
   */
  it("marks both launch tools as neither read-only nor idempotent", () => {
    for (const name of WRITES) {
      const tool = tools.find((entry) => entry.name === name);
      expect(tool?.annotations?.readOnlyHint, name).toBe(false);
      expect(tool?.annotations?.idempotentHint, name).toBe(false);
    }
  });

  it("marks both launch tools non-destructive, since they create rather than alter", () => {
    for (const name of WRITES) {
      expect(tools.find((entry) => entry.name === name)?.annotations?.destructiveHint, name).toBe(false);
    }
  });

  it("declares every tool as reaching outside this process", () => {
    for (const tool of tools) {
      expect(tool.annotations?.openWorldHint, tool.name).toBe(true);
    }
  });
});

/**
 * The whole point of the split: a client reading the tool list can tell which call can move
 * money without reading a parameter's description.
 */
describe("the two launch paths are separate on the wire", () => {
  it("gives preparing an output that can only ever say prepared", () => {
    const schema = tools.find((entry) => entry.name === PREPARE)?.outputSchema as {
      properties?: Record<string, { const?: unknown; enum?: unknown[] }>;
    };

    expect(schema.properties?.execution_status).toMatchObject({ const: "prepared" });
    expect(schema.properties?.requires_signature).toMatchObject({ const: true });
    expect(schema.properties?.requires_broadcast).toMatchObject({ const: true });
    expect(schema.properties?.signedBy).toMatchObject({ const: "caller_wallet" });
  });

  it("gives the treasury path an output that can only ever say already done", () => {
    const schema = tools.find((entry) => entry.name === TREASURY)?.outputSchema as {
      properties?: Record<string, { const?: unknown }>;
    };

    expect(schema.properties?.requires_signature).toMatchObject({ const: false });
    expect(schema.properties?.requires_broadcast).toMatchObject({ const: false });
    expect(schema.properties?.signedBy).toMatchObject({ const: "agen_agent_treasury" });
  });

  it("says in the preparing description that this server signs nothing", () => {
    const description = tools.find((entry) => entry.name === PREPARE)?.description ?? "";
    expect(description).toMatch(/nothing is signed, sent or spent/i);
    expect(description).toMatch(/your own wallet/i);
  });

  it("says in the treasury description that it spends real money", () => {
    const description = tools.find((entry) => entry.name === TREASURY)?.description ?? "";
    expect(description).toMatch(/spends real money/i);
    expect(description).toMatch(/refused rather than ignored/i);
  });

  it("keeps feeReceiver on the treasury tool so that it can be refused rather than stripped", () => {
    const schema = tools.find((entry) => entry.name === TREASURY)?.inputSchema as {
      properties?: Record<string, unknown>;
    };
    expect(Object.keys(schema.properties ?? {})).toContain("feeReceiver");
  });

  it("leaves no execution parameter behind on either", () => {
    for (const name of WRITES) {
      const schema = tools.find((entry) => entry.name === name)?.inputSchema as { properties?: Record<string, unknown> };
      expect(Object.keys(schema.properties ?? {}), name).not.toContain("execution");
    }
  });
});

describe("descriptions stand alone", () => {
  it("gives every tool a title, a description and an output schema", () => {
    for (const tool of tools) {
      expect(tool.annotations?.title ?? tool.title, tool.name).toBeTruthy();
      expect((tool.description ?? "").length, tool.name).toBeGreaterThan(80);
      expect(tool.outputSchema, tool.name).toBeDefined();
    }
  });

  it("states the constants an agent would otherwise have to read the contracts for", () => {
    const launch = tools.find((entry) => entry.name === PREPARE)?.description ?? "";
    expect(launch).toContain("1000000000");
    expect(launch).toMatch(/not a parameter/i);
    expect(launch).toMatch(/immutable/i);
  });

  it("explains the absence of a trending sort where an agent would look for it", () => {
    expect(tools.find((entry) => entry.name === "get_launches")?.description ?? "").toMatch(/no trending/i);
  });
});

/**
 * The bug this describes is the reason these tests go through a client at all.
 *
 * A failure used to be returned as `structuredContent`, which reads as the obvious thing to do
 * and passes any test that inspects the result directly. A validating client rejects it: it
 * checks `structuredContent` against the output schema whenever the field is present, error or
 * not. So every error — a missing API key, a reverted launch — reached the agent as a schema
 * validation exception from its own transport instead of as a code it could act on.
 */
describe("failures reach the caller intact", () => {
  let client: Client;

  beforeEach(async () => {
    client = await connect({ AGEN_API_KEY: undefined });
  });

  it("does not throw at a client that validates output schemas", async () => {
    const result = await client.callTool({ name: "get_launch_quote", arguments: { name: "Atlas", symbol: "ATLAS" } });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
  });

  it("carries a code and a message an agent can act on", async () => {
    const result = await client.callTool({ name: "get_launch_quote", arguments: { name: "Atlas", symbol: "ATLAS" } });

    const text = (result.content as { type: string; text: string }[])[0]?.text ?? "";
    expect(JSON.parse(text)).toMatchObject({
      ok: false,
      error: { code: "UNAUTHORIZED", message: expect.stringContaining("AGEN_API_KEY") },
    });
  });

  it("rejects a malformed address before the tool runs, naming the field", async () => {
    const result = await client.callTool({ name: "get_token", arguments: { token: "0xnope" } });

    expect(result.isError).toBe(true);
    const text = (result.content as { type: string; text: string }[])[0]?.text ?? "";
    expect(text).toMatch(/token/);
    expect(text).toMatch(/20-byte hex address/);
  });

  it("reports an unreachable backend as a code rather than a transport error", async () => {
    const result = await client.callTool({ name: "get_instant_metrics", arguments: {} });

    expect(result.isError).toBe(true);
    const text = (result.content as { type: string; text: string }[])[0]?.text ?? "";
    expect(JSON.parse(text)).toMatchObject({ error: { code: "BACKEND_UNAVAILABLE" } });
  });
});

/**
 * The other half of the same property: a successful body must satisfy the schema it is
 * advertised under. Driven through the client, so schema drift fails here rather than at an
 * agent.
 */
describe("successful output validates against the advertised schema", () => {
  it("for get_instant_metrics, whose output is entirely derived", async () => {
    const client = await connect({}, async () =>
      new Response(JSON.stringify(FEED_METRICS), { status: 200, headers: { "content-type": "application/json" } }),
    );

    const result = await client.callTool({ name: "get_instant_metrics", arguments: {} });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({ markets: 42, creators: 7 });
    expect((result.structuredContent as { terms: { supplyTokens: string } }).terms.supplyTokens).toBe("1000000000");
  });

  /**
   * The literals are the risk here: `execution_status`, `requires_signature` and
   * `requires_broadcast` are declared as constants, so a tool returning anything else is
   * rejected by the client rather than quietly believed.
   */
  it("for prepare_instant_launch, whose safety claims are schema constants", async () => {
    const client = await connect({}, async () =>
      new Response(JSON.stringify({ ok: true, data: PREPARED }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const result = await client.callTool({
      name: PREPARE,
      arguments: { name: "Atlas", symbol: "ATLAS", imageUrl: "https://agen.space/api/images/a.png", signer: PREPARED.signer },
    });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      execution_status: "prepared",
      requires_signature: true,
      requires_broadcast: true,
      signedBy: "caller_wallet",
      txHash: null,
    });
  });
});

const PREPARED = {
  chainId: 4663,
  signer: "0x1111111111111111111111111111111111111111",
  transaction: { to: "0xF85b06710E2CbEf54230c92733e12824c8fCa2D6", data: "0xabcdef", value: "0", chainId: 4663 },
  escrowTransaction: null,
  token: "0x1234567890123456789012345678901234567890",
  salt: `0x${"aa".repeat(32)}`,
  metadataURI: "https://agen.space/api/metadata/abc.json",
  feeRecipient: "0x9999999999999999999999999999999999999999",
  feePayoutAddress: "0x9999999999999999999999999999999999999999",
  name: "Atlas",
  symbol: "ATLAS",
  supplyTokens: "1000000000",
  initialBuyWei: "0",
};

const FEED_METRICS = {
  at: 1_760_000_000,
  markets: 42,
  creators: 7,
  trades: 900,
  volume: {
    quote: "5000000000000000000",
    token: "3000000000000000000000000",
    boostQuote: "1000000000000000000",
    boostToken: "500000000000000000000000",
    organicQuote: "4000000000000000000",
    organicToken: "2500000000000000000000000",
  },
  fees: { etherLeg: "75000000000000000", creator: "50000000000000000", platform: "25000000000000000", total: "75000000000000000" },
  boost: { marketsEnabled: 5, spentQuote: "1000000000000000000", sunkToken: "1000000000000000000000", buybacks: 3 },
  day: {
    since: 1_759_913_600,
    volumeQuote: "2000000000000000000",
    boostVolumeQuote: "500000000000000000",
    organicVolumeQuote: "1500000000000000000",
    trades: 120,
    boostBuybacks: 1,
  },
  lastLaunchAt: 1_759_999_000,
};

describe("input schemas reach the client", () => {
  it("so an agent can validate before calling", () => {
    const schema = tools.find((entry) => entry.name === PREPARE)?.inputSchema as {
      properties?: Record<string, unknown>;
      required?: string[];
    };

    expect(Object.keys(schema.properties ?? {})).toContain("feeReceiver");
    expect(Object.keys(schema.properties ?? {})).toContain("signer");
    expect(schema.required).toContain("name");
    expect(schema.required).toContain("symbol");
    expect(schema.required).toContain("imageUrl");
  });

  it("does not advertise a supply the caller can set to anything", () => {
    for (const name of WRITES) {
      const schema = tools.find((entry) => entry.name === name)?.inputSchema as { required?: string[] };
      expect(schema.required ?? [], name).not.toContain("totalSupply");
    }
  });
});
