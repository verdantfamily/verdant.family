import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";

import { count, eth } from "../lib/format";
import { fetchInstantMetrics } from "../lib/instant-feed";
import { marketSource } from "../lib/markets";
import { AsciiTorus, BlockBars, SpiralType } from "./art";
import { CodePanel, type CodeTab } from "./code";
import { DocNav, type DocSection } from "./nav";
import "./mcp.css";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "MCP — agen.space",
  description:
    "Agen MCP connects AI agents to Agen Instant: quote a launch, prepare the transaction, read tokens, pools and markets. No keys, no custody.",
  alternates: { canonical: "/mcp" },
  openGraph: {
    title: "Agen MCP — give AI agents access to onchain launches",
    description:
      "Eight tools over Agen Instant. Six read, one prepares a transaction your wallet signs, one spends an agent treasury.",
    url: "/mcp",
    type: "website",
  },
};

/** The index, and the order the page is written in. */
const SECTIONS: readonly DocSection[] = [
  { id: "overview", label: "Overview" },
  { id: "start", label: "Quick start" },
  { id: "config", label: "Configuration" },
  { id: "tools", label: "Tool reference" },
  { id: "flow", label: "How a launch travels" },
  { id: "session", label: "Example session" },
  { id: "custody", label: "Custody" },
  { id: "data", label: "Live data" },
  { id: "faq", label: "Questions" },
];

/* ------------------------------------------------------------------ content */

/**
 * The eight tools, exactly as the server advertises them.
 *
 * Names and kinds are copied from `packages/agen-mcp/src/server.ts` rather than
 * paraphrased. A page that renames a tool teaches an agent a name that does not resolve,
 * and a reader has no way to tell which of the two is the typo.
 */
const TOOLS: readonly {
  readonly name: string;
  readonly kind: "read" | "prepare" | "spend";
  readonly what: string;
}[] = [
  {
    name: "get_launch_quote",
    kind: "read",
    what: "Simulates the launch against the deployed factory. Tokens received, ownership, price impact, opening market cap, the fee split — and the block it was quoted at.",
  },
  {
    name: "get_launch_status",
    kind: "read",
    what: "Where a launch got to, by launch id, token address or transaction hash. Submitted, confirmed, deployed, pooled, tradable, indexed.",
  },
  {
    name: "get_token",
    kind: "read",
    what: "Everything Agen knows about one token: supply, creator, fee receiver and vault, price, market cap, volume, accrued fees.",
  },
  {
    name: "get_pool",
    kind: "read",
    what: "The Uniswap v4 pool behind a market — liquidity, tick, price, the locked position, and the fee split in ppm.",
  },
  {
    name: "get_launches",
    kind: "read",
    what: "Discovery over the indexer. Sort by newest, volume, organic volume, trades, liquidity or fees; filter by creator or token.",
  },
  {
    name: "get_instant_metrics",
    kind: "read",
    what: "The ecosystem in one call: markets, creators, trades, volume, fees, and the fixed terms every Instant launch is issued under.",
  },
  {
    name: "prepare_instant_launch",
    kind: "prepare",
    what: "Builds the launch transaction and hands it back unsigned. Stores the metadata and mines the salt; signs nothing and spends nothing.",
  },
  {
    name: "launch_instant_from_agent_treasury",
    kind: "spend",
    what: "The only tool that moves money. An authorised Agen agent's own treasury signs, inside the caps its owner set.",
  },
];

const KIND_LABEL: Readonly<Record<"read" | "prepare" | "spend", string>> = {
  read: "read-only",
  prepare: "prepare",
  spend: "executes",
};

/** The four things worth knowing before the reference starts. */
const CLAIMS: readonly { readonly title: string; readonly body: string }[] = [
  {
    title: "Quoted against the chain",
    body: "Not a bonding curve reimplemented in TypeScript. The real create call is encoded and simulated with eth_call against the deployed factory, so the tokens received come out of the contract's own return value.",
  },
  {
    title: "Prepared, not custodied",
    body: "Launch calldata comes back unsigned, marked prepared, and says twice more that it needs a signature and a broadcast. Your wallet is the only thing that can turn it into a market.",
  },
  {
    title: "The whole market, readable",
    body: "Tokens, pools, launch status, discovery by volume or recency, and ecosystem totals — straight from the Instant indexer, with nulls and reasons instead of estimates.",
  },
  {
    title: "One engine underneath",
    body: "No second quote path and no fee table copied for agents. Every figure an agent reads is computed by the code that computes it for the site you are on.",
  },
];

/** The environment, as the server validates it at boot. */
const VARS: readonly {
  readonly name: string;
  readonly fallback: string;
  readonly note: string;
}[] = [
  { name: "AGEN_API_URL", fallback: "https://agen.space", note: "Trailing slashes stripped." },
  {
    name: "AGEN_API_KEY",
    fallback: "—",
    note: "An Agen agent key, agn_…. Needed for quoting and both launch tools. Never logged.",
  },
  {
    name: "AGEN_INSTANT_FEED_URL",
    fallback: "—",
    note: "The Instant indexer. Without it the four indexer-backed tools answer CONFIG_MISSING rather than pretending there are no markets.",
  },
  {
    name: "AGEN_EXPLORER_URL",
    fallback: "—",
    note: "Only builds links. Absent, link fields come back null rather than guessed.",
  },
  { name: "AGEN_CHAIN_ID", fallback: "4663", note: "Robinhood Chain." },
  { name: "AGEN_MCP_TRANSPORT", fallback: "stdio", note: "stdio or http." },
  {
    name: "AGEN_MCP_HOST",
    fallback: "127.0.0.1",
    note: "The HTTP transport has no authentication of its own, so exposing it is an explicit decision.",
  },
  { name: "AGEN_MCP_PORT", fallback: "8848", note: "POST /mcp, and GET /healthz." },
  { name: "AGEN_MCP_TIMEOUT_MS", fallback: "15000", note: "Per read. Launches get their own, 120000." },
  { name: "AGEN_MCP_MAX_RETRIES", fallback: "2", note: "Safe requests only. A launch is never retried." },
  {
    name: "AGEN_MCP_LOG_LEVEL",
    fallback: "info",
    note: "debug logs request ids, durations and paths — never bodies.",
  },
];

/** How a launch actually travels. Six steps, and two of them are the reader's own wallet. */
const STEPS: readonly {
  readonly title: string;
  readonly body: string;
  readonly who: string;
  readonly you?: boolean;
}[] = [
  {
    title: "The agent asks what the launch would do",
    body: "get_launch_quote encodes the real create call and simulates it with eth_call against the deployed factory. Nothing is modelled here — the tokens received come out of the contract's own return value.",
    who: "agent → agen → chain",
  },
  {
    title: "Agen answers with the whole shape of it",
    body: "Tokens received, ownership percent, price impact, opening market cap, the 1.5% fee split, and the block the simulation was pinned to. Anything wrong with the launch comes back in problems[] before a wallet is ever opened.",
    who: "read-only",
  },
  {
    title: "The agent prepares the transaction",
    body: 'prepare_instant_launch stores the metadata, mines the salt and returns calldata, along with execution_status: "prepared" and requires_signature: true. It holds no key, and neither does the route behind it.',
    who: "no signature, no spend",
  },
  {
    title: "Your wallet signs",
    body: "You send it, from the signer the calldata was prepared for. The token address is derived from the sender, so the wallet that signs is the wallet the market is created by.",
    who: "your keys",
    you: true,
  },
  {
    title: "One transaction does all of it",
    body: "InstantFactory.create deploys the token, opens the Uniswap v4 pool, locks the position, wires the fee vault and executes your first buy. There is no second step to wait for.",
    who: "onchain",
    you: true,
  },
  {
    title: "The agent watches it land",
    body: "get_launch_status until it is confirmed, then get_token and get_pool for the market that now exists. Indexing is the only stage that lags, and the response says so rather than reporting the token as missing.",
    who: "agent → agen",
  },
];

const FAQ: readonly { readonly q: string; readonly a: string }[] = [
  {
    q: "What can an agent actually do?",
    a: "Quote a launch, prepare the transaction for it, read any Instant token or pool, follow a launch to confirmation, discover markets by volume or recency, and read ecosystem totals. Six of the eight tools only read. One returns unsigned calldata. One spends an authorised agent treasury.",
  },
  {
    q: "Does Agen MCP hold private keys?",
    a: "No. There is no environment variable, tool parameter or code path that accepts a private key or a mnemonic, and a test asserts it against the configuration schema so that adding one would require deleting the test. The server holds an Agen API key and nothing else.",
  },
  {
    q: "Can I use my own wallet?",
    a: "That is the default path. prepare_instant_launch returns a transaction; you sign and broadcast it yourself. Send it from the signer it was prepared for — the token address is derived from the sender, so calldata sent by a different wallet lands on a different address.",
  },
  {
    q: "Is there a remote endpoint?",
    a: "Not a public one. The server runs on your machine over stdio, which is what a desktop client wants. There is also a streamable HTTP transport, bound to 127.0.0.1 by default and deliberately unauthenticated: whoever can reach that port can call every tool with the key the process holds, so the port is the boundary. Put an authenticating proxy in front of it, or use stdio.",
  },
  {
    q: "How does the agent treasury path work?",
    a: "An Agen agent has its own isolated wallet with permissions its owner configured — a per-launch ETH ceiling, launches per day, a creator-buy cap and a reserve. launch_instant_from_agent_treasury posts to the same endpoint the agent API uses, and Agen enforces those caps. It refuses a feeReceiver or signer rather than ignoring one, because a silently dropped fee receiver would let an agent truthfully report a destination the vault does not have.",
  },
  {
    q: "What happens when something fails?",
    a: "Backend failures are normalised to a small set of codes — UNAUTHORIZED, RATE_LIMITED, INSUFFICIENT_BALANCE, TOKEN_NOT_FOUND, INDEXER_PENDING, TRANSACTION_REVERTED and a dozen more — each carrying the underlying reason wherever it is safe to show, plus a request id you can quote. Bad input is refused earlier still, by the schema, and names the field.",
  },
  {
    q: "Which chain, and what are the terms?",
    a: 'Robinhood Chain, id 4663. Every Instant market is a billion tokens at 18 decimals, opening at a 1.5 ETH valuation, with 1.5% of every trade split 1% to the creator and 0.5% to the platform. Those are factory constants, not parameters — totalSupply exists as an input only so that an agent told "launch with a 1B supply" can confirm it.',
  },
];

/* --------------------------------------------------------------- the examples */

const SETUP_EXAMPLES: readonly CodeTab[] = [
  {
    id: "build",
    label: "Build & run",
    lang: "bash",
    code: `pnpm install
pnpm --filter @verdant/agen-mcp build

# stdio, which is what a desktop client wants
AGEN_INSTANT_FEED_URL=https://instant-feed.agen.space \\
AGEN_API_KEY=agn_… \\
node packages/agen-mcp/dist/index.js`,
    note: "Configuration is validated at boot: a bad value exits 78 with every problem listed, rather than failing on the first tool call.",
  },
  {
    id: "cursor",
    label: "Cursor",
    lang: "json",
    code: `// .cursor/mcp.json — or ~/.cursor/mcp.json for every project
{
  "mcpServers": {
    "agen-instant": {
      "command": "node",
      "args": ["/absolute/path/to/verdant/packages/agen-mcp/dist/index.js"],
      "env": {
        "AGEN_API_KEY": "agn_…",
        "AGEN_INSTANT_FEED_URL": "https://instant-feed.agen.space"
      }
    }
  }
}`,
    note: "Restart Cursor and the eight tools appear. Reads can be auto-approved; the two write tools are annotated so your client knows to ask.",
  },
  {
    id: "claude",
    label: "Claude Desktop",
    lang: "json",
    code: `// ~/Library/Application Support/Claude/claude_desktop_config.json
{
  "mcpServers": {
    "agen-instant": {
      "command": "node",
      "args": ["/absolute/path/to/verdant/packages/agen-mcp/dist/index.js"],
      "env": {
        "AGEN_API_URL": "https://agen.space",
        "AGEN_API_KEY": "agn_…",
        "AGEN_INSTANT_FEED_URL": "https://instant-feed.agen.space",
        "AGEN_EXPLORER_URL": "https://explorer.rhchain.com"
      }
    }
  }
}`,
    note: "Without an explorer URL the link fields come back null rather than guessed.",
  },
  {
    id: "code",
    label: "Claude Code",
    lang: "bash",
    code: `claude mcp add agen-instant \\
  --env AGEN_API_KEY=agn_… \\
  --env AGEN_INSTANT_FEED_URL=https://instant-feed.agen.space \\
  -- node /absolute/path/to/verdant/packages/agen-mcp/dist/index.js`,
    note: "Same server, same transport. The key lives in your client's config, never in the repository.",
  },
  {
    id: "http",
    label: "Over HTTP",
    lang: "bash",
    code: `AGEN_MCP_TRANSPORT=http AGEN_MCP_PORT=8848 \\
node packages/agen-mcp/dist/index.js

# streamable HTTP on POST http://127.0.0.1:8848/mcp
# liveness on GET  http://127.0.0.1:8848/healthz`,
    note: (
      <>
        <strong>Do not expose that port.</strong> It has no authentication of its own, so anyone
        who can reach it can call every tool with the key this process holds. Put an
        authenticating proxy in front of it, or run stdio, which has no port at all.
      </>
    ),
  },
];

const CALL_EXAMPLES: readonly CodeTab[] = [
  {
    id: "ask",
    label: "The ask",
    lang: "bash",
    code: `# What the person typed, in their client:
"Launch a token called Atlas with 0.05 ETH in the first buy,
 and send the fees to 0x2222…2222."

# What the agent does with it:
#   1. get_launch_quote        → what it would cost and produce
#   2. prepare_instant_launch  → unsigned calldata
#   3. (you sign and broadcast)
#   4. get_launch_status       → until confirmed
#   5. get_token               → the market that now exists`,
    note: "Five calls, one signature, and the signature is yours. Every figure below is illustrative; the shapes are exact.",
  },
  {
    id: "quote",
    label: "1 · Quote",
    lang: "json",
    code: `// tools/call — get_launch_quote
{
  "name": "Atlas",
  "symbol": "ATLAS",
  "initialBuyEth": "0.05",
  "feeReceiver": "0x2222222222222222222222222222222222222222"
}`,
    note: (
      <>
        Simulated with <code>eth_call</code> against the deployed factory. The fee receiver may be
        any address, and is immutable once the market exists.
      </>
    ),
  },
  {
    id: "quoted",
    label: "2 · Quoted",
    lang: "json",
    code: `{
  "chainId": 4663,
  "quotedAt": 1770000000,
  "blockNumber": "4182993",
  "supplyTokens": "1000000000",
  "startingMarketCapWei": "1500000000000000000",
  "feePpm": { "total": 15000, "creator": 10000, "platform": 5000 },
  "initialBuy": {
    "amountWei": "50000000000000000",
    "tokensBaseUnits": "31800000000000000000000000",
    "ownershipPercent": 3.18,
    "priceImpactBps": 328
  },
  "problems": [],
  "simulated": true
}`,
    note: (
      <>
        A quote is true of one block of one chain, so it says which. Nothing expires — re-quoting
        is free, and <code>simulated: false</code> means the node refused rather than that the
        numbers were guessed.
      </>
    ),
  },
  {
    id: "prepare",
    label: "3 · Prepare",
    lang: "json",
    code: `// tools/call — prepare_instant_launch
{
  "name": "Atlas",
  "symbol": "ATLAS",
  "imageUrl": "https://example.com/atlas.png",
  "signer": "0x1111111111111111111111111111111111111111",
  "feeReceiver": "0x2222222222222222222222222222222222222222",
  "initialBuyEth": "0.05"
}`,
    note: "Stores the metadata document and mines the salt. It is not marked read-only for exactly that reason, even though it signs nothing.",
  },
  {
    id: "prepared",
    label: "4 · Prepared",
    lang: "json",
    code: `{
  "execution_status": "prepared",
  "requires_signature": true,
  "requires_broadcast": true,
  "signedBy": "caller_wallet",
  "transaction": {
    "to": "0x…factory",
    "data": "0x…",
    "value": "50000000000000000",
    "chainId": 4663
  },
  "token": "0x…predicted",
  "tokenAddressIsPredicted": true,
  "txHash": null,
  "launchId": null,
  "nextStep": "Sign and broadcast transaction from signer."
}`,
    note: (
      <>
        Four of those fields are schema constants, so a client can rely on them without making a
        call. <code>txHash</code> and <code>launchId</code> are null because nothing has happened
        yet.
      </>
    ),
  },
  {
    id: "status",
    label: "5 · Status",
    lang: "json",
    code: `// tools/call — get_launch_status
{ "txHash": "0x…" }

{
  "status": "confirmed",
  "stages": {
    "submitted": true,
    "confirmed": true,
    "deployed": true,
    "poolCreated": true,
    "tradable": true,
    "indexed": false
  },
  "indexerPending": true,
  "source": "both"
}`,
    note: (
      <>
        <code>deployed</code>, <code>poolCreated</code> and <code>tradable</code> turn true
        together — one transaction does all three. Only <code>indexed</code> genuinely lags.
      </>
    ),
  },
];

/* ------------------------------------------------------------------- the page */

/**
 * Agen MCP, documented.
 *
 * Somebody arriving here has already decided they want to connect an agent, so the page is
 * a reference before it is anything else: an index in the margin, one measure of text, the
 * config file, the tool list, and a straight answer about who holds the keys. The hero
 * exists to say what this is in one line, not to sell it twice.
 *
 * The figures in "Live data" are real — the same ones `/metrics` renders, read from the
 * Instant indexer at request time, with the chart bucketed from actual creation timestamps.
 * When the feed is not answering the section says so rather than falling back to a shape.
 * A chart of invented activity would be a strange thing to put on the page offering
 * programmatic access to real activity.
 */
export default async function McpDocs() {
  const [metrics, markets] = await Promise.all([
    fetchInstantMetrics(),
    marketSource()
      .list()
      .catch(() => []),
  ]);

  const weeks = weeklyLaunches(markets.filter((market) => market.kind === "instant"));

  return (
    <div className="cx">
      <header className="cx-wrap">
        <div className="cx-bar-top">
          <Link className="cx-brand" href="/">
            {/* Not next/image: an 18px brand mark already sized, with nothing to optimise. */}
            <img src="/mark.png" width={18} height={18} alt="" aria-hidden="true" />
            Agen <span>/ MCP</span>
          </Link>

          <nav className="cx-bar-links" aria-label="page">
            <a href="#tools">Tools</a>
            <a href="#flow">Flow</a>
            <a href="#custody">Custody</a>
            <a href="#faq">FAQ</a>
            <Link href="/">agen.space ↗</Link>
          </nav>
        </div>
      </header>

      <div className="cx-wrap">
        <section className="cx-hero">
          <div className="cx-hero-say">
            <p className="cx-eyebrow">Built for agentic launches.</p>

            <h1 className="cx-title">The launchpad your agent can drive.</h1>

            <p>
              Agen Instant deploys a token, opens a Uniswap v4 pool, locks the position, wires the
              fee vault and executes the first buy — in one transaction. Agen MCP puts that engine
              behind eight typed tools, over the Model Context Protocol, and holds no keys while
              doing it.
            </p>

            <div className="cx-acts">
              <a className="cx-go" href="#start">
                Quick start
              </a>
              <a className="cx-go cx-go-line" href="#tools">
                <span className="cx-dot" aria-hidden="true" />
                Read the tools
              </a>
            </div>

            <div className="cx-strip">
              <div>
                <span>Tools</span>
                <b>8 typed</b>
              </div>
              <div>
                <span>Read-only</span>
                <b>6 of 8</b>
              </div>
              <div>
                <span>Private keys</span>
                <b>0</b>
              </div>
              <div>
                <span>Chain</span>
                <b>4663</b>
              </div>
              <div>
                <span>Transport</span>
                <b>stdio · http</b>
              </div>
              <div>
                <span>Quotes</span>
                <b>eth_call</b>
              </div>
              <div>
                <span>Custody</span>
                <b>none</b>
              </div>
              <div>
                <span>Fee</span>
                <b>1.5% fixed</b>
              </div>
            </div>
          </div>

          <div className="cx-plate">
            <SpiralType phrase="AGEN INSTANT MCP" />
            <span className="cx-plate-tag">model context protocol · 2026</span>
          </div>
        </section>

        <main className="cx-body">
          <DocNav sections={SECTIONS} />

          <article className="cx-doc">
            <section className="cx-sec" id="overview">
              <p className="cx-kicker">
                001 <b>Overview</b>
              </p>
              <h2>A thin, honest interface over production.</h2>

              <p>
                There is no second quote engine here, no second launch path and no fee table
                reimplemented: every number an agent reads is computed by the same code that
                computes it for <Link href="/">agen.space</Link>. Where a figure could not be
                obtained from the existing system it comes back as <code>null</code> with a reason,
                rather than estimated.
              </p>

              <p>
                Six tools only read. One prepares a transaction and hands it back unsigned. One
                spends an authorised agent&rsquo;s own treasury, inside caps its owner set. That
                distinction is the whole design, and it is visible in the tool names.
              </p>

              <div className="cx-invert cx-up">
                <div className="cx-art">
                  <AsciiTorus />
                </div>

                <div className="cx-in">
                  <p className="cx-kicker">
                    Why <b>this</b> and not an HTTP client
                  </p>
                  <h2>Decisions already made, so the agent does not invent them.</h2>
                  <p>
                    An agent given a REST endpoint and a fee table will model the curve, guess the
                    supply and confidently report a number nobody computed. Here the shapes are
                    typed, the constants are constants, and the one call that spends money is the
                    one call that says so.
                  </p>

                  <div className="cx-blocks">
                    {CLAIMS.map((claim, index) => (
                      <div className="cx-block" key={claim.title}>
                        <strong>
                          {String(index + 1).padStart(3, "0")} / {claim.title}
                        </strong>
                        <em>{claim.body}</em>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </section>

            <section className="cx-sec cx-up" id="start">
              <p className="cx-kicker">
                002 <b>Quick start</b>
              </p>
              <h2>Running in about a minute.</h2>
              <p>
                Build the package, point your client at <code>dist/index.js</code>, give it a key.
                The read-only tools work without one; quoting and launching answer{" "}
                <code>UNAUTHORIZED</code> until there is one. Keys are created by an agent&rsquo;s
                owner on <Link href="/profile">your profile</Link> and shown once.
              </p>

              <CodePanel tabs={SETUP_EXAMPLES} />
            </section>

            <section className="cx-sec cx-up" id="config">
              <p className="cx-kicker">
                003 <b>Configuration</b>
              </p>
              <h2>Every setting is an environment variable.</h2>
              <p>
                Validated at boot, so a bad value is a startup failure listing every problem rather
                than a surprise on the first tool call. No variable accepts a private key or a
                mnemonic; there is nowhere to put one.
              </p>

              <div className="cx-scroll">
                <table className="cx-table">
                  <thead>
                    <tr>
                      <th>Variable</th>
                      <th>Default</th>
                      <th>Notes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {VARS.map((variable) => (
                      <tr key={variable.name}>
                        <td>{variable.name}</td>
                        <td>{variable.fallback}</td>
                        <td>{variable.note}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            <section className="cx-sec cx-up" id="tools">
              <p className="cx-kicker">
                004 <b>Tool reference</b>
              </p>
              <h2>Eight tools. Six read, one prepares, one spends.</h2>
              <p>
                Reading, preparing and spending carry three different annotations, so a client can
                auto-approve the first and prompt for the other two. Preparing is not marked
                read-only despite holding no key: it writes a metadata document and consumes a
                launch allowance, and auto-approving that is not something anyone agreed to.
              </p>

              <div className="cx-invert cx-in">
                <p className="cx-kicker">
                  <b>tools/list</b>
                </p>

                <ol className="cx-list">
                  {TOOLS.map((tool, index) => (
                    <li className="cx-row" key={tool.name}>
                      <span className="cx-row-n">{String(index + 1).padStart(3, "0")}</span>
                      <span className="cx-row-name">{tool.name}</span>
                      <span
                        className={
                          tool.kind === "spend" ? "cx-row-kind cx-row-kind-spend" : "cx-row-kind"
                        }
                      >
                        {KIND_LABEL[tool.kind]}
                      </span>
                      <p className="cx-row-what">{tool.what}</p>
                    </li>
                  ))}
                </ol>

                <p className="cx-total">
                  <span>8 tools · 6 read-only</span>
                  <span>1 spends</span>
                </p>
              </div>

              <h3>The fixed terms of every Instant launch</h3>
              <p>
                Worth knowing before reading the tools, because several parameters an agent might
                expect are not parameters at all.
              </p>

              <div className="cx-strip">
                <div>
                  <span>Supply</span>
                  <b>1,000,000,000</b>
                </div>
                <div>
                  <span>Decimals</span>
                  <b>18</b>
                </div>
                <div>
                  <span>Opening valuation</span>
                  <b>1.5 ETH</b>
                </div>
                <div>
                  <span>Creator allocation</span>
                  <b>none</b>
                </div>
                <div>
                  <span>Trade fee</span>
                  <b>1.5%</b>
                </div>
                <div>
                  <span>To creator</span>
                  <b>1%</b>
                </div>
                <div>
                  <span>To platform</span>
                  <b>0.5%</b>
                </div>
                <div>
                  <span>Liquidity</span>
                  <b>locked</b>
                </div>
              </div>
            </section>

            <section className="cx-sec cx-up" id="flow">
              <p className="cx-kicker">
                005 <b>How a launch travels</b>
              </p>
              <h2>From a sentence to a live market.</h2>
              <p>
                Six steps, and the two in the middle are the ones worth understanding: the agent
                prepares, and your wallet is what makes it real.
              </p>

              <ol className="cx-steps">
                {STEPS.map((step) => (
                  <li
                    className={step.you === true ? "cx-step cx-step-you" : "cx-step"}
                    key={step.title}
                  >
                    <strong>{step.title}</strong>
                    <p>{step.body}</p>
                    <span>{step.who}</span>
                  </li>
                ))}
              </ol>

              <p>
                An agent launching from its own Agen treasury replaces steps three to five with a
                single <code>launch_instant_from_agent_treasury</code> call, which returns{" "}
                <code>execution_status: &quot;confirmed&quot;</code> and a transaction hash
                directly. It also spends real money, so quote first and show the user what it will
                cost.
              </p>
            </section>

            <section className="cx-sec cx-up" id="session">
              <p className="cx-kicker">
                006 <b>Example session</b>
              </p>
              <h2>Quote, prepare, sign, confirm.</h2>
              <p>One launch, as the calls and responses actually travel.</p>

              <CodePanel tabs={CALL_EXAMPLES} />
            </section>

            <section className="cx-sec cx-up" id="custody">
              <p className="cx-kicker">
                007 <b>Custody</b>
              </p>
              <h2>Two signers, and they are two different tools.</h2>
              <p>
                The difference between them is who holds the key, and that belongs in a tool list
                rather than buried in a parameter&rsquo;s description. There is no third path, and
                no mode switch that turns one into the other.
              </p>

              <div className="cx-keys">
                <div className="cx-key">
                  <code>prepare_instant_launch</code>
                  <strong>Nobody signs.</strong>
                  <p>
                    The server returns calldata and says so three times over. Your wallet signs and
                    broadcasts it, or nothing happens. Nothing is spent, and the fee receiver may be
                    any address you like — you are the one paying for the transaction that names it.
                  </p>
                  <dl>
                    <dt>Keys held</dt>
                    <dd>none</dd>
                    <dt>Spends</dt>
                    <dd>nothing</dd>
                    <dt>Signed by</dt>
                    <dd>caller_wallet</dd>
                  </dl>
                </div>

                <div className="cx-key cx-key-spend">
                  <code>launch_instant_from_agent_treasury</code>
                  <strong>The agent&rsquo;s treasury signs.</strong>
                  <p>
                    An Agen agent&rsquo;s own isolated wallet, under the permissions its owner
                    configured: a per-launch ETH ceiling, launches per day, a creator-buy cap and a
                    reserve. Fees accrue to that agent. It refuses a fee receiver or a signer rather
                    than dropping one.
                  </p>
                  <dl>
                    <dt>Keys held</dt>
                    <dd>none — Agen signs</dd>
                    <dt>Spends</dt>
                    <dd>the agent&rsquo;s treasury</dd>
                    <dt>Bounded by</dt>
                    <dd>owner permissions</dd>
                  </dl>
                </div>
              </div>

              <ul className="cx-guards">
                <Guard n="01">
                  <b>No key can reach it.</b> No environment variable and no tool parameter accepts
                  a private key or mnemonic, and a test asserts that against the schema.
                </Guard>
                <Guard n="02">
                  <b>A launch is never retried.</b> Only idempotent reads retry. A timeout means
                  find out what happened, not try again.
                </Guard>
                <Guard n="03">
                  <b>Every address is validated</b> against a 20-byte hex pattern, with EIP-55 mixed
                  case preserved rather than lower-cased.
                </Guard>
                <Guard n="04">
                  <b>Logs are structured JSON on stderr</b>, with keys and bearer tokens redacted by
                  key and by value. Never stdout — on stdio, stdout is the protocol.
                </Guard>
                <Guard n="05">
                  <b>No admin route is reachable.</b> The server calls eight backend routes and no
                  others.
                </Guard>
                <Guard n="06">
                  <b>HTTP binds to loopback</b> and warns loudly at startup if it is pointed
                  anywhere else. That port has no authentication of its own.
                </Guard>
              </ul>
            </section>

            <Ecosystem metrics={metrics} weeks={weeks} />

            <section className="cx-sec cx-up" id="faq">
              <p className="cx-kicker">
                009 <b>Questions</b>
              </p>
              <h2>Answered before you have to ask.</h2>

              <div className="cx-faq">
                {FAQ.map((entry, index) => (
                  <details className="cx-q" key={entry.q}>
                    <summary>
                      <b>Q.{String(index + 1).padStart(3, "0")}</b>
                      <em>{entry.q}</em>
                      <i aria-hidden="true" />
                    </summary>
                    <p>{entry.a}</p>
                  </details>
                ))}
              </div>
            </section>
          </article>
        </main>

        <section className="cx-close">
          <h2>Give your agent a market to build in.</h2>
          <p>
            Start with a quote. It costs nothing, it is simulated against the live factory, and it
            is the fastest way to see what the rest of it does.
          </p>

          <div className="cx-acts">
            <a className="cx-go" href="#start">
              Quick start
            </a>
            <Link className="cx-go cx-go-line" href="/docs/agents">
              Agent API docs
            </Link>
          </div>
        </section>

        <footer className="cx-foot">
          <span>© Agen · Robinhood Chain 4663</span>
          <nav>
            <Link href="/">Launchpad</Link>
            <Link href="/metrics">Metrics</Link>
            <Link href="/docs/agents">Agent API</Link>
            <a href="https://modelcontextprotocol.io" target="_blank" rel="noreferrer">
              MCP ↗
            </a>
          </nav>
        </footer>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- the pieces */

function Guard({ n, children }: { readonly n: string; readonly children: ReactNode }) {
  return (
    <li>
      <i aria-hidden="true">{n}</i>
      <span>{children}</span>
    </li>
  );
}

/**
 * What an agent sees when it calls `get_instant_metrics`, using the real feed.
 *
 * Presented as the tool's own answer rather than as a platform brag: each figure is
 * captioned with the field it arrives in, so the section doubles as documentation of the
 * response. When the indexer is not answering, `fetchInstantMetrics` returns null and this
 * says so — the same choice `/metrics` makes, for the same reason.
 */
function Ecosystem({
  metrics,
  weeks,
}: {
  readonly metrics: Awaited<ReturnType<typeof fetchInstantMetrics>>;
  readonly weeks: readonly { readonly label: string; readonly value: number }[];
}) {
  const peak = weeks.reduce((high, week) => Math.max(high, week.value), 0);

  return (
    <section className="cx-sec cx-up" id="data">
      <p className="cx-kicker">
        008 <b>Live data</b>
      </p>
      <h2>One call returns the whole ecosystem.</h2>
      <p>
        These are this deployment&rsquo;s figures, read from the Instant indexer as this page was
        rendered — the same numbers <code>get_instant_metrics</code> puts in front of an agent, and
        the same ones <Link href="/metrics">/metrics</Link> shows a person.
      </p>

      {metrics === null ? (
        <p>
          The indexer is not answering right now, so there is nothing to report here. These figures
          come from the feed rather than from this page, and a placeholder would be a guess.
        </p>
      ) : (
        <>
          <div className="cx-figures">
            <Figure label="Markets" value={count(metrics.markets)} field="markets" />
            <Figure label="Creators" value={count(metrics.creators)} field="creators" />
            <Figure label="Trades" value={count(metrics.trades)} field="trades" />
            <Figure
              label="Volume"
              value={eth(Number(metrics.volumeQuote) / 1e18)}
              field="volume.quote"
            />
          </div>

          {peak === 0 ? null : (
            <div className="cx-chart">
              <div className="cx-chart-head">
                <span>Launches per week</span>
                <span>get_launches · sort=newest</span>
              </div>

              <BlockBars data={weeks} />

              <div className="cx-chart-foot">
                <span>12 weeks</span>
                <span>peak {count(peak)}</span>
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}

/** One figure, captioned with the field it arrives in. */
function Figure({
  label,
  value,
  field,
}: {
  readonly label: string;
  readonly value: string;
  readonly field: string;
}) {
  return (
    <div className="cx-figure">
      <span>{label}</span>
      <b>{value}</b>
      <em>{field}</em>
    </div>
  );
}

/**
 * Twelve weeks of launches, bucketed from creation timestamps.
 *
 * Weeks rather than days because a launchpad does not launch something every day, and a
 * daily chart of a young market is mostly zeroes — which reads as a broken chart rather
 * than as a quiet week. The last bucket is the current, partial one, labelled as now.
 */
function weeklyLaunches(
  markets: readonly { readonly createdAt: number }[],
): readonly { readonly label: string; readonly value: number }[] {
  const WEEKS = 12;
  const WEEK = 7 * 24 * 60 * 60;
  const now = Math.floor(Date.now() / 1000);
  const start = now - WEEKS * WEEK;

  const buckets = Array.from({ length: WEEKS }, () => 0);

  for (const market of markets) {
    if (market.createdAt <= start) continue;
    const index = Math.min(WEEKS - 1, Math.floor((market.createdAt - start) / WEEK));
    buckets[index] = (buckets[index] ?? 0) + 1;
  }

  return buckets.map((value, index) => ({
    label: index === WEEKS - 1 ? "NOW" : `W-${String(WEEKS - 1 - index)}`,
    value,
  }));
}
