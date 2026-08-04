#!/usr/bin/env bash
# Runs Verify.s.sol against the deployment recorded in packages/config, reading the
# addresses from there rather than taking them as arguments.
#
# This exists because the check is worth nothing if it is run against addresses typed by
# hand. The failure it is meant to catch — a factory wired to something other than what
# the repository believes — looks exactly like a typo in the arguments, so an invocation
# that can contain a typo cannot distinguish the two. Reading deployments.ts closes that:
# what is checked here is what every consumer will use.
#
# It is also safe to re-run at any time, and worth re-running whenever the register's
# bounds or the reviewed quote assets change, because the register is live and the
# verifier compares it against the repository as it stands now.
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1

fail() {
  echo
  echo "REFUSED: $1"
  exit 1
}

readonly DEPLOYMENTS=packages/config/src/deployments.ts
field() { grep -o "$1: \"0x[0-9a-fA-F]\{40\}\"" "$DEPLOYMENTS" | grep -o '0x[0-9a-fA-F]\{40\}'; }

FACTORY=$(field factory)
ORIGIN=$(field factoryOrigin)
[ -n "$FACTORY" ] || fail "no factory address in $DEPLOYMENTS. Record the deployment there first; that file is what the SDK, the interface and the indexer read."
[ -n "$ORIGIN" ] || fail "no factoryOrigin in $DEPLOYMENTS. Without it the anchor cannot be checked, and an anchor from an abandoned attempt is the one mistake that leaves a plausible-looking factory nobody can trust."

# The intent, which by definition cannot be read from the deployment being checked. These
# are the values the deployment was reviewed with; override them to check against
# something else.
: "${EXPECTED_TREASURY:=0xabfB34D1C870c7b2334E93b25B1299346209bE38}"
: "${EXPECTED_REGISTRY_OWNER:=0xabfB34D1C870c7b2334E93b25B1299346209bE38}"

export FACTORY ORIGIN EXPECTED_TREASURY EXPECTED_REGISTRY_OWNER

echo "--- verifying, from the factory backwards ---"
echo "factory         $FACTORY"
echo "anchor          $ORIGIN"
echo "treasury        $EXPECTED_TREASURY  (expected)"
echo "registry owner  $EXPECTED_REGISTRY_OWNER  (expected)"
echo

cd packages/contracts || fail "packages/contracts is missing"
forge script script/Verify.s.sol --rpc-url robinhood -vv || fail "the verifier refused the deployment. Read what it printed above: it names the counterparty that disagreed. Do not announce these addresses."

echo
echo "The deployment matches the repository. One warning is expected and already decided:"
echo "the register's owner is an EOA rather than a Safe."
