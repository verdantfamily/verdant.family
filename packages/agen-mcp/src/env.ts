/**
 * The configuration, checked once at boot.
 *
 * A server that starts with a missing base URL and fails on the first tool call has moved a
 * configuration error into an agent's conversation, where it reads as a product fault. So
 * everything is validated here and the process refuses to start otherwise, with every
 * problem listed rather than the first one.
 *
 * ## What is deliberately not configurable
 *
 * There is no variable for a private key, a mnemonic, or a signer of any kind — not
 * optional, not unused, not commented out. The MCP has no code that could consume one. The
 * only credential it takes is an Agen API key, which authenticates an agent that already
 * has its own treasury on the Agen side.
 */

import { z } from "zod";

const httpUrl = z
  .string()
  .trim()
  .min(1)
  .refine(
    (value) => {
      try {
        const url = new URL(value);
        return url.protocol === "http:" || url.protocol === "https:";
      } catch {
        return false;
      }
    },
    { message: "must be an http(s) URL" },
  )
  // A trailing slash here becomes a double slash in every path built from it.
  .transform((value) => value.replace(/\/+$/, ""));

const positiveInt = (fallback: number) =>
  z.coerce.number().int().positive().max(600_000).default(fallback);

export const envSchema = z.object({
  /**
   * Where agen.space answers. The Agent API v1 lives under `/api/v1`.
   */
  AGEN_API_URL: httpUrl.default("https://agen.space"),

  /**
   * An Agen agent API key, `agn_…`.
   *
   * Optional, and the read-only tools that do not need it still work without it. Absent, a
   * launch is refused with `UNAUTHORIZED` rather than attempted — the MCP never falls back
   * to an unauthenticated launch path, because there is not one.
   */
  AGEN_API_KEY: z
    .string()
    .trim()
    .regex(/^agn_[A-Za-z0-9_-]{8,}$/, "must be an Agen API key beginning agn_")
    .optional(),

  /**
   * The Instant indexer feed, as `AGEN_INSTANT_FEED_URL` names it in the web app.
   *
   * The source for every token, pool, discovery and metrics tool. Without it those tools
   * answer `CONFIG_MISSING` instead of guessing.
   */
  AGEN_INSTANT_FEED_URL: httpUrl.optional(),

  /** Chain 4663 unless a caller is pointed at a testnet deployment. */
  AGEN_CHAIN_ID: z.coerce.number().int().positive().default(4663),

  /**
   * A block explorer, used only to build links in tool output.
   *
   * Absent, the `explorerTx` and `explorerToken` links are null rather than guessed — a
   * link to the wrong chain's explorer is worse than no link.
   */
  AGEN_EXPLORER_URL: httpUrl.optional(),

  AGEN_MCP_LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),

  /** Per-request ceiling. A launch is slower than a read and gets its own. */
  AGEN_MCP_TIMEOUT_MS: positiveInt(15_000),
  AGEN_MCP_LAUNCH_TIMEOUT_MS: positiveInt(120_000),

  /**
   * How many times a *safe* request is retried. Never applied to a launch: see `http.ts`.
   */
  AGEN_MCP_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2),

  /** `stdio` for a desktop client, `http` for a hosted one. */
  AGEN_MCP_TRANSPORT: z.enum(["stdio", "http"]).default("stdio"),
  AGEN_MCP_PORT: positiveInt(8848),
  AGEN_MCP_HOST: z.string().trim().min(1).default("127.0.0.1"),
});

export type Env = z.infer<typeof envSchema>;

export class EnvError extends Error {
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(`agen-mcp configuration is not usable:\n  - ${problems.join("\n  - ")}`);
    this.name = "EnvError";
    this.problems = problems;
  }
}

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  // Empty strings are how a shell spells "unset", and would otherwise fail a `min(1)` as
  // though somebody had typed something wrong.
  const cleaned: Record<string, string> = {};
  for (const key of Object.keys(envSchema.shape)) {
    const value = source[key];
    if (value !== undefined && value.trim() !== "") cleaned[key] = value;
  }

  const parsed = envSchema.safeParse(cleaned);
  if (!parsed.success) {
    throw new EnvError(
      parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`),
    );
  }
  return parsed.data;
}
