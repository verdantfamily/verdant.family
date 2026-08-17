#!/usr/bin/env node
/**
 * The process.
 *
 * ## Configuration is checked before a transport is opened
 *
 * A server that connects and then fails every call has turned a missing environment variable
 * into something an agent has to diagnose mid-conversation. So `loadEnv` runs first and the
 * process exits non-zero with every problem listed.
 *
 * ## Nothing is ever written to stdout
 *
 * On the stdio transport stdout is the protocol. Every log line goes to stderr — see
 * `logger.ts` — and the only thing that writes to stdout is the SDK.
 *
 * ## Shutdown
 *
 * `SIGINT` and `SIGTERM` close the transport and the HTTP listener, so a client sees a clean
 * disconnection rather than a socket dropping. A second signal exits immediately, because a
 * shutdown that will not finish must not be the reason a supervisor cannot restart the
 * service. Nothing here is mid-transaction: the launch tool holds no state, and a launch
 * already broadcast is the chain's business rather than this process's.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { EnvError, loadEnv, type Env } from "./env.js";
import { createLogger, type Logger } from "./logger.js";
import { buildServer, SERVER_NAME, SERVER_VERSION } from "./server.js";

export { buildServer, buildContext } from "./server.js";
export { loadEnv, envSchema } from "./env.js";
export { AgenMcpError } from "./errors.js";

async function main(): Promise<void> {
  let env: Env;
  try {
    env = loadEnv();
  } catch (error) {
    if (error instanceof EnvError) {
      process.stderr.write(`${error.message}\n`);
      process.exit(78); // EX_CONFIG
    }
    throw error;
  }

  const logger = createLogger({ level: env.AGEN_MCP_LOG_LEVEL });

  logger.info("starting", {
    version: SERVER_VERSION,
    transport: env.AGEN_MCP_TRANSPORT,
    chainId: env.AGEN_CHAIN_ID,
    agenApi: env.AGEN_API_URL,
    // Whether a key is present, never any part of it.
    authenticated: env.AGEN_API_KEY !== undefined,
    feedConfigured: env.AGEN_INSTANT_FEED_URL !== undefined,
  });

  if (env.AGEN_API_KEY === undefined) {
    logger.warn("no AGEN_API_KEY: quoting and launching will be refused with UNAUTHORIZED");
  }
  if (env.AGEN_INSTANT_FEED_URL === undefined) {
    logger.warn("no AGEN_INSTANT_FEED_URL: token, pool, discovery and metrics tools will be refused with CONFIG_MISSING");
  }

  const { server } = buildServer({ env, logger });

  const close =
    env.AGEN_MCP_TRANSPORT === "stdio"
      ? await startStdio(server, logger)
      : await startHttp(server, env, logger);

  installShutdown(close, logger);
}

async function startStdio(
  server: ReturnType<typeof buildServer>["server"],
  logger: Logger,
): Promise<() => Promise<void>> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("listening on stdio");
  return async () => {
    await server.close();
  };
}

/**
 * Streamable HTTP, for a hosted deployment, plus a health endpoint.
 *
 * `/healthz` is unauthenticated and says only whether the process is up and what it is
 * configured to reach — never a credential, and never a backend's reply. It deliberately does
 * not call either backend: a health check that fails because a third party is slow takes a
 * working server out of rotation.
 *
 * Session management is enabled so that one listener can serve more than one client. Bound to
 * `127.0.0.1` by default: this transport has no authentication of its own, so exposing it
 * publicly is a decision an operator has to make explicitly.
 */
async function startHttp(
  server: ReturnType<typeof buildServer>["server"],
  env: Env,
  logger: Logger,
): Promise<() => Promise<void>> {
  const [{ createServer }, { StreamableHTTPServerTransport }, { randomUUID }] = await Promise.all([
    import("node:http"),
    import("@modelcontextprotocol/sdk/server/streamableHttp.js"),
    import("node:crypto"),
  ]);

  /*
   * A bind address that is not loopback is announced loudly.
   *
   * `/mcp` has no authentication of its own, and it fronts a tool that can spend an agent's
   * treasury with the key this process already holds. Exposing it is a legitimate deployment
   * — behind a proxy that authenticates — but it must never be something an operator does by
   * copying a `0.0.0.0` from an example without noticing.
   */
  if (env.AGEN_MCP_HOST !== "127.0.0.1" && env.AGEN_MCP_HOST !== "localhost" && env.AGEN_MCP_HOST !== "::1") {
    logger.warn("http transport is not bound to loopback and has no authentication of its own", {
      host: env.AGEN_MCP_HOST,
      advice: "Put an authenticating proxy in front of /mcp, or bind AGEN_MCP_HOST to 127.0.0.1.",
    });
  }

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });

  /*
   * Cast because of `exactOptionalPropertyTypes`, which this repository sets and the SDK does
   * not. The transport declares `onclose?: () => void`, the `Transport` interface it satisfies
   * declares `onclose: (() => void) | undefined`, and under that flag those are different
   * types. It is a strictness mismatch between two of the SDK's own declarations rather than
   * anything about this transport, so it is narrowed here rather than worked around.
   */
  await server.connect(transport as unknown as Parameters<typeof server.connect>[0]);

  const http = createServer((request, response) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

    if (url.pathname === "/healthz") {
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(
        JSON.stringify({
          ok: true,
          service: SERVER_NAME,
          version: SERVER_VERSION,
          chainId: env.AGEN_CHAIN_ID,
          authenticated: env.AGEN_API_KEY !== undefined,
          feedConfigured: env.AGEN_INSTANT_FEED_URL !== undefined,
          uptimeSeconds: Math.round(process.uptime()),
        }),
      );
      return;
    }

    if (url.pathname !== "/mcp") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "not found" }));
      return;
    }

    void transport.handleRequest(request, response).catch((error: unknown) => {
      logger.error("http transport failed", {
        message: error instanceof Error ? error.message : String(error),
      });
      if (!response.headersSent) {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "internal error" }));
      }
    });
  });

  await new Promise<void>((resolve) => {
    http.listen(env.AGEN_MCP_PORT, env.AGEN_MCP_HOST, resolve);
  });

  logger.info("listening on http", {
    host: env.AGEN_MCP_HOST,
    port: env.AGEN_MCP_PORT,
    mcp: "/mcp",
    health: "/healthz",
  });

  return async () => {
    await new Promise<void>((resolve) => {
      http.close(() => resolve());
    });
    await server.close();
  };
}

function installShutdown(close: () => Promise<void>, logger: Logger): void {
  let closing = false;

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      if (closing) {
        logger.warn("second signal, exiting now", { signal });
        process.exit(1);
      }
      closing = true;
      logger.info("shutting down", { signal });

      void close()
        .then(() => {
          logger.info("closed");
          process.exit(0);
        })
        .catch((error: unknown) => {
          logger.error("shutdown failed", {
            message: error instanceof Error ? error.message : String(error),
          });
          process.exit(1);
        });
    });
  }
}

/**
 * Only when run, never when imported.
 *
 * Tests import `buildServer` from this module's siblings, and a top-level `main()` here would
 * open a stdio transport in the middle of a test run.
 */
const invoked =
  process.argv[1] !== undefined &&
  (import.meta.url.endsWith(process.argv[1]) || import.meta.url === `file://${process.argv[1]}`);

if (invoked) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `${JSON.stringify({
        level: "error",
        service: SERVER_NAME,
        message: error instanceof Error ? error.message : String(error),
      })}\n`,
    );
    process.exit(1);
  });
}
