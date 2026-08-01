#!/usr/bin/env bash
# Exercises scripts/fork-test.sh's classifier against canned forge output.
#
# The classifier decides whether a red fork run blocks a merge, and it got that
# decision wrong the first time it was written: forge reports an unreachable RPC
# *as* a failing test, because `vm.createSelectFork` runs inside `setUp`, so a
# check for the presence of a `[FAIL` line classified the one case the script
# exists to tolerate as a genuine failure. It was caught by running it. This file
# is that run, kept.
#
# Needs no network and no chain: a stub `forge` on PATH prints canned output.
set -u
mkdir -p /tmp/forkstub
run_case() {
  local name="$1" body="$2" expected="$3" exit_code="${4:-1}"
  { echo '#!/usr/bin/env bash'; printf '%s\n' "$body"; echo "exit $exit_code"; } > /tmp/forkstub/forge
  chmod +x /tmp/forkstub/forge
  PATH=/tmp/forkstub:$PATH bash "$(dirname "${BASH_SOURCE[0]}")/fork-test.sh" >/dev/null 2>&1
  local got=$?
  if [ "$got" = "$expected" ]; then
    echo "ok   $name (exit $got)"
  else
    echo "FAIL $name: expected $expected, got $got"
    failed=1
  fi
}

failed=0

run_case "assertion failure blocks" \
  'echo "[FAIL: quote mismatch: 991 != 998] test_x() (gas: 100)"
echo "Suite result: FAILED. 4 passed; 1 failed; 0 skipped"' 1

run_case "connectivity alone is tolerated" \
  'echo "[FAIL: vm.createSelectFork: could not instantiate forked environment] setUp() (gas: 0)"
echo "Suite result: FAILED. 0 passed; 1 failed; 0 skipped"' 0

run_case "connectivity plus a real failure blocks" \
  'echo "[FAIL: quote mismatch: 991 != 998] test_x() (gas: 100)"
echo "[FAIL: vm.createSelectFork: could not instantiate forked environment] setUp() (gas: 0)"
echo "Suite result: FAILED. 0 passed; 2 failed; 0 skipped"' 1

run_case "rate limit is tolerated" \
  'echo "[FAIL: backend error: 429 Too Many Requests] setUp() (gas: 0)"
echo "Suite result: FAILED. 0 passed; 1 failed; 0 skipped"' 0

run_case "a clean run passes" \
  'echo "[PASS] test_x() (gas: 100)"
echo "Suite result: ok. 5 passed; 0 failed; 0 skipped"' 0 0

run_case "failure with no test lines at all blocks" \
  'echo "Error: compilation failed"
echo "Suite result: FAILED. 0 passed; 0 failed; 0 skipped"' 1

run_case "an RPC failure before any test runs is tolerated" \
  'echo "Error: error sending request for url (https://rpc.mainnet.chain.robinhood.com/)"
echo "Suite result: FAILED. 0 passed; 0 failed; 0 skipped"' 0

# The case that mattered most, and the one the script did not have: forge exits 0
# when it matches nothing, so a suite that ran zero tests looked like a pass. The
# stub prints no `Suite result:` line however often it is called, which is also the
# retry-after-rebuild path.
run_case "a run that executed no tests fails despite forge exiting 0" \
  'echo "No tests found in project! Forge looks for functions that start with \`test\`"' 1 0


# The bug this file existed for and still missed: the classifier used
# `printf | grep -q`, which under `pipefail` turns a successful match into a failure
# once the output is long enough that printf is still writing when grep exits. Every
# fixture above is a few lines long, so every one of them passed while the real
# 352-test output was misreported as "ran no tests". The padding is the test.
run_case "a long run with the match early is not misread as empty" \
  'echo "Suite result: ok. 5 passed; 0 failed; 0 skipped"
for i in $(seq 1 20000); do echo "[PASS] test_padding_$i() (gas: 100)"; done' 0 0

run_case "a long failing run is still classified on its failure lines" \
  'echo "[FAIL: quote mismatch: 991 != 998] test_x() (gas: 100)"
echo "Suite result: FAILED. 4 passed; 1 failed; 0 skipped"
for i in $(seq 1 20000); do echo "[PASS] test_padding_$i() (gas: 100)"; done' 1

# The other half of the same incident: the script ran without the fork profile and
# quietly exercised the default suite instead. It sets the profile itself now, and a
# stub that reports what it was given is the only way to know that stays true.
{
  echo '#!/usr/bin/env bash'
  echo 'echo "${FOUNDRY_PROFILE:-unset}" > /tmp/forkstub/profile-seen'
  echo 'echo "Suite result: ok. 5 passed"'
  echo 'exit 0'
} > /tmp/forkstub/forge
chmod +x /tmp/forkstub/forge
PATH=/tmp/forkstub:$PATH bash "$(dirname "${BASH_SOURCE[0]}")/fork-test.sh" >/dev/null 2>&1
seen=$(cat /tmp/forkstub/profile-seen 2>/dev/null || echo missing)
if [ "$seen" = "fork" ]; then
  echo "ok   the script runs forge under the fork profile (saw '$seen')"
else
  echo "FAIL the script ran forge under profile '$seen', not 'fork'"
  failed=1
fi

rm -rf /tmp/forkstub
exit "$failed"
