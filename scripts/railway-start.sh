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

# Instant's indexer, which is a third service with a third database.
#
# The same two lines as the Programmable indexer below and deliberately not a shared
# function: the only thing they have in common is Ponder, and the reason this service
# exists at all is that a deploy of one must not touch the other. `ponder db prune` reaches
# only the database its own `DATABASE_URL` names, so this cannot drop a Programmable
# schema even by mistake.
#
# Its own start block, from the Instant deployment record, which is the payoff. The
# Programmable indexer re-reads ten million blocks of PoolManager history on every deploy
# because Verdant's markets are that old; Instant's factory is recent, so this one has
# almost nothing to catch up on.
if [ "$service" = "instant-indexer" ]; then
  pnpm --filter @verdant/instant-indexer exec ponder db prune ||
    echo "prune failed, starting anyway"
  exec pnpm --filter @verdant/instant-indexer exec ponder start \
    --schema "$RAILWAY_DEPLOYMENT_ID" \
    --hostname 0.0.0.0
fi

# The indexer, unchanged. `||` and not `&&` on the prune is load-bearing; see the comment
# in railway.toml for the outage that taught us the difference.
pnpm --filter @verdant/indexer exec ponder db prune || echo "prune failed, starting anyway"
exec pnpm --filter @verdant/indexer exec ponder start \
  --schema "$RAILWAY_DEPLOYMENT_ID" \
  --hostname 0.0.0.0
