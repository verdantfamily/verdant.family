/**
 * That the interpretation schema is one every configured provider will accept.
 *
 * ## The failure this exists for
 *
 * OpenAI's structured outputs are stricter than JSON Schema. Under `strict`, every object must
 * set `additionalProperties: false` and must list *every* key of `properties` in `required` —
 * optional fields are not permitted at all. A schema breaking either rule does not degrade; the
 * request comes back 400 and no call succeeds.
 *
 * The engine's schema broke the second rule on ladder stages, which have `afterSeconds` for a
 * time ladder and `afterQuoteAmount` for a volume one and required neither. Every OpenAI
 * interpretation had therefore been failing since the engine was written, and nobody saw it
 * because Anthropic is the primary and Anthropic accepts the schema.
 *
 * That made the failover decorative. The app wraps its primary in `fallbackProvider` precisely
 * so an exhausted balance or a bad afternoon at one vendor is not an outage — and the spare
 * could not answer a single request. It surfaced when Anthropic's credits ran out mid-benchmark
 * and the run did not fail over; it simply failed.
 *
 * ## Why a local test rather than a live call
 *
 * Because this must fail in CI rather than in production, and because the rule is a property of
 * the schema that can be checked without a network. A live probe is the right thing to do once,
 * and the wrong thing to depend on: it needs credentials, it costs money, and it goes green the
 * moment a provider is unreachable.
 */

import { describe, expect, it } from "vitest";

import { ENVELOPE_SCHEMA } from "./interpret.js";

interface Node {
  readonly type?: unknown;
  readonly properties?: Record<string, Node>;
  readonly required?: readonly string[];
  readonly additionalProperties?: unknown;
  readonly items?: Node;
  readonly anyOf?: readonly Node[];
}

/** Every object node in the schema, with the path taken to reach it. */
function objectsIn(node: Node, path = "root"): readonly { path: string; node: Node }[] {
  const found: { path: string; node: Node }[] = [];

  if (node.properties !== undefined) found.push({ path, node });

  for (const [name, child] of Object.entries(node.properties ?? {})) {
    found.push(...objectsIn(child, `${path}.${name}`));
  }
  if (node.items !== undefined) found.push(...objectsIn(node.items, `${path}[]`));
  for (const [index, child] of (node.anyOf ?? []).entries()) {
    found.push(...objectsIn(child, `${path}|${String(index)}`));
  }

  return found;
}

describe("the interpretation schema under OpenAI's strict rules", () => {
  /*
   * The rule that was broken. Stated as "every property is required" rather than as a list of
   * known-bad spots, because the next optional field somebody adds will be somewhere else.
   */
  it("requires every property of every object", () => {
    for (const { path, node } of objectsIn(ENVELOPE_SCHEMA as Node)) {
      const properties = Object.keys(node.properties ?? {});
      const required = [...(node.required ?? [])].sort();

      expect(
        required,
        `${path} has properties [${properties.join(", ")}] and requires [${required.join(", ")}]. ` +
          `OpenAI rejects the whole request for this. Make the field required and nullable ` +
          `instead of optional.`,
      ).toEqual([...properties].sort());
    }
  });

  it("closes every object to additional properties", () => {
    for (const { path, node } of objectsIn(ENVELOPE_SCHEMA as Node)) {
      expect(node.additionalProperties, `${path} is open to additional properties`).toBe(false);
    }
  });

  /*
   * A guard on the walker. If it stopped at the root or failed to follow `anyOf` and `items`,
   * the two assertions above would pass over a handful of nodes and miss the nested ones —
   * which is exactly where the real defect was.
   */
  it("walks into arrays and unions, where the defect actually was", () => {
    const paths = objectsIn(ENVELOPE_SCHEMA as Node).map((one) => one.path);

    expect(paths.length).toBeGreaterThan(8);
    expect(paths.some((path) => path.includes("[]"))).toBe(true);
    expect(paths.some((path) => path.includes("|"))).toBe(true);

    // The node that was wrong, reached by the path it is actually at.
    expect(paths.some((path) => path.includes("ladder") && path.includes("stages"))).toBe(true);
  });

  /*
   * And that the fix took the shape it had to take. A ladder stage must carry both axes' fields
   * with both nullable, because that is the only way to express "one or the other" under rules
   * that forbid optional fields.
   */
  it("expresses a ladder stage's two axes as nullable rather than optional", () => {
    const stage = objectsIn(ENVELOPE_SCHEMA as Node).find(
      (one) => one.path.includes("ladder") && one.path.includes("stages") && one.path.endsWith("[]"),
    );

    expect(stage, "the ladder's stage schema moved").toBeDefined();
    expect(stage?.node.required).toContain("afterSeconds");
    expect(stage?.node.required).toContain("afterQuoteAmount");

    for (const field of ["afterSeconds", "afterQuoteAmount"]) {
      expect(
        stage?.node.properties?.[field]?.type,
        `${field} must accept null, since a stage of the other axis has nothing to put there`,
      ).toContain("null");
    }
  });
});
