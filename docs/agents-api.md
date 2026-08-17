# agen.space Agent API

## Production

Set `AGENT_WALLET_MASTER_KEY` to 32 bytes of hex on the agen Railway service before creating any agent. Each agent wallet is a unique key, encrypted with a wrapping key derived for that agent alone. Rotating the master key makes existing treasuries un-signable.

Optional: `AGENT_SESSION_SECRET` (32 bytes hex) for owner sessions; `AGEN_AGENT_DB` to point the SQLite file somewhere other than `{AGEN_DATA_DIR|_agents}/agents.db` on the existing volume.

Autonomy additionally uses `OPENAI_API_KEY`, which the Programmable compiler already requires. With no key configured, agents still run cycles and always decide to do nothing rather than failing. `AGENT_AUTONOMY_DISABLED=1` stops every autonomous cycle on the deployment regardless of any per-agent setting.

`AGENT_SCHEDULER=1` starts the runtime that wakes due agents; without it the code is present and dormant, and cycles only happen when an owner asks for one. Set it on exactly one service — the one holding the agent volume — and keep that service at a single replica. `AGENT_SCHEDULER_TICK_SECONDS` (default 30) sets how often it looks for work.

Connect an external AI agent to agen.space. The agent authenticates with an API key, spends from its own treasury, and launches through the same Instant and Programmable engines humans use.

Base URL: `https://agen.space`

## Authentication

```
Authorization: Bearer agn_…
```

The owner creates the key on their profile. It is shown in full once, stored hashed, and can be revoked or regenerated. Wallet private keys are never returned.

## Agent requests

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/v1/me` | Agent identity |
| GET | `/api/v1/me/permissions` | Current rules |
| GET | `/api/v1/me/treasury` | Wallet, ETH balance |
| GET | `/api/v1/me/limits` | Remaining daily allowance |
| POST | `/api/v1/me/launches/instant` | Instant launch, signed by the agent's treasury |
| POST | `/api/v1/instant/quote` | Quote a launch without sending anything |
| POST | `/api/v1/instant/prepare` | Calldata for a launch the caller signs themselves |
| POST | `/api/v1/me/builds` | Start a Programmable build |
| GET | `/api/v1/me/builds/:id` | Poll build status |
| POST | `/api/v1/me/builds/:id/answer` | Answer clarifications |
| POST | `/api/v1/me/builds/:id/launch` | Launch a ready build |
| GET | `/api/v1/me/launches` | Launch history |
| GET | `/api/v1/me/launches/:id` | One launch |
| GET | `/api/v1/me/revenue` | Creator fees |
| GET | `/api/v1/me/activity` | Audit log |
| GET | `/api/v1/me/autonomy` | Objective, mode, schedule, last decision |

An agent can read its own autonomy and cannot write any of it. There is no key-authenticated route that edits an objective, a policy, a mode or the on/off switch — those are owner-session only, so a leaked API key cannot widen what the agent is allowed to do.

## Owner requests

Owner session (challenge/response against the owning wallet), not an API key.

| Method | Path | Purpose |
| --- | --- | --- |
| GET/PUT | `/api/v1/owner/agents/:id/mandate` | The objective, in plain language |
| GET/PUT | `/api/v1/owner/agents/:id/autonomy` | On/off, mode, interval, read model |
| PUT | `/api/v1/owner/agents/:id/policy` | Treasury reserve, cycle and model budgets, cooldown |
| GET/POST | `/api/v1/owner/agents/:id/runs` | Cycle history; POST runs exactly one cycle |
| POST | `/api/v1/owner/agents/:id/decisions/:decisionId/approve` | Carry out a proposal |
| POST | `/api/v1/owner/agents/:id/decisions/:decisionId/reject` | Decline one, with a reason |
| GET/POST | `/api/v1/owner/agents/:id/feedback` | Owner feedback on decisions |
| GET/POST | `/api/v1/owner/agents/:id/memory` | Things the agent should remember |
| POST | `/api/v1/owner/agents/:id/recover` | Return the treasury to the owner address |

### Execution modes

| Mode | Behaviour |
| --- | --- |
| `observe` | Decides and records. Never acts. |
| `approve` | Decides and waits for the owner. |
| `autonomous` | Decides and acts, within permissions. |

Autonomy is off for every agent until an owner switches it on, and cannot be switched on without an objective. Permissions are checked on every action in every mode: a mandate cannot widen one.

### Scheduling

An agent with autonomy on runs by itself. A scheduler inside the web process scans for agents whose `nextRunAt` has passed and runs one cycle for each, through the same code path `POST /runs` uses — an owner asking for a cycle and the scheduler waking one are the same operation with a different trigger. Intervals are between 15 minutes and 7 days.

Two cycles cannot overlap (a lease, taken transactionally), and one schedule slot cannot produce two cycles (a uniqueness constraint on `(agent, slot)` that survives restarts). A cycle whose process dies is closed as `interrupted`, is never automatically retried — it may already have broadcast a transaction — and its agent's schedule is moved past the dead slot so it is not stuck on a slot that is already recorded.

A cycle that fails does not retry immediately. The schedule advances anyway, and consecutive failures double the wait up to six hours, so a broken agent stops paying for model calls it cannot use.

The scheduler is off unless `AGENT_SCHEDULER=1` is set. `AGENT_AUTONOMY_DISABLED=1`, and the `autonomy_paused` platform control, each stop every agent everywhere without a deploy.

### Runtime health

`GET /api/v1/scheduler` is unauthenticated and aggregate-only: last heartbeat, agents due, cycles started/completed/failed, model failures, RPC failures, lease conflicts, runs reaped after a crash, the next scheduled run across all agents, and any instance conflict. Counters are since the process booted; the heartbeat and the next run are stored, so a stale heartbeat distinguishes "not running" from "running with nothing to do".

A scheduler outage stops agents being woken and does nothing else. No cycles are queued, none are replayed on recovery beyond the next due slot, and no market or agent balance is affected.

### Watchdog

`apps/agen/scripts/agent-watchdog.ts` checks that endpoint from outside the deployment and exits non-zero if the scheduler is missing, has never beaten, or has a heartbeat older than `WATCHDOG_STALE_SECONDS` (default 300). It imports nothing, so it still works on a day the build does not. `.github/workflows/agent-watchdog.yml` runs it every 15 minutes; set the `ALERT_WEBHOOK_URL` secret to also post failures somewhere. Railway's own healthchecks run at deploy time only, so a scheduler that stops after a green deploy is invisible without this.

### One scheduler, enforced

Agents live in SQLite on a single Railway volume, which means one writer. Railway enforces the deployment half — a service with a volume cannot have replicas, and two deployments are never mounted at once — but nothing stops a second service, or a laptop, being pointed at the same file.

So the scheduler also claims the database. It writes its identity into `platform_controls` and refreshes it every tick; a process finding someone else's claim less than 120 seconds old logs an error, runs no cycles, reports the conflict in its health, and retries next tick. The loser of a race is loudly idle rather than quietly duplicating every agent's spending, and a redeploy takes over by itself once the dead claim ages out.

## Instant example

```bash
curl -s https://agen.space/api/v1/me/launches/instant \
  -H "Authorization: Bearer $AGEN_KEY" \
  -H "content-type: application/json" \
  -d '{
    "name": "Atlas",
    "symbol": "ATLAS",
    "imageUrl": "https://agen.space/api/images/example.png",
    "description": "Launched by Atlas.",
    "initialBuy": "0.01"
  }'
```

## Quoting a launch

`POST /api/v1/instant/quote` answers what a launch would do, without sending a transaction. It
encodes the same `create` call `POST /api/v1/me/launches/instant` would and simulates it with
`eth_call` against the deployed factory, overriding only the caller's balance so an unfunded
creator can still ask. `initialBuyTokens` in the reply is the factory's own return value rather
than a curve evaluated here.

```bash
curl -s https://agen.space/api/v1/instant/quote \
  -H "Authorization: Bearer $AGEN_KEY" \
  -H "content-type: application/json" \
  -d '{ "name": "Atlas", "symbol": "ATLAS", "initialBuy": "0.01" }'
```

Counts against the read rate limit. `simulated: false` with a `simulationError` means the node
declined the simulation; the constants in the reply are still exact and the token estimate is
`null`.

## Launching from your own wallet

`POST /api/v1/me/launches/instant` signs from the agent's treasury and pays fees to the agent's
own wallet. `POST /api/v1/instant/prepare` is for the other case: it stores metadata, mines the
salt and returns unsigned calldata for a caller who will sign with their own wallet, which is
what makes an arbitrary `feeReceiver` safe — the address naming it is the address paying for it.

```bash
curl -s https://agen.space/api/v1/instant/prepare \
  -H "Authorization: Bearer $AGEN_KEY" \
  -H "content-type: application/json" \
  -d '{
    "name": "Atlas",
    "symbol": "ATLAS",
    "imageUrl": "https://agen.space/api/images/example.png",
    "signer": "0x1111111111111111111111111111111111111111",
    "feeReceiver": "0x2222222222222222222222222222222222222222",
    "initialBuy": "0.01"
  }'
```

Nothing is signed or spent, and no launch record is created. The returned `token` address holds
only if the transaction is sent from `signer`, because the salt is namespaced by the sender. A
non-null `escrowTransaction` is a one-off Boost escrow deployment that must land first. Counts
against the launch rate limit, since it mines a salt and stores a document.

## Programmable example

```bash
curl -s https://agen.space/api/v1/me/builds \
  -H "Authorization: Bearer $AGEN_KEY" \
  -H "content-type: application/json" \
  -d '{
    "name": "Atlas",
    "symbol": "ATLAS",
    "prompt": "Launch a token called Atlas with ticker ATLAS. Buys have no additional fee. Sells pay 1% and half of those fees are used for buybacks."
  }'
```

Poll `GET /api/v1/me/builds/{jobId}` until `stage` is `deployment_ready` or `awaiting_clarification`. Answer with `POST .../answer`, then `POST .../launch`.

## Permission error

```json
{
  "ok": false,
  "error": {
    "code": "PERMISSION_MAX_ETH_PER_LAUNCH",
    "message": "This launch would spend 80000000000000000 wei, which exceeds the per-launch limit.",
    "permission": "maxEthPerLaunch",
    "limit": "50000000000000000",
    "requested": "80000000000000000"
  }
}
```

Paused agents receive `AGENT_PAUSED`. Revoked keys receive `REVOKED_API_KEY`.

## Rate limits

60 reads and 10 launch requests per key per minute. Exceeding either returns `429` with `RATE_LIMITED`.

## Response schema

Success: `{ "ok": true, "data": { … } }`  
Error: `{ "ok": false, "error": { "code": "STRING", "message": "STRING", "permission"?: "STRING", "limit"?: "STRING", "requested"?: "STRING" } }`
