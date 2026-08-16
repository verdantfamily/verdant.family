# agen.space Agent API

## Production

Set `AGENT_WALLET_MASTER_KEY` to 32 bytes of hex on the agen Railway service before creating any agent. Each agent wallet is a unique key, encrypted with a wrapping key derived for that agent alone. Rotating the master key makes existing treasuries un-signable.

Optional: `AGENT_SESSION_SECRET` (32 bytes hex) for owner sessions; `AGEN_AGENT_DB` to point the SQLite file somewhere other than `{AGEN_DATA_DIR|_agents}/agents.db` on the existing volume.

Autonomy (Phase 2) additionally uses `OPENAI_API_KEY`, which the Programmable compiler already requires. With no key configured, agents still run cycles and always decide to do nothing rather than failing. `AGENT_AUTONOMY_DISABLED=1` stops every autonomous cycle on the deployment regardless of any per-agent setting.

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
| POST | `/api/v1/me/launches/instant` | Instant launch |
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

`POST /runs` executes one cycle and returns when it finishes. Nothing in the deployment starts a cycle on its own — there is no timer, cron or worker in Phase 2. `nextRunAt` is recorded for a future driver to read.

Two cycles cannot overlap (a lease, taken transactionally), and one schedule slot cannot produce two cycles (a uniqueness constraint on `(agent, slot)` that survives restarts). A cycle whose process dies is closed as `interrupted` and is never automatically retried.

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
