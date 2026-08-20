import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { getAddress, type Address, type Hex } from "viem";

import { derive, instantParams, validate } from "../instant";
import { AgentError } from "./errors";
import { issueApiKey, lookLikeApiKey } from "./keys";
import {
  assertAgentOperable,
  assertCannotChooseWallet,
  assertCannotSelfModify,
  assertCreatorBuy,
  assertLaunchTypeAllowed,
  assertNoExternalTransfer,
  parsePermissions,
} from "./permissions";
import { encodeSession, issueChallenge, ownerChallengeMessage, readSession, redeemChallenge } from "./auth";
import { AgentStore, resetAgentStoreForTests } from "./store";
import { DEFAULT_PERMISSIONS } from "./types";
import { createIsolatedWallet, unlockWallet } from "./wallets";
import {
  agentInstantLaunch,
  agentLaunchBuild,
  agentStartBuild,
  claimAgentRevenue,
  createAgent,
  createAgentKey,
  publicAgentView,
  rejectAgentSelfModify,
  rejectExternalTransfer,
  rejectWalletOverride,
  revokeAgentKey,
  setAgentStatus,
} from "./service";
import { draftFromRequest, spendWeiOf } from "./instant";
import { parseBuildRequest } from "./programmable";
import { attributionForToken } from "./attribution";

const OWNER = "0x1f23c28F93aE48E6346DD05Ca66ba5e2213b00b8" as Address;
const OTHER = "0xed91105C6f6F45185A80509402CB4C941918ac63" as Address;
const TOKEN = "0x1111111111111111111111111111111111111111" as Address;

vi.mock("./instant", async (original) => {
  const actual = await original<typeof import("./instant")>();
  const token = "0x1111111111111111111111111111111111111111" as Address;
  const pool = `0x${"22".repeat(32)}` as Hex;
  const tx = `0x${"33".repeat(32)}` as Hex;
  return {
    ...actual,
    executeInstantLaunch: vi.fn(async (_store, agent: { walletAddress: Address }, body: { initialBuy?: string }) => {
      const value = body.initialBuy;
      let spend = 0n;
      if (value !== undefined && value.trim() !== "") {
        const [whole = "0", frac = ""] = value.trim().split(".");
        spend = BigInt(`${whole === "" ? "0" : whole}${frac.padEnd(18, "0").slice(0, 18)}`);
      }
      return {
        token,
        poolId: pool,
        txHash: tx,
        feeRecipient: agent.walletAddress,
        spendWei: spend,
      };
    }),
  };
});

vi.mock("./programmable", async (original) => {
  const actual = await original<typeof import("./programmable")>();
  const token = "0x1111111111111111111111111111111111111111" as Address;
  const hook = "0xed91105C6f6F45185A80509402CB4C941918ac63" as Address;
  const tx = `0x${"33".repeat(32)}` as Hex;
  return {
    ...actual,
    startAgentBuild: vi.fn(async (store: AgentStore, agent: { id: string }, body: Record<string, unknown>) => {
      const parsed = actual.parseBuildRequest(body);
      store.linkBuild({ jobId: "job-ready", agentId: agent.id, createdAt: Math.floor(Date.now() / 1000) });
      return {
        id: "job-ready",
        stage: "prompt_received",
        name: parsed.name,
        symbol: parsed.symbol,
        prompt: parsed.prompt,
      };
    }),
    launchAgentBuild: vi.fn(async (store: AgentStore, agent: { id: string }, jobId: string) => {
      if (jobId === "job-blocked") {
        const error = new Error("This build was not cleared for deployment.") as Error & { code: string; status: number };
        error.code = "BUILD_NOT_READY";
        error.status = 409;
        throw error;
      }
      if (store.buildOwner(jobId) !== agent.id) {
        const error = new Error("There is no build with that id for this agent.") as Error & { code: string };
        error.code = "BUILD_NOT_FOUND";
        throw error;
      }
      return {
        token,
        hook,
        txHash: tx,
        buyTxHash: null,
        spendWei: 0n,
        jobId,
      };
    }),
    readAgentBuild: vi.fn(async (store: AgentStore, agentId: string, jobId: string) => {
      if (store.buildOwner(jobId) !== agentId) {
        const error = new Error("There is no build with that id for this agent.") as Error & { code: string };
        error.code = "BUILD_NOT_FOUND";
        throw error;
      }
      return { id: jobId, stage: jobId === "job-blocked" ? "failed" : "deployment_ready" };
    }),
  };
});

function openStore(): AgentStore {
  const dir = mkdtempSync(join(tmpdir(), "agen-agents-"));
  return new AgentStore(join(dir, "agents.db"));
}

function atlas(store: AgentStore, permissions: Record<string, unknown> = {}) {
  return createAgent(
    OWNER,
    {
      name: "Atlas",
      username: "atlas",
      description: "An autonomous agent.",
      imageUrl: "https://agen.space/api/images/atlas.png",
      permissions: { ...DEFAULT_PERMISSIONS, ...permissions },
    },
    store,
  );
}

describe("agen.space agents — Phase 1", () => {
  let store: AgentStore;

  beforeEach(() => {
    store = openStore();
    resetAgentStoreForTests(store);
  });

  afterEach(() => {
    store.close();
    resetAgentStoreForTests(null);
  });

  it("1. creates an Agent", () => {
    const { agent } = atlas(store);
    expect(agent.name).toBe("Atlas");
    expect(agent.username).toBe("atlas");
    expect(agent.ownerAddress).toBe(getAddress(OWNER));
    expect(agent.status).toBe("active");
    expect(publicAgentView(agent).url).toBe("/agents/atlas");
  });

  it("2. assigns an isolated wallet", () => {
    const first = atlas(store);
    const second = createAgent(OWNER, { name: "Bolt", username: "bolt" }, store);
    expect(first.agent.walletAddress).not.toBe(second.agent.walletAddress);

    const walletA = store.getWallet(first.agent.id)!;
    const walletB = store.getWallet(second.agent.id)!;
    expect(walletA.ciphertext).not.toBe(walletB.ciphertext);
    expect(walletA.salt).not.toBe(walletB.salt);

    const keyA = unlockWallet(walletA);
    const keyB = unlockWallet(walletB);
    expect(keyA).not.toBe(keyB);
    expect(privateKeyToAccount(keyA).address).toBe(first.agent.walletAddress);
    expect(privateKeyToAccount(keyB).address).toBe(second.agent.walletAddress);
  });

  it("3. issues an API key that works", () => {
    const { agent } = atlas(store);
    const issued = createAgentKey(OWNER, agent.id, store);
    expect(lookLikeApiKey(issued.secret)).toBe(true);
    const found = store.findApiKeyBySecret(issued.secret);
    expect(found?.agentId).toBe(agent.id);
    expect(found?.revokedAt).toBeNull();
  });

  it("4. rejects an invalid key", () => {
    expect(store.findApiKeyBySecret("agn_not-a-real-key")).toBeNull();
  });

  it("5. rejects a revoked key", () => {
    const { agent } = atlas(store);
    const issued = createAgentKey(OWNER, agent.id, store);
    revokeAgentKey(OWNER, agent.id, issued.id, store);
    const found = store.findApiKeyBySecret(issued.secret);
    expect(found?.revokedAt).not.toBeNull();
  });

  it("6. rejects a paused Agent", async () => {
    const { agent } = atlas(store);
    setAgentStatus(OWNER, agent.id, "paused", store);
    await expect(
      agentInstantLaunch(store, store.getAgent(agent.id)!, null, {
        name: "Atlas",
        symbol: "ATLAS",
        imageUrl: "https://agen.space/api/images/a.png",
      }),
    ).rejects.toMatchObject({ code: "AGENT_PAUSED" });
  });

  it("7. Instant-disabled Agent cannot launch Instant", async () => {
    const { agent } = atlas(store, { instantAllowed: false });
    await expect(
      agentInstantLaunch(store, agent, null, {
        name: "Atlas",
        symbol: "ATLAS",
        imageUrl: "https://agen.space/api/images/a.png",
      }),
    ).rejects.toMatchObject({ code: "PERMISSION_INSTANT_DISABLED", permission: "instantAllowed" });
  });

  it("8. Programmable-disabled Agent cannot start a Programmable build", async () => {
    const { agent } = atlas(store, { programmableAllowed: false });
    await expect(
      agentStartBuild(store, agent, null, {
        name: "Atlas",
        symbol: "ATLAS",
        prompt: "Launch a token called Atlas with ticker ATLAS and a 1% sell fee.",
      }),
    ).rejects.toMatchObject({ code: "PERMISSION_PROGRAMMABLE_DISABLED" });
  });

  it("9. enforces the per-launch spending limit", async () => {
    const { agent } = atlas(store, { maxEthPerLaunchWei: 50_000_000_000_000_000n });
    await expect(
      agentInstantLaunch(store, agent, null, {
        name: "Atlas",
        symbol: "ATLAS",
        imageUrl: "https://agen.space/api/images/a.png",
        initialBuy: "0.08",
      }),
    ).rejects.toMatchObject({ code: "PERMISSION_MAX_CREATOR_BUY", permission: "maxCreatorBuy" });
  });

  it("10. enforces the daily spending limit", async () => {
    const { agent } = atlas(store, {
      maxEthPerLaunchWei: 100_000_000_000_000_000n,
      maxEthPerDayWei: 150_000_000_000_000_000n,
      maxCreatorBuyWei: 100_000_000_000_000_000n,
      maxLaunchesPerDay: 10,
    });

    await agentInstantLaunch(store, agent, null, {
      name: "One",
      symbol: "ONE",
      imageUrl: "https://agen.space/api/images/a.png",
      initialBuy: "0.10",
    });

    await expect(
      agentInstantLaunch(store, agent, null, {
        name: "Two",
        symbol: "TWO",
        imageUrl: "https://agen.space/api/images/a.png",
        initialBuy: "0.10",
      }),
    ).rejects.toMatchObject({ code: "PERMISSION_MAX_ETH_PER_DAY", permission: "maxEthPerDay" });
  });

  it("11. enforces the daily launch limit", async () => {
    const { agent } = atlas(store, { maxLaunchesPerDay: 1 });
    await agentInstantLaunch(store, agent, null, {
      name: "One",
      symbol: "ONE",
      imageUrl: "https://agen.space/api/images/a.png",
    });
    await expect(
      agentInstantLaunch(store, agent, null, {
        name: "Two",
        symbol: "TWO",
        imageUrl: "https://agen.space/api/images/a.png",
      }),
    ).rejects.toMatchObject({ code: "PERMISSION_MAX_LAUNCHES_PER_DAY" });
  });

  it("12. concurrent requests cannot bypass limits", async () => {
    const { agent } = atlas(store, { maxLaunchesPerDay: 1 });
    const body = { name: "Race", symbol: "RACE", imageUrl: "https://agen.space/api/images/a.png" };
    const results = await Promise.allSettled([
      agentInstantLaunch(store, agent, null, body),
      agentInstantLaunch(store, agent, null, { ...body, name: "Race2", symbol: "RAC2" }),
    ]);
    const won = results.filter((row) => row.status === "fulfilled");
    const lost = results.filter((row) => row.status === "rejected");
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect((lost[0] as PromiseRejectedResult).reason).toMatchObject({
      code: "PERMISSION_MAX_LAUNCHES_PER_DAY",
    });
  });

  it("13. an Agent cannot modify its own permissions", () => {
    expect(() => rejectAgentSelfModify()).toThrow(AgentError);
    try {
      assertCannotSelfModify();
    } catch (error) {
      expect(error).toMatchObject({ code: "PERMISSION_SELF_MODIFY" });
    }
  });

  it("14. an Agent cannot choose another wallet", () => {
    expect(() => rejectWalletOverride({ creator: OTHER })).toThrowError(/cannot choose a signer/);
    expect(() => assertCannotChooseWallet()).toThrowError(/cannot choose a signer/);
  });

  it("15. an Agent cannot perform an arbitrary external transfer", () => {
    expect(() => rejectExternalTransfer()).toThrowError(/External transfers are disabled/);
    expect(() => assertNoExternalTransfer()).toThrowError(/External transfers/);
  });

  it("16. Instant launch uses the existing Instant draft / params", () => {
    const draft = draftFromRequest(
      {
        name: "Atlas",
        symbol: "ATLAS",
        imageUrl: "https://agen.space/api/images/a.png",
        description: "Launched by Atlas.",
        initialBuy: "0.01",
      },
      OWNER,
    );
    const derived = derive(draft, OWNER);
    expect(derived?.name).toBe("Atlas");
    expect(derived?.symbol).toBe("ATLAS");
    expect(derived?.feeRecipient).toBe(getAddress(OWNER));
    expect(derived?.initialBuyWei).toBe(10_000_000_000_000_000n);
    expect(validate(draft, OWNER).filter((problem) => !/held|public address/i.test(problem))).toEqual([]);
    const params = instantParams({
      derived: derived!,
      metadataURI: "https://agen.space/api/metadata/x.json",
      salt: ("0x" + "11".repeat(32)) as Hex,
      feeRecipient: OWNER,
    });
    expect(params.name).toBe("Atlas");
    expect(params.feeRecipient).toBe(OWNER);
    expect(params.initialBuyAmount).toBe(10_000_000_000_000_000n);
    expect(spendWeiOf(draft, OWNER)).toBe(10_000_000_000_000_000n);
  });

  it("17. Programmable builds use the same request bounds as the human compiler route", () => {
    const parsed = parseBuildRequest({
      name: "Atlas",
      symbol: "ATLAS",
      prompt: "Launch a token called Atlas with ticker ATLAS. Sells pay 1%.",
    });
    expect(parsed.symbol).toBe("ATLAS");
    expect(() => parseBuildRequest({ name: "A", symbol: "A", prompt: "short" })).toThrow(AgentError);
  });

  it("18. Programmable launch respects the global production gate", async () => {
    const { agent } = atlas(store);
    store.linkBuild({ jobId: "job-blocked", agentId: agent.id, createdAt: Math.floor(Date.now() / 1000) });
    await expect(agentLaunchBuild(store, agent, null, "job-blocked", {})).rejects.toMatchObject({
      code: "PROGRAMMABLE_HELD",
    });
  });

  it("19. a successful launch is attributed to the Agent", async () => {
    const { agent } = atlas(store);
    const result = await agentInstantLaunch(store, agent, null, {
      name: "Atlas",
      symbol: "ATLAS",
      imageUrl: "https://agen.space/api/images/a.png",
    });
    expect(result.token).toBe(TOKEN);
    const found = store.launchByToken(TOKEN);
    expect(found?.agentId).toBe(agent.id);
    expect(found?.agentWallet).toBe(agent.walletAddress);
    expect(found?.kind).toBe("instant");
    resetAgentStoreForTests(store);
    const attribution = attributionForToken(TOKEN);
    expect(attribution?.agent.username).toBe("atlas");
  });

  it("20. a normal human launch has no agent attribution", () => {
    expect(attributionForToken(TOKEN)).toBeNull();
    const draft = draftFromRequest(
      { name: "Human", symbol: "HUM", imageUrl: "https://agen.space/api/images/a.png" },
      OWNER,
    );
    expect(derive(draft, OWNER)?.feeRecipient).toBe(getAddress(OWNER));
  });

  it("21. a public Agent profile loads", () => {
    const { agent } = atlas(store);
    const view = publicAgentView(agent, { launches: 0 });
    expect(view.username).toBe("atlas");
    expect(view.label).toBe("Autonomous Agent");
    expect(view.walletAddress).toBe(agent.walletAddress);
    expect(store.getAgentByUsername("atlas")?.id).toBe(agent.id);
  });

  it("22. a launch appears on the Agent", async () => {
    const { agent } = atlas(store);
    await agentInstantLaunch(store, agent, null, {
      name: "Atlas",
      symbol: "ATLAS",
      imageUrl: "https://agen.space/api/images/a.png",
    });
    const launches = store.listLaunches(agent.id);
    expect(launches).toHaveLength(1);
    expect(launches[0]?.token).toBe(TOKEN);
    expect(launches[0]?.name).toBe("Atlas");
  });

  it("23. creator revenue maps to the launching Agent", async () => {
    const { agent } = atlas(store);
    await agentInstantLaunch(store, agent, null, {
      name: "Atlas",
      symbol: "ATLAS",
      imageUrl: "https://agen.space/api/images/a.png",
    });
    store.upsertRevenue({
      agentId: agent.id,
      token: TOKEN,
      lifetimeWei: 42_000_000_000_000_000n,
      claimedWei: 0n,
    });
    const rows = store.listRevenue(agent.id);
    expect(rows[0]?.token).toBe(TOKEN);
    expect(rows[0]?.lifetimeWei).toBe(42_000_000_000_000_000n);
  });

  it("24. an Agent cannot claim another Agent's revenue", async () => {
    const atlasAgent = atlas(store);
    await agentInstantLaunch(store, atlasAgent.agent, null, {
      name: "Atlas",
      symbol: "ATLAS",
      imageUrl: "https://agen.space/api/images/a.png",
    });
    const bolt = createAgent(OWNER, { name: "Bolt", username: "bolt" }, store);
    await expect(
      claimAgentRevenue(store, { agent: bolt.agent, asOwner: true }, TOKEN),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("25. the activity log records important actions without secrets", () => {
    const { agent } = atlas(store);
    const issued = createAgentKey(OWNER, agent.id, store);
    const activity = store.listActivity(agent.id);
    const types = activity.map((row) => row.type);
    expect(types).toContain("agent_created");
    expect(types).toContain("key_created");
    const serialised = JSON.stringify(activity);
    expect(serialised).not.toContain(issued.secret);
    expect(serialised).not.toMatch(/"ciphertext"/);
    expect(activity.find((row) => row.type === "key_created")?.payload).toMatchObject({
      prefix: issued.prefix,
    });
  });

  it("26. archive and pause do not remove already-launched markets", async () => {
    const { agent } = atlas(store);
    await agentInstantLaunch(store, agent, null, {
      name: "Atlas",
      symbol: "ATLAS",
      imageUrl: "https://agen.space/api/images/a.png",
    });
    setAgentStatus(OWNER, agent.id, "paused", store);
    expect(store.listLaunches(agent.id)[0]?.token).toBe(TOKEN);
    setAgentStatus(OWNER, agent.id, "archived", store);
    expect(store.listLaunches(agent.id)[0]?.status).toBe("succeeded");
    resetAgentStoreForTests(store);
    expect(attributionForToken(TOKEN)?.agent.username).toBe("atlas");
    expect(store.listPublicAgents().some((row) => row.username === "atlas")).toBe(false);
  });
});

describe("a month of an agent's spending", () => {
  let store: AgentStore;

  beforeEach(() => {
    store = openStore();
    resetAgentStoreForTests(store);
  });

  afterEach(() => {
    store.close();
    resetAgentStoreForTests(null);
  });

  it("returns every day in the window, including the ones nothing happened on", () => {
    const { agent } = atlas(store);
    const history = store.spendHistory(agent.id, 30, "2026-03-15");

    expect(history).toHaveLength(30);
    expect(history[0]?.day).toBe("2026-02-14");
    expect(history[29]?.day).toBe("2026-03-15");
    expect(history.every((day) => day.spentWei === 0n)).toBe(true);
  });

  it("reads back what was actually spent, on the day it was spent", () => {
    const { agent } = atlas(store);
    const spend = store.db.prepare(
      "INSERT INTO agent_spend_days (agent_id, day, launches, spent_wei) VALUES (?, ?, ?, ?)",
    );
    spend.run(agent.id, "2026-03-14", 2, "2000000000000000");
    spend.run(agent.id, "2026-03-10", 1, "1000000000000000");

    const history = store.spendHistory(agent.id, 30, "2026-03-15");
    const busy = history.filter((day) => day.spentWei > 0n);

    expect(busy.map((day) => day.day)).toEqual(["2026-03-10", "2026-03-14"]);
    expect(busy[1]?.spentWei).toBe(2_000_000_000_000_000n);
    expect(busy[1]?.launches).toBe(2);
  });

  it("stops at the edge of the window rather than reaching back past it", () => {
    const { agent } = atlas(store);
    store.db
      .prepare("INSERT INTO agent_spend_days (agent_id, day, launches, spent_wei) VALUES (?, ?, ?, ?)")
      .run(agent.id, "2026-01-01", 9, "9000000000000000");

    const history = store.spendHistory(agent.id, 30, "2026-03-15");
    expect(history.some((day) => day.spentWei > 0n)).toBe(false);
  });
});

describe("agent wallets and sessions", () => {
  it("a wrapping key for one agent cannot unlock another", () => {
    const a = createIsolatedWallet("agent-a");
    const b = createIsolatedWallet("agent-b");
    const swapped = { ...a.record, agentId: "agent-b", salt: b.record.salt };
    expect(() => unlockWallet(swapped)).toThrow();
  });

  it("owner sessions verify a signed challenge", async () => {
    const store = openStore();
    const account = privateKeyToAccount(generatePrivateKey());
    const challenge = issueChallenge(store, account.address);
    expect(challenge.message).toBe(
      ownerChallengeMessage(account.address, challenge.nonce, challenge.expiresAt),
    );
    const signature = await account.signMessage({ message: challenge.message });
    const session = await redeemChallenge(store, {
      address: account.address,
      nonce: challenge.nonce,
      signature,
    });
    expect(readSession(session.token)).toBe(account.address);
    expect(() => readSession(encodeSession(account.address, Math.floor(Date.now() / 1000) - 10))).toThrow(
      /expired/,
    );
    store.close();
  });

  it("permissions stay tight: transfers off, approved contracts on", () => {
    const parsed = parsePermissions({
      instantAllowed: true,
      externalTransfers: true,
      approvedContractsOnly: false,
    });
    expect(parsed.externalTransfers).toBe(false);
    expect(parsed.approvedContractsOnly).toBe(true);
    expect(() => assertLaunchTypeAllowed(parsed, "programmable")).not.toThrow();
    expect(() => assertCreatorBuy(parsed, parsed.maxCreatorBuyWei + 1n)).toThrow(AgentError);
    expect(() =>
      assertAgentOperable({
        id: "x",
        username: "x",
        name: "x",
        description: "",
        imageUrl: null,
        ownerAddress: OWNER,
        walletAddress: OWNER,
        status: "paused",
        kind: "agent",
        createdAt: 0,
        updatedAt: 0,
      }),
    ).toThrowError(/paused/);
  });

  it("API key hashes are unique per secret", () => {
    const a = issueApiKey("agent");
    const b = issueApiKey("agent");
    expect(a.issued.secret).not.toBe(b.issued.secret);
    expect(a.record.hash).not.toBe(b.record.hash);
  });
});
