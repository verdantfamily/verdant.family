import { describe, expect, it } from "vitest";

import { readArguments, registry, runTool, ToolError } from "./tools";
import { defineTool } from "./tools";

describe("registry", () => {
  it("refuses a duplicate name and a name that is not snake_case", () => {
    const tool = defineTool({
      name: "read_x_post",
      summary: "Read a post.",
      kind: "read",
      parameters: [],
      available: () => true,
      run: async () => ({ text: "ok" }),
    });

    expect(() => registry([tool, tool])).toThrow(/Two tools/);
    expect(() => registry([{ ...tool, name: "ReadXPost" }])).toThrow(/snake_case/);
  });

  it("reports a tool that cannot run, with the reason", () => {
    const ready = defineTool({
      name: "ok",
      summary: "Works.",
      kind: "read",
      parameters: [],
      available: () => true,
      run: async () => ({ text: "ok" }),
    });
    const down = defineTool({
      name: "search_x",
      summary: "Search.",
      kind: "read",
      parameters: [],
      available: () => "X search is not configured",
      run: async () => ({ text: "no" }),
    });

    const usable = registry([ready, down]).usable(undefined);
    expect(usable.ready.map((tool) => tool.name)).toEqual(["ok"]);
    expect(usable.unavailable).toEqual([{ name: "search_x", reason: "X search is not configured" }]);
  });
});

describe("readArguments", () => {
  const parameters = [
    { name: "token", type: "string" as const, required: true, description: "Address." },
    { name: "limit", type: "number" as const, required: false, description: "How many." },
  ];

  it("coerces a number written as a string and drops unknown keys", () => {
    expect(readArguments(parameters, '{"token":"0xabc","limit":"12","extra":true}')).toEqual({
      token: "0xabc",
      limit: 12,
    });
  });

  it("refuses a missing required argument and a payload pretending to be one", () => {
    expect(() => readArguments(parameters, "{}")).toThrow(ToolError);
    expect(() => readArguments(parameters, '{"token":"' + "a".repeat(401) + '"}')).toThrow(
      /too long/,
    );
  });
});

describe("runTool", () => {
  it("turns a throw into a readable failure the model can react to", async () => {
    const tool = defineTool({
      name: "inspect_url",
      summary: "Fetch a page.",
      kind: "read",
      parameters: [],
      available: () => true,
      run: async () => {
        throw new Error("timed out");
      },
    });

    const outcome = await runTool(tool, {}, undefined, 1_000);
    expect(outcome.ok).toBe(false);
    expect(outcome.text).toContain("timed out");
  });
});
