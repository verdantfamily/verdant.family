#!/usr/bin/env bash
#
# Proves the Instant feed end to end, on this machine, with no network.
#
# What it does, in order: starts anvil, deploys a Uniswap v4 onto it, deploys Instant
# through the real `DeployInstant.s.sol`, launches two Instant markets and trades them,
# runs the indexer against the whole history, and then asks the three Instant routes the
# same questions the contracts can answer and requires the same answers.
#
# ## Why this exists beside `indexer-proof.sh` rather than inside it
#
# That script proves Verdant, Agen and the agent layer agree with their indexer, and it is
# long, slow and in service. Instant is a third launch path that touches neither, so its
# proof is a third script: a failure here says something about Instant and nothing about
# anything else, which is the property that makes a red run worth reading.
#
# The Verdant contracts are deliberately *not* deployed, and since Instant moved into
# `apps/instant-indexer` nothing here has to pretend they were. That app watches Instant's
# factory and Uniswap's PoolManager and knows nothing about a Verdant factory, so the
# isolation this proof wants is now a property of what is running rather than of six
# environment variables set to the zero address.
#
# ## What it cannot prove
#
# That the deployed Uniswap on 4663 behaves the same way. The fork suite does that
# (`test/fork/Instant.fork.t.sol`), including the router the interface trades through.
# This proves the other half: that what the chain emits and what the feed serves agree.
#
# Usage: bash scripts/instant-proof.sh
#        INSTANT_KEEP=1 bash scripts/instant-proof.sh   # leave it running
# Requires: anvil, forge, node, pnpm. No RPC, no Postgres, no keys.

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
ROOT="$PWD"

# Not 8545, and not 8555 either: the first is where a developer's own anvil lives and the
# second is `indexer-proof.sh`'s, so this can run beside either without either noticing.
ANVIL_PORT="${ANVIL_PORT:-8565}"
PONDER_PORT="${PONDER_PORT:-42169}"
RPC="http://127.0.0.1:${ANVIL_PORT}"
API="http://127.0.0.1:${PONDER_PORT}"

# anvil's first account. A well-known key on a throwaway local node, written here rather
# than read from the environment: making it configurable would invite someone to point
# this at a funded key on a real chain.
OPERATOR_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
OPERATOR=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266

# anvil's second account. Instant's treasury may be any address that is not zero; a
# separate one from the creator keeps the two ledgers legible in the vault.
TREASURY_ADDRESS=0x70997970C51812dc3A010C7d01b50e0d17dc79C8

# The indexer's config is written for 4663, and a mismatch would have it index a chain
# that is not the one it is talking to.
CHAIN_ID=4663

LOGS="$ROOT/.instant-proof"
mkdir -p "$LOGS"

anvil_pid=""
ponder_pid=""

# Both background processes are started under job control (`set -m`) so each leads its own
# process group, and both are stopped by signalling the group rather than the pid: `pnpm
# ponder start` is a node process that spawns another, so killing what bash backgrounded
# leaves the real indexer running and the next run finds the port served by a stale one.
stop_group() {
  local pid="$1"
  [ -z "$pid" ] && return 0
  kill -- "-$pid" 2>/dev/null || kill "$pid" 2>/dev/null || true
}

port_in_use() {
  (exec 3<>"/dev/tcp/127.0.0.1/$1") >/dev/null 2>&1
}

cleanup() {
  local status=$?
  if [ -n "${INSTANT_KEEP:-}" ] && [ "$status" -eq 0 ]; then
    return 0
  fi
  stop_group "$ponder_pid"
  stop_group "$anvil_pid"
  if [ "$status" -ne 0 ]; then
    echo
    echo "the proof failed. Logs are in $LOGS:"
    echo "  anvil:   $LOGS/anvil.log"
    echo "  indexer: $LOGS/ponder.log"
  fi
  exit "$status"
}
trap cleanup EXIT INT TERM

step() { echo; echo "=== $* ==="; }
fail() { echo; echo "FAILED: $1" >&2; exit 1; }

# Reads an address a forge script printed, matched by its label rather than its position
# so a change to the output format fails here loudly instead of picking the wrong one.
address_from() {
  local file="$1" label="$2" found
  found=$(grep -oE "${label}[[:space:]]+0x[0-9a-fA-F]{40}" "$file" | tail -1 | grep -oE '0x[0-9a-fA-F]{40}' || true)
  [ -n "$found" ] || fail "could not find '${label}' in ${file}"
  printf "%s" "$found"
}

for check in "anvil:${ANVIL_PORT}:ANVIL_PORT" "the indexer:${PONDER_PORT}:PONDER_PORT"; do
  what=${check%%:*}
  rest=${check#*:}
  port=${rest%%:*}
  variable=${rest#*:}
  if port_in_use "$port"; then
    fail "port ${port} is already in use, and ${what} needs it. Stop it, or set ${variable}."
  fi
done

step "starting anvil on ${ANVIL_PORT}"
# `--disable-code-size-limit` on the *node*, not only on the forge script. This
# repository compiles PoolManager and PositionManager over EIP-170 because foundry.toml
# optimises for runtime gas rather than size, and forge's own flag only relaxes the
# simulation — without this the node rejects both deployments and the run fails with two
# bare transaction hashes and no reason. The contracts deployed on 4663 are Uniswap's own
# smaller build; nothing Instant deploys is anywhere near the limit.
set -m
anvil \
  --port "$ANVIL_PORT" \
  --chain-id "$CHAIN_ID" \
  --disable-code-size-limit \
  --silent \
  >"$LOGS/anvil.log" 2>&1 &
anvil_pid=$!
set +m

for _ in $(seq 1 50); do
  port_in_use "$ANVIL_PORT" && break
  sleep 0.2
done
port_in_use "$ANVIL_PORT" || fail "anvil never started; see $LOGS/anvil.log"

cd "$ROOT/packages/contracts"

step "building the contracts"
# Forced when the artifacts are ABI-only, which is what a `forge lint` run leaves behind:
# forge's cache does not record that the output selection changed, so a plain build then
# reports "no files changed" and the script fails with "Could not find target contract".
forge build >"$LOGS/build.log" 2>&1 || { cat "$LOGS/build.log"; exit 1; }
if ! grep -q '"bytecode"' out/LocalUniswap.s.sol/LocalUniswap.json 2>/dev/null; then
  echo "artifacts have no bytecode (a lint run left them ABI-only); rebuilding"
  forge build --force >"$LOGS/build.log" 2>&1 || { cat "$LOGS/build.log"; exit 1; }
fi

step "deploying a Uniswap v4"
# --disable-code-size-limit only here, and deliberately not on the Instant deploy below.
# These two Uniswap contracts are over EIP-170 in this repository's build; every contract
# Instant deploys is under it, and that is a property worth keeping enforced.
forge script script/LocalUniswap.s.sol \
  --rpc-url "$RPC" --private-key "$OPERATOR_KEY" --broadcast \
  --disable-code-size-limit -vv \
  >"$LOGS/uniswap.log" 2>&1 || { cat "$LOGS/uniswap.log"; exit 1; }

POOL_MANAGER=$(address_from "$LOGS/uniswap.log" "POOL_MANAGER")
POSITION_MANAGER=$(address_from "$LOGS/uniswap.log" "POSITION_MANAGER")
SWAP_ROUTER=$(address_from "$LOGS/uniswap.log" "SWAP_ROUTER")
export POOL_MANAGER POSITION_MANAGER SWAP_ROUTER
echo "PoolManager     $POOL_MANAGER"
echo "PositionManager $POSITION_MANAGER"

START_BLOCK=$(cast block-number --rpc-url "$RPC")

step "deploying Instant"
# The real script, not a rig substitute: the hook is mined to 0x38cc through the same
# CREATE2 deployer, the factory is anchored through FactoryOrigin, and every wiring
# assertion in it runs. A deployment that would fail on 4663 fails here.
TREASURY="$TREASURY_ADDRESS" forge script script/DeployInstant.s.sol \
  --rpc-url "$RPC" --private-key "$OPERATOR_KEY" --broadcast -vv \
  >"$LOGS/deploy-instant.log" 2>&1 || { cat "$LOGS/deploy-instant.log"; exit 1; }

INSTANT_FACTORY=$(address_from "$LOGS/deploy-instant.log" "factory")
INSTANT_REGISTRY=$(address_from "$LOGS/deploy-instant.log" "registry")
INSTANT_HOOK=$(address_from "$LOGS/deploy-instant.log" "hook")
export INSTANT_FACTORY INSTANT_REGISTRY
echo "InstantFactory  $INSTANT_FACTORY"
echo "InstantHook     $INSTANT_HOOK"

step "verifying the deployment from the other end"
FACTORY="$INSTANT_FACTORY" EXPECTED_TREASURY="$TREASURY_ADDRESS" \
  forge script script/VerifyInstant.s.sol --rpc-url "$RPC" -vv \
  >"$LOGS/verify-instant.log" 2>&1 || { cat "$LOGS/verify-instant.log"; exit 1; }
grep -q "FAIL" "$LOGS/verify-instant.log" && { cat "$LOGS/verify-instant.log"; fail "the verifier refused the deployment"; }
echo "verified"

step "launching and trading"
forge script script/InstantSeed.s.sol \
  --rpc-url "$RPC" --private-key "$OPERATOR_KEY" --broadcast -vv \
  >"$LOGS/seed.log" 2>&1 || { cat "$LOGS/seed.log"; exit 1; }

TOKEN_ONE=$(address_from "$LOGS/seed.log" "MARKET_ONE_TOKEN")
TOKEN_TWO=$(address_from "$LOGS/seed.log" "MARKET_TWO_TOKEN")
echo "market one $TOKEN_ONE"
echo "market two $TOKEN_TWO"

cd "$ROOT"

step "building the TypeScript the indexer imports"
pnpm --filter "@verdant/instant-indexer^..." build >"$LOGS/build-ts.log" 2>&1 ||
  { tail -30 "$LOGS/build-ts.log"; exit 1; }

step "indexing"
# Instant's addresses, from this rig rather than from the deployment record — the record
# names mainnet, and watching those addresses on a local chain would find nothing.
export INSTANT_FACTORY INSTANT_REGISTRY
export INSTANT_START_BLOCK="$START_BLOCK"

# The Uniswap this rig deployed, not the one on 4663. Without it the indexer would watch
# the real PoolManager's address on a node where nothing lives there, and every market
# would arrive with no pool.
export VERDANT_POOL_MANAGER="$POOL_MANAGER"
export PONDER_RPC_URL_4663="$RPC"

# No DATABASE_URL, so Ponder uses PGlite in a directory under the app. Removed first,
# because a previous run's database would be reused and the proof would pass on stale
# data — the one failure mode that would make this script worthless.
rm -rf "$ROOT/apps/instant-indexer/.ponder"

set -m
(cd "$ROOT/apps/instant-indexer" && exec pnpm ponder start --schema instantproof --port "$PONDER_PORT") \
  >"$LOGS/ponder.log" 2>&1 &
ponder_pid=$!
set +m

# Wait for the API to serve both markets rather than merely to accept connections: Ponder
# answers /health long before the backfill is done, and a poll on that races the
# assertions below.
ready=""
indexed=0
for _ in $(seq 1 150); do
  body=$(curl -sf "$API/instant/markets" 2>/dev/null || true)
  indexed=$(printf "%s" "$body" | awk -v RS='"poolId"' "END {print NR - 1}")
  if [ "$indexed" -ge 2 ]; then
    ready=1
    break
  fi
  if ! kill -0 "$ponder_pid" 2>/dev/null; then
    echo "the indexer exited before serving anything:" >&2
    tail -40 "$LOGS/ponder.log" >&2
    exit 1
  fi
  sleep 1
done

[ -n "$ready" ] || { tail -40 "$LOGS/ponder.log" >&2; fail "the indexer served $indexed of 2 Instant markets within 150 seconds"; }
echo "the indexer is serving both Instant markets"

step "asserting the feed against the chain"
node "$ROOT/apps/instant-indexer/scripts/assert-instant.ts" \
  --api "$API" --rpc "$RPC" \
  --factory "$INSTANT_FACTORY" --token "$TOKEN_ONE" --second "$TOKEN_TWO" \
  || fail "the Instant feed does not agree with the chain"

if [ -n "${INSTANT_KEEP:-}" ]; then
  cat <<KEEP

--- left running ---

  chain    $RPC        (chain id $CHAIN_ID)
  feed     $API/instant
  factory  $INSTANT_FACTORY
  token    $TOKEN_ONE

Point the app at it:

  AGEN_INSTANT_FEED_URL=$API \\
  NEXT_PUBLIC_INSTANT_FACTORY=$INSTANT_FACTORY \\
  NEXT_PUBLIC_INSTANT_DEPLOYER=$(address_from "$LOGS/deploy-instant.log" "deployer") \\
  NEXT_PUBLIC_INSTANT_REGISTRY=$INSTANT_REGISTRY \\
  NEXT_PUBLIC_INSTANT_HOOK=$INSTANT_HOOK \\
  NEXT_PUBLIC_RPC_URL=$RPC \\
  NEXT_PUBLIC_SITE_URL=http://127.0.0.1:3000 \\
  pnpm --filter @verdant/agen dev

Stop it with: kill -- -$anvil_pid -$ponder_pid
KEEP
else
  echo
  echo "Instant indexes and serves correctly."
fi
