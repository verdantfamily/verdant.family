/**
 * A counting semaphore, because two builds must not both decide the machine is theirs.
 *
 * ## What this is protecting
 *
 * A market build spends most of its wall time waiting on a model and a small part of it
 * running `forge`, and those two are not interchangeable. Model calls are I/O: a dozen
 * in flight costs nothing local. `forge` is the opposite — it compiles the whole
 * vendored Uniswap tree with ASTs and storage layouts, saturates every core it can find
 * through its own thread pool, and holds hundreds of megabytes while it does it.
 *
 * So the interesting failure is not "the server is slow". It is that `forge` is given a
 * timeout, and a timeout is a wall-clock measurement of a CPU-bound job. Put six
 * compiles on four cores and each one takes several times longer than it should; the
 * ones that cross the limit are killed, and the build fails reporting that the *market*
 * could not be compiled. Load turns into false negatives about somebody's contracts,
 * which is the worst way for a queue to be missing.
 *
 * Hence a gate in front of the subprocess rather than a bigger timeout. Waiting for a
 * slot is free — the timeout starts when the process spawns — so a queued compile is
 * slower and still correct, which is the trade this exists to make.
 *
 * ## Fairness
 *
 * First in, first out, because the alternative is a build that arrives during a busy
 * minute never running. Resolvers are held in an array and taken from the front; there
 * is no priority and nothing jumps.
 */

export interface Gate {
  /** Run `task` once a slot is free, releasing it however the task ends. */
  run<T>(task: () => Promise<T>): Promise<T>;
  /** How many slots are in use. For tests and for reporting. */
  readonly active: number;
  /** How many callers are waiting for one. */
  readonly waiting: number;
}

/**
 * A gate of `limit` slots. A limit below one is treated as one: a gate that admits
 * nobody is a deadlock, and it is the kind of value that arrives from a misread
 * environment variable rather than from a decision.
 */
export function gate(limit: number): Gate {
  const slots = Math.max(1, Math.floor(limit));

  let active = 0;
  const queue: (() => void)[] = [];

  const release = (): void => {
    active -= 1;
    // Handed to the next waiter rather than dropped, so a burst drains in order.
    queue.shift()?.();
  };

  const acquire = async (): Promise<void> => {
    if (active < slots) {
      active += 1;
      return;
    }

    return new Promise<void>((resolve) => {
      queue.push(() => {
        active += 1;
        resolve();
      });
    });
  };

  return {
    run: async <T>(task: () => Promise<T>): Promise<T> => {
      await acquire();
      try {
        return await task();
      } finally {
        release();
      }
    },
    get active() {
      return active;
    },
    get waiting() {
      return queue.length;
    },
  };
}

/**
 * How many `forge` processes this process will run at once.
 *
 * Two by default, which is a statement about cores rather than about builds. Foundry
 * parallelises a single invocation across everything available, so one compile already
 * uses the machine; a second overlaps its I/O and its single-threaded phases with the
 * first, and a third mostly competes with them. On a small container the difference
 * between two and six is not throughput, it is whether the ninety-second timeout starts
 * failing builds that were fine.
 *
 * Raise it on a machine with cores to spare. It is read once, at module load, because a
 * limit that could change under a running gate is a limit nobody can reason about.
 */
function configured(): number {
  const raw = process.env["AGEN_MAX_FORGE"];
  if (raw === undefined || raw.trim() === "") return 2;

  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : 2;
}

/**
 * The one gate every `forge` call in this process passes through.
 *
 * Pinned to a registered symbol rather than to module scope, because "one gate" has to
 * survive this module being instantiated more than once. A bundler that gives two route
 * handlers their own copy of this file gives them a gate each, and two gates of two
 * slots is a bound of four that nobody chose — the failure is silent and only shows up
 * as compiles timing out under load. `Symbol.for` is keyed across the realm, so every
 * copy resolves the same object.
 */
const FORGE_GATE = Symbol.for("agen.forge.gate");

function shared(): Gate {
  const realm = globalThis as unknown as Record<symbol, Gate | undefined>;
  return (realm[FORGE_GATE] ??= gate(configured()));
}

export const forgeGate: Gate = {
  run: (task) => shared().run(task),
  get active() {
    return shared().active;
  },
  get waiting() {
    return shared().waiting;
  },
};
