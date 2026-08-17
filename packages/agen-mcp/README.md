# Agen Instant MCP

A [Model Context Protocol](https://modelcontextprotocol.io) server that gives an AI agent access
to **Agen Instant** — the one-transaction token launcher on Robinhood Chain (4663).

An agent connected to this server can discover markets, read a token's canonical data, get a
launch quoted by the deployed factory itself, and initiate a launch — without knowing anything
about Agen's internals.

> Launch a token called AAA, use `0xabc…` as the fee receiver, and put 0.05 ETH into the first buy.

## What this is, and what it is not

It is a **thin interface over production**. Every number an agent sees here is computed by the
same code that computes it for agen.space:

| Concern | Where it actually happens |
| --- | --- |
| Deployment, pool creation, locking, creator's first buy | `InstantFactory.create`, one transaction |
| Fee split and vault construction | `InstantHook` / `InstantFeeVault` |
| Launch validation, salt mining, metadata | `apps/agen/src/app/lib/instant.ts` |
| Quoting | `eth_call` against the deployed factory |
| Token, pool, discovery, metrics | `apps/instant-indexer` feed |
| Authenticated launching from an agent treasury | `POST /api/v1/me/launches/instant` |

There is no quote engine, launch engine, fee table or supply constant reimplemented in this
package. Where a number could not be obtained from the existing system, it is returned as `null`
with a reason rather than estimated.

```
MCP client (Claude, Cursor, …)
        ↓  stdio or streamable HTTP
Agen Instant MCP  ← this package
        ↓  HTTPS
Agen API (/api/v1)  +  Instant indexer feed
        ↓
InstantFactory on Robinhood Chain
```

Replacing or deleting this package changes nothing about how Instant works.

## Security model

The MCP has **no keys and no custody**. There is no environment variable, no tool parameter and
no code path through which a private key or mnemonic could reach it — `src/env.test.ts` asserts
this against the schema so that adding one requires deleting a test.

There are two signers, and they are **two separate tools** rather than one tool with a mode.
The difference between them is who holds the key, and that should be visible in a tool list
rather than buried in a parameter's description.

**`prepare_instant_launch` — nobody signs.** The server returns calldata and says so three
times over: `execution_status: "prepared"`, `requires_signature: true`,
`requires_broadcast: true`. Your wallet signs and broadcasts it, or nothing happens. Nothing is
spent, and `feeReceiver` may be any address you like, because you are the one paying for the
transaction that names it.

**`launch_instant_from_agent_treasury` — the Agen agent signs.** Posted to
`POST /api/v1/me/launches/instant`, where an Agen agent's own isolated treasury signs under the
permissions its owner configured (per-launch ETH cap, launches per day, creator-buy cap,
reserve). Fees accrue to that agent's wallet. This tool **refuses** a `feeReceiver` or `signer`
rather than dropping it, because a silently-ignored fee receiver would let an agent truthfully
report a destination the vault does not have.

Also true by construction:

- Reading, preparing and spending are three different annotations, so a client can auto-approve
  reads and prompt for the rest. Preparing is **not** marked read-only despite holding no key:
  it stores a metadata document and consumes a launch allowance, and auto-approving that is not
  something a user agreed to. Asserted in `src/server.test.ts`.
- A launch is **never retried**. Only idempotent reads retry.
- Every address is checked against `^0x[0-9a-fA-F]{40}$` before use, with EIP-55 mixed case
  preserved rather than lower-cased.
- Logs are structured JSON on **stderr** only, with API keys, bearer headers and anything
  key-shaped redacted — by key *and* by value, so a credential quoted back inside an upstream
  error message is caught too. `src/logger.test.ts` and `src/no-secret-leak.test.ts` chase a key
  through whole tool calls at `debug` level and assert it appears nowhere.
- No admin route is reachable. The server calls eight backend routes and no others.
- The HTTP transport binds to `127.0.0.1` and warns loudly at startup if it is pointed anywhere
  else. See [Exposing the HTTP transport](#exposing-the-http-transport).

## Installation

From the repository root:

```bash
pnpm install
pnpm --filter @verdant/agen-mcp build
```

Run it:

```bash
# stdio, which is what a desktop client wants
AGEN_INSTANT_FEED_URL=https://instant-feed.agen.space \
AGEN_API_KEY=agn_… \
node packages/agen-mcp/dist/index.js
```

Without building, straight from source:

```bash
pnpm --filter @verdant/agen-mcp dev
```

Tests and types:

```bash
pnpm --filter @verdant/agen-mcp test
pnpm --filter @verdant/agen-mcp typecheck
```

## Configuration

All configuration is environment variables, validated at boot. A bad value exits `78` with
every problem listed, rather than failing on the first tool call.

| Variable | Default | Required for | Notes |
| --- | --- | --- | --- |
| `AGEN_API_URL` | `https://agen.space` | — | Trailing slashes stripped. |
| `AGEN_API_KEY` | — | `get_launch_quote`, both launch tools, launch records | An Agen agent key, `agn_…`. Never logged. |
| `AGEN_INSTANT_FEED_URL` | — | `get_token`, `get_pool`, `get_launches`, `get_instant_metrics` | The Instant indexer base URL. |
| `AGEN_EXPLORER_URL` | — | — | Only builds links. Absent, link fields are `null` rather than guessed. |
| `AGEN_CHAIN_ID` | `4663` | — | Robinhood Chain. |
| `AGEN_MCP_TRANSPORT` | `stdio` | — | `stdio` or `http`. |
| `AGEN_MCP_HOST` | `127.0.0.1` | http | The HTTP transport has no auth of its own; exposing it is an explicit decision. |
| `AGEN_MCP_PORT` | `8848` | http | `POST /mcp`, and `GET /healthz`. |
| `AGEN_MCP_TIMEOUT_MS` | `15000` | — | Per read. |
| `AGEN_MCP_LAUNCH_TIMEOUT_MS` | `120000` | — | Per launch. |
| `AGEN_MCP_MAX_RETRIES` | `2` | — | Safe requests only. |
| `AGEN_MCP_LOG_LEVEL` | `info` | — | `debug` logs request ids, durations and paths — never bodies. |

Without a key the server still starts and warns; the read-only tools work and quoting and
launching answer `UNAUTHORIZED`. Without a feed URL the indexer-backed tools answer
`CONFIG_MISSING` instead of pretending there are no markets.

**Never commit a key.** `AGEN_API_KEY` belongs in your client's local config or your process
manager's secret store.

## Client configuration

### Claude Desktop

`~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
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
}
```

### Claude Code

```bash
claude mcp add agen-instant \
  --env AGEN_API_KEY=agn_… \
  --env AGEN_INSTANT_FEED_URL=https://instant-feed.agen.space \
  -- node /absolute/path/to/verdant/packages/agen-mcp/dist/index.js
```

### Cursor

`.cursor/mcp.json` in a project, or `~/.cursor/mcp.json` globally:

```json
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
}
```

### Any client, over HTTP

```bash
AGEN_MCP_TRANSPORT=http AGEN_MCP_PORT=8848 node packages/agen-mcp/dist/index.js
```

Streamable HTTP on `POST http://127.0.0.1:8848/mcp`, health on `GET /healthz`.

### Exposing the HTTP transport

**`/mcp` has no authentication of its own. Do not expose it publicly.**

Anyone who can reach that port can call every tool, using the `AGEN_API_KEY` this process
already holds — including `launch_instant_from_agent_treasury`, which spends an agent's
treasury and cannot be undone. There is no per-request credential to check and no allow-list:
the port *is* the boundary.

So the default bind is `127.0.0.1`, and pointing `AGEN_MCP_HOST` anywhere else logs a warning
at startup naming the host. If you need it reachable beyond the machine it runs on:

- put an authenticating reverse proxy in front of it (mTLS, an OAuth2 proxy, a VPN or service
  mesh) and let only that proxy reach the port;
- keep the process itself bound to loopback or to a private interface the proxy shares;
- give it an API key whose agent permissions are as small as the deployment needs — a per-launch
  ETH ceiling and a daily cap bound the damage a compromised endpoint can do, and those are
  enforced by Agen rather than by this server;
- or run stdio instead, which has no port at all. For a desktop client that is the right answer.

`/healthz` is unauthenticated by design and reports only liveness and which backends are
configured — never a credential, a backend response, or anything about a launch.

## The fixed terms of every Instant launch

Worth knowing before reading the tools, because several parameters an agent might expect are
not parameters at all:

| | |
| --- | --- |
| Supply | 1,000,000,000 tokens, 18 decimals, a factory constant |
| Creator allocation | none, and no vesting — the entire supply opens as one locked position |
| Opening valuation | 1.5 ETH for every market |
| Fees | 1.5% total: 1% creator, 0.5% platform (15000/10000/5000 ppm of 1000000) |
| Quote asset | ether; the token is always `currency1` |
| Fee receiver | immutable once launched |
| Name / ticker | ≤32 bytes / ≤11 bytes, letters and numbers |

`totalSupply` exists as an input only so that an agent told "launch with a 1B supply" can
confirm it. Any other value is refused rather than ignored.

## Tool reference

Eight tools. Six read, one prepares, one spends.

| Tool | Kind | Backend |
| --- | --- | --- |
| `get_launch_quote` | read-only | Agen API → `eth_call` on the factory |
| `get_launch_status` | read-only | Agen API + indexer |
| `get_token` | read-only | indexer |
| `get_pool` | read-only | indexer |
| `get_launches` | read-only | indexer |
| `get_instant_metrics` | read-only | indexer |
| `prepare_instant_launch` | writes a metadata document; **signs nothing, spends nothing** | Agen API |
| `launch_instant_from_agent_treasury` | **spends the agent's treasury** | Agen API |

A successful call returns `structuredContent` matching the tool's declared output schema.

A failure sets `isError` and returns `{ ok: false, error: { code, message, requestId, … } }` as
JSON **text**, with no `structuredContent` — a validating client checks that field against the
output schema whenever it is present, so an error body sent there would be rejected by the
client's own transport before the agent ever read the code. Bad input is refused earlier still,
by the schema, and arrives as a protocol validation error naming the field:

```
Invalid arguments for tool get_token: must be a 20-byte hex address beginning 0x at token
```

---

### `get_launch_quote`

What a launch would do, before signing anything. The factory is asked directly: the encoded
`create` call is simulated with `eth_call` (with a balance state override so an unfunded creator
can still quote), and `initialBuyTokens` is decoded from the contract's own return value. No
curve is reimplemented here.

**Inputs**

| | |
| --- | --- |
| `name` * | ≤32 bytes |
| `symbol` * | ≤11 bytes; a leading `$` is dropped, the rest upper-cased |
| `initialBuyEth` | decimal ether as a string, e.g. `"0.05"` |
| `creator` | defaults to the authenticated agent's wallet |
| `feeReceiver` | defaults to the creator |
| `boostCapable` | default true |
| `imageUrl` | the real logo, if chosen |
| `totalSupply` | confirmation only |

**Output** — `chainId`, `quotedAt` and `blockNumber` (see below); supply and decimals;
`initialTick`; `startingMarketCapWei`; `feePpm`; `boostEscrowRequired`; `initialBuy` with
`amountWei`, the fee split, `tokensBaseUnits`, `ownershipBps`/`ownershipPercent`,
`openingPriceWeiPerToken`, `effectivePriceWeiPerToken`, `priceImpactBps`; `pool.liquidity`;
`problems[]`; and `simulated` / `simulationError`.

**Freshness.** A quote is true of one state of one chain, and every figure in it can move with
the next trade. `chainId` says which chain, `blockNumber` is the block the `eth_call` was pinned
to — read before the call, not after, so it names the state actually simulated — and `quotedAt`
is unix seconds for callers that cannot turn a height into a time. Nothing expires: there is no
signed offer here, so a stale quote is simply an old one, and re-quoting is free.
`blockNumber` is `null` if the node would not report a height, in which case the simulation was
not pinned.

`simulated: false` means the node refused the simulation — the constants are still exact, the
token estimate is `null`. It never guesses.

`pool.etherLiquidityAtOpenWei` is always `0` and `pooledSupplyPercent` always `100`: the market
opens as a single one-sided position, so an LP/MCAP ratio at open is a ratio to zero. Ether depth
appears only as buys arrive, which is what `get_pool` reports afterwards.

```json
{ "name": "Atlas", "symbol": "ATLAS", "initialBuyEth": "0.05" }
```

Common errors: `UNAUTHORIZED` (no key), `INVALID_INPUT`, `INVALID_ADDRESS`,
`LAUNCH_SIMULATION_FAILED`, `CONFIG_MISSING` (the backend has no RPC configured),
`RATE_LIMITED`.

---

### `prepare_instant_launch`

Builds the launch transaction and hands it back. It cannot sign or send: this process holds no
key, and neither does the route it calls. What it does do is store the metadata document and
mine the salt, which is why it is not marked read-only and not idempotent.

**Inputs**: `name` *, `symbol` *, `imageUrl` *, `signer`, `feeReceiver`, `initialBuyEth`,
`totalSupply`, `description`, `boostCapable`, `linkX`, `website`, `telegram`.

**Output**: `execution_status: "prepared"`, `requires_signature: true`,
`requires_broadcast: true`, `signedBy: "caller_wallet"` — all four are schema constants, so a
client can rely on them without making a call — plus `transaction`, `escrowTransaction`,
`token`, `tokenAddressIsPredicted: true`, `chainId`, `creator`, `feeReceiver`,
`feePayoutAddress`, `supplyTokens`, `initialBuyWei`, `metadataURI`, `preparedAt`, `urls` and
`nextStep`. `txHash`, `pool` and `launchId` are always `null`: nothing has happened yet.

Notes that matter:

- **Send `transaction` from `signer`.** The token address is derived from the sender, so
  calldata prepared for one signer and sent by another lands on a different address, and the
  `token` returned here would be wrong.
- `escrowTransaction` is non-null on a creator's first Boost-capable launch. It must land
  **before** the launch transaction.
- `feeReceiver` may be any address, and is immutable once launched.
- Not retried, at any timeout — it stores a document and mines a salt.

```json
{
  "name": "Atlas",
  "symbol": "ATLAS",
  "imageUrl": "https://example.com/atlas.png",
  "signer": "0x1111111111111111111111111111111111111111",
  "feeReceiver": "0x2222222222222222222222222222222222222222",
  "initialBuyEth": "0.05"
}
```

Common errors: `UNAUTHORIZED`, `INVALID_INPUT`, `INVALID_TOKEN_METADATA` (unreachable logo),
`INVALID_ADDRESS`, `RATE_LIMITED`, `TIMEOUT`.

---

### `launch_instant_from_agent_treasury`

The only tool that spends money. The authenticated Agen agent's own isolated treasury signs,
under the permissions its owner set. Requires an API key; there is no unauthenticated launch
path. Both tools end at the same `InstantFactory.create` — there is no second deployment path.

**Inputs**: `name` *, `symbol` *, `imageUrl` *, `initialBuyEth`, `totalSupply`, `description`,
`boostCapable`, `linkX`, `website`, `telegram`. Also `signer` and `feeReceiver`, which exist
only in order to be refused: see below.

**Output**: `execution_status: "confirmed"`, `requires_signature: false`,
`requires_broadcast: false`, `signedBy: "agen_agent_treasury"`, plus `txHash`, `token`,
`tokenAddressIsPredicted: false`, `pool`, `launchId`, `creator`, `feeReceiver`, `supplyTokens`,
`initialBuyWei`, `urls` and `nextStep`.

Notes that matter:

- `feeReceiver` and `signer` are **refused**, not ignored. The Agen route builds its draft with
  the agent's own wallet and discards anything else, so forwarding one would produce a market
  whose fees go somewhere the agent has just told its user they would not. The refusal names
  `prepare_instant_launch`, which does support both.
- Not retried, at any timeout. A timeout means "find out what happened", not "try again" —
  use `get_launch_status`.

Common errors: `UNAUTHORIZED`, `PERMISSION_DENIED` (an agent's own caps, or a refused
`feeReceiver`/`signer` — the response names the permission and the numbers),
`INSUFFICIENT_BALANCE`, `INVALID_TOKEN_METADATA`, `TRANSACTION_REVERTED`, `RATE_LIMITED`,
`TIMEOUT`.

---

### `get_launch_status`

Takes `launchId`, `token` or `txHash` (at least one).

Returns `status` (`pending` | `submitted` | `confirmed` | `failed` | `not_found`), a `stages`
object, the transaction and market identifiers, `error`, `indexerPending`, and `source`
(`agen-api` | `instant-feed` | `both`).

`deployed`, `poolCreated` and `tradable` become true **together**, because
`InstantFactory.create` does all of it in one transaction. Do not poll for a transition between
them; there isn't one. `indexed` is the only stage that genuinely lags, and `indexerPending`
names that case so a confirmed launch is never reported as missing.

A token launched from your own wallet has no Agen launch record. That is not a failure — the
indexer alone is enough to report it as confirmed.

Common errors: `INVALID_INPUT` (no identifier), `UNAUTHORIZED`, `LAUNCH_NOT_FOUND`.

---

### `get_token`

Takes `token` or `poolId`. Returns address, name, symbol, decimals, total and circulating
supply, creator, fee receiver and vault, `launchType: "instant"`, the pool block, price and
launch price, `marketCapWei`, volume (all-time, organic, Boost, plus a 24h block), accrued fees
split creator/platform, trade count, creation time and transaction, `metadataURI`, Boost state,
and `tradable`.

Organic volume excludes Boost buybacks and is served by the feed rather than subtracted here, so
every consumer subtracts the same way. The 24h block is `null` if the feed could not supply it —
the rest of the answer still stands.

Common errors: `TOKEN_NOT_FOUND`, `INDEXER_PENDING` (launched but not yet indexed — retry),
`CONFIG_MISSING`, `INVALID_ADDRESS`.

---

### `get_pool`

Takes `token` or `poolId`. Returns the v4 pool id, both currencies (`currency0` is always ether),
`fee` (the dynamic-fee flag — the hook prices each swap), tick spacing, liquidity, tick,
`sqrtPriceX96`, price, the locked position's id and liquidity, locker, vault, the fee split in
ppm, volume, trades, `lastSwapAt` and `createdAt`.

Common errors: `POOL_NOT_FOUND`, `INDEXER_PENDING`, `CONFIG_MISSING`.

---

### `get_launches`

Discovery. `sort` is one of `newest` (default), `volume`, `organicVolume`, `trades`,
`liquidity`, `fees`; plus `creator`, `token`, `limit` (≤100) and `offset`. Returns `launches[]`
with `total`, `limit`, `offset`, `sort`, `creator`.

There is deliberately **no `trending`**. Agen's own discovery marks Trending as unavailable
because the product has not defined a ranking, and inventing one here would give an agent this
server's opinion dressed as Agen's. `organicVolume` is the closest honest ranking of real
activity. `trending` is not in the schema's enum, so a client is told at validation time rather
than after a call.

`token` looks up a single market and ignores sorting and paging.

---

### `get_instant_metrics`

No inputs. Market count, distinct creators, trades, volume (total, organic, Boost, token),
accrued fees, a 24h block, Boost aggregates, `lastLaunchAt`, and a `terms` block carrying the
constants above straight from the contracts.

## Example workflows

### 1. Launch a token

> Launch AAA with a 1B supply and use `0xabc…` as the fee receiver.

1. `get_launch_quote` with `{ name: "AAA", symbol: "AAA", initialBuyEth: "0.05", feeReceiver: "0xabc…" }`
   → present the tokens received, ownership percent, price impact, opening market cap and the
   1.5% fee split, along with the block it was quoted at. Stop here if `problems[]` is non-empty.
2. `prepare_instant_launch` with the same values plus the user's `signer` →
   `execution_status: "prepared"` and a `transaction`.
3. If `escrowTransaction` is present, have the user send that one first.
4. The user signs and broadcasts `transaction` from `signer`. **The MCP never does this** — that
   is what `requires_signature` and `requires_broadcast` are telling you.
5. `get_launch_status` with the `txHash` → poll until `stages.confirmed`, then until
   `stages.indexed` while `indexerPending` is true.
6. `get_token` → the final contract, pool, price and market URL.

An agent launching from its own Agen treasury replaces steps 2–4 with a single
`launch_instant_from_agent_treasury` call, with no `signer` or `feeReceiver`: it returns
`execution_status: "confirmed"` with a `txHash` and `launchId` directly. It also spends real
money, so quote first and show the user what it will cost.

### 2. Inspect a launch

> Tell me everything about token `0x…`.

`get_token` for the canonical data, `get_pool` for pool depth and the locked position,
`get_launch_status` if it may be too new to be indexed.

### 3. Discover launches

> Show me the newest Instant launches.

`get_launches` with `{ sort: "newest", limit: 10 }`. For real activity rather than recency, use
`{ sort: "organicVolume" }`, which excludes Boost buybacks. `get_instant_metrics` for the
platform totals around it.

## Errors

Backend failures are normalised to a small set of codes, and the underlying reason is preserved
wherever it is safe to show. An error carries `code`, `message`, and where known `upstreamCode`,
`httpStatus`, `source`, `requestId`, `retryable`, and for a permission refusal the `permission`,
`limit` and `requested` values.

`INVALID_INPUT` · `INVALID_ADDRESS` · `INVALID_TOKEN_METADATA` · `UNSUPPORTED_CHAIN` ·
`UNAUTHORIZED` · `FORBIDDEN` · `RATE_LIMITED` · `INSUFFICIENT_BALANCE` · `PERMISSION_DENIED` ·
`LAUNCH_SIMULATION_FAILED` · `TRANSACTION_REVERTED` · `TOKEN_NOT_FOUND` · `POOL_NOT_FOUND` ·
`LAUNCH_NOT_FOUND` · `INDEXER_PENDING` · `BACKEND_UNAVAILABLE` · `CONFIG_MISSING` · `TIMEOUT` ·
`INTERNAL`

That list is deliberately shorter than a generic launch API's. A `QUOTE_EXPIRED` would imply a
quote with a deadline, but a quote here is an `eth_call` against current state. A
`DEPLOYMENT_FAILED` distinct from `TRANSACTION_REVERTED` would imply a deployment stage that can
fail on its own, and there isn't one. An invalid supply or an unknown sort is refused by the
input schema before a tool runs, so it arrives as a protocol-level validation error naming the
field. Codes that can never occur are branches an agent writes and never exercises.

`RATE_LIMITED` respects Agen's `retry-after`. Agen's limits are 60 reads/minute and 10
launches/minute per agent; the client honours them rather than hammering through them.

## Production notes

- **Logging**: JSON to stderr, never stdout, because on stdio transport stdout is the protocol.
  Keys, bearer tokens and anything `agn_…`-shaped are redacted by key *and* by value.
- **Request IDs**: one per tool call, sent as `x-request-id` to the backend and returned on every
  error, so a user's complaint can be found in Agen's logs.
- **Timeouts and retries**: separate ceilings for reads and launches; retries with backoff for
  idempotent reads only.
- **Health**: `GET /healthz` on the HTTP transport reports process state and what it is
  configured to reach. It deliberately does not call the backends — a health check that fails
  because a third party is slow takes a working server out of rotation.
- **Shutdown**: `SIGINT`/`SIGTERM` close the listener and transport; a second signal exits
  immediately.
- **Exposure**: `/mcp` is unauthenticated and binds to loopback. Anything else needs a proxy in
  front of it — see [Exposing the HTTP transport](#exposing-the-http-transport).

## Tests

```bash
pnpm --filter @verdant/agen-mcp test
```

218 tests. `fetch` is replaced at construction with a recorder that has no transport, and any
undeclared request fails the test loudly — so a test run cannot reach a real backend or launch a
real token. Coverage includes schema and address validation, error normalisation, response
normalisation, backend failures and unreachability, authentication failures, timeouts, the
retry boundary, the tool annotations a client relies on to decide what to auto-approve, both
launch tools' refusals, and a credential chased through whole tool calls at `debug` level to
prove it reaches no log line.

`server.test.ts` drives a real MCP client over an in-memory transport rather than calling tool
functions directly, because a client validates output against the advertised schemas and a
hand-rolled caller does not. That is how the error-result shape above was found: it looked
correct and passed every direct test, and failed at the first real client.

## Layout

```
src/
  index.ts          process, transports, health, shutdown
  server.ts         tool registration and annotations
  env.ts            configuration schema
  errors.ts         backend errors → MCP codes
  logger.ts         structured stderr logging with redaction
  schemas.ts        every tool's input and output schema
  normalize.ts      feed rows → tool output
  clients/          http, agen api, instant feed
  tools/            one file per tool, plus shared context
```
