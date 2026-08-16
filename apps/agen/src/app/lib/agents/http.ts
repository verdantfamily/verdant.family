import { NextResponse } from "next/server";

import { AgentError } from "./errors";

export function ok<T>(data: T, status = 200): NextResponse {
  return NextResponse.json(
    { ok: true, data: jsonSafe(data) },
    { status, headers: { "cache-control": "no-store" } },
  );
}

export function fail(error: unknown): NextResponse {
  if (error instanceof AgentError) {
    return NextResponse.json(
      { ok: false, error: error.toJSON() },
      { status: error.status, headers: { "cache-control": "no-store" } },
    );
  }

  console.error("[agen:agents]", error);
  return NextResponse.json(
    {
      ok: false,
      error: { code: "VALIDATION_FAILED", message: "The request could not be completed." },
    },
    { status: 500, headers: { "cache-control": "no-store" } },
  );
}

export function jsonSafe(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = jsonSafe(entry);
    }
    return out;
  }
  return value;
}

export async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = (await request.json()) as unknown;
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      throw new AgentError("VALIDATION_FAILED", "The request body was not a JSON object.");
    }
    return body as Record<string, unknown>;
  } catch (error) {
    if (error instanceof AgentError) throw error;
    throw new AgentError("VALIDATION_FAILED", "The request body was not JSON.");
  }
}
