/**
 * Buying and selling by tweet, and the wallet it comes out of.
 *
 * What is real here is everything that touches somebody's money before a swap is built: the
 * wallet, its key, its owner, the balance check, the gas reserve, and the words the bot says
 * when it will not trade. The chain and the swap are stubbed, because the swap itself is
 * `agents/trade.ts` and is tested there against the same router a person's own trade uses.
 *
 * Two of these are worth reading twice. The one about the gas reserve, because a wallet holding
 * exactly what somebody asked to spend is the most likely first deposit anybody makes and the
 * most annoying way to fail. And the one about the unclaimed owner, because it is the whole
 * custody argument in one assertion: until an address is proved, the wallet has no owner that
 * anybody — Agen included — could withdraw to.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Address } from "viem";
import { beforeEach, describe, expect, it, vi } from "vitest";

const TOKEN = "0x1111111111111111111111111111111111111111" as Address;
const OTHER = "0x2222222222222222222222222222222222222222" as Address;
const OWNER = "0x1f23c28F93aE48E6346DD05Ca66ba5e2213b00b8" as Address;

const ETH = 1_000_000_000_000_000_000n;
/** One gwei, as the stubbed chain prices gas. 1.5M units of it is the reserve. */
const GAS_PRICE = 1_000_000_000n;
const GAS_RESERVE = GAS_PRICE * 1_500_000n;

let balance = 0n;

const readInstantMarket = vi.fn();
const readInstantMarkets = vi.fn();

vi.mock("../onchain", () => ({
  publicClient: () => ({
    getBalance: async () => balance,
    getGasPrice: async () => GAS_PRICE,
    // Read by `readAgentHoldings` for each candidate token. Zero means no position, which
    // keeps the wallet reply about the ether unless a test says otherwise.
    readContract: async () => 0n,
  }),
}));

vi.mock("../instant-markets", () => ({
  readInstantMarket: (...args: unknown[]) => readInstantMarket(...args),
  readInstantMarkets: (...args: unknown[]) => readInstantMarkets(...args),
}));

const { AgentStore } = await import("../agents/store");
const { XStore } = await import("./store");
const { XError } = await import("./errors");
const { executeXTrade } = await import("./trade");
const { linkXWalletOwner, isClaimed, xWalletFor, UNCLAIMED_OWNER } = await import("./wallet");
const { refusalReply, tradeReply, walletReply } = await import("./reply");
const { readAgentHoldings } = await import("../agents/holdings");
const { publicProfile } = await import("../agents/public");

type Agents = InstanceType<typeof AgentStore>;
type X = InstanceType<typeof XStore>;

function stores(): { readonly agents: Agents; readonly store: X } {
  const dir = mkdtempSync(join(tmpdir(), "agen-x-trade-"));
  return { agents: new AgentStore(join(dir, "agents.db")), store: new XStore(join(dir, "x.db")) };
}

function author(id = "770077", username = "trencher") {
  return {
    id,
    username,
    name: "Trencher",
    avatarUrl: null,
    followers: 250,
    createdAt: "2020-01-01T00:00:00.000Z",
    verified: false,
  };
}

function buyIntent(amountWei: bigint | null, token: Address = TOKEN) {
  return {
    side: "buy" as const,
    target: { kind: "address" as const, token },
    amountWei,
    fraction: null,
  };
}

function sellIntent(fraction = 1, token: Address = TOKEN) {
  return {
    side: "sell" as const,
    target: { kind: "address" as const, token },
    amountWei: null,
    fraction,
  };
}

/** What a filled buy looks like coming back from the agent trade layer. */
function filled(overrides: Record<string, unknown> = {}) {
  return {
    side: "buy",
    token: TOKEN,
    symbol: "TEST",
    quoteWei: ETH / 1000n,
    tokenAmount: 1_234_000n * ETH,
    minAmountOut: 1_200_000n * ETH,
    priceImpactBps: 42,
    txHash: `0x${"bb".repeat(32)}`,
    approvalTxHash: null,
    ...overrides,
  };
}

/**
 * Run something that must refuse, and hand back the refusal.
 *
 * Also asserts that it refused at all: a trade that quietly succeeded where a test expected a
 * top-up message is the exact bug these cases exist to catch, and a `.catch` that never fires
 * would let it pass.
 */
async function refused(run: Promise<unknown>): Promise<InstanceType<typeof XError>> {
  try {
    await run;
  } catch (thrown) {
    // An `XError` specifically. A `TypeError` from a mistake in this module would otherwise be
    // caught here and read as a refusal with a code the reply composer would try to speak.
    if (!(thrown instanceof XError)) throw thrown;
    return thrown;
  }
  throw new Error("that was supposed to be refused");
}

beforeEach(() => {
  balance = 0n;
  readInstantMarket.mockReset();
  readInstantMarkets.mockReset();
  readInstantMarket.mockResolvedValue({ token: TOKEN, symbol: "TEST" });
  readInstantMarkets.mockResolvedValue([]);
});

describe("a wallet for an X account", () => {
  it("is made once and found again", () => {
    const { agents, store } = stores();

    const first = xWalletFor("770077", "trencher", { store, agents });
    const second = xWalletFor("770077", "trencher", { store, agents });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.row.address).toBe(first.row.address);
    expect(second.agent.id).toBe(first.agent.id);
  });

  it("gives two accounts two wallets", () => {
    const { agents, store } = stores();
    const one = xWalletFor("770077", "trencher", { store, agents });
    const two = xWalletFor("880088", "other", { store, agents });
    expect(one.row.address).not.toBe(two.row.address);
  });

  it("has no owner until an address is proved", () => {
    const { agents, store } = stores();
    const wallet = xWalletFor("770077", "trencher", { store, agents });

    // The burn address: nobody holds its key, so recovery — which pays the owner on the row
    // and demands a signature from it — cannot be made to pay anybody.
    expect(wallet.agent.ownerAddress).toBe(UNCLAIMED_OWNER);
    expect(isClaimed(wallet.agent)).toBe(false);
  });

  it("takes the owner it is given, and only then can be withdrawn from", () => {
    const { agents, store } = stores();
    xWalletFor("770077", "trencher", { store, agents });

    const linked = linkXWalletOwner("770077", OWNER, { store, agents });
    expect(linked?.ownerAddress).toBe(OWNER);
    expect(isClaimed(linked!)).toBe(true);
    expect(agents.listOwnerAgents(OWNER).map((agent) => agent.id)).toContain(linked!.id);
  });

  it("does nothing when the account never traded", () => {
    const { agents, store } = stores();
    expect(linkXWalletOwner("770077", OWNER, { store, agents })).toBe(null);
  });

  it("stays out of the public agent directory", () => {
    const { agents, store } = stores();
    xWalletFor("770077", "trencher", { store, agents });
    // These are one person's wallet, not a published agent. A directory full of them would be
    // a directory full of rows nobody chose to create.
    expect(agents.listPublicAgents()).toEqual([]);
  });

  it("cannot be named by a username anybody could register", async () => {
    const { agents, store } = stores();
    const wallet = xWalletFor("770077", "trencher", { store, agents });

    // A person's username is letters, numbers and underscores, so a colon puts these rows
    // outside the namespace entirely — no collision to lose a wallet to, and no profile page.
    expect(wallet.agent.username).toBe("x:770077");
    expect(await publicProfile("x:770077", agents)).toBe(null);
  });
});

describe("buying from a post", () => {
  it("spends what the post said, from the wallet that belongs to the poster", async () => {
    const { agents, store } = stores();
    balance = ETH;
    const buy = vi.fn().mockResolvedValue(filled());

    const result = await executeXTrade(author(), buyIntent(ETH / 1000n), {
      store,
      agents,
      buy,
    });

    const wallet = store.walletFor("770077");
    expect(buy).toHaveBeenCalledTimes(1);
    const [, agent, request] = buy.mock.calls[0]!;
    expect((agent as { walletAddress: string }).walletAddress).toBe(wallet?.address);
    expect(request).toEqual({ token: TOKEN, amountWei: ETH / 1000n });
    expect(result.outcome.txHash).toBe(filled().txHash);
  });

  it("says what it bought, with the market to look at", async () => {
    const { agents, store } = stores();
    balance = ETH;
    const result = await executeXTrade(author(), buyIntent(ETH / 1000n), {
      store,
      agents,
      buy: vi.fn().mockResolvedValue(filled()),
    });

    const reply = tradeReply(result);
    expect(reply).toContain("Bought 1.23M $TEST for 0.001 ETH.");
    expect(reply).toContain(`https://agen.space/markets/${TOKEN}`);
  });

  it("asks for a top-up instead of trading, and names the wallet to top up", async () => {
    const { agents, store } = stores();
    balance = 0n;
    const buy = vi.fn();

    const error = await refused(executeXTrade(author(), buyIntent(ETH / 1000n), {
      store,
      agents,
      buy,
    }));

    expect(buy).not.toHaveBeenCalled();
    expect(error.code).toBe("WALLET_UNFUNDED");

    const wallet = store.walletFor("770077");
    // The reply the brief asks for, addressed to the wallet the person was just given.
    expect(refusalReply(error)).toBe(`Please top up your wallet: ${String(wallet?.address)}`);
  });

  it("keeps back enough for gas, so a buy it promised can be mined", async () => {
    const { agents, store } = stores();
    // Exactly the amount asked for and not a wei more: affordable on paper, unmineable in
    // fact. Trading here would fail after the person had been told it was going through.
    balance = ETH / 1000n;
    const buy = vi.fn();

    const error = await refused(executeXTrade(author(), buyIntent(ETH / 1000n), {
      store,
      agents,
      buy,
    }));

    expect(buy).not.toHaveBeenCalled();
    expect(error.code).toBe("WALLET_UNFUNDED");
    expect(error.details.gasReserveWei).toBe(GAS_RESERVE.toString());

    // The same buy goes through once the wallet also holds the gas.
    balance = ETH / 1000n + GAS_RESERVE + 1n;
    const second = vi.fn().mockResolvedValue(filled());
    await executeXTrade(author(), buyIntent(ETH / 1000n), { store, agents, buy: second });
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("tells somebody who did not say how much to say how much", async () => {
    const { agents, store } = stores();
    balance = ETH;
    const buy = vi.fn();

    const error = await refused(executeXTrade(author(), buyIntent(null), { store, agents, buy }));

    expect(buy).not.toHaveBeenCalled();
    expect(error.code).toBe("AMOUNT_MISSING");
    expect(refusalReply(error)).toContain("How much?");
  });

  it("will not trade an address the registry does not know", async () => {
    const { agents, store } = stores();
    balance = ETH;
    readInstantMarket.mockResolvedValue(null);
    const buy = vi.fn();

    const error = await refused(executeXTrade(author(), buyIntent(ETH / 1000n, OTHER), {
      store,
      agents,
      buy,
    }));

    expect(buy).not.toHaveBeenCalled();
    expect(error.code).toBe("TOKEN_NOT_FOUND");
  });

  it("refuses a ticker that names more than one market rather than picking one", async () => {
    const { agents, store } = stores();
    balance = ETH;
    readInstantMarkets.mockResolvedValue([
      { token: TOKEN, symbol: "DOG" },
      { token: OTHER, symbol: "DOG" },
    ]);
    const buy = vi.fn();

    const error = await refused(executeXTrade(
      author(),
      { side: "buy", target: { kind: "ticker", ticker: "DOG" }, amountWei: ETH, fraction: null },
      { store, agents, buy },
    ));

    expect(buy).not.toHaveBeenCalled();
    expect(error.code).toBe("TOKEN_AMBIGUOUS");
  });

  it("resolves a ticker that names exactly one market", async () => {
    const { agents, store } = stores();
    balance = ETH;
    readInstantMarkets.mockResolvedValue([{ token: TOKEN, symbol: "DOG" }]);
    const buy = vi.fn().mockResolvedValue(filled());

    await executeXTrade(
      author(),
      {
        side: "buy",
        target: { kind: "ticker", ticker: "dog" },
        amountWei: ETH / 1000n,
        fraction: null,
      },
      { store, agents, buy },
    );

    expect(buy.mock.calls[0]![2]).toEqual({ token: TOKEN, amountWei: ETH / 1000n });
  });

  it("does not claim nothing was spent when it does not know", async () => {
    const { agents, store } = stores();
    balance = ETH;
    const buy = vi.fn().mockRejectedValue(new Error("timed out waiting for the receipt"));

    const error = await refused(executeXTrade(author(), buyIntent(ETH / 1000n), {
      store,
      agents,
      buy,
    }));

    expect(error.code).toBe("TRADE_FAILED");
    expect(refusalReply(error)).toContain("Check your wallet");
  });

  it("says only gas was spent when the chain refused the swap", async () => {
    const { agents, store } = stores();
    balance = ETH;
    const buy = vi.fn().mockRejectedValue(new Error("The transaction reverted."));

    const error = await refused(executeXTrade(author(), buyIntent(ETH / 1000n), {
      store,
      agents,
      buy,
    }));

    expect(error.code).toBe("TRADE_REVERTED");
    expect(refusalReply(error)).toContain("Only gas was spent.");
  });

  it("will not trade from a wallet its owner has paused", async () => {
    const { agents, store } = stores();
    balance = ETH;
    const wallet = xWalletFor("770077", "trencher", { store, agents });
    agents.updateAgent(wallet.agent.id, { status: "paused" });
    const buy = vi.fn();

    await expect(
      executeXTrade(author(), buyIntent(ETH / 1000n), { store, agents, buy }),
    ).rejects.toThrow();
    expect(buy).not.toHaveBeenCalled();
  });
});

describe("selling from a post", () => {
  it("sells the whole position by default", async () => {
    const { agents, store } = stores();
    balance = ETH;
    const sell = vi.fn().mockResolvedValue(filled({ side: "sell" }));

    await executeXTrade(author(), sellIntent(), { store, agents, sell });

    expect(sell.mock.calls[0]![2]).toEqual({ token: TOKEN, fraction: 1 });
  });

  it("passes a share through when the post named one", async () => {
    const { agents, store } = stores();
    balance = ETH;
    const sell = vi.fn().mockResolvedValue(filled({ side: "sell" }));

    await executeXTrade(author(), sellIntent(0.5), { store, agents, sell });

    expect(sell.mock.calls[0]![2]).toEqual({ token: TOKEN, fraction: 0.5 });
  });

  it("needs gas, but nothing beyond it", async () => {
    const { agents, store } = stores();
    // A sell brings ether in, so the only thing it has to be able to afford is its own
    // transaction.
    balance = GAS_RESERVE + 1n;
    const sell = vi.fn().mockResolvedValue(filled({ side: "sell" }));

    await executeXTrade(author(), sellIntent(), { store, agents, sell });
    expect(sell).toHaveBeenCalledTimes(1);

    balance = 0n;
    const second = vi.fn();
    const error = await refused(executeXTrade(author(), sellIntent(), {
      store,
      agents,
      sell: second,
    }));

    expect(second).not.toHaveBeenCalled();
    expect(error.code).toBe("WALLET_UNFUNDED");
  });

  it("says so plainly when the wallet holds none of it", async () => {
    const { agents, store } = stores();
    balance = ETH;
    const sell = vi
      .fn()
      .mockRejectedValue(new Error("This agent holds none of that token, so there is nothing to sell."));

    const error = await refused(executeXTrade(author(), sellIntent(), { store, agents, sell }));

    expect(error.code).toBe("NOTHING_TO_SELL");
    expect(refusalReply(error)).toBe("Your wallet doesn't hold any of that.");
  });
});

describe("what the wallet reply says", () => {
  it("leads with the address, because that is what it is read for", async () => {
    const { agents, store } = stores();
    balance = ETH / 2n;
    const wallet = xWalletFor("770077", "trencher", { store, agents });

    const reply = walletReply(await readAgentHoldings(agents, wallet.agent));

    expect(reply).toContain(`Your Agen wallet: ${wallet.row.address}`);
    expect(reply).toContain("0.5 ETH");
  });

  it("tells an empty wallet what it is for", async () => {
    const { agents, store } = stores();
    balance = 0n;
    const wallet = xWalletFor("770077", "trencher", { store, agents });

    expect(walletReply(await readAgentHoldings(agents, wallet.agent))).toContain(
      "Send ETH there and I can buy for you.",
    );
  });
});
