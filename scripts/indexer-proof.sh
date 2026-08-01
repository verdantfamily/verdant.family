#!/usr/bin/env bash
#
# Proves the market feed end to end, on this machine, with no network.
#
# What it does, in order: starts anvil, deploys a Uniswap v4 onto it, puts Uniswap's
# quoter and Permit2 at the addresses the interface is configured with, deploys
# Verdant, launches four markets from Solidity and two more *through the SDK*, trades
# them, warps past a fee transition and trades again, collects and claims the fees,
# runs the indexer against the whole history, and then asks the contracts the same
# questions the indexer just answered and requires the same answers.
#
# ## The two markets the SDK launches
#
# Four of the six come from `Seed.s.sol`, which creates them in Solidity — so they
# prove the contracts and the indexer and say nothing whatever about the calldata
# `packages/sdk` produces. Until `apps/web/scripts/assert-sdk-launch.ts` was added,
# no create transaction built by the SDK had ever been broadcast anywhere, on any
# chain. A launch is irreversible and its wiring is immutable, so the first one should
# not have been on mainnet. It is the fifth and sixth markets here instead.
#
# Three of those four markets are quoted in ether and the fourth in a tokenized
# equity that the seed deploys for the purpose. Robinhood Chain's own equities live
# on 4663 and nowhere else, so a local node has nothing a stock-paired market could
# be quoted in — and without one, every assertion here would pass just as happily on
# an indexer that still assumed currency0 is always ether.
#
# ## Why local rather than a fork of 4663
#
# A fork would use the real Uniswap bytecode, which is a genuinely better test of
# Uniswap — and the fork suite already does exactly that. What this proves is
# different: that the indexer, the SDK and Verdant's own contracts agree. That does
# not depend on which build of v4 is underneath, and making it depend on a remote RPC
# would make a green run depend on somebody else's uptime. The fork gate had to be
# made warn-only for precisely that reason, and a proof that can be skipped is not a
# proof.
#
# The cost of running locally: this repository compiles PoolManager and
# PositionManager over EIP-170, because foundry.toml optimises for runtime gas rather
# than size. Hence --disable-code-size-limit. The contracts deployed on 4663 are
# Uniswap's own smaller build (V1 in docs/verification.md).
#
# Usage: bash scripts/indexer-proof.sh
#        VERDANT_KEEP=1 bash scripts/indexer-proof.sh   # leave it running
# Requires: anvil, forge, node, pnpm. No RPC, no Postgres, no keys.
#
# With VERDANT_KEEP set, the chain and the indexer stay up after the assertions pass
# and the script prints what the interface needs to talk to them. That makes the
# development environment the *proven* one: the app is developed against a stack that
# has just demonstrated its numbers agree with the contracts, rather than against a
# separate rig that drifts from this one.

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
ROOT="$PWD"

# Not 8545. That is where a developer's own anvil lives, and a rig that quietly
# attached to it would deploy a Uniswap into someone's working session and then make
# assertions about a chain it does not control. The check below refuses to run against
# a node it did not start, which is what catches the case where this port is busy too.
ANVIL_PORT="${ANVIL_PORT:-8555}"
PONDER_PORT="${PONDER_PORT:-42069}"
RPC="http://127.0.0.1:${ANVIL_PORT}"
API="http://127.0.0.1:${PONDER_PORT}"

# anvil's first account. A well-known key on a throwaway local node, which is why it
# is written here rather than read from the environment: making this configurable
# would invite someone to point it at a funded key on a real chain.
OPERATOR_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
OPERATOR=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266

# anvil's second account, used as the treasury. It has to be a different account from
# the one that creates the markets: FeeSplitter rejects a market whose creator is also
# the treasury, because a splitter with one recipient wearing both hats has a split
# that means nothing. The rig would rather satisfy that rule than route around it.
TREASURY_ADDRESS=0x70997970C51812dc3A010C7d01b50e0d17dc79C8

# The chain id matters: the indexer's config is written for 4663, and a mismatch
# would have it index a chain that is not the one it is talking to.
CHAIN_ID=4663

LOGS="$ROOT/.proof"
mkdir -p "$LOGS"

anvil_pid=""
ponder_pid=""

# Both background processes are started under job control (`set -m`) so each leads its
# own process group, and both are stopped by signalling the group rather than the pid.
#
# The pid alone is not enough, and this is not theoretical: `pnpm ponder start` is a
# node process that spawns another, so killing what bash backgrounded left the real
# indexer running. The next run then found port 42069 already served — by an indexer
# pointed at the *previous* run's chain, which had just been shut down. The readiness
# poll was satisfied by that stale server and the run took eight minutes to fail with
# a connection error to a port this script had never heard of.
stop_group() {
  local pid="$1"
  [ -z "$pid" ] && return 0
  kill -- "-$pid" 2>/dev/null || kill "$pid" 2>/dev/null || true
}

# True when something already answers on a port. Bash's own /dev/tcp, so this needs no
# lsof or nc — both are absent or differently flagged somewhere this has to run.
port_in_use() {
  (exec 3<>"/dev/tcp/127.0.0.1/$1") >/dev/null 2>&1
}

cleanup() {
  local status=$?
  stop_group "$ponder_pid"
  stop_group "$anvil_pid"
  if [ "$status" -ne 0 ]; then
    echo
    echo "the proof failed. Logs are in $LOGS:"
    echo "  anvil:   $LOGS/anvil.log"
    echo "  indexer: $LOGS/ponder.log"
  fi
  exit "$status"
}
trap cleanup EXIT INT TERM

step() { echo; echo "=== $* ==="; }

# Reads an address that a forge script printed, e.g. "VerdantHook     0xabc...".
# Matching the label rather than a position, so a change to the script's output
# format fails here loudly instead of picking up the wrong address.
address_from() {
  local file="$1" label="$2" found
  found=$(grep -oE "${label}[[:space:]]+0x[0-9a-fA-F]{40}" "$file" | tail -1 | grep -oE '0x[0-9a-fA-F]{40}' || true)
  if [ -z "$found" ]; then
    echo "could not find '${label}' in ${file}" >&2
    return 1
  fi
  printf '%s' "$found"
}

# Checked together, and before anything is built or deployed: a busy indexer port
# discovered twenty seconds in would waste a deployment, and — worse — an indexer that
# fails to bind leaves whatever is already there answering the readiness poll.
for check in "anvil:${ANVIL_PORT}:ANVIL_PORT" "the indexer:${PONDER_PORT}:PONDER_PORT"; do
  what="${check%%:*}"
  rest="${check#*:}"
  port="${rest%%:*}"
  variable="${rest#*:}"
  if port_in_use "$port"; then
    echo "port ${port} is already in use, and ${what} needs it. Stop it, or set ${variable}." >&2
    exit 1
  fi
done

step "starting anvil on port ${ANVIL_PORT}"
set -m
anvil \
  --port "$ANVIL_PORT" \
  --chain-id "$CHAIN_ID" \
  --disable-code-size-limit \
  --silent \
  >"$LOGS/anvil.log" 2>&1 &
anvil_pid=$!
set +m

for _ in $(seq 1 50); do
  if cast chain-id --rpc-url "$RPC" >/dev/null 2>&1; then break; fi
  sleep 0.2
done
actual_chain=$(cast chain-id --rpc-url "$RPC" 2>/dev/null || true)
if [ "$actual_chain" != "$CHAIN_ID" ]; then
  echo "the node on ${ANVIL_PORT} reports chain ${actual_chain:-none}, not ${CHAIN_ID}." >&2
  echo "Either anvil failed to start, or this is not the node this script started." >&2
  tail -20 "$LOGS/anvil.log" >&2
  exit 1
fi
echo "anvil is up, chain ${actual_chain}"

cd "$ROOT/packages/contracts"

step "building the contracts"
# `forge lint` compiles with a reduced output selection and overwrites artifacts with
# ABI-only versions, and forge's cache does not record that the selection changed — so
# a plain `forge build` afterwards reports "no files changed" and `forge script` fails
# with "Could not find target contract". Same family as the stale-cache trap in
# scripts/fork-test.sh. Detected rather than worked around by always forcing, because
# a full rebuild is ten seconds and knowing which state we were in is worth printing.
forge build >"$LOGS/build-contracts.log" 2>&1 || { cat "$LOGS/build-contracts.log"; exit 1; }
if ! grep -q '"bytecode"' out/LocalUniswap.s.sol/LocalUniswap.json 2>/dev/null; then
  echo "artifacts have no bytecode (a lint run left them ABI-only); rebuilding"
  forge build --force >"$LOGS/build-contracts.log" 2>&1 || { cat "$LOGS/build-contracts.log"; exit 1; }
fi

step "deploying a Uniswap v4"
# --disable-code-size-limit only here, and deliberately not on the Verdant deploy
# below. These two contracts are over EIP-170 in this repository's build; every
# contract Verdant deploys is under it, and that is a property worth keeping enforced
# — if one of ours ever crossed the line, this rig should fail rather than shrug.
forge script script/LocalUniswap.s.sol \
  --rpc-url "$RPC" --private-key "$OPERATOR_KEY" --broadcast \
  --disable-code-size-limit -vv \
  >"$LOGS/uniswap.log" 2>&1 || { cat "$LOGS/uniswap.log"; exit 1; }

POOL_MANAGER=$(address_from "$LOGS/uniswap.log" "POOL_MANAGER")
POSITION_MANAGER=$(address_from "$LOGS/uniswap.log" "POSITION_MANAGER")
SWAP_ROUTER=$(address_from "$LOGS/uniswap.log" "SWAP_ROUTER")
MULTICALL3=$(address_from "$LOGS/uniswap.log" "MULTICALL3")
V4_QUOTER_STAGED=$(address_from "$LOGS/uniswap.log" "V4_QUOTER_STAGED")
export POOL_MANAGER POSITION_MANAGER SWAP_ROUTER
echo "PoolManager     $POOL_MANAGER"
echo "PositionManager $POSITION_MANAGER"

step "building the TypeScript"
# Before the periphery step rather than before the indexer, which is where this used
# to be: the next step asks @verdant/config where the interface looks for Uniswap's
# quoter, and the SDK proof after it drives apps/web's own launch code, which imports
# @verdant/ui. Both need built packages.
pnpm --filter @verdant/config --filter @verdant/sdk --filter @verdant/ui build \
  >"$LOGS/build.log" 2>&1 || { cat "$LOGS/build.log"; exit 1; }

step "putting Uniswap's periphery where the interface looks for it"
# `EXTERNAL_ADDRESSES` in @verdant/config holds Robinhood mainnet's addresses for the
# contracts Verdant does not deploy, and both `apps/web` and the SDK resolve two of
# them **by chain id, with no override**: the trade panel reads `EXTERNAL.quoter`, and
# Permit2 is a module constant in `packages/sdk/src/trade/approve.ts`. This rig runs at
# chain id 4663. So unless those exact addresses answer here, the app's own code path
# cannot be exercised at all — every quote reverts and every allowance reads zero — and
# the rig would be proving a path the interface does not take.
#
# ## Why moving runtime code is sound, and not a trick
#
# Solidity immutables live in the runtime code, not in storage. So a copy of a
# contract's deployed code is still bound to whatever its constructor captured: the
# quoter copied below keeps pointing at the PoolManager *this rig* deployed, which is
# checked immediately afterwards rather than assumed. Both contracts are moved before
# a single byte of their storage is written, so there is no state left behind at the
# staging address and none missing at the canonical one.
#
# Permit2 is not recompiled at all. It pins `pragma solidity 0.8.17` and needs viaIR,
# and this machine has neither that compiler nor a network to fetch it — but the
# permit2 repository vendors its own deployed runtime code for exactly this reason
# (`test/utils/DeployPermit2.sol`, which etches it in Foundry). That is 9 152 bytes,
# which is what V1 in docs/verification.md measured on 4663, so the rig runs the same
# Permit2 the chain does. Its EIP-712 domain separator is recomputed at call time
# whenever the chain id differs from the one baked in at deployment, which on this
# node it does — so the separator below is the correct one for this address on 4663,
# and that is checked rather than hoped for.
#
# The Universal Router gets none of this. Its source is not vendored, no artefact of
# it exists in this repository, and with no network there is no way to fetch either.
# It is left absent deliberately: a stub would let a swap "succeed" against a contract
# this repository wrote. See the end of the SDK proof for what that costs.
external_address() {
  (cd "$ROOT/apps/web" && node --input-type=module -e \
    "import { EXTERNAL_ADDRESSES } from '@verdant/config'; process.stdout.write(EXTERNAL_ADDRESSES['$1']);")
}

V4_QUOTER=$(external_address v4Quoter)
PERMIT2=$(external_address permit2)
UNIVERSAL_ROUTER=$(external_address universalRouter)

cast rpc anvil_setCode "$V4_QUOTER" "$(cast code "$V4_QUOTER_STAGED" --rpc-url "$RPC")" \
  --rpc-url "$RPC" >/dev/null

# One `hex"…"` literal in that file and nothing else that looks like one, so the match
# is unambiguous; `head -1` guards the day somebody adds a second.
PERMIT2_SOURCE="$ROOT/packages/contracts/vendor/v4-periphery/lib/permit2/test/utils/DeployPermit2.sol"
PERMIT2_RUNTIME=$(grep -oE 'hex"[0-9a-f]+"' "$PERMIT2_SOURCE" | head -1 | sed 's/^hex"//; s/"$//')
if [ -z "$PERMIT2_RUNTIME" ]; then
  echo "no precompiled Permit2 bytecode in $PERMIT2_SOURCE" >&2
  exit 1
fi
cast rpc anvil_setCode "$PERMIT2" "0x$PERMIT2_RUNTIME" --rpc-url "$RPC" >/dev/null

# Behaviour, not `code.length > 0`. A wrong copy has code too, and would fail every
# trade rather than failing here.
quoter_bound_to=$(cast call "$V4_QUOTER" "poolManager()(address)" --rpc-url "$RPC")
if [ "$(printf '%s' "$quoter_bound_to" | tr 'A-F' 'a-f')" != "$(printf '%s' "$POOL_MANAGER" | tr 'A-F' 'a-f')" ]; then
  echo "the quoter at $V4_QUOTER answers to PoolManager $quoter_bound_to, not $POOL_MANAGER." >&2
  echo "Its immutable did not survive the move, so a quote here would be about another chain's pools." >&2
  exit 1
fi

permit2_bytes=$(( $(cast code "$PERMIT2" --rpc-url "$RPC" | wc -c | tr -d ' ') / 2 - 1 ))
if [ "$permit2_bytes" -ne 9152 ]; then
  echo "Permit2 at $PERMIT2 is $permit2_bytes bytes; V1 recorded 9 152 on 4663." >&2
  exit 1
fi

# A real `allowance` read, which an address with the wrong code would not answer.
permit2_allowance=$(cast call "$PERMIT2" "allowance(address,address,address)(uint160,uint48,uint48)" \
  "$OPERATOR" "$POOL_MANAGER" "$UNIVERSAL_ROUTER" --rpc-url "$RPC" | tr -d ' \n')
if [ "$permit2_allowance" != "000" ]; then
  echo "Permit2 answered '$permit2_allowance' for a triple that has never been approved;" >&2
  echo "an amount, an expiry and a nonce of zero is the only right answer there." >&2
  exit 1
fi

# And the separator a signature would be checked against, computed here from the
# canonical address and this chain id. Equality is what says the etched code is
# functioning *as the contract at this address* rather than as a copy of one elsewhere.
domain_expected=$(cast keccak "$(cast abi-encode 'f(bytes32,bytes32,uint256,address)' \
  "$(cast keccak "$(cast from-utf8 'EIP712Domain(string name,uint256 chainId,address verifyingContract)')")" \
  "$(cast keccak "$(cast from-utf8 'Permit2')")" "$CHAIN_ID" "$PERMIT2")")
domain_actual=$(cast call "$PERMIT2" "DOMAIN_SEPARATOR()(bytes32)" --rpc-url "$RPC")
if [ "$domain_actual" != "$domain_expected" ]; then
  echo "Permit2's domain separator is $domain_actual, not the $domain_expected this address on chain $CHAIN_ID should give." >&2
  exit 1
fi

echo "V4Quoter        $V4_QUOTER (from $V4_QUOTER_STAGED, still bound to this rig's PoolManager)"
echo "Permit2         $PERMIT2 ($permit2_bytes bytes, the same build 4663 runs)"
echo "UniversalRouter $UNIVERSAL_ROUTER — deliberately absent; see the SDK proof's closing note"

step "deploying Verdant"
# On a real deployment these are Safes decided in advance and checked by
# script/Verify.s.sol. Here they only have to be distinct and non-zero.
export TREASURY="$TREASURY_ADDRESS"
export REGISTRY_OWNER="$OPERATOR"

forge script script/Deploy.s.sol \
  --rpc-url "$RPC" --private-key "$OPERATOR_KEY" --broadcast -vv \
  >"$LOGS/deploy.log" 2>&1 || { cat "$LOGS/deploy.log"; exit 1; }

FACTORY=$(address_from "$LOGS/deploy.log" "VerdantFactory")
HOOK=$(address_from "$LOGS/deploy.log" "VerdantHook")
MARKET_REGISTRY=$(address_from "$LOGS/deploy.log" "MarketRegistry")
MODEL_REGISTRY=$(address_from "$LOGS/deploy.log" "ModelRegistry")
# The account that executes the token's CREATE2, and therefore the address every
# predicted token address is computed from. The SDK mines a salt against it and the
# interface reads its init code hash; getting it from anywhere else would predict
# addresses no launch lands on.
DEPLOYER=$(address_from "$LOGS/deploy.log" "VerdantDeployer")
export FACTORY
echo "VerdantFactory  $FACTORY"
echo "VerdantHook     $HOOK"

# Everything the indexer cares about happens from here on, so this is where it starts
# reading. Taken before the markets exist, deliberately: an indexer that began after
# a creation would miss it, and a start block that is too early only costs time.
START_BLOCK=$(cast block-number --rpc-url "$RPC")
echo "start block     $START_BLOCK"

step "verifying the deployment"
FACTORY="$FACTORY" \
EXPECTED_TREASURY="$TREASURY" \
EXPECTED_REGISTRY_OWNER="$REGISTRY_OWNER" \
POOL_MANAGER="$POOL_MANAGER" \
POSITION_MANAGER="$POSITION_MANAGER" \
  forge script script/Verify.s.sol --rpc-url "$RPC" -vv \
  >"$LOGS/verify.log" 2>&1 || { cat "$LOGS/verify.log"; exit 1; }
echo "the verifier is satisfied with the local deployment"

step "launching four markets, one buy each"
PHASE=create forge script script/Seed.s.sol \
  --rpc-url "$RPC" --private-key "$OPERATOR_KEY" --broadcast -vv \
  >"$LOGS/seed-create.log" 2>&1 || { cat "$LOGS/seed-create.log"; exit 1; }
grep -E '^  (fixed|progressive|vested|stock|equity)' "$LOGS/seed-create.log" || true

# The mock equity the seed deployed, and the launch token of the market quoted in
# it. Read out of the log for the reason every other address here is: the seed
# chooses both at run time — it deploys the equity, and it mines the stock market's
# salt until that token sorts above it — so nothing upstream of this line can
# predict either.
#
# Both are handed to the assertions rather than left for them to discover. Finding
# the stock-paired market by looking for the one the indexer calls equity-quoted
# would take the indexer's word for the thing under test: a feed that had dropped
# the quote asset would report four ether-quoted markets and the search would find
# nothing to disagree with.
EQUITY=$(address_from "$LOGS/seed-create.log" "equity")
STOCK_TOKEN=$(address_from "$LOGS/seed-create.log" "stock")
echo "mock equity     $EQUITY"
echo "stock market    $STOCK_TOKEN"

step "launching two more markets, through @verdant/sdk"
# The point of the whole exercise. Everything above created markets from Solidity;
# this creates two from the same functions `apps/web` calls, in the same order, and
# then asks the chain whether what landed is what the SDK said it was building.
#
# Placed here, between the seed's create and trade phases, deliberately: the seed's
# later phases loop over the *registry*, so these two markets are bought, collected
# and claimed alongside the other four with no special-casing, and the feed
# assertions then hold them to exactly the same standard.
SDK_OUTPUT="$LOGS/sdk-launch.env"
rm -f "$SDK_OUTPUT"
(
  cd "$ROOT" &&
  VERDANT_RPC="$RPC" \
  VERDANT_FACTORY="$FACTORY" \
  VERDANT_HOOK="$HOOK" \
  VERDANT_DEPLOYER="$DEPLOYER" \
  VERDANT_MARKET_REGISTRY="$MARKET_REGISTRY" \
  VERDANT_MULTICALL3="$MULTICALL3" \
  VERDANT_POOL_MANAGER="$POOL_MANAGER" \
  VERDANT_POSITION_MANAGER="$POSITION_MANAGER" \
  VERDANT_SWAP_ROUTER="$SWAP_ROUTER" \
  VERDANT_EQUITY="$EQUITY" \
  VERDANT_SDK_OUTPUT="$SDK_OUTPUT" \
    node apps/web/scripts/assert-sdk-launch.ts
)

# The two tokens and their pool ids, written by that script rather than parsed out of
# its output: a pool id is 32 bytes and `address_from` matches 20, and inventing a
# second parser for the sake of symmetry would be the fragile choice.
if [ ! -f "$SDK_OUTPUT" ]; then
  echo "the SDK proof passed but wrote no addresses to $SDK_OUTPUT" >&2
  exit 1
fi
# shellcheck disable=SC1090
. "$SDK_OUTPUT"

step "warping past the fee transition"
# One hour plus a minute. The two-stage market's second stage begins at 3600 seconds,
# so this puts the next trade unambiguously on the far side of it — which is the whole
# reason the rig warps at all: a fee schedule that is never crossed is untested.
cast rpc evm_increaseTime 3660 --rpc-url "$RPC" >/dev/null
cast rpc anvil_mine 1 --rpc-url "$RPC" >/dev/null
echo "chain time is now $(cast block --rpc-url "$RPC" -f timestamp)"

step "trading again, on the far side of the transition"
PHASE=trade forge script script/Seed.s.sol \
  --rpc-url "$RPC" --private-key "$OPERATOR_KEY" --broadcast -vv \
  >"$LOGS/seed-trade.log" 2>&1 || { cat "$LOGS/seed-trade.log"; exit 1; }

step "collecting and claiming fees"
PHASE=settle forge script script/Seed.s.sol \
  --rpc-url "$RPC" --private-key "$OPERATOR_KEY" --broadcast -vv \
  >"$LOGS/seed-settle.log" 2>&1 || { cat "$LOGS/seed-settle.log"; exit 1; }

cd "$ROOT"

step "indexing"
export VERDANT_FACTORY="$FACTORY"
export VERDANT_HOOK="$HOOK"
# The Uniswap this rig deployed, not the one on 4663. Without this the indexer would
# watch the real PoolManager's address on a node where nothing lives there, and every
# market would arrive with no pool.
export VERDANT_POOL_MANAGER="$POOL_MANAGER"
export VERDANT_START_BLOCK="$START_BLOCK"
export PONDER_RPC_URL_4663="$RPC"

# No DATABASE_URL, so Ponder uses PGlite in a directory under the app. Removed first,
# because a previous run's database would be reused and the proof would pass on stale
# data — the one failure mode that would make this whole script worthless.
rm -rf "$ROOT/apps/indexer/.ponder"

# --schema names the Postgres schema the tables live in. Ponder insists on one for
# `start` rather than defaulting, because two deployments sharing a schema would
# silently overwrite each other's tables; a rig that recreates its database every run
# can pick any name.
# `exec` so that pnpm inherits this subshell's pid and stays the group leader, which
# is what makes the group kill in cleanup reach the node process underneath it.
set -m
(cd "$ROOT/apps/indexer" && exec pnpm ponder start --schema proof --port "$PONDER_PORT") \
  >"$LOGS/ponder.log" 2>&1 &
ponder_pid=$!
set +m

# Wait for the API to serve *every* market rather than merely to accept connections.
#
# Ponder answers /health long before the backfill is done, so polling that races the
# indexing. Waiting for the first market is not enough either, and that is the bug this
# replaced: the poll returned as soon as one pool id appeared, the assertions ran
# against a listing two markets deep, and the run failed claiming the indexer and the
# registry disagreed about how many markets exist. They did — for another second.
#
# The registry is the authority on the count, so that is what this waits for. It also
# means the condition tightens automatically if the seed ever creates more.
expected_markets=$(cast call "$MARKET_REGISTRY" "marketCount()(uint256)" --rpc-url "$RPC" | awk "{print \$1}")
echo "the registry has $expected_markets markets; waiting for the indexer to have all of them"

# Counting pool ids in the response, which sounds trivial and has two traps in it.
#
# The `|| true` on the curl is load-bearing: this script runs under `set -o pipefail`,
# the API is by construction not up on the first iteration, and a failed curl inside a
# command substitution fails the assignment, which `set -e` turns into an exit. That
# killed a run before the indexer had written its first log line, so the script reported
# nothing at all.
#
# And the count is done by splitting on the key rather than with `grep -c`, because
# `grep -c` counts matching *lines* and the whole listing is one line. It reported 1 for
# any non-empty response, so the loop waited out its full timeout while the indexer sat
# there fully caught up.
ready=""
indexed=0
for _ in $(seq 1 150); do
  body=$(curl -sf "$API/markets" 2>/dev/null || true)
  indexed=$(printf "%s" "$body" | awk -v RS='"poolId"' "END {print NR - 1}")
  if [ "$indexed" = "$expected_markets" ]; then
    ready=1
    break
  fi
  if ! kill -0 "$ponder_pid" 2>/dev/null; then
    echo "the indexer exited before serving anything:" >&2
    tail -30 "$LOGS/ponder.log" >&2
    exit 1
  fi
  sleep 1
done

if [ -z "$ready" ]; then
  echo "the indexer served $indexed of $expected_markets markets within 150 seconds:" >&2
  tail -30 "$LOGS/ponder.log" >&2
  exit 1
fi
echo "the indexer is serving all $expected_markets markets"

step "asking the chain whether the indexer is telling the truth"
VERDANT_API="$API" \
VERDANT_RPC="$RPC" \
VERDANT_HOOK="$HOOK" \
VERDANT_MARKET_REGISTRY="$MARKET_REGISTRY" \
VERDANT_MULTICALL3="$MULTICALL3" \
VERDANT_EQUITY="$EQUITY" \
VERDANT_STOCK_TOKEN="$STOCK_TOKEN" \
VERDANT_EXPECTED_MARKETS="$expected_markets" \
VERDANT_EQUITY_QUOTED_TOKENS="$STOCK_TOKEN,$SDK_EQUITY_TOKEN" \
  node apps/indexer/scripts/assert-feed.ts

step "done"
echo "the feed agrees with the contracts. Logs in $LOGS."

if [ -n "${VERDANT_KEEP:-}" ]; then
  cat <<INFO

The stack is up and will stay up until this is interrupted.

  chain     $RPC  (chain $CHAIN_ID)
  indexer   $API
  markets   $API/markets

The two markets this rig launched through the SDK, which are the ones to open first —
they are the only markets anywhere that were created by the calldata the interface
builds:

  ether-quoted   $SDK_ETHER_POOL_ID
                 token $SDK_ETHER_TOKEN
  equity-quoted  $SDK_EQUITY_POOL_ID
                 token $SDK_EQUITY_TOKEN  (quoted in $EQUITY)

For the interface, in another terminal. Every variable is needed: the app resolves
Verdant's addresses from the environment because nothing is recorded in
packages/config/src/deployments.ts yet, and it would otherwise render a page that
refuses to spend gas rather than one pointed at this rig.

  VERDANT_FEED_URL=$API \\
  NEXT_PUBLIC_CHAIN_ID=$CHAIN_ID \\
  NEXT_PUBLIC_RPC_URL=$RPC \\
  NEXT_PUBLIC_VERDANT_FACTORY=$FACTORY \\
  NEXT_PUBLIC_VERDANT_HOOK=$HOOK \\
  NEXT_PUBLIC_VERDANT_DEPLOYER=$DEPLOYER \\
  NEXT_PUBLIC_VERDANT_MODEL_REGISTRY=$MODEL_REGISTRY \\
  NEXT_PUBLIC_VERDANT_MARKET_REGISTRY=$MARKET_REGISTRY \\
    pnpm --filter @verdant/web dev

Uniswap's quoter and Permit2 need no variables: they are at the addresses
@verdant/config already names, which is what the periphery step above arranged. The
Universal Router is *not* here, so the trade panel's swap button will fail on this rig
even though its quote and its approvals will not. That is the honest state of it —
see docs/feed.md.

For a wallet, import anvil's first account. It created every market here:

  $OPERATOR

Addresses, if something needs them directly:

  VERDANT_FACTORY=$FACTORY
  VERDANT_HOOK=$HOOK
  VERDANT_DEPLOYER=$DEPLOYER
  VERDANT_MODEL_REGISTRY=$MODEL_REGISTRY
  VERDANT_MARKET_REGISTRY=$MARKET_REGISTRY
  VERDANT_POOL_MANAGER=$POOL_MANAGER
  VERDANT_POSITION_MANAGER=$POSITION_MANAGER
  VERDANT_SWAP_ROUTER=$SWAP_ROUTER
  VERDANT_MULTICALL3=$MULTICALL3
  VERDANT_EQUITY=$EQUITY
  V4_QUOTER=$V4_QUOTER
  PERMIT2=$PERMIT2

INFO

  # `wait` rather than a sleep loop, so an interrupt reaches the trap immediately and
  # both children are stopped by group. If the indexer dies on its own, this returns
  # and the stack comes down rather than leaving a chain nobody is reading.
  wait "$ponder_pid" || true
  echo "the indexer stopped; bringing the stack down"
fi
