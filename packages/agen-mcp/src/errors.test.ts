/**
 * Translating Agen's refusals without losing the reason.
 *
 * The point of this layer is that an agent can branch. So the tests are about whether two
 * failures that need different handling stay distinguishable: a permission refusal from a
 * rate limit, a reverted transaction from a rejected ticker, a missing token from a lagging
 * indexer.
 */

import { describe, expect, it } from "vitest";

import { AgenMcpError, asMcpError, fromAgenError } from "./errors.js";

const base = { status: 400, source: "agen-api" as const };

describe("fromAgenError", () => {
  it("keeps the upstream code alongside its own", () => {
    const error = fromAgenError({
      ...base,
      status: 403,
      code: "PERMISSION_MAX_ETH_PER_LAUNCH",
      message: "This launch would spend too much.",
      permission: "maxEthPerLaunch",
      limit: "50000000000000000",
      requested: "80000000000000000",
    });

    expect(error.code).toBe("PERMISSION_DENIED");
    expect(error.detail.upstreamCode).toBe("PERMISSION_MAX_ETH_PER_LAUNCH");
    // The numbers survive, because an agent's next move depends on them.
    expect(error.detail.limit).toBe("50000000000000000");
    expect(error.detail.requested).toBe("80000000000000000");
  });

  it.each([
    ["INVALID_API_KEY", 401, "UNAUTHORIZED"],
    ["REVOKED_API_KEY", 401, "UNAUTHORIZED"],
    ["AGENT_PAUSED", 403, "FORBIDDEN"],
    ["RATE_LIMITED", 429, "RATE_LIMITED"],
    ["INSUFFICIENT_TREASURY", 403, "INSUFFICIENT_BALANCE"],
    ["LAUNCH_NOT_FOUND", 404, "LAUNCH_NOT_FOUND"],
    ["CONFIG_MISSING", 503, "CONFIG_MISSING"],
    ["WRONG_CHAIN", 503, "UNSUPPORTED_CHAIN"],
  ])("maps %s to %s", (code, status, expected) => {
    expect(fromAgenError({ ...base, status, code, message: "x" }).code).toBe(expected);
  });

  it("marks a rate limit retryable and a permission refusal not", () => {
    expect(fromAgenError({ ...base, status: 429, code: "RATE_LIMITED", message: "x" }).detail.retryable).toBe(true);
    expect(
      fromAgenError({ ...base, status: 403, code: "PERMISSION_INSTANT_DISABLED", message: "x" }).detail.retryable,
    ).toBe(false);
  });

  describe("VALIDATION_FAILED, which Agen uses for two unrelated things", () => {
    it("stays INVALID_INPUT for a rejected draft", () => {
      const error = fromAgenError({
        ...base,
        code: "VALIDATION_FAILED",
        message: "A ticker can only use letters and numbers.",
      });
      expect(error.code).toBe("INVALID_INPUT");
    });

    it("becomes TRANSACTION_REVERTED when the transaction landed and did nothing", () => {
      const error = fromAgenError({
        ...base,
        code: "VALIDATION_FAILED",
        message: "The transaction went through but did not create a market.",
      });
      expect(error.code).toBe("TRANSACTION_REVERTED");
    });

    it("becomes INSUFFICIENT_BALANCE when the treasury could not pay", () => {
      const error = fromAgenError({
        ...base,
        code: "VALIDATION_FAILED",
        message: "insufficient funds for gas * price + value",
      });
      expect(error.code).toBe("INSUFFICIENT_BALANCE");
    });

    it("becomes INVALID_TOKEN_METADATA for a logo problem", () => {
      expect(
        fromAgenError({ ...base, code: "VALIDATION_FAILED", message: "Your token needs a logo." }).code,
      ).toBe("INVALID_TOKEN_METADATA");
    });

    it("becomes INVALID_ADDRESS for a malformed receiver the backend caught", () => {
      expect(
        fromAgenError({ ...base, code: "VALIDATION_FAILED", message: "The fee receiver is not an address." }).code,
      ).toBe("INVALID_ADDRESS");
    });

    it("carries validate()'s whole list, not just the first complaint", () => {
      const error = fromAgenError({
        ...base,
        code: "VALIDATION_FAILED",
        message: "Your token needs a name.",
        problems: ["Your token needs a name.", "Your token needs a ticker."],
      });
      expect(error.detail.problems).toHaveLength(2);
    });
  });

  it("falls back on status alone when a backend sends no code", () => {
    expect(fromAgenError({ ...base, status: 500, code: undefined, message: "boom" }).code).toBe("BACKEND_UNAVAILABLE");
    expect(
      fromAgenError({ status: 404, source: "instant-feed", code: undefined, message: "no such market" }).code,
    ).toBe("TOKEN_NOT_FOUND");
  });

  it("does not flatten a code it has never seen into a familiar one", () => {
    const error = fromAgenError({ ...base, status: 409, code: "SOME_FUTURE_CODE", message: "x" });
    // Mapped by status, but the real code is still on the wire for a caller to read.
    expect(error.detail.upstreamCode).toBe("SOME_FUTURE_CODE");
  });
});

describe("toStructured", () => {
  it("omits absent fields rather than emitting nulls a model has to skip", () => {
    const body = new AgenMcpError("TOKEN_NOT_FOUND", "gone", { source: "instant-feed" }).toStructured();
    expect(body).toEqual({
      ok: false,
      error: { code: "TOKEN_NOT_FOUND", message: "gone", source: "instant-feed" },
    });
  });
});

describe("asMcpError", () => {
  it("passes ours through unchanged", () => {
    const original = new AgenMcpError("TIMEOUT", "slow");
    expect(asMcpError(original)).toBe(original);
  });

  it("wraps anything else without inventing a code", () => {
    expect(asMcpError(new Error("kaboom")).code).toBe("INTERNAL");
    expect(asMcpError("kaboom").code).toBe("INTERNAL");
  });
});
