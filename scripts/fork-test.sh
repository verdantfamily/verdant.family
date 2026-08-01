#!/usr/bin/env bash
# Runs the fork suite and reports one of three outcomes, because they call for three
# different responses:
#
#   1. tests ran and something failed -> this commit is broken against the real
#      chain. Fails.
#   2. the RPC could not be reached -> nothing was learned either way. Warns and
#      passes: blocking merges on somebody else's endpoint being up makes red marks
#      routine, which is how a gate stops being read.
#   3. no tests ran at all -> fails, loudly. `forge test` exits 0 when it matches
#      nothing, so without this check a suite that silently ran zero tests would be
#      the greenest job in the pipeline.
#
# Outcome 3 is not hypothetical. The default profile excludes `test/fork`, so an
# ordinary `forge test` can leave a cache in which the fork profile finds no tests at
# all. A forced rebuild clears it, so this attempts that once rather than telling a
# human to.
set -uo pipefail

# The profile is set here rather than left to the caller. This script exists only to
# run the fork suite, and without the profile `forge test` quietly runs the *default*
# suite instead — 352 passing tests that say nothing about the deployed chain, which
# is a worse outcome than an error because it looks like success.
export FOUNDRY_PROFILE=fork

# Runnable from anywhere; forge needs the package as its working directory.
cd "$(dirname "${BASH_SOURCE[0]}")/../packages/contracts" || exit 1

readonly RPC_TROUBLE='could not instantiate forked environment|error sending request|failed to get latest block|connection (refused|closed|reset)|tunnel error|dns error|operation timed out|429 Too Many Requests|50[23] '

# Bash's own matching rather than `printf | grep -q`. That pipeline is wrong under
# `pipefail`: grep exits at the first match, printf is still writing, printf dies of
# SIGPIPE with status 141, and pipefail promotes that to the pipeline's status — so a
# successful match reads as a failure. It only shows up when the output is long enough
# for printf to still be going, which is every real forge run and no small test
# fixture. It reported "the fork suite ran no tests" over a 352-test run.
ran_nothing() {
  [[ $1 != *"Suite result:"* ]]
}

# Herestrings below, for the same reason: a redirect is not a pipeline, so `grep -q`
# leaving early cannot poison the status.
has_rpc_trouble() {
  grep -qiE "$RPC_TROUBLE" <<<"$1"
}

output=$(forge test -vv 2>&1)
status=$?

if ran_nothing "$output"; then
  echo "$output"
  echo "::warning::the fork suite matched no tests; rebuilding from scratch and retrying once"

  if ! forge build --force; then
    echo "::error::the rebuild failed, so the fork suite could not be run"
    exit 1
  fi

  output=$(forge test -vv 2>&1)
  status=$?
fi

echo "$output"

if ran_nothing "$output"; then
  echo "::error::the fork suite ran no tests. forge exits 0 in that case, so this is a failure rather than a pass."
  exit 1
fi

if [ "$status" -eq 0 ]; then
  exit 0
fi

# A broken commit and a broken endpoint cannot be told apart by exit code, which is 1
# either way. Nor by the mere presence of a `[FAIL` line: forge reports an unreachable
# RPC *as* a failing test, because `createSelectFork` runs inside `setUp`. So every
# failure line is classified, and the run is tolerated only when all of them are
# connectivity.
failures=$(grep -E '^\[FAIL' <<<"$output" || true)
total=$(grep -c '^\[FAIL' <<<"$failures" || true)
connectivity=$(grep -icE "$RPC_TROUBLE" <<<"$failures" || true)

if [ "$total" -gt 0 ] && [ "$total" -eq "$connectivity" ]; then
  echo "::warning::the 4663 RPC was unreachable, so the fork suite proved nothing. Not failing the build."
  exit 0
fi

if [ "$total" -eq 0 ] && has_rpc_trouble "$output"; then
  echo "::warning::the 4663 RPC was unreachable before any test ran. Not failing the build."
  exit 0
fi

echo "::error::the fork suite failed against the deployed Uniswap on 4663 ($connectivity of $total failures were connectivity)"
exit "$status"
