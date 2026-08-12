/**
 * The gate is four lines of bookkeeping and the thing standing between a busy minute and
 * a machine that kills its own compiles, so it is tested rather than eyeballed.
 */

import { describe, expect, it } from "vitest";

import { gate } from "./limit.js";

/** A task that finishes when told to, so concurrency can be observed rather than timed. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("the concurrency gate", () => {
  it("runs up to the limit at once and holds the rest", async () => {
    const limiter = gate(2);
    const tasks = [deferred(), deferred(), deferred()];
    const started: number[] = [];

    const runs = tasks.map((task, index) =>
      limiter.run(async () => {
        started.push(index);
        await task.promise;
      }),
    );

    // A microtask turn, so the two that can start have.
    await Promise.resolve();

    expect(started).toEqual([0, 1]);
    expect(limiter.active).toBe(2);
    expect(limiter.waiting).toBe(1);

    tasks[0]!.resolve();
    await runs[0];
    // The released waiter is resumed through a promise, so its body runs a turn after
    // the slot is handed over rather than in the same one.
    await Promise.resolve();

    expect(started).toEqual([0, 1, 2]);

    tasks[1]!.resolve();
    tasks[2]!.resolve();
    await Promise.all(runs);

    expect(limiter.active).toBe(0);
  });

  it("releases the slot when a task throws, rather than leaking it", async () => {
    const limiter = gate(1);

    await expect(
      limiter.run(() => Promise.reject(new Error("forge exploded"))),
    ).rejects.toThrow("forge exploded");

    // The whole point: a build that fails must not permanently narrow the machine. One
    // leaked slot on a limit of one is a server that never compiles again.
    expect(limiter.active).toBe(0);
    await expect(limiter.run(async () => "next")).resolves.toBe("next");
  });

  it("admits waiters in the order they arrived", async () => {
    const limiter = gate(1);
    const blocker = deferred();
    const order: string[] = [];

    const first = limiter.run(async () => {
      order.push("first");
      await blocker.promise;
    });

    const rest = ["a", "b", "c"].map((name) =>
      limiter.run(async () => {
        order.push(name);
      }),
    );

    blocker.resolve();
    await Promise.all([first, ...rest]);

    // Without fairness a burst can starve whoever arrived first, which on a build queue
    // is a creator whose market never starts while newer ones keep overtaking it.
    expect(order).toEqual(["first", "a", "b", "c"]);
  });

  it("treats a nonsense limit as one rather than as none", () => {
    // Zero arrives from a misread environment variable, and a gate that admits nobody
    // is a deadlock that looks exactly like a hung build.
    expect(gate(0).active).toBe(0);
    expect(gate(-4).active).toBe(0);

    return expect(gate(0).run(async () => "ran")).resolves.toBe("ran");
  });
});
