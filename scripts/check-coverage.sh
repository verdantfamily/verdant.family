#!/usr/bin/env bash
#
# Enforces the per-file coverage floor for packages/contracts.
#
# `forge coverage` has no threshold flag, so without this the acceptance bar is
# a number in a plan document that nobody re-checks. A contract added later with
# no tests would report 0% and CI would stay green.
#
# The floor is per file rather than on the total, because a total hides exactly
# the case worth catching: one well-tested library carrying an untested contract.
#
# Excludes mirror packages/contracts/package.json's `coverage` script:
#   vendor/, test/  — not our code, and tests are not the subject
#   ScheduleLibGasTest — coverage builds without the optimiser, which inflates
#                        gas past the budgets that suite asserts
set -euo pipefail

FLOOR="${COVERAGE_FLOOR:-95}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "$ROOT/packages/contracts"

report="$(
  forge coverage \
    --no-match-coverage "(vendor|test)" \
    --no-match-contract ScheduleLibGasTest \
    --report summary
)"

echo "$report"

echo "$report" | awk -F'|' -v floor="$FLOOR" '
  # Rows for our own sources look like:
  # | src/VerdantToken.sol | 100.00% (14/14) | ... |
  $2 ~ /^ *src\// {
    file = $2
    gsub(/^ +| +$/, "", file)

    for (column = 3; column <= 6; column++) {
      percent = $column + 0            # leading numeric prefix, so "92.39% (..)" -> 92.39
      if (percent < floor) {
        printf "coverage below %s%%: %s at %.2f%% (column %d)\n", floor, file, percent, column - 2
        failed = 1
      }
    }
    seen = 1
  }

  END {
    if (!seen) {
      print "no src/ rows in the coverage report — the report format changed"
      exit 1
    }
    if (failed) exit 1
    printf "every source file is at or above %s%% on lines, statements, branches and functions\n", floor
  }
'
