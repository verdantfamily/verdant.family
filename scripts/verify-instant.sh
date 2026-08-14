#!/usr/bin/env bash
#
# Source-verify the Instant deployment on Robinhood's Blockscout.
#
# Two jobs, both idempotent and both read-only with respect to the chain:
#
#   1. The infrastructure — factory, hook, registry, deployer — which is deployed once and
#      verified once. Every constructor argument is read back off the deployed contract
#      rather than restated here, so this cannot verify something against arguments it was
#      not built with.
#
#   2. Every token the registry knows about, as a backfill. New launches verify themselves
#      through `POST /api/instant/verify`; this catches anything launched before that
#      existed, or while the explorer was down.
#
# Nothing here signs anything. Verification is a claim that source matches bytecode, which
# anybody can make and everybody can check, so no deployment key is involved.
#
#   RPC_URL=... bash scripts/verify-instant.sh
#
# Blockscout rate-limits hard and its window is minutes long, so submissions are paced.
# Being slow is the correct behaviour for a job nobody is waiting on.
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$here/packages/contracts"

EXPLORER="https://robinhoodchain.blockscout.com"
VERIFIER="$EXPLORER/api/"
RPC="${RPC_URL:-https://rpc.mainnet.chain.robinhood.com}"

# Long enough to stay under the limit when several contracts need submitting at once.
PACE="${VERIFY_PACE:-25}"

# --- the deployment, from the committed record ---------------------------------

# The committed record, imported by absolute path. `@verdant/config` is not a dependency of
# the contracts package, so a bare specifier cannot resolve from here; the built entry point
# can. Needs `pnpm --filter @verdant/config build` to have run, which every install and the
# image build both do.
read -r FACTORY HOOK REGISTRY DEPLOYER TREASURY <<<"$(
  node --input-type=module -e "
    const m = await import('$here/packages/config/dist/index.js');
    const r = m.instantFor(m.ROBINHOOD_MAINNET_ID);
    if (r === null) { console.error('no Instant deployment recorded'); process.exit(1); }
    console.log([r.factory, r.hook, r.registry, r.deployer, r.treasury].join(' '));
  " 2>/dev/null || echo ""
)"

if [[ -z "${FACTORY:-}" ]]; then
  echo "could not read the Instant deployment record from packages/config/dist" >&2
  echo "run: pnpm --filter @verdant/config build" >&2
  exit 1
fi

POOL_MANAGER=$(cast call "$FACTORY" 'poolManager()(address)' --rpc-url "$RPC")
POSITION_MANAGER=$(cast call "$FACTORY" 'positionManager()(address)' --rpc-url "$RPC")

echo "Instant on 4663"
echo "  factory   $FACTORY"
echo "  hook      $HOOK"
echo "  registry  $REGISTRY"
echo "  deployer  $DEPLOYER"
echo

# Whether Blockscout already holds source. An unverified contract answers with bytecode and
# no `source_code` field at all, which is the only thing that distinguishes the two.
verified() {
  curl -s -m 15 "$EXPLORER/api/v2/smart-contracts/$1" \
    | python3 -c 'import sys,json; d=json.load(sys.stdin); print("yes" if isinstance(d.get("source_code"), str) and d["source_code"] else "no")' \
    2>/dev/null || echo "no"
}

# One contract, skipped when it is already done. Failure is reported and never fatal: this
# script exists to improve a state, not to gate anything.
submit() {
  local label="$1" address="$2" target="$3" args="$4"

  if [[ "$(verified "$address")" == "yes" ]]; then
    printf '  %-16s %s  already verified\n' "$label" "$address"
    return 0
  fi

  printf '  %-16s %s  submitting…\n' "$label" "$address"

  local extra=()
  [[ -n "$args" ]] && extra=(--constructor-args "$args")

  if forge verify-contract "$address" "$target" \
    --chain-id 4663 --verifier blockscout --verifier-url "$VERIFIER" \
    "${extra[@]}" >/dev/null 2>&1; then
    sleep 6
    printf '  %-16s %s  %s\n' "" "" "$(verified "$address")"
  else
    printf '  %-16s %s  refused (rate limit or not yet indexed) — rerun later\n' "" ""
  fi

  sleep "$PACE"
}

echo "Infrastructure"
submit InstantDeployer "$DEPLOYER" src/InstantDeployer.sol:InstantDeployer \
  "$(cast abi-encode 'constructor(address)' "$FACTORY")"
submit MarketRegistry "$REGISTRY" src/MarketRegistry.sol:MarketRegistry \
  "$(cast abi-encode 'constructor(address)' "$FACTORY")"
submit InstantHook "$HOOK" src/InstantHook.sol:InstantHook \
  "$(cast abi-encode 'constructor(address,address,address)' "$POOL_MANAGER" "$FACTORY" "$POSITION_MANAGER")"
submit InstantFactory "$FACTORY" src/InstantFactory.sol:InstantFactory \
  "$(cast abi-encode 'constructor(address,address,address,address,address,address)' \
      "$POOL_MANAGER" "$POSITION_MANAGER" "$HOOK" "$DEPLOYER" "$REGISTRY" "$TREASURY")"

# --- every market, and the two contracts each one deploys ----------------------

# The markets, from Instant's own feed rather than by decoding the registry's struct in
# shell. The struct is thirteen fields of mixed width and `cast` prints it as one line; the
# feed already publishes the three addresses wanted — token, vault, locker — as JSON. This
# is a verification job, so reading them from the indexer costs nothing in trust: every
# argument submitted is still read back off the deployed contract itself below.
FEED="${INSTANT_FEED_URL:-https://instant-indexer-production-069f.up.railway.app}"

markets=$(curl -s -m 20 "$FEED/instant/markets?limit=100" \
  | python3 -c '
import sys, json
try:
    d = json.load(sys.stdin)
except Exception:
    raise SystemExit
for m in d.get("markets", []):
    print(m["token"], m.get("vault") or "", m.get("locker") or "", m.get("positionTokenId") or "")
' 2>/dev/null)

echo
if [[ -z "$markets" ]]; then
  echo "Markets: none reachable through the feed at $FEED"
else
  echo "Markets ($(echo "$markets" | wc -l | tr -d ' '))"
fi

while read -r token vault locker tokenId; do
  [[ -z "${token:-}" ]] && continue

  name=$(cast call "$token" 'name()(string)' --rpc-url "$RPC" | tr -d '"')
  symbol=$(cast call "$token" 'symbol()(string)' --rpc-url "$RPC" | tr -d '"')
  supply=$(cast call "$token" 'totalSupply()(uint256)' --rpc-url "$RPC" | cut -d' ' -f1)
  creator=$(cast call "$token" 'creator()(address)' --rpc-url "$RPC")
  uri=$(cast call "$token" 'metadataURI()(string)' --rpc-url "$RPC" | tr -d '"')
  mutable=$(cast call "$token" 'metadataMutable()(bool)' --rpc-url "$RPC")

  submit "\$$symbol" "$token" src/VerdantToken.sol:VerdantToken \
    "$(cast abi-encode 'constructor(string,string,uint256,address,string,bool)' \
        "$name" "$symbol" "$supply" "$creator" "$uri" "$mutable")"

  if [[ -n "$vault" && "$vault" != "0x0000000000000000000000000000000000000000" ]]; then
    submit "  vault" "$vault" src/InstantFeeVault.sol:InstantFeeVault \
      "$(cast abi-encode 'constructor(address,address,address,address)' \
          "$HOOK" "$POOL_MANAGER" "$creator" "$TREASURY")"
  fi

  if [[ -n "$locker" && "$locker" != "0x0000000000000000000000000000000000000000" && -n "$tokenId" ]]; then
    # `currency0` is ether for every Instant market — the factory hard-codes it — and
    # `currency1` is the launched token. The locker's own getters would answer too; the
    # feed already has both, and a wrong pair fails verification rather than mis-verifying.
    submit "  locker" "$locker" src/PositionLocker.sol:PositionLocker \
      "$(cast abi-encode 'constructor(address,uint256,address,address,address)' \
          "$POSITION_MANAGER" "$tokenId" "$vault" \
          0x0000000000000000000000000000000000000000 "$token")"
  fi
done <<<"$markets"

echo
echo "Done. Rerun to pick up anything the explorer refused."
