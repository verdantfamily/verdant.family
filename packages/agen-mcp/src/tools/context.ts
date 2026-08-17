/**
 * What every tool is handed, and how every tool answers.
 *
 * ## Success carries `structuredContent`; failure deliberately does not
 *
 * A successful call returns its JSON both as text and as `structuredContent`, which is what a
 * client validates against the tool's declared `outputSchema`.
 *
 * A failure returns the same JSON as text, sets `isError`, and sets **no** `structuredContent`
 * at all. That is not a convenience: a validating client — including the SDK's own — checks
 * `structuredContent` against the output schema whenever it is present, error or not. An error
 * body sent there is rejected before the caller ever sees it, and what the agent gets instead
 * of "UNAUTHORIZED, set AGEN_API_KEY" is a schema-validation exception from its own transport.
 * Verified end to end in `server.test.ts` rather than assumed from the specification.
 *
 * The alternative — widening every output schema to a union of the answer and an error — would
 * make each schema describe two things at once and document both of them worse.
 *
 * ## Nothing is written in prose
 *
 * Responses carry codes and numbers. The one exception is `nextStep` on a launch, which
 * exists because "here is unsigned calldata" is genuinely ambiguous about whose turn it is,
 * and an agent that guesses either signs nothing or signs twice.
 */

import { randomUUID } from "node:crypto";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { AgenClient } from "../clients/agen.js";
import type { FeedClient } from "../clients/feed.js";
import type { Env } from "../env.js";
import { AgenMcpError, asMcpError } from "../errors.js";
import type { Logger } from "../logger.js";

export interface ToolContext {
  readonly env: Env;
  readonly agen: AgenClient;
  readonly feed: FeedClient;
  readonly logger: Logger;
}

/**
 * The SDK's own result type rather than a local restatement of it.
 *
 * Declared locally once and it did not survive: `CallToolResult` carries an index signature
 * and mutable arrays, so a tidier hand-written version does not assign to it. Importing the
 * real one also means a change to the protocol's result shape is a type error here rather
 * than a runtime surprise at a client.
 */
export type ToolResult = CallToolResult;

export function success(data: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data) }],
    structuredContent: data,
  };
}

export function failure(error: AgenMcpError): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(error.toStructured()) }],
    isError: true,
  };
}

/**
 * The boundary every tool runs inside.
 *
 * One request id per call, threaded into both backends and into every log line, and returned
 * on failure so that a caller reporting a problem can be found in the logs. Nothing escapes
 * as an unhandled throw: an MCP client that receives a transport error learns less than one
 * that receives a code.
 */
export async function runTool<T>(
  {
    name,
    context,
    input,
  }: { readonly name: string; readonly context: ToolContext; readonly input: T },
  body: (arguments_: { readonly requestId: string; readonly logger: Logger }) => Promise<Record<string, unknown>>,
): Promise<ToolResult> {
  const requestId = randomUUID();
  const logger = context.logger.child({ tool: name, requestId });
  const started = Date.now();

  logger.info("tool call", { input });

  try {
    const data = await body({ requestId, logger });
    logger.info("tool ok", { durationMs: Date.now() - started });
    return success(data);
  } catch (error) {
    const failed = asMcpError(error);
    const withId =
      failed.detail.requestId === undefined
        ? new AgenMcpError(failed.code, failed.message, { ...failed.detail, requestId })
        : failed;

    logger.warn("tool failed", {
      durationMs: Date.now() - started,
      code: withId.code,
      upstreamCode: withId.detail.upstreamCode,
      httpStatus: withId.detail.httpStatus,
      message: withId.message,
    });

    return failure(withId);
  }
}

/** Agen's own market page for a token, which the deployment always serves. */
export function marketUrl(env: Env, token: string | null): string | null {
  return token === null ? null : `${env.AGEN_API_URL}/markets/${token}`;
}

export function explorerUrl(env: Env, kind: "tx" | "address", value: string | null): string | null {
  if (value === null || env.AGEN_EXPLORER_URL === undefined) return null;
  return `${env.AGEN_EXPLORER_URL}/${kind}/${value}`;
}
