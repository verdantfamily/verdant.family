#!/usr/bin/env bash
# Deploys Instant's four shared contracts to Robinhood, and refuses to broadcast unless
# every check that can be run beforehand has been run.
#
# This is `deploy-agen.sh` for the third stack in the repository, and it is a separate
# script for the same reason `DeployInstant.s.sol` is a separate script: Verdant, Agen and
# Instant share a PoolManager and nothing else, and deploying one must never be able to
# disturb the others.
#
# What cannot be corrected afterwards: everything. `InstantHook`, `InstantDeployer` and the
# `MarketRegistry` each hold the factory in an immutable, the factory holds all three plus
# the treasury, the PoolManager and the PositionManager in immutables of its own, and the
# hook's permissions are its address. There are no setters. A deployment wired to the wrong
# Uniswap — or paying the wrong treasury — is not repaired, it is abandoned, along with any
# market launched through it in the meantime.
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
[ -n "${TREASURY:-}" ] || fail "TREASURY is unset. It is where Instant's 0.50% accrues, immutably, for every market this factory ever creates."

# Read from the config the rest of the repository reads, rather than repeating the
# addresses here. A second copy of a pinned address is a second thing that can go stale,
# and this one would go stale silently: an Instant wired to a Uniswap that is not the one
# on 4663 is internally consistent and passes every check in the deployment script.
readonly CHAINS=packages/config/src/chains.ts
POOL_MANAGER=$(grep -o 'poolManager: "0x[0-9a-fA-F]\{40\}"' "$CHAINS" | grep -o '0x[0-9a-fA-F]\{40\}')
POSITION_MANAGER=$(grep -o 'positionManager: "0x[0-9a-fA-F]\{40\}"' "$CHAINS" | grep -o '0x[0-9a-fA-F]\{40\}')
export POOL_MANAGER POSITION_MANAGER TREASURY
[ -n "$POOL_MANAGER" ] || fail "no poolManager in $CHAINS"
[ -n "$POSITION_MANAGER" ] || fail "no positionManager in $CHAINS"

echo "--- what this will deploy against ---"
echo "rpc alias       $RPC"
echo "PoolManager     $POOL_MANAGER   (immutable in the factory, forever)"
echo "PositionManager $POSITION_MANAGER   (immutable in the factory, forever)"
echo "treasury        $TREASURY   (immutable, and snapshotted into every market's vault)"
echo "operator        $SENDER"
echo
echo "Four contracts, deployed once per chain and never again:"
echo "  FactoryOrigin     anchors the factory's address so it is read, not predicted"
echo "  InstantDeployer   performs every market's CREATE2, for this factory only"
echo "  MarketRegistry    Instant's own; Verdant's writer is immutable and names Verdant"
echo "  InstantHook       mined so its address carries the seven permissions it needs"
echo "  InstantFactory    the one contract a creator's wallet ever calls"
echo
echo "The fee is fixed at 1.50%: 1.00% to the creator, 0.50% to the treasury above,"
echo "both in ether. Nothing about it is configurable after this. See ADR-014."
echo

# The repository is the only durable record of which deployment is the live one, because
# a second, abandoned deployment passes every internal check identically. That record is
# worth nothing if the bytecode came from a tree no commit describes.
#
# A warning rather than a refusal: mid-development trees are normal and the operator may
# have good reason. It is printed here, before the irreversible part, and repeated in the
# record at the end so the provenance is written down either way.
readonly PROVENANCE=(
  packages/contracts/src/InstantFactory.sol
  packages/contracts/src/InstantDeployer.sol
  packages/contracts/src/InstantHook.sol
  packages/contracts/src/InstantFeeVault.sol
  packages/contracts/src/libraries/InstantFees.sol
  packages/contracts/src/MarketRegistry.sol
  packages/contracts/src/FactoryOrigin.sol
  packages/contracts/script/DeployInstant.s.sol
  packages/config
)
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

echo "--- 1/4 the suite passes with no network ---"
# The whole suite rather than the Instant files alone. Instant sits on shared code —
# `MarketRegistry`, `PositionLocker`, `VerdantConstants` — and a deployment is the wrong
# moment to find out that a change to something shared broke a market type nobody was
# looking at.
(cd packages/contracts && forge test) || fail "the contract suite failed"

echo
echo "--- 2/4 Instant's fork tests pass against the real Uniswap on 4663 ---"
# The one gate `deploy-agen.sh` does not have, and Instant needs it: the whole design rests
# on the deployed PositionManager reporting the factory through `msgSender()`, the deployed
# PoolManager honouring two returns-delta permissions, and `AgenRouter` — the route the
# interface trades through — accepting an Instant pool. All three are facts about somebody
# else's bytecode, and none of them is true in the vendored build by construction.
#
# Scoped to Instant's own file rather than run through `scripts/fork-test.sh`, which runs
# the whole fork profile. That is the right gate for a commit and the wrong one for this
# script: an unrelated regression in another product's fork tests would block an Instant
# deployment while telling the operator nothing about Instant. The commit gate still covers
# everything; this one covers what is about to be deployed.
#
# Connectivity is tolerated, for the reason `fork-test.sh` gives at length: a gate that
# fails on somebody else's downtime stops being read. A real failure is not tolerated.
readonly RPC_TROUBLE='could not instantiate forked environment|error sending request|failed to get latest block|connection (refused|closed|reset)|tunnel error|dns error|operation timed out|429 Too Many Requests|50[23] '

fork_output=$(cd packages/contracts &&
  FOUNDRY_PROFILE=fork forge test --match-path "test/fork/Instant.fork.t.sol" -vv 2>&1)
fork_status=$?
echo "$fork_output"

if [ "$fork_status" -ne 0 ]; then
  if grep -qiE "$RPC_TROUBLE" <<<"$fork_output"; then
    echo
    echo "WARNING: the 4663 endpoint was unreachable, so Instant was not proved against the"
    echo "         deployed Uniswap. Everything below still runs; re-run this when it is up."
  else
    fail "Instant's fork tests failed against 4663"
  fi
elif ! grep -q "Suite result:" <<<"$fork_output"; then
  # `forge test` exits 0 when it matches nothing, so a suite that silently ran zero tests
  # would be the greenest gate in the script.
  fail "Instant's fork tests matched nothing, so nothing was proved"
fi

echo
echo "--- 3/4 simulating, against real chain state ---"
# No key. This is what proves the PoolManager and PositionManager have code where the
# config says they do, and it mines the hook — so the address book below is the one the
# broadcast will produce.
simulated=$(cd packages/contracts &&
  forge script script/DeployInstant.s.sol --rpc-url "$RPC" --sender "$SENDER" 2>&1)
simulate_status=$?
echo "$simulated"
[ "$simulate_status" -eq 0 ] || fail "the simulation failed, so nothing was broadcast"

if [ "$BROADCAST" != "--broadcast" ]; then
  echo
  echo "Simulated only. Nothing was sent."
  echo "Read the address book above, then run: SENDER=$SENDER TREASURY=$TREASURY $0 --broadcast"
  exit 0
fi

echo
echo "--- 4/4 broadcasting ---"
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
  forge script script/DeployInstant.s.sol --rpc-url "$RPC" --broadcast \
    --sender "$SENDER" --interactives 1 2>&1) | tee "$log"
[ "${PIPESTATUS[0]}" -eq 0 ] || fail "the broadcast failed. Read the output above before retrying: a partial deployment is abandoned, not resumed."
broadcast=$(cat "$log")

# Parsed from the script's own report rather than from broadcast/*.json, because the report
# is what a human reads and what gets recorded. If the two ever disagreed, this would be
# verifying the wrong thing loudly rather than the right thing silently.
#
# The leading whitespace is not decoration: forge indents everything a script logs by two
# spaces, so anchoring these to the start of a line finds nothing.
value_of() { grep -m1 "^ *$1 " <<<"$broadcast" | grep -o '0x[0-9a-fA-F]\{40\}'; }
factory=$(value_of "factory")
deployer=$(value_of "deployer")
registry=$(value_of "registry")
hook=$(value_of "hook")
origin=$(value_of "origin")

[ -n "$factory" ] && [ -n "$deployer" ] && [ -n "$registry" ] && [ -n "$hook" ] ||
  fail "the broadcast output had no address book, so the deployment could not be verified. Do not use these addresses until VerifyInstant.s.sol has passed against them."

echo
echo "--- verifying from the other end ---"
# The deployment asserts its own wiring as it goes, but against values the same script
# computed. The verifier starts from the factory and asks every counterparty who *they*
# think the factory is, which is the only way a deployment pointed at the wrong Uniswap is
# caught — and it is the only check on the treasury, which nothing else can confirm.
verified=$(cd packages/contracts &&
  FACTORY="$factory" ORIGIN="$origin" EXPECTED_TREASURY="$TREASURY" \
    forge script script/VerifyInstant.s.sol --rpc-url "$RPC" 2>&1)
echo "$verified"

if grep -q "FAIL" <<<"$verified"; then
  fail "the verifier refused this deployment. There is nothing to repair: deploy again at fresh addresses and do not record these."
fi

block=$(cast block-number --rpc-url "$RPC" 2>/dev/null || echo 0)

cat <<RECORD

--- 1. record this in packages/config/src/deployments.ts, under INSTANT ---

  [ROBINHOOD_MAINNET_ID]: {
    // Deployed from $source_note
    factoryOrigin: "$origin",
    deployer: "$deployer",
    registry: "$registry",
    hook: "$hook",
    factory: "$factory",
    treasury: "$TREASURY",
    deployedAtBlock: $block,
  },

Commit that with the transaction hashes in the message. It is the only durable record of
which deployment is the live one: a second, abandoned deployment passes every internal
check exactly as this one does. The interface and the indexer both read this record, so a
deploy of one cannot disagree with a deploy of the other about which Instant it is.

--- 2. then, and only then ---

  * set INSTANT_LAUNCHABLE = true in apps/agen/src/app/lib/instant.ts
  * set AGEN_START_BLOCK-style config for the indexer if it needs a floor
  * launch one market deliberately, from a wallet you control, before telling anyone

The launch button stays off until that flag is turned over, which is deliberate: the
addresses being recorded and the product being open are two decisions, and they should not
be one commit.
RECORD
