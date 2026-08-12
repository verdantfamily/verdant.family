#!/usr/bin/env bash
# Deploys Agen's three shared contracts to Robinhood, and refuses to broadcast unless
# every check that can be run beforehand has been run.
#
# This is `deploy-mainnet.sh` for the other half of the repository, and it is a separate
# script for the same reason `DeployAgen.s.sol` is a separate script: Verdant and Agen
# share a PoolManager and nothing else, and deploying one must never be able to disturb
# the other. The gates differ too — Agen has no parameter register to project and no
# treasury to get wrong, and it does have a factory whose address is anchored rather
# than predicted.
#
# What cannot be corrected afterwards: everything. `AgenDeployer` and
# `AgenMarketRegistry` each hold the factory in an immutable, and the factory holds both
# plus the PoolManager and PositionManager in immutables of its own. There are no
# setters. A deployment wired to the wrong Uniswap is not repaired, it is abandoned —
# along with any market launched through it in the meantime.
#
# Simulating is the default. Broadcasting takes --broadcast, and the key is never an
# argument or an environment variable: forge prompts for it, so it stays out of argv, out
# of the environment and out of shell history.
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1

readonly BROADCAST=${1:-}

# Which chain. The alias is a foundry.toml rpc_endpoint, so this cannot be pointed at an
# endpoint the rest of the repository does not know about.
readonly RPC=${RPC_ALIAS:-robinhood}

fail() {
  echo
  echo "REFUSED: $1"
  exit 1
}

[ -n "${SENDER:-}" ] || fail "SENDER is unset. It is the operator address this is simulated and broadcast from."

# Read from the config the rest of the repository reads, rather than repeating the
# addresses here. A second copy of a pinned address is a second thing that can go stale,
# and this one would go stale silently: an Agen wired to a Uniswap that is not the one on
# 4663 is internally consistent and passes every check in the deployment script.
readonly CHAINS=packages/config/src/chains.ts
POOL_MANAGER=$(grep -o 'poolManager: "0x[0-9a-fA-F]\{40\}"' "$CHAINS" | grep -o '0x[0-9a-fA-F]\{40\}')
POSITION_MANAGER=$(grep -o 'positionManager: "0x[0-9a-fA-F]\{40\}"' "$CHAINS" | grep -o '0x[0-9a-fA-F]\{40\}')
export POOL_MANAGER POSITION_MANAGER
[ -n "$POOL_MANAGER" ] || fail "no poolManager in $CHAINS"
[ -n "$POSITION_MANAGER" ] || fail "no positionManager in $CHAINS"

echo "--- what this will deploy against ---"
echo "rpc alias       $RPC"
echo "PoolManager     $POOL_MANAGER   (immutable in the factory, forever)"
echo "PositionManager $POSITION_MANAGER   (immutable in the factory, forever)"
echo "operator        $SENDER"
echo
echo "Three contracts, deployed once per chain and never again:"
echo "  FactoryOrigin        anchors the factory's address so it is read, not predicted"
echo "  AgenDeployer         performs every market's CREATE2, for this factory only"
echo "  AgenMarketRegistry   records every market, writable by this factory only"
echo "  AgenFactory          the one contract a creator's wallet ever calls"
echo

# The repository is the only durable record of which deployment is the live one, because
# a second, abandoned deployment passes every internal check identically. That record is
# worth nothing if the bytecode came from a tree no commit describes.
#
# A warning rather than a refusal: mid-development trees are normal and the operator may
# have good reason. It is printed here, before the irreversible part, and repeated in the
# record at the end so the provenance is written down either way.
readonly PROVENANCE=(packages/contracts/src/agen packages/contracts/src/FactoryOrigin.sol packages/contracts/script/DeployAgen.s.sol packages/config)
commit=$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")
uncommitted=$(git status --porcelain -- "${PROVENANCE[@]}" 2>/dev/null)

if [ -n "$uncommitted" ]; then
  source_note="$commit plus uncommitted changes"
  echo "WARNING: the bytecode this deploys is not described by any commit. Uncommitted:"
  sed 's/^/         /' <<<"$uncommitted"
  echo "         Committing first is what makes the deployment reproducible and verifiable."
  echo
else
  source_note="$commit"
fi

echo "--- 1/3 the suite passes with no network ---"
# The whole suite rather than test/agen alone. Agen's contracts sit on the same shared
# code as Verdant's, and a deployment is the wrong moment to find out that a change to
# something shared broke a market type nobody was looking at.
(cd packages/contracts && forge test) || fail "the contract suite failed"

echo
echo "--- 2/3 simulating, against real chain state ---"
# No key. This is what proves the PoolManager and PositionManager have code where the
# config says they do — `DeployAgen.s.sol` requires it, and requiring it against a live
# chain is the only place that check means anything.
simulated=$(cd packages/contracts &&
  forge script script/DeployAgen.s.sol --rpc-url "$RPC" --sender "$SENDER" 2>&1)
simulate_status=$?
echo "$simulated"
[ "$simulate_status" -eq 0 ] || fail "the simulation failed, so nothing was broadcast"

if [ "$BROADCAST" != "--broadcast" ]; then
  echo
  echo "Simulated only. Nothing was sent."
  echo "Read the address book above, then run: SENDER=$SENDER $0 --broadcast"
  exit 0
fi

echo
echo "--- 3/3 broadcasting ---"
# --interactives 1 prompts for the key. Paste it at the prompt; it is not echoed and it
# does not reach argv, the environment or the shell's history.
#
# Through a file rather than a command substitution so the broadcast is visible while it
# happens: this takes a minute, and a silent minute during an irreversible deployment
# invites the operator to interrupt it. `tee` also puts the pipeline's real status in
# PIPESTATUS, which a substitution around the pipe would discard.
log=$(mktemp)
trap 'rm -f "$log"' EXIT

(cd packages/contracts &&
  forge script script/DeployAgen.s.sol --rpc-url "$RPC" --broadcast \
    --sender "$SENDER" --interactives 1 2>&1) | tee "$log"
[ "${PIPESTATUS[0]}" -eq 0 ] || fail "the broadcast failed. Read the output above before retrying: a partial deployment is abandoned, not resumed."
broadcast=$(cat "$log")

# Parsed from the script's own report rather than from broadcast/*.json, because the
# report is what a human reads and what gets recorded. If the two ever disagreed, this
# would be verifying the wrong thing loudly rather than the right thing silently.
#
# The leading whitespace is not decoration: forge indents everything a script logs by two
# spaces, so anchoring these to the start of a line finds nothing.
value_of() { grep -m1 "^ *$1 " <<<"$broadcast" | grep -o '0x[0-9a-fA-F]\{40\}'; }
factory=$(value_of "NEXT_PUBLIC_AGEN_FACTORY")
deployer=$(value_of "NEXT_PUBLIC_AGEN_DEPLOYER")
registry=$(value_of "NEXT_PUBLIC_AGEN_REGISTRY")
origin=$(grep -m1 "^ *FACTORY_ORIGIN" <<<"$broadcast" | grep -o '0x[0-9a-fA-F]\{40\}')

[ -n "$factory" ] && [ -n "$deployer" ] && [ -n "$registry" ] ||
  fail "the broadcast output had no address book, so the deployment could not be verified. Do not use these addresses until VerifyAgen.s.sol has passed against them."

echo
echo "--- verifying from the other end ---"
# The deployment asserts its own wiring as it goes, but against values the same script
# computed. The verifier starts from the factory and asks every counterparty who *they*
# think the factory is, which is the only way a deployment pointed at the wrong Uniswap
# is caught.
verified=$(cd packages/contracts &&
  FACTORY="$factory" ORIGIN="$origin" \
    forge script script/VerifyAgen.s.sol --rpc-url "$RPC" 2>&1)
echo "$verified"

if grep -q "FAIL" <<<"$verified"; then
  fail "the verifier refused this deployment. There is nothing to repair: deploy again at fresh addresses and do not record these."
fi

cat <<RECORD

--- 1. the interface reads these three ---

Set them in apps/agen/.env.local for local work, and in the Agen service's variables on
Railway for the deployed site. The app refuses to show a launch button without them, so
nothing is live until they are set.

NEXT_PUBLIC_AGEN_FACTORY=$factory
NEXT_PUBLIC_AGEN_DEPLOYER=$deployer
NEXT_PUBLIC_AGEN_REGISTRY=$registry

--- 2. record this in deployments/robinhood.json, under "agen" ---

  "agen": {
    "deployedFrom": "$source_note",
    "factory": { "address": "$factory" },
    "deployer": { "address": "$deployer" },
    "registry": { "address": "$registry" },
    "factoryOrigin": { "address": "$origin" }
  }

Commit that with the transaction hashes in the message. It is the only durable record of
which deployment is the live one: a second, abandoned deployment passes every internal
check exactly as this one does. The indexer reads this file, so it is also how the feed
learns which factory to follow.

Then launch one market deliberately before telling anyone the addresses.
RECORD
