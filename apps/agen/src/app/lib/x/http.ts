import { NextResponse } from "next/server";

import { jsonSafe } from "../agents/http";
import { XError } from "./errors";

/**
 * The X surface's own answers.
 *
 * The same envelope as `agents/http.ts` — `{ ok, data }` or `{ ok, error }`, never cached — and
 * a separate function only because the error type differs. `jsonSafe` is borrowed rather than
 * copied: it exists to turn bigints into strings before `JSON.stringify` refuses to, and there
 * is no version of that this surface needs differently.
 */
export function ok<T>(data: T, status = 200): NextResponse {
  return NextResponse.json(
    { ok: true, data: jsonSafe(data) },
    { status, headers: { "cache-control": "no-store" } },
  );
}

export function fail(error: unknown): NextResponse {
  if (error instanceof XError) {
    return NextResponse.json(
      { ok: false, error: error.toJSON() },
      { status: error.status, headers: { "cache-control": "no-store" } },
    );
  }

  console.error("[agen:x]", error);
  return NextResponse.json(
    {
      ok: false,
      error: { code: "VALIDATION_FAILED", message: "The request could not be completed." },
    },
    { status: 500, headers: { "cache-control": "no-store" } },
  );
}

export async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = (await request.json()) as unknown;
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      throw new XError("VALIDATION_FAILED", "The request body was not a JSON object.");
    }
    return body as Record<string, unknown>;
  } catch (error) {
    if (error instanceof XError) throw error;
    throw new XError("VALIDATION_FAILED", "The request body was not JSON.");
  }
}
