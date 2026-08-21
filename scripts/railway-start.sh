#!/usr/bin/env bash
#
# Which process this container is.
#
# Two services deploy from this repository and Railway applies the root `railway.toml` to
# both of them: there is no per-service section, and a service only reads a different file
# if somebody sets its config path in the dashboard by hand. The first deploy of the Agen
# app therefore ran the indexer's start command, failed a health check on a path it does
# not serve, and rolled back.
#
# The branch lived in the TOML for one deploy and was worse there — an `if` inside a
# quoted TOML string, escaped twice, that fails by exiting silently with no log line to
# say why. Here it is just a script.

set -euo pipefail

service="${RAILWAY_SERVICE_NAME:-}"
echo "[start] service=${service:-<unset>}"

if [ "$service" = "agen" ]; then
  exec pnpm --filter @verdant/agen start
fi

# How long to wait for a starting indexer to answer `/health` before pruning anyway.
#
# Generous, because the thing being waited for is a lock rather than a backfill: Ponder takes
# its schema lock and starts serving `/health` within seconds of connecting to Postgres, long
# before it has indexed anything. If it has not answered in two minutes it is not going to,
# and pruning then is the old behaviour rather than a new risk.
readonly HEALTH_TIMEOUT_SECONDS=120

# Polled with Node rather than curl, which is not guaranteed to be in the image. Node is: it
# is what Ponder runs on.
wait_for_health() {
  node -e '
    const url = `http://127.0.0.1:${process.env.PORT ?? "8080"}/health`;
    const deadline = Date.now() + Number(process.argv[1]) * 1000;

    const poll = async () => {
      while (Date.now() < deadline) {
        try {
          const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
          if (response.ok) process.exit(0);
        } catch {
          // Not listening yet, which is the expected answer for the first few seconds.
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      process.exit(1);
    };

    void poll();
  ' "$HEALTH_TIMEOUT_SECONDS"
}

# Drop the schemas of deployments that are no longer running — after this one is serving.
#
# ## Why the order matters more than the pruning does
#
# `ponder db prune` drops every Ponder app in the database whose schema lock is not currently
# held. Run *before* `ponder start`, as this did, that includes the schema this container is
# about to recover from — because Ponder unlocks its schema on the way out of a fatal error,
# so a crashed app looks exactly like an abandoned one two seconds later.
#
# That turned every crash into a full replay. Ponder can resume: it writes checkpoints during
# the historical backfill and, given the same schema name and build id, logs "Detected crash
# recovery" and carries on from the last one. Dropping the schema first threw that away, so
# `instant-indexer` re-read 5.86 million blocks on every restart, was rate-limited to death by
# the public RPC before it could finish, and restarted — a loop it never got out of. The visible
# symptom was on the metrics page, which sums whatever rows exist and therefore reported a total
# volume that swept from zero up to the real figure every few minutes.
#
# Run *after* the app is serving, the same command is safe by the same rule it was unsafe by:
# this app now holds its lock and is heart-beating, so prune skips it and drops only the
# deployments that really are gone.
#
# ## Still not load-bearing
#
# In the background, its failures swallowed, and nothing waits on it. That is the lesson from
# the outage in `railway.toml`: a cleanup meant to prevent a full disk must never be able to
# stop the service from answering. If the health check never comes, the prune simply does not
# happen and the next deploy tries again.
prune_when_serving() {
  local filter="$1"

  if ! wait_for_health; then
    echo "[start] no health response in ${HEALTH_TIMEOUT_SECONDS}s, skipping prune"
    return 0
  fi

  echo "[start] serving; pruning schemas of deployments that are gone"
  pnpm --filter "$filter" exec ponder db prune || echo "prune failed, ignoring"
}

# Run one Ponder service, and let a restart resume instead of starting over.
#
# Shared by both indexers, which the previous version of this file deliberately did not do.
# That was right while each was two lines whose only common element was the word `ponder`; it
# is wrong now that the ordering above is the thing keeping them alive, because two copies of
# it is two chances to fix the loop in one service and leave the other in it. What the comment
# was protecting is unaffected: `ponder db prune` reaches only the database its own
# `DATABASE_URL` names, and each service has its own, so this still cannot touch the other's
# schemas.
#
# `wait` rather than `exec`, because the prune has to be able to run alongside a process that
# is already serving — which means something has to still be here to wait for it. The trap
# forwards a platform stop, and the exit code is Ponder's own, so `restartPolicyType =
# "ON_FAILURE"` still sees a crash as a crash.
start_ponder() {
  local filter="$1"

  pnpm --filter "$filter" exec ponder start \
    --schema "$RAILWAY_DEPLOYMENT_ID" \
    --hostname 0.0.0.0 &
  local ponder=$!

  prune_when_serving "$filter" &

  trap 'kill -TERM "$ponder" 2>/dev/null || true' TERM INT

  # Not `set -e`'s business: a non-zero exit here is information to pass on, not a reason to
  # abandon the rest of this function.
  local status=0
  wait "$ponder" || status=$?

  return "$status"
}

# Instant's indexer, which is a third service with a third database.
#
# Its own start block, from the Instant deployment record. That was once the payoff — the
# Programmable indexer re-reads ten million blocks of PoolManager history because Verdant's
# markets are that old, and Instant's factory was recent. It is not recent any more: this
# chain mines sub-second blocks, so the 36,378,954 the factory landed in is now 5.86 million
# blocks behind the tip, and a replay of it is a five-minute job against an RPC that will not
# allow one. Which is why the recovery above matters here first.
if [ "$service" = "instant-indexer" ]; then
  start_ponder @verdant/instant-indexer
  exit $?
fi

start_ponder @verdant/indexer
exit $?
