#!/usr/bin/env bash
#
# Runs `forge lint` over our own Solidity and fails if anything is reported.
#
# `forge lint` exits 0 even when it emits warnings, so a warning would otherwise
# scroll past in a green build. The findings it produces are the ones that matter
# for this codebase — silent truncation in a bit-packed encoding, and shift
# operands in the wrong order — so they are treated as errors.
#
# Where a finding is a false positive it is suppressed on the line with
# `// forge-lint: disable-next-line(<rule>) -- <reason>`, never by turning the
# rule off globally: a rule disabled in config stays disabled for code nobody has
# written yet.
#
# vendor/ is excluded by passing our own paths rather than by ignoring theirs.
# script/ is included: a deployment script is the one file whose truncation bug
# nobody catches in review, because it is read once and run once.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT/packages/contracts"

log="$(mktemp)"
trap 'rm -f "$log"' EXIT

forge lint src test script 2>&1 | tee "$log"

if grep -q '^warning\[' "$log"; then
  count="$(grep -c '^warning\[' "$log")"
  echo "forge lint reported $count warning(s); fix them or suppress with a justification" >&2
  exit 1
fi

echo "forge lint: no findings in src/, test/ or script/"
