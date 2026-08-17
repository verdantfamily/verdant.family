/**
 * Redaction, which is the only part of logging worth testing.
 *
 * Every case here is a way a secret can reach a log line without anybody deciding to put it
 * there: under an obvious key, under an unobvious one, inside a string a backend sent back,
 * and nested a few levels down in a request body being logged wholesale.
 */

import { describe, expect, it } from "vitest";

import { createLogger, REDACTED, redact } from "./logger.js";

function capture(): { readonly lines: string[]; readonly logger: ReturnType<typeof createLogger> } {
  const lines: string[] = [];
  return { lines, logger: createLogger({ level: "debug", write: (line) => lines.push(line) }) };
}

describe("redact", () => {
  it.each([
    "authorization",
    "apiKey",
    "api_key",
    "API-KEY",
    "token",
    "secret",
    "password",
    "privateKey",
    "private_key",
    "mnemonic",
    "seed",
    "seedPhrase",
    "cookie",
  ])("removes anything under a key called %s", (key) => {
    expect(redact({ [key]: "hunter2" })).toEqual({ [key]: REDACTED });
  });

  it("removes an Agen API key wherever it appears in a string", () => {
    const line = redact({ message: "auth failed for agn_abcdefghijklmnop on /me" }) as { message: string };
    expect(line.message).not.toContain("agn_abcdefghijklmnop");
    expect(line.message).toContain(REDACTED);
  });

  it("removes an owner session token", () => {
    expect(String((redact({ m: "ags_abcdefghijklmnop" }) as { m: string }).m)).not.toContain("ags_abcd");
  });

  it("removes a 32-byte hex secret, which is the shape of a private key", () => {
    const key = `0x${"ab".repeat(32)}`;
    expect(String((redact({ m: `signing with ${key}` }) as { m: string }).m)).not.toContain(key);
  });

  it("leaves an address alone: 20 bytes is public information", () => {
    const address = "0x1111111111111111111111111111111111111111";
    expect(redact({ m: address })).toEqual({ m: address });
  });

  it("removes a bearer header even spelled inline", () => {
    expect(String((redact({ m: "Bearer agn_xyzxyzxyzxyz" }) as { m: string }).m)).not.toContain("agn_");
  });

  it("reaches into nested objects and arrays", () => {
    const out = redact({ request: { headers: [{ authorization: "Bearer x" }] } }) as {
      request: { headers: { authorization: string }[] };
    };
    expect(out.request.headers[0]?.authorization).toBe(REDACTED);
  });

  it("stringifies bigint rather than throwing when serialised", () => {
    expect(redact({ wei: 10n ** 27n })).toEqual({ wei: "1000000000000000000000000000" });
  });

  it("stops at a depth rather than following a cycle forever", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => redact(cyclic)).not.toThrow();
  });
});

describe("createLogger", () => {
  it("writes one JSON object per line", () => {
    const { lines, logger } = capture();
    logger.info("hello", { a: 1 });

    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(parsed).toMatchObject({ level: "info", service: "agen-mcp", message: "hello", a: 1 });
    expect(typeof parsed.at).toBe("string");
  });

  it("redacts the message itself, not only the fields", () => {
    const { lines, logger } = capture();
    logger.error("failed with agn_abcdefghijklmnop");
    expect(lines[0]).not.toContain("agn_abcdefghijklmnop");
  });

  it("honours the level", () => {
    const lines: string[] = [];
    const logger = createLogger({ level: "warn", write: (line) => lines.push(line) });
    logger.debug("nope");
    logger.info("nope");
    logger.warn("yes");
    expect(lines).toHaveLength(1);
  });

  it("carries a child's fields into every line", () => {
    const { lines, logger } = capture();
    logger.child({ requestId: "r-1", tool: "get_token" }).info("call");
    expect(JSON.parse(lines[0]!)).toMatchObject({ requestId: "r-1", tool: "get_token" });
  });

  it("still logs when a field cannot be serialised", () => {
    const { lines, logger } = capture();
    const bad = { toJSON: () => { throw new Error("no"); } };
    expect(() => logger.info("with a bad field", { bad })).not.toThrow();
    expect(lines).toHaveLength(1);
  });
});
