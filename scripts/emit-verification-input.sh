#!/usr/bin/env bash
#
# Regenerate the Standard JSON Input that Instant token verification submits.
#
# Every Instant launch deploys the same contract, so the compiler input is a constant of
# the deployment and is committed rather than rebuilt per launch. See
# packages/contracts/verification/README.md for why.
#
# Run this only when `VerdantToken` or the compiler settings change, and only alongside a
# new deployment: verifying a token against an input it was not compiled with produces no
# match, which is the right failure and a confusing one to debug.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
contracts="$here/packages/contracts"
out="$contracts/verification/VerdantToken.standard.json"

cd "$contracts"

# The address is irrelevant: `--show-standard-json-input` prints the compiler input and
# sends nothing. A placeholder keeps the argument list valid without naming a real token.
forge verify-contract 0x0000000000000000000000000000000000000001 \
  src/VerdantToken.sol:VerdantToken \
  --chain-id 4663 \
  --show-standard-json-input > "$out.tmp"

# Checked before it replaces the committed file, because an empty or truncated input would
# fail verification at launch time rather than here.
python3 - "$out.tmp" <<'PY'
import json, sys

path = sys.argv[1]
with open(path) as handle:
    document = json.load(handle)

settings = document["settings"]
optimizer = settings["optimizer"]

expected = {
    "language": document.get("language") == "Solidity",
    "optimizer enabled": optimizer.get("enabled") is True,
    "optimizer runs 1000000": optimizer.get("runs") == 1_000_000,
    "evmVersion cancun": settings.get("evmVersion") == "cancun",
    "bytecodeHash ipfs": settings.get("metadata", {}).get("bytecodeHash") == "ipfs",
    "token source present": "src/VerdantToken.sol" in document["sources"],
    "sources self-contained": all("content" in entry for entry in document["sources"].values()),
}

wrong = [name for name, ok in expected.items() if not ok]
if wrong:
    raise SystemExit("verification input is wrong: " + ", ".join(wrong))

print(f"ok: {len(document['sources'])} sources, settings match foundry.toml")
PY

mv "$out.tmp" "$out"
echo "wrote $out"
