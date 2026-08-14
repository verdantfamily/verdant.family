import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { newJob, Stage } from "./job.js";
import type { JobStore } from "./job.js";
import { fileJobStore, memoryJobStore } from "./store.js";

let directory: string | null = null;

afterEach(async () => {
  if (directory !== null) await rm(directory, { recursive: true, force: true });
  directory = null;
});

async function stores(): Promise<readonly { name: string; store: JobStore }[]> {
  directory = await mkdtemp(join(tmpdir(), "agen-jobs-"));
  return [
    { name: "memory", store: memoryJobStore() },
    { name: "file", store: fileJobStore(directory) },
  ];
}

function job(id: string, now = 1_000) {
  return newJob({ id, prompt: "charge more on large sells", name: "Canopy", symbol: "CNPY", now });
}

describe("both stores behave the same way", () => {
  it("round-trips a job", async () => {
    for (const { name, store } of await stores()) {
      await store.create(job("build-1"));
      const read = await store.read("build-1");

      expect(read?.prompt, name).toBe("charge more on large sells");
      expect(read?.stage, name).toBe(Stage.PromptReceived);
    }
  });

  it("returns null for a job that does not exist", async () => {
    for (const { name, store } of await stores()) {
      expect(await store.read("never-created"), name).toBeNull();
    }
  });

  it("refuses to create the same job twice", async () => {
    for (const { name, store } of await stores()) {
      await store.create(job("build-1"));
      await expect(store.create(job("build-1")), name).rejects.toThrow(/already exists/);
    }
  });

  it("lists newest first", async () => {
    for (const { name, store } of await stores()) {
      await store.create(job("older", 1_000));
      await store.create(job("newer", 2_000));

      const listed = await store.list(10);
      expect(
        listed.map((entry) => entry.id),
        name,
      ).toEqual(["newer", "older"]);
    }
  });

  it("survives a bigint in the manifest, which JSON alone does not", async () => {
    for (const { name, store } of await stores()) {
      const created = await store.create(job("build-1"));

      // Wei values are the reason: above 2^53 a number loses precision exactly where
      // it must not.
      const withBigint = {
        ...created,
        specification: {
          ...(created.specification ?? {}),
          rules: [{ parameters: { amountWei: 12_345_678_901_234_567_890n } }],
        } as never,
      };

      await store.write(withBigint);
      const read = await store.read("build-1");
      const amount = (read?.specification as never as { rules: { parameters: { amountWei: bigint } }[] })
        .rules[0]!.parameters.amountWei;

      expect(typeof amount, name).toBe("bigint");
      expect(amount, name).toBe(12_345_678_901_234_567_890n);
    }
  });
});

describe("the file store specifically", () => {
  it("loads jobs written before harness attempts were tracked", async () => {
    directory = await mkdtemp(join(tmpdir(), "agen-jobs-"));
    const store = fileJobStore(directory);
    const { harnessAttempts: _legacyMissingField, ...legacy } = job("legacy");
    await writeFile(join(directory, "legacy.json"), JSON.stringify(legacy), "utf8");

    expect((await store.read("legacy"))?.harnessAttempts).toBe(0);
  });

  it("refuses a job id that would name a file elsewhere", async () => {
    directory = await mkdtemp(join(tmpdir(), "agen-jobs-"));
    const store = fileJobStore(directory);

    await expect(store.read("../../etc/passwd")).rejects.toThrow(/url-safe/);
    await expect(store.create(job("with/slash"))).rejects.toThrow(/url-safe/);
  });

  it("ignores files it did not write", async () => {
    directory = await mkdtemp(join(tmpdir(), "agen-jobs-"));
    const store = fileJobStore(directory);

    await store.create(job("build-1"));
    await writeFile(join(directory, "notes.txt"), "not a job", "utf8");
    await writeFile(join(directory, "corrupt.json"), "{ this is not json", "utf8");

    // A directory with rubbish in it should still list the jobs that are real, rather
    // than failing the whole operator view.
    const listed = await store.list(10);
    expect(listed.map((entry) => entry.id)).toEqual(["build-1"]);
  });

  it("leaves no temporary files behind", async () => {
    directory = await mkdtemp(join(tmpdir(), "agen-jobs-"));
    const store = fileJobStore(directory);

    await store.create(job("build-1"));
    await store.write({ ...job("build-1"), stage: Stage.Interpreting });

    const { readdir } = await import("node:fs/promises");
    const names = await readdir(directory);
    expect(names).toEqual(["build-1.json"]);
  });
});
