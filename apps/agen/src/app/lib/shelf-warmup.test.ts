import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const KEY = Symbol.for("agen.shelf.warmup");

function forget(): void {
  delete (globalThis as Record<symbol, unknown>)[KEY];
}

async function warmup() {
  return await import("./shelf-warmup");
}

describe("when a fresh container is fit to be shown to anyone", () => {
  beforeEach(() => {
    forget();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    forget();
  });

  it("is ready before anything announces a warm-up, so a build without the boot hook still serves", async () => {
    const { shelfReady } = await warmup();
    expect(shelfReady()).toBe(true);
  });

  it("is not ready while the shelf is still being read", async () => {
    const { warmupStarted, shelfReady } = await warmup();

    warmupStarted();
    expect(shelfReady()).toBe(false);
  });

  it("is ready once the shelf has been read", async () => {
    const { warmupStarted, warmupFinished, shelfReady } = await warmup();

    warmupStarted();
    warmupFinished();
    expect(shelfReady()).toBe(true);
  });

  it("gives up waiting rather than failing the deploy, when nothing ever answers", async () => {
    const { warmupStarted, shelfReady } = await warmup();

    warmupStarted();
    vi.advanceTimersByTime(24_000);
    expect(shelfReady()).toBe(false);

    vi.advanceTimersByTime(2_000);
    expect(shelfReady()).toBe(true);
  });

  it("gives up well inside Railway's five-minute window, so the deploy is never rolled back for this", async () => {
    const { warmupStarted, shelfReady } = await warmup();

    warmupStarted();
    vi.advanceTimersByTime(300_000);
    expect(shelfReady()).toBe(true);
  });

  it("keeps the first moment it was asked, so a second announcement cannot restart the clock", async () => {
    const { warmupStarted, shelfReady } = await warmup();

    warmupStarted();
    vi.advanceTimersByTime(20_000);
    warmupStarted();
    vi.advanceTimersByTime(6_000);

    expect(shelfReady()).toBe(true);
  });
});

describe("the health check Railway polls", () => {
  beforeEach(() => {
    forget();
  });

  afterEach(() => {
    forget();
  });

  it("refuses traffic with a 503 while the shelf is cold", async () => {
    const { warmupStarted } = await warmup();
    warmupStarted();

    const { GET } = await import("../health/route");
    const response = GET();

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ ok: false, waitingFor: "shelf" });
  });

  it("accepts traffic once the shelf is warm", async () => {
    const { warmupStarted, warmupFinished } = await warmup();
    warmupStarted();
    warmupFinished();

    const { GET } = await import("../health/route");
    const response = GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, service: "agen" });
  });
});
