/**
 * The mention loop, without X.
 *
 * The loop itself is small; what is worth testing is what it does when a pass goes wrong, because
 * the failure that matters is silent. A poller that stops looping after one bad read leaves a bot
 * that looks configured, reports healthy and never answers anybody again — so the tests below are
 * mostly about the loop surviving things, and about a 429 costing a wait rather than the window.
 *
 * `pollOnce` is injected throughout. A test that reached the real one would read the live account's
 * mentions with the credentials in a developer's environment, and could end in a sponsored launch.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { XError } from "./errors";
import { skipExistingMentions, type PollResult } from "./ingest";
import { backoffFrom, MentionPoller, pollerInstance, startMentionPoller } from "./poller";
import { XStore } from "./store";

const POLLER_KEY = Symbol.for("agen.x.poller");

/** Nothing was mentioned, which is what most passes find. */
function quiet(overrides: Partial<PollResult> = {}): PollResult {
  return { seen: 0, handled: 0, launched: 0, outcomes: [], cursor: null, resolved: 0, ...overrides };
}

function rateLimited(resetAt: string | null): XError {
  return new XError("X_UNAVAILABLE", "X rate limited reading mentions.", {
    retryable: true,
    details: { status: 429, resetAt },
  });
}

/** The environment `startMentionPoller` needs before it will agree the deployment can read. */
function configured(): void {
  process.env.X_POLLER = "1";
  process.env.X_BEARER_TOKEN = "bearer";
  process.env.X_API_KEY = "key";
  process.env.X_API_SECRET = "secret";
  process.env.X_ACCESS_TOKEN = "token";
  process.env.X_ACCESS_SECRET = "token-secret";
  process.env.X_INGRESS_SECRET = "ingress";
  process.env.X_BOT_USER_ID = "1";
  delete process.env.X_MENTION_DELIVERY;
  delete process.env.X_POLL_SECONDS;
}

afterEach(() => {
  delete process.env.X_POLLER;
  delete process.env.X_POLL_SECONDS;
  delete process.env.X_MENTION_DELIVERY;
  (globalThis as unknown as Record<symbol, unknown>)[POLLER_KEY] = null;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("a pass", () => {
  it("counts what it found", async () => {
    const poll = vi.fn().mockResolvedValue(quiet({ seen: 3, handled: 2, launched: 1 }));
    const poller = new MentionPoller({ poll });

    await poller.pass();

    const health = poller.health();
    expect(health.passes).toBe(1);
    expect(health.seen).toBe(3);
    expect(health.handled).toBe(2);
    expect(health.launched).toBe(1);
    expect(health.failures).toBe(0);
    expect(health.lastError).toBeNull();
  });

  it("survives a failure and reads again", async () => {
    const poll = vi
      .fn()
      .mockRejectedValueOnce(new Error("X did not answer while reading mentions."))
      .mockResolvedValue(quiet({ seen: 1 }));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const poller = new MentionPoller({ poll });

    expect(await poller.pass()).toBeNull();
    expect(poller.health().failures).toBe(1);

    // The point of the test: a bad read is not the end of the loop.
    expect(await poller.pass()).not.toBeNull();
    expect(poller.health().seen).toBe(1);
  });

  it("keeps a failure's message out of the log beyond 200 characters", async () => {
    const poll = vi.fn().mockRejectedValue(new Error("x".repeat(500)));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const poller = new MentionPoller({ poll });

    await poller.pass();

    expect(poller.health().lastError).toHaveLength(200);
  });

  it("does not run while another is still in flight", async () => {
    let release: (value: PollResult) => void = () => undefined;
    const poll = vi.fn().mockImplementation(
      async () =>
        new Promise<PollResult>((resolve) => {
          release = resolve;
        }),
    );
    const poller = new MentionPoller({ poll });

    const first = poller.pass();
    expect(await poller.pass()).toBeNull();
    expect(poll).toHaveBeenCalledTimes(1);

    release(quiet());
    await first;
  });
});

describe("being rate limited", () => {
  it("waits rather than trying again next tick", async () => {
    const at = Math.floor(Date.now() / 1000);
    const poll = vi.fn().mockRejectedValue(rateLimited(String(at + 300)));
    const poller = new MentionPoller({ poll });

    await poller.pass();

    const health = poller.health();
    expect(health.backoffUntil).toBe(at + 300);
    // Not a failure: the window working as documented is not something a person needs to see.
    expect(health.failures).toBe(0);

    await poller.pass();
    expect(poll).toHaveBeenCalledTimes(1);
  });

  it("reads again once the wait is over", async () => {
    vi.useFakeTimers();
    const poll = vi
      .fn()
      .mockRejectedValueOnce(rateLimited(null))
      .mockResolvedValue(quiet({ seen: 2 }));
    const poller = new MentionPoller({ poll });

    await poller.pass();
    expect(poller.health().backoffUntil).not.toBeNull();

    vi.setSystemTime(Date.now() + 200_000);
    await poller.pass();

    expect(poller.health().seen).toBe(2);
    expect(poller.health().backoffUntil).toBeNull();
  });
});

describe("the wait X asked for", () => {
  const at = 1_000_000;

  it("is the reset it named", () => {
    expect(backoffFrom(rateLimited(String(at + 60)), at)).toBe(at + 60);
  });

  it("is a fixed wait when the reset is in the past", () => {
    expect(backoffFrom(rateLimited(String(at - 60)), at)).toBe(at + 120);
  });

  it("is a fixed wait when the reset is absurdly far away", () => {
    // A timestamp misread as seconds-from-now is how a poller goes quiet for a day.
    expect(backoffFrom(rateLimited(String(at + 86_400)), at)).toBe(at + 120);
  });

  it("is a fixed wait when there is no reset to read", () => {
    expect(backoffFrom(rateLimited(null), at)).toBe(at + 120);
    expect(backoffFrom(rateLimited("nonsense"), at)).toBe(at + 120);
  });

  it("is not asked for by anything that was not a 429", () => {
    expect(backoffFrom(new XError("X_UNAVAILABLE", "X refused reading mentions."), at)).toBeNull();
    expect(backoffFrom(new XError("CONFIG_MISSING", "no token"), at)).toBeNull();
    expect(backoffFrom(new Error("fetch failed"), at)).toBeNull();
  });
});

describe("starting the loop", () => {
  it("does not, unless it was asked for", () => {
    configured();
    delete process.env.X_POLLER;

    expect(startMentionPoller({ poll: vi.fn() })).toBeNull();
    expect(pollerInstance()).toBeNull();
  });

  it("does not when X pushes mentions instead", () => {
    configured();
    process.env.X_MENTION_DELIVERY = "webhook";

    expect(startMentionPoller({ poll: vi.fn() })).toBeNull();
  });

  it("does not on a deployment that cannot read mentions", () => {
    configured();
    delete process.env.X_BEARER_TOKEN;
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(startMentionPoller({ poll: vi.fn() })).toBeNull();
  });

  it("makes one loop, however many times it is called", () => {
    configured();
    process.env.X_POLL_SECONDS = "45";

    const first = startMentionPoller({
      poll: vi.fn().mockResolvedValue(quiet()),
      skipExisting: async () => null,
    });
    const second = startMentionPoller({
      poll: vi.fn().mockResolvedValue(quiet()),
      skipExisting: async () => null,
    });

    expect(first).not.toBeNull();
    expect(second).toBe(first);
    expect(first?.health().pollSeconds).toBe(45);
    first?.stop();
  });

  it("ignores a poll interval that is not a positive number", () => {
    configured();
    process.env.X_POLL_SECONDS = "not-a-number";

    const poller = startMentionPoller({
      poll: vi.fn().mockResolvedValue(quiet()),
      skipExisting: async () => null,
    });
    expect(poller?.health().pollSeconds).toBe(10);
    poller?.stop();
  });

  it("polls every ten seconds unless told otherwise", () => {
    configured();
    const poller = startMentionPoller({
      poll: vi.fn().mockResolvedValue(quiet()),
      skipExisting: async () => null,
    });
    expect(poller?.health().pollSeconds).toBe(10);
    poller?.stop();
  });

  it("will not poll faster than five seconds", () => {
    configured();
    process.env.X_POLL_SECONDS = "2";
    const poller = startMentionPoller({
      poll: vi.fn().mockResolvedValue(quiet()),
      skipExisting: async () => null,
    });
    expect(poller?.health().pollSeconds).toBe(5);
    poller?.stop();
  });

  it("skips the timeline that already exists, once, before it answers anything", async () => {
    const skip = vi.fn().mockResolvedValue("2090544373683323219");
    const poll = vi.fn().mockResolvedValue(quiet({ seen: 1 }));
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const poller = new MentionPoller({ poll, skipExisting: skip });

    await poller.pass();
    await poller.pass();

    expect(skip).toHaveBeenCalledTimes(1);
    expect(poll).toHaveBeenCalledTimes(2);
  });
});

describe("skipExistingMentions", () => {
  it("advances the cursor to the newest mention and handles none of them", async () => {
    const store = new XStore(join(mkdtempSync(join(tmpdir(), "agen-x-skip-")), "x.db"));
    const mentions = vi.fn().mockResolvedValue([{ id: "10" }, { id: "30" }, { id: "20" }]);

    const newest = await skipExistingMentions({
      store,
      client: { mentions } as never,
    });

    expect(newest).toBe("30");
    expect(store.sinceId()).toBe("30");
    expect(mentions).toHaveBeenCalledWith(null, 5);
  });
});
