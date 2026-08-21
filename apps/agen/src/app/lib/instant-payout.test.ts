/**
 * Paying a creator who has no wallet, and refusing to do it for nothing.
 *
 * There is no authorisation to test here, and that absence is the feature: `claimCreator` pays an
 * address the vault made immutable, so the sender cannot influence where the money goes and a
 * stranger pressing the button is harmless. What can go wrong is economic — Agen paying more in
 * gas than the transaction moves — and structural, a request aiming the platform's hot key at a
 * contract of its own. Those are what these assertions are about.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Address, Hex } from "viem";

const TOKEN = "0x1111111111111111111111111111111111111111" as Address;
const VAULT = "0x2222222222222222222222222222222222222222" as Address;
const CREATOR = "0xEB2d2F1b8c558a40207669291Fda468E50c8A0bB" as Address;
const TX = `0x${"bb".repeat(32)}` as Hex;

const readInstantVault = vi.fn();
const sendSponsoredToVault = vi.fn();
const readInstantOutstanding = vi.fn();
const readInstantFeeRecipient = vi.fn();
const buildInstantClaimCreator = vi.fn();

vi.mock("./instant-vault", () => ({
  readInstantVault: (...args: unknown[]) => readInstantVault(...args),
}));

vi.mock("./x/sponsor", () => ({
  sendSponsoredToVault: (...args: unknown[]) => sendSponsoredToVault(...args),
  sponsorProblems: () => [],
}));

vi.mock("./onchain", () => ({
  publicClient: () => ({
    getGasPrice: async () => 1_000_000_000n,
  }),
}));

vi.mock("@verdant/sdk", async (original) => {
  const actual = await original<typeof import("@verdant/sdk")>();
  return {
    ...actual,
    instant: {
      ...actual.instant,
      readInstantOutstanding: (...args: unknown[]) => readInstantOutstanding(...args),
      readInstantFeeRecipient: (...args: unknown[]) => readInstantFeeRecipient(...args),
      buildInstantClaimCreator: (...args: unknown[]) => buildInstantClaimCreator(...args),
    },
  };
});

const { XError } = await import("./x/errors");
const { forgetPayoutCooldowns, payOutCreator, payoutLimits, readPayoutStanding } = await import(
  "./instant-payout"
);

/**
 * The cost of a claim at the stubbed gas price, from the module's own arithmetic.
 *
 * Derived rather than written down, so a change to the flat gas figure moves these tests with the
 * code instead of leaving them asserting a number that is no longer the threshold.
 */
const COST = 1_000_000_000n * 120_000n;

const DIALS = ["AGEN_PAYOUT_MIN_MULTIPLE", "AGEN_PAYOUT_COOLDOWN_SECONDS", "AGEN_PAYOUT_DISABLED"];

beforeEach(() => {
  for (const dial of DIALS) delete process.env[dial];
  forgetPayoutCooldowns();

  readInstantVault.mockReset().mockResolvedValue(VAULT);
  readInstantFeeRecipient.mockReset().mockResolvedValue(CREATOR);
  buildInstantClaimCreator.mockReset().mockImplementation(({ vault }: { vault: Address }) => ({
    to: vault,
    data: "0xdeadbeef" as Hex,
    value: 0n,
  }));
  sendSponsoredToVault
    .mockReset()
    .mockResolvedValue({ hash: TX, vault: VAULT, gasWei: COST, receipt: { status: "success" } });

  // Comfortably over the threshold, so a test about anything else is not about the threshold.
  readInstantOutstanding.mockReset().mockResolvedValue({
    creator: COST * 100n,
    platform: 0n,
  });
});

describe("paying a creator with no wallet", () => {
  it("sends what is owed to the address the vault made immutable", async () => {
    const paid = await payOutCreator(TOKEN);

    expect(paid.recipient).toBe(CREATOR);
    expect(paid.amountWei).toBe(COST * 100n);
    expect(paid.txHash).toBe(TX);
  });

  /**
   * The structural guard. A caller names a token and the vault is derived from the registry, so a
   * request cannot point the sponsor key at a contract of its own — which matters because such a
   * contract could burn the wallet's gas on every call even though it could never take its ether.
   */
  it("never passes an address through to the thing that signs", async () => {
    await payOutCreator(TOKEN);

    const [target] = sendSponsoredToVault.mock.calls[0] as [{ token: Address }];
    expect(target).toEqual({ token: TOKEN });
    expect(JSON.stringify(target)).not.toContain(VAULT);
  });

  /** The calldata is built from the address the signer proved, not the one this module read. */
  it("builds the claim from the vault the signer proved", async () => {
    const proven = "0x9999999999999999999999999999999999999999" as Address;
    sendSponsoredToVault.mockImplementation(
      async (_target: unknown, build: (vault: Address) => unknown) => {
        build(proven);
        return { hash: TX, vault: proven, gasWei: COST, receipt: { status: "success" } };
      },
    );

    const paid = await payOutCreator(TOKEN);

    expect(buildInstantClaimCreator).toHaveBeenCalledWith({ vault: proven });
    expect(paid.vault).toBe(proven);
  });

  it("refuses an address that is not one", async () => {
    await expect(payOutCreator("not an address")).rejects.toThrow(/not a token address/i);
    expect(sendSponsoredToVault).not.toHaveBeenCalled();
  });

  it("refuses a token that is not a market here", async () => {
    readInstantVault.mockRejectedValue(new XError("TOKEN_NOT_FOUND", "not ours"));
    await expect(payOutCreator(TOKEN)).rejects.toMatchObject({ code: "TOKEN_NOT_FOUND" });
  });
});

describe("refusing to spend more than it moves", () => {
  /** `claimCreator` reverts with `NothingToClaim`, so this would be gas spent to fail. */
  it("refuses a vault with nothing in it", async () => {
    readInstantOutstanding.mockResolvedValue({ creator: 0n, platform: 0n });

    await expect(payOutCreator(TOKEN)).rejects.toThrow(/no creator fees waiting/i);
    expect(sendSponsoredToVault).not.toHaveBeenCalled();
  });

  /**
   * The guard that stops this being a way to drain the sponsor wallet. Nothing is stolen by a dust
   * claim — the creator gets their dust — but Agen pays more to move it than it is worth, and a
   * loop of those is a slow drain with no theft in it anywhere.
   */
  it("refuses an amount that costs more in gas than it is worth", async () => {
    readInstantOutstanding.mockResolvedValue({ creator: COST * 2n, platform: 0n });

    await expect(payOutCreator(TOKEN)).rejects.toThrow(/not enough waiting yet/i);
    expect(sendSponsoredToVault).not.toHaveBeenCalled();
  });

  it("sends once the amount is worth the transaction", async () => {
    process.env.AGEN_PAYOUT_MIN_MULTIPLE = "3";
    readInstantOutstanding.mockResolvedValue({ creator: COST * 3n, platform: 0n });

    await expect(payOutCreator(TOKEN)).resolves.toMatchObject({ recipient: CREATOR });
  });

  it("reads what is owed and what it would cost together", async () => {
    const standing = await readPayoutStanding(VAULT);

    expect(standing.owedWei).toBe(COST * 100n);
    expect(standing.costWei).toBe(COST);
  });

  it("takes the multiple from the environment", () => {
    process.env.AGEN_PAYOUT_MIN_MULTIPLE = "9";
    expect(payoutLimits().minMultiple).toBe(9n);
  });
});

describe("the limits on pressing it repeatedly", () => {
  it("makes a market wait before it can be settled again", async () => {
    process.env.AGEN_PAYOUT_COOLDOWN_SECONDS = "600";

    await payOutCreator(TOKEN);
    await expect(payOutCreator(TOKEN)).rejects.toMatchObject({ code: "COOLDOWN" });
  });

  /** A refusal is not a settlement, so it must not start the clock. */
  it("does not start the clock when nothing was sent", async () => {
    process.env.AGEN_PAYOUT_COOLDOWN_SECONDS = "600";
    readInstantOutstanding.mockResolvedValueOnce({ creator: 0n, platform: 0n });

    await expect(payOutCreator(TOKEN)).rejects.toThrow();
    await expect(payOutCreator(TOKEN)).resolves.toMatchObject({ recipient: CREATOR });
  });

  it("refuses everything when settling is switched off", async () => {
    process.env.AGEN_PAYOUT_DISABLED = "1";

    await expect(payOutCreator(TOKEN)).rejects.toMatchObject({ code: "CONFIG_MISSING" });
    expect(sendSponsoredToVault).not.toHaveBeenCalled();
  });
});
