#!/usr/bin/env bash
#
# Fails if Foundry would run fewer test suites than the tree contains.
#
# This exists because it happened. `forge fmt` rewrote two test files, and on the next
# `forge test` one whole suite — seven differential assertions holding the SDK's agent id,
# market commitment and quote hash to the Solidity — silently stopped being discovered.
# Its artefact was still in `out/`, the file was still on disk, `--match-contract` on its
# name reported "no tests found in project", and the run reported 39 suites and 620 passing
# tests in green. `forge clean` brought it back at 40 and 627.
#
# That is the worst failure a test suite can have. A failing assertion is information; an
# assertion that quietly stops running looks exactly like an assertion that passes, and
# the number it moves is a total nobody reads closely. Seven vector tests over hashing
# code that decides an agent's identity were not running, and every gate was green.
#
# So: count the test contracts in the tree, ask Foundry what it would run, and require
# the two to agree. `forge test --list` executes nothing, so this costs a compile that
# has usually already happened.
#
# Fork suites are excluded from both sides. They are excluded from the default profile by
# `no_match_path`, so Foundry not listing them is correct rather than a discrepancy.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT/packages/contracts"

# --- what the tree contains -----------------------------------------------
#
# A test suite is a contract in a `*.t.sol` file that inherits something. Helper
# contracts inside a test file (mocks, handlers, reentrancy attackers) are the reason
# this greps for the declaration in a `.t.sol` and then filters to the ones Foundry
# itself lists as suites — the count that matters is "did anything disappear", so the
# comparison is by name, not by number.

declared="$(mktemp)"
listed="$(mktemp)"
trap 'rm -f "$declared" "$listed"' EXIT

# `-h` suppresses filenames, so the stream is declarations only. Interfaces, libraries
# and abstract contracts cannot be test suites and are excluded by matching `contract`
# at the start of a line.
grep -rh --include='*.t.sol' '^contract [A-Za-z0-9_]*Test' test |
  sed -E 's/^contract ([A-Za-z0-9_]*Test).*/\1/' |
  sort -u >"$declared"

# Fork suites, removed from the declared side so that both sides describe the default
# profile. Grepping them out by name rather than by path because a suite is compared by
# name throughout.
grep -rh --include='*.t.sol' '^contract [A-Za-z0-9_]*Test' test/fork |
  sed -E 's/^contract ([A-Za-z0-9_]*Test).*/\1/' |
  sort -u >"$listed"

comm -23 "$declared" "$listed" >"$declared.default"
mv "$declared.default" "$declared"

# --- what Foundry would run -----------------------------------------------

forge test --list --json |
  python3 -c '
import json, sys

# {path: {contract: [test names]}}. Contract names are the second level, and a suite
# listed with zero tests is as good as absent, so those are dropped here rather than
# silently counted.
tree = json.load(sys.stdin)
for suites in tree.values():
    for name, tests in suites.items():
        if tests:
            print(name)
' | sort -u >"$listed"

# --- the comparison -------------------------------------------------------

missing="$(comm -23 "$declared" "$listed")"

if [[ -n "$missing" ]]; then
  echo "these test suites exist in test/ and Foundry would not run them:" >&2
  echo "$missing" | sed 's/^/  /' >&2
  echo >&2
  echo "if the file is on disk and reads correctly, the build cache is stale:" >&2
  echo "  cd packages/contracts && forge clean && forge test" >&2
  echo "a suite that stops being discovered passes silently, which is why this is a gate." >&2
  exit 1
fi

count="$(wc -l <"$listed" | tr -d ' ')"
echo "test discovery: all $count test suites in test/ are runnable"
