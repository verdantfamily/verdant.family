#!/usr/bin/env bash
#
# EIP-170 headroom, for the contracts Verdant actually deploys.
#
# `forge build --sizes` measures everything it compiled, which includes the
# vendored Uniswap tree. `PoolManager` and `PositionManager` are both over 24 576
# bytes under our optimizer settings — Uniswap builds and deploys them with their
# own, and we never deploy either — so the bare flag fails on somebody else's
# contracts and tells us nothing about ours.
#
# This checks the concrete contracts declared under src/ and nothing else. A
# Verdant contract that grows past the limit is undeployable, which is worth
# failing a build over; a vendored one that is already deployed on chain is not.
#
# Usage: bash scripts/check-sizes.sh

set -euo pipefail

cd "$(dirname "$0")/../packages/contracts"

if ! command -v jq >/dev/null 2>&1; then
  echo "check-sizes: jq is required" >&2
  exit 1
fi

# Concrete contracts only. An interface or an abstract contract is never
# deployed on its own and has no size to bust.
#
# Read into a plain string rather than with `mapfile`, which needs bash 4 and so
# would not run on a stock macOS shell.
OURS="$(
  grep -rhoE '^[[:space:]]*(contract|library)[[:space:]]+[A-Za-z0-9_]+' src \
    | awk '{print $2}' \
    | sort -u
)"

if [ -z "$OURS" ]; then
  echo "check-sizes: found no contracts under src/, which cannot be right" >&2
  exit 1
fi

# --sizes exits non-zero when anything it compiled is over the limit, including
# the vendored contracts this script exists to ignore. The preceding build step
# is what establishes that compilation succeeded.
SIZES="$(forge build --sizes --json 2>/dev/null || true)"

if [ -z "$SIZES" ] || ! echo "$SIZES" | jq empty >/dev/null 2>&1; then
  echo "check-sizes: forge produced no size report" >&2
  exit 1
fi

LIMIT=24576
failed=0
checked=0

printf '%-24s %10s %10s\n' "contract" "runtime" "headroom"

for name in $OURS; do
  size="$(echo "$SIZES" | jq -r --arg n "$name" '.[$n].runtime_size // empty')"
  [ -z "$size" ] && continue

  checked=$((checked + 1))
  headroom=$((LIMIT - size))

  if [ "$headroom" -lt 0 ]; then
    printf '%-24s %10s %10s  OVER EIP-170\n' "$name" "$size" "$headroom"
    failed=$((failed + 1))
  else
    printf '%-24s %10s %10s\n' "$name" "$size" "$headroom"
  fi
done

echo
if [ "$failed" -gt 0 ]; then
  echo "$failed Verdant contract(s) exceed the 24 576 byte runtime limit and cannot be deployed."
  exit 1
fi

echo "$checked Verdant contracts, all within EIP-170."
