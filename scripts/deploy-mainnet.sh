#!/usr/bin/env bash
# Deploys Verdant to Robinhood mainnet, in the order docs/deployment.md sets out, and
# refuses to broadcast unless every check that can be run beforehand has been run.
#
# The reason this is a script and not a paragraph of instructions: a Verdant deployment
# cannot be corrected. The hook's address is mined, v4 reads its permissions from that
# address on every call, and the factory, both registries and the deployer name each
# other in immutables. A mistake is not patched but abandoned, along with any market
# created against it in the meantime. So the steps that are easy to skip by hand — the
# bounds diff, the fork suite, the two intent addresses — are not optional here.
#
# Simulating is the default. Broadcasting takes --broadcast, and the key is never an
# argument or an environment variable: forge prompts for it, so it stays out of argv,
# out of the environment and out of shell history.
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1

readonly BROADCAST=${1:-}

fail() {
  echo
  echo "REFUSED: $1"
  exit 1
}

# The two addresses that cannot be changed afterwards have no defaults, deliberately.
# `Deploy.s.sol` defaults REGISTRY_OWNER to the sending key, which would leave the
# register owned by whatever laptop ran this; a default here would hide that same
# mistake one level further down.
[ -n "${TREASURY:-}" ] || fail "TREASURY is unset. It is immutable in every market this factory will ever create."
[ -n "${REGISTRY_OWNER:-}" ] || fail "REGISTRY_OWNER is unset. Unset means the deploying key owns the register."
[ -n "${SENDER:-}" ] || fail "SENDER is unset. It is the operator address the deployment is simulated and broadcast from."

# Read from the config the rest of the repository reads, rather than repeating the
# addresses here. A second copy of a pinned address is a second thing that can go stale,
# and this one would go stale silently: a deployment wired to a Uniswap that is not the
# one on 4663 is internally consistent and passes every check but the fork suite.
readonly CHAINS=packages/config/src/chains.ts
POOL_MANAGER=$(grep -o 'poolManager: "0x[0-9a-fA-F]\{40\}"' "$CHAINS" | grep -o '0x[0-9a-fA-F]\{40\}')
POSITION_MANAGER=$(grep -o 'positionManager: "0x[0-9a-fA-F]\{40\}"' "$CHAINS" | grep -o '0x[0-9a-fA-F]\{40\}')
export POOL_MANAGER POSITION_MANAGER
[ -n "$POOL_MANAGER" ] || fail "no poolManager in $CHAINS"
[ -n "$POSITION_MANAGER" ] || fail "no positionManager in $CHAINS"

echo "--- what this will deploy against ---"
echo "PoolManager     $POOL_MANAGER"
echo "PositionManager $POSITION_MANAGER"
echo "treasury        $TREASURY        (immutable in every market, forever)"
echo "registry owner  $REGISTRY_OWNER  (the only live privilege in the system)"
echo "operator        $SENDER"
echo

# Step 6 of the runbook says the repository is the only durable record of which
# deployment is the live one, because a second, abandoned deployment passes every
# internal check identically. That record is worth nothing if the bytecode came from a
# tree no commit describes — and it is also what Blockscout verification in step 7 is
# checked against, so uncommitted source here becomes source nobody can reproduce later.
#
# A warning rather than a refusal: mid-development trees are normal and the operator may
# have good reason. But it is printed here, before the irreversible part, and repeated in
# the record at the end so the provenance is written down either way.
readonly PROVENANCE=(packages/contracts/src packages/contracts/script packages/config)
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

echo "--- 1/5 the parameter register matches its projection ---"
# Against the file's own regeneration, not against the last commit. CI can compare with
# git because CI runs on a clean checkout; in a working tree that comparison answers a
# different question and answers it wrongly — it fails on any uncommitted work anywhere
# in the register, which is not what makes a deployment unsafe. What makes a deployment
# unsafe is a *stale* projection: `ModelRegistry` is seeded from this file in its
# constructor and never again, so a copy that no longer matches packages/config produces
# a register that refuses launches it should admit while passing every other check here.
readonly BOUNDS=packages/config/generated/bounds.json
before=$(cat "$BOUNDS" 2>/dev/null)
pnpm bounds:emit >/dev/null 2>&1 || fail "pnpm bounds:emit failed"
[ "$before" = "$(cat "$BOUNDS")" ] ||
  fail "$BOUNDS was stale — regenerating it from packages/config changed it, and it has now been rewritten. Read the diff, run the suite against it, and commit it before deploying: the register seeded from the old copy would refuse launches it should admit."

echo "--- 2/5 the suite passes with no network ---"
(cd packages/contracts && forge test) || fail "the contract suite failed"

echo "--- 3/5 the suite passes against the Uniswap actually on 4663 ---"
# fork-test.sh passes when the RPC is unreachable, on purpose: a CI gate that fails on
# somebody else's outage stops being read. That tolerance is wrong here. A fork run that
# proved nothing is the only evidence there is that `IMsgSender.msgSender()` on the
# deployed PositionManager reports what the liquidity guard depends on, so an
# unreachable endpoint blocks the deployment rather than warning about it.
fork_output=$(bash scripts/fork-test.sh 2>&1)
fork_status=$?
echo "$fork_output"
[ "$fork_status" -eq 0 ] || fail "the fork suite failed against 4663"
if [[ $fork_output == *"proved nothing"* || $fork_output == *"matched no tests"* ]]; then
  fail "the fork suite did not actually run. Nothing may be broadcast on the strength of a run that proved nothing."
fi

echo "--- 4/5 simulating, against real chain state ---"
simulated=$(cd packages/contracts && forge script script/Deploy.s.sol --rpc-url robinhood --sender "$SENDER" 2>&1)
simulate_status=$?
echo "$simulated"
[ "$simulate_status" -eq 0 ] || fail "the simulation failed, so nothing was broadcast"

if [ "$BROADCAST" != "--broadcast" ]; then
  echo
  echo "Simulated only. Nothing was sent."
  echo "Read the address book above, then run: $0 --broadcast"
  exit 0
fi

echo "--- 5/5 broadcasting ---"
# --interactives 1 prompts for the key. Paste it at the prompt; it is not echoed and it
# does not reach argv, the environment or ~/.zsh_history.
#
# Through a file rather than a command substitution so that the broadcast is visible
# while it happens — this step takes a minute and a silent minute during an irreversible
# deployment invites the operator to interrupt it. `tee` also puts the pipeline's real
# status in PIPESTATUS, which a substitution around the pipe would discard.
log=$(mktemp)
trap 'rm -f "$log"' EXIT

(cd packages/contracts &&
  forge script script/Deploy.s.sol --rpc-url robinhood --broadcast \
    --sender "$SENDER" --interactives 1 2>&1) | tee "$log"
[ "${PIPESTATUS[0]}" -eq 0 ] || fail "the broadcast failed. Read the output above before retrying: a partial deployment is abandoned, not resumed."
broadcast=$(cat "$log")

# Parsed from the script's own address book rather than from broadcast/*.json, because
# the address book is what a human reads and what step 6 of the runbook records. If the
# two ever disagreed, this would be verifying the wrong thing loudly rather than the
# right thing silently.
#
# The leading whitespace in the pattern is not decoration: forge indents everything a
# script logs by two spaces, so anchoring this to the start of the line found nothing
# and the run refused a deployment that had in fact succeeded. Being refused after the
# broadcast is the safe direction to be wrong in, but it is still wrong.
address_of() { grep -m1 "^ *$1 " <<<"$broadcast" | grep -o '0x[0-9a-fA-F]\{40\}'; }
factory=$(address_of "VerdantFactory")
origin=$(address_of "FactoryOrigin")
[ -n "$factory" ] && [ -n "$origin" ] || fail "the broadcast output had no address book, so the deployment could not be verified. Do not announce these addresses until Verify.s.sol has passed against them."

echo
echo "--- verifying from the other end ---"
# The deployment asserts its own wiring as it goes, but those assertions run against
# values the same script computed. The verifier starts from the factory and asks every
# counterparty who *they* think the factory is, which is the only way a deployment
# pointed at the wrong PositionManager is caught.
verified=$(cd packages/contracts &&
  FACTORY="$factory" ORIGIN="$origin" \
    EXPECTED_TREASURY="$TREASURY" EXPECTED_REGISTRY_OWNER="$REGISTRY_OWNER" \
    forge script script/Verify.s.sol --rpc-url robinhood 2>&1)
echo "$verified"

if grep -q "FAIL" <<<"$verified"; then
  fail "the verifier refused this deployment. There is nothing to repair: deploy again at fresh addresses and do not record these."
fi

cat <<RECORD

--- record this in packages/config/src/deployments.ts ---
  // Deployed from $source_note
  4663: {
    origin: "$origin",
    factory: "$factory",
$(grep -E "^ *(ModelRegistry|MarketRegistry|VerdantDeployer|VerdantHook) " <<<"$broadcast" |
  sed -E 's/^ *ModelRegistry +/    modelRegistry: "/; s/^ *MarketRegistry +/    marketRegistry: "/; s/^ *VerdantDeployer +/    deployer: "/; s/^ *VerdantHook +/    hook: "/; s/ *$/",/')
  },

Commit that with the transaction hashes in the message. It is the only durable record of
which deployment is the live one: a second, abandoned deployment passes every internal
check exactly as this one does.

Then verify the source on Blockscout (step 7) and launch one market deliberately
(step 8) before telling anyone the addresses.
RECORD
