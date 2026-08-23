#!/usr/bin/env bash
# Deploys the Agen engine's five shared contracts to Robinhood, and refuses to broadcast
# unless every check that can be run beforehand has been run.
#
# A fourth stack beside Verdant's, Agen's and Instant's, and a separate script for the same
# reason `DeployAgenEngine.s.sol` is a separate script: the four share a PoolManager and
# nothing else, and deploying one must never be able to disturb the others. In particular the
# engine gets its own `AgenMarketRegistry` instance rather than writing into engine-0's, which
# is pinned to `AgenFactory` and could not accept writes from here anyway.
#
# What cannot be corrected afterwards: everything. `AgenEngineHook`, `AgenEngineDeployer` and
# the engine's `AgenMarketRegistry` each hold the factory in an immutable, the factory holds
# all three plus the treasury, the PoolManager and the PositionManager in immutables of its
# own, and the hook's permissions are its address. There are no setters. A deployment wired to
# the wrong Uniswap — or paying the wrong treasury — is not repaired, it is abandoned, along
# with any market launched through it in the meantime.
#
# Simulating is the default. Broadcasting takes --broadcast, and the key is never an argument
# or an environment variable: forge prompts for it, so it stays out of argv, out of the
# environment and out of shell history.
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

[ -n "${SENDER:-}" ] || fail "SENDER is unset. It is the operator address this is simulated and broadcast from, and the address committed into FactoryOrigin."
[ -n "${AGEN_ENGINE_TREASURY:-}" ] || fail "AGEN_ENGINE_TREASURY is unset. It is where a Treasury recipient's share of every engine market accrues, immutably, for every market this factory ever creates."

# Read from the config the rest of the repository reads, rather than repeating the addresses
# here. A second copy of a pinned address is a second thing that can go stale, and this one
# would go stale silently: an engine wired to a Uniswap that is not the one on 4663 is
# internally consistent and passes every check in the deployment script.
readonly CHAINS=packages/config/src/chains.ts
POOL_MANAGER=$(grep -o 'poolManager: "0x[0-9a-fA-F]\{40\}"' "$CHAINS" | grep -o '0x[0-9a-fA-F]\{40\}')
POSITION_MANAGER=$(grep -o 'positionManager: "0x[0-9a-fA-F]\{40\}"' "$CHAINS" | grep -o '0x[0-9a-fA-F]\{40\}')
export POOL_MANAGER POSITION_MANAGER AGEN_ENGINE_TREASURY
[ -n "$POOL_MANAGER" ] || fail "no poolManager in $CHAINS"
[ -n "$POSITION_MANAGER" ] || fail "no positionManager in $CHAINS"

echo "--- what this will deploy against ---"
echo "rpc alias       $RPC"
echo "PoolManager     $POOL_MANAGER   (immutable in the factory and the hook, forever)"
echo "PositionManager $POSITION_MANAGER   (immutable in the factory and the hook, forever)"
echo "treasury        $AGEN_ENGINE_TREASURY   (immutable, and resolved into every market's split)"
echo "operator        $SENDER   (immutable in FactoryOrigin; the only address that may spend it)"
echo
echo "Five contracts, deployed once per chain and never again:"
echo "  FactoryOrigin       anchors the factory's address so it is read, not predicted"
echo "  AgenEngineDeployer  holds the per-market bytecode so the factory stays under EIP-170"
echo "  AgenMarketRegistry  the engine's own; engine-0's writer is immutable and names AgenFactory"
echo "  AgenEngineHook      mined so its address carries the seven permissions it needs (0x38cc)"
echo "  AgenEngineFactory   the one contract a creator's wallet ever calls"
echo
echo "The hook's salt is mined inside the deployment, after the real FactoryOrigin exists."
echo "It is an output of this run, not an input to it: a salt is only meaningful for one"
echo "origin, and one carried in by hand cannot be checked for having gone stale. See ADR-007."
echo

# The repository is the only durable record of which deployment is the live one, because a
# second, abandoned deployment passes every internal check identically. That record is worth
# nothing if the bytecode came from a tree no commit describes.
#
# A warning rather than a refusal: mid-development trees are normal and the operator may have
# good reason. It is printed here, before the irreversible part, and repeated in the record at
# the end so the provenance is written down either way.
readonly PROVENANCE=(
  packages/contracts/src/agen/engine/AgenEngineFactory.sol
  packages/contracts/src/agen/engine/AgenEngineDeployer.sol
  packages/contracts/src/agen/engine/AgenEngineHook.sol
  packages/contracts/src/agen/engine/AgenEngineVault.sol
  packages/contracts/src/agen/engine/AgenRuleLib.sol
  packages/contracts/src/agen/AgenMarketRegistry.sol
  packages/contracts/src/agen/AgenPositionLocker.sol
  packages/contracts/src/agen/AgenCurve.sol
  packages/contracts/src/VerdantToken.sol
  packages/contracts/src/FactoryOrigin.sol
  packages/contracts/script/DeployAgenEngine.s.sol
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

echo "--- 1/3 the suite passes with no network ---"
# The whole suite rather than the engine files alone. The engine sits on shared code —
# `VerdantToken`, `AgenPositionLocker`, `AgenCurve`, `FactoryOrigin` — and a deployment is the
# wrong moment to find out that a change to something shared broke a market type nobody was
# looking at. `DeployAgenEngine.t.sol` is in here, which is what checks that this script's own
# derivation chain holds: origin to predicted factory to salt to hook to factory.
(cd packages/contracts && forge test) || fail "the contract suite failed"

echo
echo "--- 2/3 the engine's sizes are under EIP-170 ---"
# Separate from the suite above only because it is the check whose failure mode is a
# transaction that reverts on chain having spent the gas. `AgenEngineDeployer` carries the
# token, vault and locker creation code and has the least margin of anything in the repository.
(cd packages/contracts && forge test --match-path "test/agen/engine/EngineSizes.t.sol") ||
  fail "an engine contract is over the EIP-170 limit"

echo
echo "--- 3/3 simulating, against real chain state ---"
# No key. This is what proves the PoolManager and PositionManager have code where the config
# says they do and that the deterministic deployer is present, and it mines the hook — so the
# address book below is the one the broadcast will produce, for this operator at this nonce.
simulated=$(cd packages/contracts &&
  forge script script/DeployAgenEngine.s.sol --rpc-url "$RPC" --sender "$SENDER" 2>&1)
simulate_status=$?
echo "$simulated"
[ "$simulate_status" -eq 0 ] || fail "the simulation failed, so nothing was broadcast"

# The one fact in the simulation worth restating on its own, because it is the one whose
# failure is silent rather than loud. Without the two returns-delta bits the PoolManager never
# reads the delta the hook returns: every market would trade, balance and charge nobody.
hook=$(grep -m1 '^ *hook ' <<<"$simulated" | grep -o '0x[0-9a-fA-F]\{40\}')
[ -n "$hook" ] || fail "the simulation printed no hook address"
if ! grep -q '^ *hook permission bits 14540$' <<<"$simulated"; then
  fail "the mined hook's address does not carry 0x38cc (14540). Do not broadcast this."
fi
echo
echo "mined hook $hook carries 0x38cc, including both returns-delta bits."

if [ "$BROADCAST" != "--broadcast" ]; then
  echo
  echo "Simulated only. Nothing was sent."
  echo "Source: $source_note"
  echo
  echo "Read the address book above. Note that every address in it derives from $SENDER"
  echo "at its current nonce, so it holds only until that account sends another transaction."
  exit 0
fi

echo
echo "--- 4/4 broadcasting ---"
# --interactives 1 prompts for the key. Paste it at the prompt; it is not echoed and it does
# not reach argv, the environment or the shell's history.
#
# Through a file rather than a command substitution so the broadcast is visible while it
# happens: a silent minute during an irreversible deployment invites the operator to
# interrupt it. `tee` also puts the pipeline's real status in PIPESTATUS, which a
# substitution around the pipe would discard.
log=$(mktemp)
trap 'rm -f "$log"' EXIT

(cd packages/contracts &&
  forge script script/DeployAgenEngine.s.sol --rpc-url "$RPC" --broadcast \
    --sender "$SENDER" --interactives 1 2>&1) | tee "$log"
[ "${PIPESTATUS[0]}" -eq 0 ] || fail "the broadcast failed. Read the output above before retrying: a partial deployment is abandoned at a fresh anchor, not resumed."
broadcast=$(cat "$log")

# Parsed from the script's own report rather than from broadcast/*.json, because the report is
# what a human reads and what gets recorded. If the two ever disagreed, this would be
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
  fail "the broadcast output had no address book, so the deployment could not be verified. Do not use these addresses until VerifyAgenEngine.s.sol has passed against them."

echo
echo "--- verifying from the other end ---"
# The deployment asserts its own wiring as it goes, but against values the same script
# computed: pointed at an address that is not this chain's PoolManager it would deploy a
# self-consistent engine wired to a Uniswap nobody trades on and report success. The verifier
# starts from the factory and asks every counterparty who *they* think the factory is, checks
# the hook's permissions against its own address, and compares both runtime code hashes with
# the approved release. It is also the only check the treasury ever gets, which is the input
# with no counterparty and the one that cannot be corrected for any market, ever.
verified=$(cd packages/contracts &&
  FACTORY="$factory" ORIGIN="$origin" EXPECTED_TREASURY="$AGEN_ENGINE_TREASURY" \
    forge script script/VerifyAgenEngine.s.sol --rpc-url "$RPC" 2>&1)
echo "$verified"

if grep -q "FAIL" <<<"$verified"; then
  fail "the verifier refused this deployment. There is nothing to repair: every identity is an
         immutable and the anchor's one creation is spent, so deploy again at a fresh anchor
         and do not record these addresses anywhere."
fi

block=$(cast block-number --rpc-url "$RPC" 2>/dev/null || echo 0)

cat <<RECORD

--- record this deployment ---

  AGEN_ENGINE_FACTORY   $factory
  AGEN_ENGINE_DEPLOYER  $deployer
  AGEN_ENGINE_REGISTRY  $registry
  AGEN_ENGINE_HOOK      $hook
  origin                $origin   (spent)
  treasury              $AGEN_ENGINE_TREASURY
  operator              $SENDER
  block                 $block
  source                $source_note

The app and the indexer read the four AGEN_ENGINE_* names above. Record the same addresses in
deployments/robinhood.json, whose \`artifact\` field must name this run's broadcast file
explicitly — run-latest.json is overwritten by any later run, including a local one, and is
not the history of anything.
RECORD
