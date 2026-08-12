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

# The indexer, unchanged. `||` and not `&&` on the prune is load-bearing; see the comment
# in railway.toml for the outage that taught us the difference.
pnpm --filter @verdant/indexer exec ponder db prune || echo "prune failed, starting anyway"
exec pnpm --filter @verdant/indexer exec ponder start \
  --schema "$RAILWAY_DEPLOYMENT_ID" \
  --hostname 0.0.0.0
