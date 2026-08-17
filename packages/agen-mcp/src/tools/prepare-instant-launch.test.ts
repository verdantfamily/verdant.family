/**
 * The non-custodial path, and the claims it makes about itself.
 *
 * The response tells an agent three things that are load-bearing — nothing was signed, a
 * signature is required, a broadcast is required — and an agent will repeat all three to a
 * user. If any of them were ever produced by a call that had in fact sent a transaction, the
 * user would be told their money was safe while it was not. So they are asserted as constants
 * on every path through this tool, including the ones that fail.
 *
 * The other property here is negative: the route that signs is never reached from this file,
 * at any input.
 */

import { describe, expect, it } from "vitest";

import { bodyOf, errorOf, harness } from "../test/harness.js";
import { prepareInstantLaunch } from "./prepare-instant-launch.js";

const SIGNER = "0x1111111111111111111111111111111111111111";
const OTHER = "0x9999999999999999999999999999999999999999";

const minimal = {
  name: "Atlas",
  symbol: "ATLAS",
  imageUrl: "https://agen.space/api/images/a.png",
} as const;

const preparedBody = {
  chainId: 4663,
  signer: SIGNER,
  transaction: { to: "0xF85b06710E2CbEf54230c92733e12824c8fCa2D6", data: "0xabcdef", value: "10000000000000000", chainId: 4663 },
  escrowTransaction: null,
  token: "0x1234567890123456789012345678901234567890",
  salt: `0x${"aa".repeat(32)}`,
  metadataURI: "https://agen.space/api/metadata/abc.json",
  feeRecipient: OTHER,
  feePayoutAddress: OTHER,
  name: "Atlas",
  symbol: "ATLAS",
  supplyTokens: "1000000000",
  initialBuyWei: "10000000000000000",
};

describe("what it returns", () => {
  it("is calldata, and it says nothing has happened yet", async () => {
    const test = harness();
    test.reply("/api/v1/instant/prepare", { body: { ok: true, data: preparedBody } });

    const result = await prepareInstantLaunch(test.context, { ...minimal, signer: SIGNER, initialBuyEth: "0.01" });
    const body = bodyOf(result);

    expect(result.isError).toBeUndefined();
    expect(body.execution_status).toBe("prepared");
    expect(body.requires_signature).toBe(true);
    expect(body.requires_broadcast).toBe(true);
    expect(body.signedBy).toBe("caller_wallet");
    expect(body.transaction).toMatchObject({ value: "10000000000000000", chainId: 4663 });
    expect(body.txHash).toBeNull();
    expect(body.pool).toBeNull();
    expect(body.launchId).toBeNull();

    // The one route that signs was never touched.
    expect(test.sent("/me/launches/instant")).toHaveLength(0);
  });

  it("says the token address is a prediction, because the sender decides it", async () => {
    const test = harness();
    test.reply("/api/v1/instant/prepare", { body: { ok: true, data: preparedBody } });

    const body = bodyOf(await prepareInstantLaunch(test.context, { ...minimal, signer: SIGNER }));
    expect(body.tokenAddressIsPredicted).toBe(true);
    expect(body.creator).toBe(SIGNER);
  });

  it("stamps when it was prepared", async () => {
    const test = harness();
    test.reply("/api/v1/instant/prepare", { body: { ok: true, data: preparedBody } });

    const body = bodyOf(await prepareInstantLaunch(test.context, { ...minimal, signer: SIGNER }));
    expect(body.preparedAt).toBeGreaterThan(1_700_000_000);
    expect(body.preparedAt).toBeLessThan(Math.floor(Date.now() / 1000) + 2);
  });

  it("honours an arbitrary fee receiver, which is the point of this path", async () => {
    const test = harness();
    test.reply("/api/v1/instant/prepare", { body: { ok: true, data: preparedBody } });

    const result = await prepareInstantLaunch(test.context, { ...minimal, signer: SIGNER, feeReceiver: OTHER });

    expect(test.sent("/prepare")[0]?.body).toMatchObject({ signer: SIGNER, feeReceiver: OTHER });
    expect(bodyOf(result).feePayoutAddress).toBe(OTHER);
  });

  it("says the escrow must land first, when one is needed", async () => {
    const test = harness();
    test.reply("/api/v1/instant/prepare", {
      body: {
        ok: true,
        data: { ...preparedBody, escrowTransaction: { to: OTHER, data: "0x01", value: "0", chainId: 4663 } },
      },
    });

    const body = bodyOf(await prepareInstantLaunch(test.context, { ...minimal, signer: SIGNER }));
    expect(body.escrowTransaction).not.toBeNull();
    expect(String(body.nextStep)).toMatch(/escrowTransaction first/);
    // Still unsigned, still the caller's move.
    expect(body.requires_signature).toBe(true);
  });
});

describe("what it will not do", () => {
  it("is not retried, because it stores a document and mines a salt", async () => {
    const test = harness();
    test.reply("/api/v1/instant/prepare", { hang: true });

    const result = await prepareInstantLaunch(test.context, { ...minimal, signer: SIGNER });

    expect(errorOf(result).code).toBe("TIMEOUT");
    expect(test.sent("/prepare")).toHaveLength(1);
  });

  it("refuses without a key rather than reaching an unauthenticated route", async () => {
    const test = harness({ AGEN_API_KEY: undefined });

    expect(errorOf(await prepareInstantLaunch(test.context, { ...minimal, signer: SIGNER })).code).toBe("UNAUTHORIZED");
    expect(test.requests).toHaveLength(0);
  });

  it("never reaches the signing route, whatever it is asked for", async () => {
    const test = harness();
    test.reply("/api/v1/instant/prepare", { body: { ok: true, data: preparedBody } });

    await prepareInstantLaunch(test.context, {
      ...minimal,
      signer: SIGNER,
      feeReceiver: OTHER,
      initialBuyEth: "100",
      boostCapable: false,
    });

    expect(test.requests.map((entry) => entry.url).join(" ")).not.toContain("/me/launches");
  });
});

describe("failures carry a request id", () => {
  it("so a caller can be found in the logs", async () => {
    const test = harness();
    test.reply("/api/v1/instant/prepare", { status: 500, body: { ok: false, error: { message: "boom" } } });

    const error = errorOf(await prepareInstantLaunch(test.context, { ...minimal, signer: SIGNER }));

    expect(error.requestId).toMatch(/^[0-9a-f-]{36}$/);
    // The same id went to the backend.
    expect(test.sent("/prepare")[0]?.headers["x-request-id"]).toBe(error.requestId);
  });

  it("reports an unreachable logo as bad metadata rather than bad input", async () => {
    const test = harness();
    test.reply("/api/v1/instant/prepare", {
      status: 400,
      body: { ok: false, error: { code: "VALIDATION_FAILED", message: "That logo could not be fetched." } },
    });

    expect(errorOf(await prepareInstantLaunch(test.context, { ...minimal, signer: SIGNER })).code).toBe(
      "INVALID_TOKEN_METADATA",
    );
  });
});
