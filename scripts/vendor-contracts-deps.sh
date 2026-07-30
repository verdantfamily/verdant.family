#!/usr/bin/env bash
#
# Vendor the Solidity dependencies at commits pinned to the bytecode actually
# deployed on Robinhood Chain 4663.
#
# Why tarballs and not git submodules: the pins below are exact and must not
# drift, and a submodule tree invites an accidental `git submodule update
# --remote`. Fetching immutable commit tarballs makes the dependency graph a
# declaration in this file rather than state in .gitmodules.
#
# Why these particular commits: the Blockscout-verified source of the deployed
# PositionManager on 4663 is byte-for-byte identical to v4-periphery
# @ 3c31961fb9. Everything below is that commit's own submodule set.
# Current v4-periphery `main` is NOT equivalent — it adds a ModifyPosition event
# and `virtual` modifiers the deployed contract does not have. See
# docs/verification.md.
#
# Usage: pnpm contracts:deps

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Deliberately NOT `lib/`. Foundry treats plain directories under `lib/` as
# uninitialised git submodules and tries to install them on every build, which
# both prints spurious errors and reaches for the network in CI. `vendor/` with
# `libs = ["vendor"]` in foundry.toml avoids that entirely.
LIB="$REPO_ROOT/packages/contracts/vendor"

# --- pins -------------------------------------------------------------------
V4_PERIPHERY="3c31961fb9"                                   # deployed match
V4_CORE="59d3ecf53afa"                                      # periphery submodule
PERMIT2="cc56ad0f3439"                                      # periphery submodule
SOLMATE="4b47a19038b798b4a33d9749d25e570443520647"          # v4-core submodule
OPENZEPPELIN="dbb6104ce834628e473d2173bbc9d47f81a9eec3"      # v4-core submodule
FORGE_STD="v1.16.2"                                         # ours, for tests only

fetch() {
  local repo="$1" ref="$2" dest="$3"
  if [ -d "$dest" ] && [ -f "$dest/.vendored-ref" ] && [ "$(cat "$dest/.vendored-ref")" = "$ref" ]; then
    printf '  = %-52s %s (cached)\n' "$repo" "$ref"
    return 0
  fi
  printf '  + %-52s %s\n' "$repo" "$ref"
  rm -rf "$dest"
  mkdir -p "$dest"
  # Dependency dotfile directories are excluded: we vendor source, not the
  # upstream project's editor and CI configuration.
  # Excluded: upstream editor/CI config, audit PDFs (5.3 MB in v4-periphery
  # alone) and broadcast logs. We vendor source that the compiler reads.
  curl -fsSL --max-time 180 "https://codeload.github.com/$repo/tar.gz/$ref" \
    | tar -xz -C "$dest" --strip-components=1 \
        --exclude='.git' --exclude='.github' --exclude='.vscode' \
        --exclude='.gitmodules' --exclude='.gitattributes' \
        --exclude='audits' --exclude='broadcast' --exclude='docs'
  printf '%s' "$ref" > "$dest/.vendored-ref"
}

echo "Vendoring Solidity dependencies into packages/contracts/vendor"
fetch "foundry-rs/forge-std"            "$FORGE_STD"    "$LIB/forge-std"
fetch "Uniswap/v4-periphery"            "$V4_PERIPHERY" "$LIB/v4-periphery"
fetch "Uniswap/v4-core"                 "$V4_CORE"      "$LIB/v4-periphery/lib/v4-core"
fetch "Uniswap/permit2"                 "$PERMIT2"      "$LIB/v4-periphery/lib/permit2"
fetch "transmissions11/solmate"         "$SOLMATE"      "$LIB/v4-periphery/lib/v4-core/lib/solmate"
fetch "OpenZeppelin/openzeppelin-contracts" "$OPENZEPPELIN" "$LIB/v4-periphery/lib/v4-core/lib/openzeppelin-contracts"

echo "Done. Remappings in packages/contracts/remappings.txt resolve against these paths."
