/**
 * Configuration, checked here so it is never checked in a conversation.
 *
 * The last test in this file is the important one: there is no environment variable through
 * which a signing key could be supplied, and that should stay true by test rather than by
 * memory.
 */

import { describe, expect, it } from "vitest";

import { EnvError, envSchema, loadEnv } from "./env.js";

describe("loadEnv", () => {
  it("has usable defaults for a read-only server", () => {
    const env = loadEnv({});
    expect(env.AGEN_API_URL).toBe("https://agen.space");
    expect(env.AGEN_CHAIN_ID).toBe(4663);
    expect(env.AGEN_MCP_TRANSPORT).toBe("stdio");
    expect(env.AGEN_API_KEY).toBeUndefined();
    expect(env.AGEN_INSTANT_FEED_URL).toBeUndefined();
  });

  it("strips a trailing slash, which would otherwise double up in every path", () => {
    expect(loadEnv({ AGEN_API_URL: "https://agen.space/" }).AGEN_API_URL).toBe("https://agen.space");
    expect(loadEnv({ AGEN_API_URL: "https://agen.space///" }).AGEN_API_URL).toBe("https://agen.space");
  });

  it("treats an empty variable as unset, which is how a shell spells it", () => {
    const env = loadEnv({ AGEN_API_KEY: "", AGEN_INSTANT_FEED_URL: "   " });
    expect(env.AGEN_API_KEY).toBeUndefined();
    expect(env.AGEN_INSTANT_FEED_URL).toBeUndefined();
  });

  it.each([
    ["a key of the wrong shape", { AGEN_API_KEY: "sk-not-an-agen-key" }],
    ["a key that is too short", { AGEN_API_KEY: "agn_x" }],
    ["a non-http api url", { AGEN_API_URL: "ftp://agen.space" }],
    ["an unparseable api url", { AGEN_API_URL: "agen.space" }],
    ["a non-http feed url", { AGEN_INSTANT_FEED_URL: "not a url" }],
    ["a negative timeout", { AGEN_MCP_TIMEOUT_MS: "-1" }],
    ["an unknown transport", { AGEN_MCP_TRANSPORT: "websocket" }],
    ["an unknown log level", { AGEN_MCP_LOG_LEVEL: "verbose" }],
    ["too many retries", { AGEN_MCP_MAX_RETRIES: "50" }],
  ])("refuses %s", (_label, source) => {
    expect(() => loadEnv(source)).toThrow(EnvError);
  });

  it("lists every problem, not just the first", () => {
    try {
      loadEnv({ AGEN_API_KEY: "nope", AGEN_MCP_TRANSPORT: "carrier-pigeon" });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(EnvError);
      expect((error as EnvError).problems).toHaveLength(2);
    }
  });

  it("accepts a complete production configuration", () => {
    const env = loadEnv({
      AGEN_API_URL: "https://agen.space",
      AGEN_API_KEY: "agn_abcdefghijklmnopqrstuvwxyz",
      AGEN_INSTANT_FEED_URL: "https://feed.internal",
      AGEN_EXPLORER_URL: "https://explorer.robinhood.com",
      AGEN_CHAIN_ID: "4663",
      AGEN_MCP_TRANSPORT: "http",
      AGEN_MCP_PORT: "8848",
      AGEN_MCP_LOG_LEVEL: "debug",
    });
    expect(env.AGEN_MCP_TRANSPORT).toBe("http");
    expect(env.AGEN_MCP_PORT).toBe(8848);
  });

  /**
   * The security property, as a test.
   *
   * If a future change adds a variable that could hold a key, this fails and the person
   * adding it has to explain themselves in a diff rather than in an incident.
   */
  it("has no variable that could carry a signing secret", () => {
    const forbidden = /private|mnemonic|seed|signer|keystore|wallet_key|secret/i;
    const offenders = Object.keys(envSchema.shape).filter((key) => forbidden.test(key));
    expect(offenders).toEqual([]);
  });
});
