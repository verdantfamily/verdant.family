import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";

import { Bloom } from "../bloom";
import { SiteFooter } from "../footer";
import { count, eth } from "../lib/format";
import { fetchInstantMetrics } from "../lib/instant-feed";
import { marketSource } from "../lib/markets";
import { CodePanel, type CodeTab } from "./code";
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
const CLAIMS: readonly {
  readonly title: string;
  readonly body: string;
  readonly icon: ReactNode;
}[] = [
  {
    title: "Quoted against the chain",
    body: "The real create call is encoded and simulated with eth_call against the deployed factory, so the tokens received come out of the contract's own return value.",
    icon: <Wave />,
  },
  {
    title: "Prepared, not custodied",
    body: "Launch calldata comes back unsigned and marked prepared. Your wallet is the only thing that can turn it into a market.",
    icon: <Lock />,
  },
  {
    title: "The whole market, readable",
    body: "Tokens, pools, launch status, discovery by volume or recency, and ecosystem totals — straight from the Instant indexer.",
    icon: <Layers />,
  },
  {
    title: "One engine underneath",
    body: "No second quote path and no fee table copied for agents. Every figure an agent reads is computed by the code that computes it here.",
    icon: <Cog />,
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
  {
    name: "AGEN_MCP_TIMEOUT_MS",
    fallback: "15000",
    note: "Per read. Launches get their own, 120000.",
  },
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
 * ## Why this looks like the rest of the site rather than like a docs site
 *
 * Because it is part of the site. The band, the white sheet, the sections and their
 * hairlines, the cards, the pills and the footer are the launchpad's own — the same
 * components Explore, Create and Metrics are built from — and the page-specific pieces
 * below are made of the same tokens. A second design language would have said that this is
 * a different product, which is the opposite of what it is: it is the engine the rest of
 * the site runs on, addressed by a machine instead of by a form.
 *
 * The figures in "Live data" are real — the same ones `/metrics` renders, read from the
 * Instant indexer at request time, with the chart bucketed from actual creation timestamps.
 * When the feed is not answering the section says so rather than falling back to a shape. A
 * chart of invented activity would be a strange thing to put on the page offering
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
    <div className="ax-page mx-page">
      <Bloom active="docs" photo="mcpbg" centred>
        <h1>MCP</h1>
        <p>
          Connect an AI agent to Agen Instant. Quote a launch against the live factory, prepare the
          transaction your wallet signs, and read every token, pool and market — over the Model
          Context Protocol.
        </p>

        <div className="ax-acts">
          <a className="ax-btn ax-btn-dark" href="#start">
            Quick start
          </a>
          <a className="ax-btn ax-btn-light" href="#tools">
            The eight tools
          </a>
        </div>
      </Bloom>

      <main className="ax-wrap">
        <section className="ax-section ax-reveal" id="overview">
          <div className="ax-section-head">
            <h2>Overview</h2>
            <span className="ax-tag">8 tools · 6 read-only</span>
          </div>

          <p className="mx-lede" style={{ marginTop: "22px" }}>
            A thin, typed interface over the engine that is already running. There is no second
            quote path here, no second launch path and no fee table reimplemented for agents.
          </p>

          <p className="mx-say">
            Every number an agent reads is computed by the same code that computes it for{" "}
            <Link href="/">agen.space</Link>. Where a figure could not be obtained from the existing
            system it comes back as <code>null</code> with a reason, rather than estimated. Six
            tools only read. One prepares a transaction and hands it back unsigned. One spends an
            authorised agent&rsquo;s own treasury, inside caps its owner set — and that distinction
            is visible in the tool names.
          </p>

          <div className="mx-cards">
            {CLAIMS.map((claim) => (
              <div className="mx-card" key={claim.title}>
                {claim.icon}
                <strong>{claim.title}</strong>
                <span>{claim.body}</span>
              </div>
            ))}
          </div>
        </section>

        <section className="ax-section ax-reveal" id="start">
          <div className="ax-section-head">
            <h2>Quick start</h2>
            <span className="ax-tag">about a minute</span>
          </div>

          <p className="mx-say">
            Build the package, point your client at <code>dist/index.js</code>, give it a key. The
            read-only tools work without one; quoting and launching answer <code>UNAUTHORIZED</code>{" "}
            until there is one. Keys are created by an agent&rsquo;s owner on{" "}
            <Link href="/profile">your profile</Link> and shown once.
          </p>

          <CodePanel tabs={SETUP_EXAMPLES} />
        </section>

        <section className="ax-section ax-reveal" id="config">
          <div className="ax-section-head">
            <h2>Configuration</h2>
            <span className="ax-tag">environment only</span>
          </div>

          <p className="mx-say">
            Validated at boot, so a bad value is a startup failure listing every problem rather than
            a surprise on the first tool call. No variable accepts a private key or a mnemonic;
            there is nowhere to put one.
          </p>

          <div className="mx-scroll">
            <table className="mx-table">
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
                    <td>
                      <code>{variable.name}</code>
                    </td>
                    <td>
                      <code>{variable.fallback}</code>
                    </td>
                    <td>{variable.note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="ax-section ax-reveal" id="tools">
          <div className="ax-section-head">
            <h2>Tool reference</h2>
            <span className="ax-tag">tools/list</span>
          </div>

          <p className="mx-say">
            Reading, preparing and spending carry three different annotations, so a client can
            auto-approve the first and prompt for the other two. Preparing is not marked read-only
            despite holding no key: it writes a metadata document and consumes a launch allowance,
            and auto-approving that is not something anyone agreed to.
          </p>

          <div className="mx-tools">
            {TOOLS.map((tool) => (
              <div className="mx-tool" key={tool.name}>
                <code>{tool.name}</code>
                <span className={tool.kind === "spend" ? "mx-kind mx-kind-spend" : "mx-kind"}>
                  <i aria-hidden="true" />
                  {KIND_LABEL[tool.kind]}
                </span>
                <p>{tool.what}</p>
              </div>
            ))}
          </div>

          <h3 className="mx-h3">The fixed terms of every Instant launch</h3>
          <p className="mx-say" style={{ marginTop: "8px" }}>
            Worth knowing before reading the tools, because several parameters an agent might expect
            are not parameters at all.
          </p>

          <div className="ax-figs">
            <span className="ax-fig">Supply 1,000,000,000</span>
            <span className="ax-fig">18 decimals</span>
            <span className="ax-fig">Opens at 1.5 ETH</span>
            <span className="ax-fig">No creator allocation</span>
            <span className="ax-fig">1.5% trade fee</span>
            <span className="ax-fig">1% to the creator</span>
            <span className="ax-fig">0.5% to the platform</span>
            <span className="ax-fig">Liquidity locked</span>
          </div>
        </section>

        <section className="ax-section ax-reveal" id="flow">
          <div className="ax-section-head">
            <h2>How a launch travels</h2>
            <span className="ax-tag">one signature</span>
          </div>

          <p className="mx-say">
            Six steps, and the two in the middle are the ones worth understanding: the agent
            prepares, and your wallet is what makes it real.
          </p>

          <ol className="mx-flow">
            {STEPS.map((step) => (
              <li className={step.you === true ? "mx-step mx-step-you" : "mx-step"} key={step.title}>
                <strong>{step.title}</strong>
                <p>{step.body}</p>
                <span className="mx-who">{step.who}</span>
              </li>
            ))}
          </ol>

          <p className="mx-say">
            An agent launching from its own Agen treasury replaces steps three to five with a single{" "}
            <code>launch_instant_from_agent_treasury</code> call, which returns{" "}
            <code>execution_status: &quot;confirmed&quot;</code> and a transaction hash directly. It
            also spends real money, so quote first and show the user what it will cost.
          </p>
        </section>

        <section className="ax-section ax-reveal" id="session">
          <div className="ax-section-head">
            <h2>Example session</h2>
            <span className="ax-tag">quote → prepare → sign → confirm</span>
          </div>

          <p className="mx-say">One launch, as the calls and responses actually travel.</p>

          <CodePanel tabs={CALL_EXAMPLES} />
        </section>

        <section className="ax-section ax-reveal" id="custody">
          <div className="ax-section-head">
            <h2>Custody</h2>
            <span className="ax-tag">0 private keys</span>
          </div>

          <p className="mx-say">
            Two signers, and they are two different tools. The difference between them is who holds
            the key, and that belongs in a tool list rather than buried in a parameter&rsquo;s
            description. There is no third path, and no mode switch that turns one into the other.
          </p>

          <div className="mx-keys">
            <div className="mx-key">
              <code>prepare_instant_launch</code>
              <strong>Nobody signs.</strong>
              <p>
                The server returns calldata and says so three times over. Your wallet signs and
                broadcasts it, or nothing happens. Nothing is spent, and the fee receiver may be any
                address you like — you are the one paying for the transaction that names it.
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

            <div className="mx-key mx-key-spend">
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

          <ul className="mx-guards">
            <Guard>
              <b>No key can reach it.</b> No environment variable and no tool parameter accepts a
              private key or mnemonic, and a test asserts that against the schema.
            </Guard>
            <Guard>
              <b>A launch is never retried.</b> Only idempotent reads retry. A timeout means find
              out what happened, not try again.
            </Guard>
            <Guard>
              <b>Every address is validated</b> against a 20-byte hex pattern, with EIP-55 mixed
              case preserved rather than lower-cased.
            </Guard>
            <Guard>
              <b>Logs are structured JSON on stderr</b>, with keys and bearer tokens redacted by key
              and by value. Never stdout — on stdio, stdout is the protocol.
            </Guard>
            <Guard>
              <b>No admin route is reachable.</b> The server calls eight backend routes and no
              others.
            </Guard>
            <Guard>
              <b>HTTP binds to loopback</b> and warns loudly at startup if it is pointed anywhere
              else. That port has no authentication of its own.
            </Guard>
          </ul>
        </section>

        <Ecosystem metrics={metrics} weeks={weeks} />

        <section className="ax-section ax-reveal" id="faq">
          <div className="ax-section-head">
            <h2>Questions</h2>
          </div>

          <div className="mx-faq">
            {FAQ.map((entry) => (
              <details className="mx-q" key={entry.q}>
                <summary>
                  {entry.q}
                  <i aria-hidden="true" />
                </summary>
                <p>{entry.a}</p>
              </details>
            ))}
          </div>
        </section>

        <section className="mx-close ax-reveal">
          <div>
            <h2>Give your agent a market to build in.</h2>
            <p>
              Start with a quote. It costs nothing, it is simulated against the live factory, and it
              is the fastest way to see what the rest of it does.
            </p>
          </div>

          <div className="ax-acts">
            <a className="ax-btn ax-btn-dark" href="#start">
              Quick start
            </a>
            <Link className="ax-btn ax-btn-light" href="/docs/agents">
              Agent API
            </Link>
          </div>
        </section>

        <SiteFooter />
      </main>
    </div>
  );
}

/* --------------------------------------------------------------- the pieces */

function Guard({ children }: { readonly children: ReactNode }) {
  return (
    <li>
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
        <path d="M3 8.5 6.4 12 13 4.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
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
    <section className="ax-section ax-reveal" id="data">
      <div className="ax-section-head">
        <h2>Live data</h2>
        <span className="ax-tag">get_instant_metrics</span>
      </div>

      <p className="mx-say">
        This deployment&rsquo;s figures, read from the Instant indexer as this page was rendered —
        the same numbers an agent gets back, and the same ones <Link href="/metrics">/metrics</Link>{" "}
        shows a person.
      </p>

      {metrics === null ? (
        <p className="ax-empty" style={{ marginTop: "22px" }}>
          The indexer is not answering right now, so there is nothing to report here. These figures
          come from the feed rather than from this page, and a placeholder would be a guess.
        </p>
      ) : (
        <>
          <div className="ax-mx" style={{ marginTop: "22px" }}>
            <Stat label="Markets" value={count(metrics.markets)} field="markets" lead />
            <Stat label="Creators" value={count(metrics.creators)} field="creators" />
            <Stat label="Trades" value={count(metrics.trades)} field="trades" />
            <Stat
              label="Volume"
              value={eth(Number(metrics.volumeQuote) / 1e18)}
              field="volume.quote"
            />
          </div>

          {peak === 0 ? null : (
            <>
              <h3 className="mx-h3">Launches per week</h3>

              <div className="mx-chart">
                <div className="mx-bars">
                  {weeks.map((week, index) => (
                    <div
                      className={index >= weeks.length - 4 ? "mx-bar mx-bar-near" : "mx-bar"}
                      key={week.label}
                      title={`${week.label}: ${count(week.value)}`}
                    >
                      <i
                        style={
                          {
                            "--h": `${String(Math.round((week.value / peak) * 100))}%`,
                            "--i": String(index),
                          } as React.CSSProperties
                        }
                      />
                    </div>
                  ))}
                </div>

                <div className="mx-axis">
                  <span>12 weeks ago</span>
                  <span>peak {count(peak)} in a week</span>
                  <span>this week</span>
                </div>
              </div>
            </>
          )}
        </>
      )}
    </section>
  );
}

/** One figure, captioned with the field of the response it arrives in. */
function Stat({
  label,
  value,
  field,
  lead = false,
}: {
  readonly label: string;
  readonly value: string;
  readonly field: string;
  readonly lead?: boolean;
}) {
  return (
    <div className={lead ? "ax-mx-card ax-mx-lead" : "ax-mx-card"}>
      <p className="ax-mx-label">{label}</p>
      <p className="ax-mx-value ax-num">{value}</p>
      <p className="ax-mx-note">{field}</p>
    </div>
  );
}

/**
 * Twelve weeks of launches, bucketed from creation timestamps.
 *
 * Weeks rather than days because a launchpad does not launch something every day, and a
 * daily chart of a young market is mostly zeroes — which reads as a broken chart rather
 * than as a quiet week. The last bucket is the current, partial one.
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
    label: index === WEEKS - 1 ? "this week" : `${String(WEEKS - 1 - index)} weeks ago`,
    value,
  }));
}

/* ------------------------------------------------------------------- icons */

function Wave() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
      <path d="M2 12c2.5 0 2.5-6 5-6s2.5 8 5 8 2.5-6 6-6" strokeLinecap="round" />
    </svg>
  );
}

function Lock() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
      <rect x="3.75" y="8.5" width="12.5" height="8.25" rx="2.25" />
      <path d="M6.75 8.5V6.25a3.25 3.25 0 0 1 6.5 0V8.5" strokeLinecap="round" />
    </svg>
  );
}

function Layers() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
      <path d="M10 2.75 17 6.5l-7 3.75L3 6.5z" strokeLinejoin="round" />
      <path d="m3 10.5 7 3.75 7-3.75M3 14.25 10 18l7-3.75" strokeLinecap="round" />
    </svg>
  );
}

function Cog() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
      <circle cx="10" cy="10" r="2.75" />
      <path
        d="M10 2v2.2M10 15.8V18M2 10h2.2M15.8 10H18M4.4 4.4 6 6M14 14l1.6 1.6M15.6 4.4 14 6M6 14l-1.6 1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}
