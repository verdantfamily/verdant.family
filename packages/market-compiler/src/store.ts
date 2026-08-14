/**
 * Where builds are kept.
 *
 * The repository has no general-purpose database — Ponder's store belongs to the
 * indexer and holds chain observations, and putting off-chain build state in it would
 * mix "what the chain said" with "what a model proposed", which is exactly the
 * distinction the indexer's own schema is careful about.
 *
 * So the interface comes first and two implementations sit behind it: a map, for tests
 * and for a laptop, and a directory of JSON files, for a single-process deployment that
 * has to survive a restart. Neither is the final answer. When Postgres exists for the
 * application layer, a third implementation goes here and nothing above it changes,
 * which is the reason the pipeline never sees anything but `JobStore`.
 *
 * The file store is not a database and does not pretend to be one: writes are atomic
 * per job through a rename, and there is no cross-job transaction, no query language
 * and no concurrent-writer story beyond last-write-wins. That is honest for a build
 * artefact owned by one worker, and it would not be honest for anything financial.
 */

import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { GenerationJob, JobStore } from "./job.js";

export function memoryJobStore(): JobStore {
  const jobs = new Map<string, GenerationJob>();

  return {
    create: async (job) => {
      if (jobs.has(job.id)) throw new Error(`a job with id ${job.id} already exists`);
      jobs.set(job.id, job);
      return job;
    },
    read: async (id) => jobs.get(id) ?? null,
    write: async (job) => {
      jobs.set(job.id, job);
      return job;
    },
    list: async (limit) =>
      [...jobs.values()].sort((left, right) => right.createdAt - left.createdAt).slice(0, limit),
  };
}

/**
 * JSON is not quite enough on its own.
 *
 * A manifest holds `bigint` values, which `JSON.stringify` refuses outright rather than
 * silently mangling. Tagging them on the way out and restoring them on the way in keeps
 * the store honest about types; the alternative — numbers — loses precision above 2^53
 * exactly where it matters, which is wei.
 */
const BIGINT_TAG = "__bigint__";

function replacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? { [BIGINT_TAG]: value.toString() } : value;
}

function reviver(_key: string, value: unknown): unknown {
  if (value !== null && typeof value === "object" && BIGINT_TAG in value) {
    return BigInt((value as Record<string, string>)[BIGINT_TAG]!);
  }
  return value;
}

/** A job id that could name a file outside the directory is not a job id. */
function safeId(id: string): string {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
    throw new Error(`job id must be url-safe and at most 64 characters, got "${id}"`);
  }
  return id;
}

export function fileJobStore(directory: string): JobStore {
  const pathFor = (id: string): string => join(directory, `${safeId(id)}.json`);

  const readOne = async (id: string): Promise<GenerationJob | null> => {
    try {
      const stored = JSON.parse(await readFile(pathFor(id), "utf8"), reviver) as GenerationJob;
      return {
        ...stored,
        // Jobs created before the canonical test-environment lane remain readable.
        harnessAttempts: stored.harnessAttempts ?? 0,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  };

  const writeOne = async (job: GenerationJob): Promise<GenerationJob> => {
    await mkdir(directory, { recursive: true });

    // Write then rename: a reader that arrives mid-write sees the previous job rather
    // than half of this one. A build screen polling every second will do exactly that.
    const target = pathFor(job.id);
    const scratch = `${target}.${String(process.pid)}.tmp`;

    await writeFile(scratch, JSON.stringify(job, replacer, 2), "utf8");
    try {
      await rename(scratch, target);
    } catch (error) {
      await unlink(scratch).catch(() => undefined);
      throw error;
    }

    return job;
  };

  return {
    create: async (job) => {
      if ((await readOne(job.id)) !== null) {
        throw new Error(`a job with id ${job.id} already exists`);
      }
      return writeOne(job);
    },

    read: readOne,
    write: writeOne,

    list: async (limit) => {
      const names = await readdir(directory).catch(() => [] as string[]);
      const jobs = await Promise.all(
        names
          .filter((name) => name.endsWith(".json"))
          .map((name) => readOne(name.slice(0, -".json".length)).catch(() => null)),
      );

      return jobs
        .filter((job): job is GenerationJob => job !== null)
        .sort((left, right) => right.createdAt - left.createdAt)
        .slice(0, limit);
    },
  };
}
