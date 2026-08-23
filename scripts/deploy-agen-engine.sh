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

# Deliberately after the simulation rather than before it, so that asking for --broadcast
# still produces the full dossier and fails only at the irreversible step.
#
# `deploy-instant.sh` broadcasts and then runs `VerifyInstant.s.sol`, which starts from the
# factory and asks every counterparty who *they* think the factory is. That is the only check
# on the treasury and the only way a deployment pointed at the wrong Uniswap is caught, since
# the deployment script asserts its wiring against values it computed itself. There is no
# `VerifyAgenEngine.s.sol` yet, and a stack whose immutables cannot be read back from the
# other end is one where a mis-deployment would be recorded as the live one.
#
# So this refuses, with a reason that is fixable rather than a warning that gets read once.
fail "there is no script/VerifyAgenEngine.s.sol, so a broadcast engine could not be verified
         from the other end. Every wiring the deployment asserts, it asserts against addresses
         it computed itself; the verifier is what asks the counterparties independently, and it
         is the only check the treasury ever gets. Write it, prove it against the simulation
         above, then remove this refusal."
