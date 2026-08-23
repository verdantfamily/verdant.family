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
# ## The agent layer
#
# It also creates three agents, two of which launch markets of their own, and drives
# them through every state-changing event the agent layer has: services registered,
# repriced and retired, a treasury funded and spent from, a service bought from one
# agent by another, revenue recognised, allocated and settled across four legs and two
# assets, a market's fee stream claimed into an agent's router, a guardian's pause and
# resume, and an agent revoked.
#
# That list is not decoration. An agent event with no handler produces no rows and no
# errors, so a missing one is indistinguishable from a chain where it never happened —
# `apps/indexer/src/agent-events.test.ts` catches the handler nobody wrote, and only a
# real chain can catch the handler that writes the wrong row.
# `apps/indexer/scripts/assert-agents.ts` then reconciles every revenue leg against the
# router's own counters, and requires that all eighteen activity types actually appear.
#
# ## The engine-v1 market, which is the newest thing here and the least proven
#
# Everything above is about generated markets, whose hook is written per market. Agen's
# second launch path is a *configuration* executed by one shared, already-deployed engine,
# and until this section existed no engine market had been launched anywhere and
# `ponder.on("AgenEngineFactory:EngineMarketDeployed")` had never executed at all.
#
# That is the failure this rig is built to catch, in its purest form: an indexer pointed at
# a factory that never emits produces no rows and no errors, reports healthy, and serves an
# empty API. It is indistinguishable from a chain where nothing has launched. Unit tests
# cannot close it — they can only assert that a handler would do the right thing with an
# event nobody has ever delivered.
#
# So the engine is deployed here through `DeployAgenEngine.s.sol`, the same five phases a
# production broadcast runs, and then one market is launched through **agen.space's own
# launch path**: the configuration is compiled by `@verdant/market-engine`, approved with a
# real signature over `engineApprovalMessage`, turned into calldata by the server's own
# `prepareEngineLaunch`, broadcast, and registered by the app's own `recordLaunch` from the
# real receipt. It is then bought and sold against the real PoolManager.
#
# Three assertions follow, and they check different things on purpose:
#
#   - `apps/indexer/scripts/assert-engine.ts` holds the feed to the chain: the launch event,
#     the registry, the hook's `FeeTaken`, the pool's `Swap` and the vault's own balance.
#   - the second phase of `apps/agen/src/app/lib/engine-chain-proof.test.ts` reads the market
#     back through `marketSource()`, which is what the listing and the market page call.
#   - the negative controls at the end misconfigure the engine three ways and require the
#     first assertion to *fail* each time. A proof that cannot fail is not evidence, and this
#     one had never been observed failing for the right reason.
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

# anvil's fifth account, which launches and trades the engine-v1 market.
#
# Deliberately not the operator. An engine market is attributed to `msg.sender` in three
# separate places — the registry's record, the vault's creator leg, and the event the app
# decodes — and a rig whose creator was also its deployer could not tell a correct
# attribution from one that had quietly defaulted to whoever was broadcasting. The address
# is checked against the key below rather than trusted, since a mismatched pair would
# produce a market attributed to an account this script never names.
ENGINE_CREATOR_KEY=0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a
ENGINE_CREATOR=0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65

# The chain id matters: the indexer's config is written for 4663, and a mismatch
# would have it index a chain that is not the one it is talking to.
CHAIN_ID=4663

LOGS="$ROOT/.proof"
mkdir -p "$LOGS"

# Where the engine proof keeps its two halves.
#
# `AGEN_DATA_DIR` is the app's own build store, pointed at a directory this run owns: the
# launch phase writes a build and a launch record into it and the assertion phase reads them
# back through the shipped store rather than through a fixture. Both are removed at the start
# of every run, because a proof that could pass on the previous run's launch record would be
# proving nothing about this one — which is the single failure mode that would make this
# whole script worthless.
ENGINE_DATA_DIR="$LOGS/agen-data"
ENGINE_PROOF_FILE="$LOGS/engine-proof.json"
rm -rf "$ENGINE_DATA_DIR" "$ENGINE_PROOF_FILE"

anvil_pid=""
ponder_pid=""
# Which log the indexer is writing to. Set by `start_indexer`, because the negative controls
# restart it several times and a single ponder.log would interleave four runs into one file.
PONDER_LOG="$LOGS/ponder.log"

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
    echo "  indexer: $PONDER_LOG"
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
STATE_VIEW_STAGED=$(address_from "$LOGS/uniswap.log" "STATE_VIEW_STAGED")
export POOL_MANAGER POSITION_MANAGER SWAP_ROUTER
echo "PoolManager     $POOL_MANAGER"
echo "PositionManager $POSITION_MANAGER"

step "building the TypeScript"
# Before the periphery step rather than before the indexer, which is where this used
# to be: the next step asks @verdant/config where the interface looks for Uniswap's
# quoter, and the SDK proof after it drives apps/web's own launch code, which imports
# @verdant/ui. Both need built packages.
#
# `@verdant/market-engine` and `@verdant/market-compiler` are here for the engine proof:
# both publish from `dist`, and the engine launch below compiles its configuration with the
# first and builds its approval message with the second. A stale build of either would have
# the rig launching a market from one version of the encoder and checking it against another.
pnpm --filter @verdant/config --filter @verdant/sdk --filter @verdant/ui \
  --filter @verdant/market-engine --filter @verdant/market-compiler build \
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
STATE_VIEW=$(external_address stateView)

cast rpc anvil_setCode "$V4_QUOTER" "$(cast code "$V4_QUOTER_STAGED" --rpc-url "$RPC")" \
  --rpc-url "$RPC" >/dev/null

# `StateView`, moved for exactly the same reason and by exactly the same argument.
#
# It is how `apps/agen` reads a pool: price, tick and liquidity by pool id, at the address
# `@verdant/config` names, resolved by chain id with no override. `AgenMarketRegistry`
# records a market's pool id and not the key that hashes to it, so there is no way to ask
# the PoolManager directly without rebuilding the key — which is the whole reason this lens
# is in the read path. Without it every Agen market page renders with no price, on a rig
# whose entire purpose is to prove that a launched market shows up correctly.
cast rpc anvil_setCode "$STATE_VIEW" "$(cast code "$STATE_VIEW_STAGED" --rpc-url "$RPC")" \
  --rpc-url "$RPC" >/dev/null

# Multicall3, at the address every viem client on this chain batches through.
#
# The rig has always deployed a `Multicall3Lite` and handed its address to the scripts that
# build their own chain object. `apps/agen` does not build one: it uses `@verdant/config`'s
# chain, whose `contracts.multicall3` is the canonical address, resolved by chain id with no
# override — so a batched read on this rig called an address with no code at it.
#
# Nothing errored. `readLiveMarket` treats an unanswerable chain as "no market", by design, so
# every Agen market rendered as an unlaunched build with no price: the same symptom as the
# registry-routing bug and a completely different cause. Found the same way.
#
# Safe to relocate for the simplest possible reason: `Multicall3Lite` has no constructor, no
# immutables and no storage. It is `aggregate3` and nothing else, which is the only function
# viem calls when batching.
MULTICALL3_CANONICAL=$(cd "$ROOT/apps/web" && node --input-type=module -e \
  "import { robinhoodMainnet } from '@verdant/config'; process.stdout.write(robinhoodMainnet.contracts.multicall3.address);")

cast rpc anvil_setCode "$MULTICALL3_CANONICAL" "$(cast code "$MULTICALL3" --rpc-url "$RPC")" \
  --rpc-url "$RPC" >/dev/null

# The selector answers, which a wrong copy would not. An empty batch is the cheapest call that
# proves `aggregate3` is there and decodes its own arguments.
if ! cast call "$MULTICALL3_CANONICAL" "aggregate3((address,bool,bytes)[])((bool,bytes)[])" "[]" \
  --rpc-url "$RPC" >/dev/null 2>&1; then
  echo "the Multicall3 at $MULTICALL3_CANONICAL does not answer aggregate3." >&2
  echo "Every batched read the app makes would fail, and every market would show no price." >&2
  exit 1
fi

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

lens_bound_to=$(cast call "$STATE_VIEW" "poolManager()(address)" --rpc-url "$RPC")
if [ "$(printf '%s' "$lens_bound_to" | tr 'A-F' 'a-f')" != "$(printf '%s' "$POOL_MANAGER" | tr 'A-F' 'a-f')" ]; then
  echo "the state view at $STATE_VIEW answers to PoolManager $lens_bound_to, not $POOL_MANAGER." >&2
  echo "Every market page would read an empty pool and show no price." >&2
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
echo "StateView       $STATE_VIEW (from $STATE_VIEW_STAGED, likewise)"
echo "Multicall3      $MULTICALL3_CANONICAL (from $MULTICALL3, answering aggregate3)"
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
AGENT_FACTORY=$(address_from "$LOGS/deploy.log" "AgentLaunchFactory")
AGENT_IDENTITY_REGISTRY=$(address_from "$LOGS/deploy.log" "AgentIdentityRegistry")
AGENT_SERVICE_REGISTRY=$(address_from "$LOGS/deploy.log" "AgentServiceRegistry")
HOOK=$(address_from "$LOGS/deploy.log" "VerdantHook")
MARKET_REGISTRY=$(address_from "$LOGS/deploy.log" "MarketRegistry")
MODEL_REGISTRY=$(address_from "$LOGS/deploy.log" "ModelRegistry")
# The account that executes the token's CREATE2, and therefore the address every
# predicted token address is computed from. The SDK mines a salt against it and the
# interface reads its init code hash; getting it from anywhere else would predict
# addresses no launch lands on.
DEPLOYER=$(address_from "$LOGS/deploy.log" "VerdantDeployer")
export FACTORY AGENT_FACTORY
echo "VerdantFactory  $FACTORY"
echo "VerdantHook     $HOOK"
echo "AgentLaunchFactory $AGENT_FACTORY"

step "deploying Agen's deterministic engine"
# The same five phases a production broadcast runs, in the same script, with no test seam
# taken: `FactoryOrigin` anchors the factory's address, the deployer and the registry are
# told it, the hook's salt is mined in-process against that origin, and the factory lands on
# the anchored address with a constructor that checks all three wirings. Every prediction is
# restated against the deployed result inside the script, so a stale salt or a wrong ordering
# is a failed deployment here rather than a market whose rules never run.
#
# Deliberately without --disable-code-size-limit. `AgenEngineFactory` sits close to EIP-170
# and `EngineSizes.t.sol` is the guard; a rig that waived the limit would stop being able to
# catch the day one of ours crossed it.
AGEN_ENGINE_TREASURY="$TREASURY_ADDRESS" \
  forge script script/DeployAgenEngine.s.sol \
  --rpc-url "$RPC" --private-key "$OPERATOR_KEY" --broadcast -vv \
  >"$LOGS/deploy-engine.log" 2>&1 || { cat "$LOGS/deploy-engine.log"; exit 1; }

# Read under the names the indexer and the app consume them by, which is what the tail of
# `DeployAgenEngine._report` prints for exactly this purpose. All four or none: the hook pins
# the factory and the factory pins the hook, so a rig holding three quarters of a deployment
# describes something that cannot exist on chain.
ENGINE_FACTORY=$(address_from "$LOGS/deploy-engine.log" "AGEN_ENGINE_FACTORY")
ENGINE_DEPLOYER=$(address_from "$LOGS/deploy-engine.log" "AGEN_ENGINE_DEPLOYER")
ENGINE_REGISTRY=$(address_from "$LOGS/deploy-engine.log" "AGEN_ENGINE_REGISTRY")
ENGINE_HOOK=$(address_from "$LOGS/deploy-engine.log" "AGEN_ENGINE_HOOK")

echo "AgenEngineFactory  $ENGINE_FACTORY"
echo "AgenEngineHook     $ENGINE_HOOK"
echo "AgenMarketRegistry $ENGINE_REGISTRY (the engine's own, not the generated one)"

# The hook's address carries its own permissions in its low fourteen bits, and v4 re-reads
# them on every call. The script requires this too; it is restated here because a hook that
# landed on the wrong bits is unrecoverable — the market cannot be repointed — so it is worth
# failing before anything is launched against it.
engine_hook_bits=$(printf '%d' "$(( $(printf '%d' "0x${ENGINE_HOOK: -4}") & 0x3fff ))")
if [ "$engine_hook_bits" -ne 14540 ]; then
  echo "the engine hook at $ENGINE_HOOK carries permission bits ${engine_hook_bits}, not 14540 (0x38cc)." >&2
  echo "v4 would never call the callbacks this engine's economics live in." >&2
  exit 1
fi
echo "the engine hook carries 0x38cc, so v4 will call it"

step "deploying AgenRouter, the route a real trade takes"
# One per chain, named in the deployment record, and the contract `apps/agen`'s trade panel
# calls. It is deployed here because the engine trades below go through it as well as through
# the rig's bare router: the bare one proves the pool, the hook and the indexer, and this one
# proves the product's own settlement survives a hook that takes a delta out of the trade.
#
# That is not a theoretical distinction. The router settles the input before the swap, then
# takes the output and any unspent input back out, all inside one lock — and the engine hook
# takes its fee as an extra delta in the middle of it. A router computing its own expected
# balances would revert on a pool that trades perfectly well through a bare one, and until this
# ran no engine market had been traded through it on any chain.
forge script script/DeployAgenRouter.s.sol \
  --rpc-url "$RPC" --private-key "$OPERATOR_KEY" --broadcast -vv \
  >"$LOGS/deploy-agen-router.log" 2>&1 || { cat "$LOGS/deploy-agen-router.log"; exit 1; }

AGEN_ROUTER=$(address_from "$LOGS/deploy-agen-router.log" "NEXT_PUBLIC_AGEN_ROUTER")
echo "AgenRouter      $AGEN_ROUTER"

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

step "creating three agents, launching two agent markets"
# The agent layer, driven on a real chain. `AgentSeed.s.sol` explains what each of
# the three agents is for; what matters here is that between this phase and the one
# after the warp, **every** state-changing agent event fires at least once.
#
# Before the warp, deliberately. Two of those events need time to have passed — a
# spending period only rolls once one has elapsed, and a market has no fees to claim
# until it has been traded and collected — and the phases below do both.
PHASE=launch forge script script/AgentSeed.s.sol \
  --rpc-url "$RPC" --private-key "$OPERATOR_KEY" --broadcast -vv \
  >"$LOGS/agents-launch.log" 2>&1 || { cat "$LOGS/agents-launch.log"; exit 1; }
grep -E '^  (provider|payer|retired|service)' "$LOGS/agents-launch.log" || true

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

step "settling the agent layer"
# After the warp and after the markets have traded, which is what the two events this
# phase exists for require: a market fee stream that has something in it, and a
# spending period that has actually rolled with something counted against it.
PHASE=settle forge script script/AgentSeed.s.sol \
  --rpc-url "$RPC" --private-key "$OPERATOR_KEY" --broadcast -vv \
  >"$LOGS/agents-settle.log" 2>&1 || { cat "$LOGS/agents-settle.log"; exit 1; }

cd "$ROOT"

step "launching an engine-v1 market, through agen.space's own launch path"
# The point of this half of the rig, and the same argument as the SDK launch above: nothing
# in the engine path had ever produced a transaction that landed anywhere. So this does not
# reimplement the launch — it calls the app's own functions, in the app's own order:
#
#   compile the configuration  (@verdant/market-engine)
#   sign the approval          (engineApprovalMessage, a real key, a real signature)
#   approveBuild               (the server's real verifier)
#   prepareEngineLaunch        (the server's real calldata, commitment re-checked)
#   send it                    (to the factory this rig just deployed)
#   recordLaunch               (the app's real receipt decoder, on a real receipt)
#   buy, then sell             (against the real PoolManager, through the rig's router)
#
# It then writes what the chain said to $ENGINE_PROOF_FILE, which every assertion after this
# is held to. The addresses are exported under the names production uses, because the point
# is to exercise the resolution the deployed app performs rather than a test seam beside it.

# The key and the address have to be the same account, or the market would be attributed to
# somebody this script never names and the attribution assertions would pass vacuously.
engine_creator_derived=$(cast wallet address --private-key "$ENGINE_CREATOR_KEY")
if [ "$(printf '%s' "$engine_creator_derived" | tr 'A-F' 'a-f')" != "$(printf '%s' "$ENGINE_CREATOR" | tr 'A-F' 'a-f')" ]; then
  echo "ENGINE_CREATOR_KEY belongs to $engine_creator_derived, not $ENGINE_CREATOR." >&2
  exit 1
fi

# Every variable the engine path resolves from the environment, in one place, because both
# phases and the indexer need the same four addresses and a partial set is the failure they
# are all trying to detect.
engine_env=(
  "AGEN_ENGINE_PROOF=1"
  "AGEN_ENGINE_VERSION=1"
  "AGEN_ENGINE_FACTORY=$ENGINE_FACTORY"
  "AGEN_ENGINE_DEPLOYER=$ENGINE_DEPLOYER"
  "AGEN_ENGINE_REGISTRY=$ENGINE_REGISTRY"
  "AGEN_ENGINE_HOOK=$ENGINE_HOOK"
  "AGEN_DATA_DIR=$ENGINE_DATA_DIR"
  "AGEN_ENGINE_PROOF_OUTPUT=$ENGINE_PROOF_FILE"
  "AGEN_ENGINE_PROOF_SWAP_ROUTER=$SWAP_ROUTER"
  "AGEN_ENGINE_PROOF_AGEN_ROUTER=$AGEN_ROUTER"
  "AGEN_ENGINE_PROOF_KEY=$ENGINE_CREATOR_KEY"
  # The router the app resolves for this chain, so the assert phase drives the same trade path
  # the token page does rather than the one the deployment record names for 4663.
  "NEXT_PUBLIC_AGEN_ROUTER=$AGEN_ROUTER"
  "NEXT_PUBLIC_CHAIN_ID=$CHAIN_ID"
  "NEXT_PUBLIC_RPC_URL=$RPC"
)

(
  cd "$ROOT/apps/agen" &&
  env "${engine_env[@]}" AGEN_ENGINE_PROOF_PHASE=launch \
    pnpm vitest run src/app/lib/engine-chain-proof.test.ts
)

# The file is the proof that the phase ran rather than skipped. `describe.skipIf` reports a
# green suite for a skipped one, so a missing environment variable would otherwise look like
# a passing launch — the exact class of silent success this rig exists to remove.
if [ ! -f "$ENGINE_PROOF_FILE" ]; then
  echo "the engine launch phase reported success and wrote nothing to $ENGINE_PROOF_FILE." >&2
  echo "It skipped rather than ran, so no market was launched." >&2
  exit 1
fi

# Read back with node rather than parsed out of the log, for the reason the SDK launch writes
# a file: a pool id is 32 bytes and `address_from` matches 20.
proof_field() {
  node --input-type=module -e '
import { readFileSync } from "node:fs";
const proof = JSON.parse(readFileSync(process.argv[1], "utf8"));
const value = proof[process.argv[2]];
if (value === undefined) {
  process.stderr.write("the engine proof file has no " + process.argv[2] + "\n");
  process.exit(1);
}
process.stdout.write(String(value));
' "$ENGINE_PROOF_FILE" "$1"
}

ENGINE_TOKEN=$(proof_field token)
ENGINE_POOL_ID=$(proof_field poolId)
ENGINE_VAULT=$(proof_field vault)
ENGINE_LAUNCH_TX=$(proof_field launchTx)

echo "engine market   $ENGINE_POOL_ID"
echo "  token         $ENGINE_TOKEN"
echo "  vault         $ENGINE_VAULT"
echo "  launched in   $ENGINE_LAUNCH_TX"
echo "  creator       $ENGINE_CREATOR (not the operator, deliberately)"
echo "  traded        twice through PoolSwapTest and twice through AgenRouter"

step "indexing"
export VERDANT_FACTORY="$FACTORY"
export VERDANT_HOOK="$HOOK"
# The Uniswap this rig deployed, not the one on 4663. Without this the indexer would
# watch the real PoolManager's address on a node where nothing lives there, and every
# market would arrive with no pool.
export VERDANT_POOL_MANAGER="$POOL_MANAGER"
export VERDANT_START_BLOCK="$START_BLOCK"
export PONDER_RPC_URL_4663="$RPC"

# The agent layer. Nothing is recorded for it in packages/config yet, and the indexer
# treats an absent agent layer as "watch nothing" rather than as an error — which is
# the right default for a chain that has none, and would silently produce an empty
# agent surface here. All three are exported together for that reason: the indexer
# refuses a partial override rather than guessing the rest.
export VERDANT_AGENT_FACTORY="$AGENT_FACTORY"
export VERDANT_AGENT_IDENTITY_REGISTRY="$AGENT_IDENTITY_REGISTRY"
export VERDANT_AGENT_SERVICE_REGISTRY="$AGENT_SERVICE_REGISTRY"
export VERDANT_AGENT_START_BLOCK="$START_BLOCK"

# Agen's engine, under the same all-or-nothing rule and for a stronger reason than the agent
# layer's: the hook pins the factory and the factory pins the hook, so a mixed pair describes
# a deployment that cannot exist. `src/addresses.ts` refuses a partial set rather than
# guessing the rest, and the third negative control at the end of this script proves it.
#
# Nothing about the engine is in `packages/config`'s deployment record yet, so without these
# the indexer watches the zero address, indexes no engine market, and reports healthy. That
# is precisely the state every assertion below exists to distinguish from a working one.
export AGEN_ENGINE_FACTORY="$ENGINE_FACTORY"
export AGEN_ENGINE_HOOK="$ENGINE_HOOK"
export AGEN_ENGINE_REGISTRY="$ENGINE_REGISTRY"
export AGEN_ENGINE_START_BLOCK="$START_BLOCK"

# Started and stopped as functions rather than inline, because the negative controls restart
# the indexer with a deliberately wrong configuration and then restore it. Every start is
# from an empty database: PGlite lives in a directory under the app, and a run that reused
# the previous one's tables would let a misconfigured indexer pass on rows a correct one
# wrote — which would invert the meaning of every control below.
start_indexer() {
  local schema="$1"
  PONDER_LOG="$LOGS/ponder-${schema}.log"

  rm -rf "$ROOT/apps/indexer/.ponder"

  # The port has to be genuinely free. A start that fails to bind leaves whatever is still
  # shutting down answering the readiness poll, which is how a previous version of this
  # script spent eight minutes asserting against a dead run's data.
  for _ in $(seq 1 50); do
    port_in_use "$PONDER_PORT" || break
    sleep 0.2
  done
  if port_in_use "$PONDER_PORT"; then
    echo "port ${PONDER_PORT} is still busy; the previous indexer did not stop." >&2
    exit 1
  fi

  # --schema names the Postgres schema the tables live in. Ponder insists on one for `start`
  # rather than defaulting, because two deployments sharing a schema would silently overwrite
  # each other's tables; a rig that recreates its database every run can pick any name.
  # `exec` so that pnpm inherits this subshell's pid and stays the group leader, which is what
  # makes the group kill in cleanup reach the node process underneath it.
  set -m
  (cd "$ROOT/apps/indexer" && exec pnpm ponder start --schema "$schema" --port "$PONDER_PORT") \
    >"$PONDER_LOG" 2>&1 &
  ponder_pid=$!
  set +m
}

stop_indexer() {
  stop_group "$ponder_pid"
  ponder_pid=""
}

# The block the indexer has actually reached, from Ponder's own checkpoint. -1 when it cannot
# be read, which the caller treats as "not there yet" rather than as an answer.
indexed_block() {
  local body
  body=$(curl -sf "$API/status" 2>/dev/null || true)
  local found
  found=$(printf '%s' "$body" | grep -o '"number":[0-9]*' | head -1 | cut -d: -f2)
  printf '%s' "${found:--1}"
}

# Caught up to the head, not merely started.
#
# `/ready` is not enough and the difference cost a run. It reports that *historical* indexing
# is complete, and historical means up to the chain's finalized block — which on anvil lags the
# head by about thirty blocks. So a rig that stops at `/ready` asks its questions while the
# blocks holding the launch and the trades are still being indexed live.
#
# That is exactly the distinction the negative controls rest on. If "the engine market is not
# in the listing" can mean "the indexer has not got there yet", then a control failing proves
# nothing about the configuration — and the restore afterwards fails for the same reason with
# nothing wrong. So this waits for the checkpoint to reach the head, and the chain is idle by
# now, so the head is a fixed target rather than a moving one.
wait_ready() {
  local label="$1" seconds="${2:-240}"
  local head
  head=$(cast block-number --rpc-url "$RPC")

  local ready="" at=-1
  for _ in $(seq 1 "$seconds"); do
    if curl -sf "$API/ready" >/dev/null 2>&1; then
      at=$(indexed_block)
      if [ "$at" -ge "$head" ]; then
        ready=1
        break
      fi
    fi
    if ! kill -0 "$ponder_pid" 2>/dev/null; then
      echo "the indexer exited while ${label}:" >&2
      tail -40 "$PONDER_LOG" >&2
      return 1
    fi
    sleep 1
  done

  if [ -z "$ready" ]; then
    echo "the indexer reached block ${at} of ${head} within ${seconds}s while ${label}:" >&2
    tail -40 "$PONDER_LOG" >&2
    return 1
  fi

  echo "the indexer has caught up to block ${head}"
}

start_indexer proof

if ! wait_ready "indexing the rig's history"; then exit 1; fi
echo "the indexer has finished its backfill"

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

# And the agents, for the same reason and separately. The markets are created early in
# the history and the agent layer is driven to the very end of it, so a poll satisfied
# by the market listing can return while the last agent transactions are still being
# indexed — and the assertions would then report an indexer that had dropped events it
# simply had not reached yet.
expected_agents=$(cast call "$AGENT_IDENTITY_REGISTRY" "agentCount()(uint256)" --rpc-url "$RPC" | awk "{print \$1}")
echo "the registry has $expected_agents agents; waiting for the indexer to have all of them"

agents_ready=""
indexed_agents=0
for _ in $(seq 1 150); do
  body=$(curl -sf "$API/agents" 2>/dev/null || true)
  indexed_agents=$(printf "%s" "$body" | awk -v RS='"agentId"' "END {print NR - 1}")
  if [ "$indexed_agents" = "$expected_agents" ]; then
    agents_ready=1
    break
  fi
  if ! kill -0 "$ponder_pid" 2>/dev/null; then
    echo "the indexer exited while the agents were being indexed:" >&2
    tail -30 "$LOGS/ponder.log" >&2
    exit 1
  fi
  sleep 1
done

if [ -z "$agents_ready" ]; then
  echo "the indexer served $indexed_agents of $expected_agents agents within 150 seconds:" >&2
  tail -30 "$LOGS/ponder.log" >&2
  exit 1
fi
echo "the indexer is serving all $expected_agents agents"

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

step "asking the chain the same questions about the agents"
# The market assertions above would pass unchanged on a build with no agent surface at
# all, because none of them mentions an agent. These are the ones that would not.
#
# The human market is named rather than discovered: it is the ether-quoted market the
# SDK launched, and it is here to prove that agent attribution did not leak onto the
# markets that have no agent. Searching for a market the indexer reports as
# unattributed would take the indexer's word for exactly the thing under test.
VERDANT_API="$API" \
VERDANT_RPC="$RPC" \
VERDANT_AGENT_IDENTITY_REGISTRY="$AGENT_IDENTITY_REGISTRY" \
VERDANT_AGENT_SERVICE_REGISTRY="$AGENT_SERVICE_REGISTRY" \
VERDANT_MULTICALL3="$MULTICALL3" \
VERDANT_EXPECTED_AGENTS="$expected_agents" \
VERDANT_HUMAN_POOL_ID="$SDK_ETHER_POOL_ID" \
  node apps/indexer/scripts/assert-agents.ts

# --- the engine, which is the part that had never run anywhere ---------------
#
# Three assertions, kept separate because they can fail independently and each names a
# different culprit. Written as a function because the negative controls run the first of
# them again, several times, and require it to fail.

#
# The addresses handed to the assertion are always the correct ones, even when the indexer
# has been told something else. Its job is to compare the API against the chain, so it needs
# the real hook and the real registry to read; what the indexer was told to watch is the
# variable under test, not an input to the check.
assert_engine_feed() {
  VERDANT_API="$API" \
  VERDANT_RPC="$RPC" \
  VERDANT_POOL_MANAGER="$POOL_MANAGER" \
  AGEN_ENGINE_HOOK="$ENGINE_HOOK" \
  AGEN_ENGINE_REGISTRY="$ENGINE_REGISTRY" \
  AGEN_ENGINE_PROOF_OUTPUT="$ENGINE_PROOF_FILE" \
    node apps/indexer/scripts/assert-engine.ts
}

assert_engine_app() {
  (
    cd "$ROOT/apps/agen" &&
    env "${engine_env[@]}" AGEN_ENGINE_PROOF_PHASE=assert \
      AGEN_FEED_URL="$API" \
      pnpm vitest run src/app/lib/engine-chain-proof.test.ts
  )
}

step "asking the chain whether the engine feed is telling the truth"
# Every claim here is against the chain, not against the indexer's own consistency: the
# launch event, the registry record, the hook's FeeTaken, the pool's Swap and the vault's own
# balance sheet. In particular it asserts both halves of the fee claim — that the pool
# reported zero, and that the feed nonetheless reports the rate the hook charged — because
# either one alone passes on a feed that infers the rate from Uniswap.
assert_engine_feed

step "opening the engine market the way agen.space does"
# The listing, the market page and the trade list, through `marketSource()` — the same
# function the shelves and the token page call. This is the stage that proves the fixes hold
# end to end: the launch is registered from a real receipt, the registry read goes to the
# engine's own registry rather than engine 0's, and the trade list is the indexer's swaps
# rather than the empty array it used to return for every programmable market.
assert_engine_app

step "proving the engine proof can fail"
# A proof that has never been seen failing is not evidence. These three misconfigure the
# indexer in the three ways production could plausibly be misconfigured, and require the
# feed assertion to fail each time — for the right reason, which is checked rather than
# assumed. A control that failed because the API was unreachable would be worthless.
#
# The market is *already launched and traded on chain* throughout. Nothing about the chain
# changes between these runs; only what the indexer was told to watch does. So a control that
# passed would mean the assertion is insensitive to whether the handler ran at all.

engine_restore_config() {
  export AGEN_ENGINE_FACTORY="$ENGINE_FACTORY"
  export AGEN_ENGINE_HOOK="$ENGINE_HOOK"
  export AGEN_ENGINE_REGISTRY="$ENGINE_REGISTRY"
}

# Run in this shell rather than in a subshell, so that `ponder_pid` stays the one the exit
# trap knows about. A control that left an indexer running under a pid the parent never saw
# would have the next start fail on a busy port, several minutes later, for no visible reason.
engine_control() {
  local index="$1" mode="$2" what="$3" log="$LOGS/negative-${1}.log"

  echo
  echo "  control ${index}: ${what}"

  case "$mode" in
    wrong-factory) export AGEN_ENGINE_FACTORY="$ENGINE_REGISTRY" ;;
    unconfigured) unset AGEN_ENGINE_FACTORY AGEN_ENGINE_HOOK AGEN_ENGINE_REGISTRY ;;
    partial) unset AGEN_ENGINE_FACTORY ;;
    *)
      echo "unknown control mode '${mode}'" >&2
      exit 1
      ;;
  esac

  start_indexer "control${index}"

  # The partial set is refused at configuration time, so this one never reaches a database.
  # Waited for rather than slept through, because "the indexer exits" and "the indexer is
  # still starting" are different observations and only the first one is the control passing.
  if [ "$mode" = "partial" ]; then
    for _ in $(seq 1 60); do
      grep -q "or none of them" "$PONDER_LOG" && break
      kill -0 "$ponder_pid" 2>/dev/null || break
      sleep 0.5
    done

    if ! grep -q "or none of them" "$PONDER_LOG"; then
      echo "  FAIL the indexer accepted three quarters of an engine deployment:" >&2
      tail -20 "$PONDER_LOG" >&2
      stop_indexer
      exit 1
    fi

    echo "  ok   it refused to start, rather than guessing the missing address"
    stop_indexer
    engine_restore_config
    return 0
  fi

  if ! wait_ready "running control ${index}"; then exit 1; fi

  if assert_engine_feed >"$log" 2>&1; then
    echo "  FAIL the engine feed assertion passed with ${what}." >&2
    echo "       It is therefore not sensitive to whether the engine handler ran at all, so" >&2
    echo "       a green run against the correct configuration proves nothing. See $log." >&2
    stop_indexer
    exit 1
  fi

  # Failing is not enough: it has to fail *because the market is missing*. An unreachable API
  # or a malformed proof file would also fail, and would tell us nothing about the handler.
  if ! grep -q "is not in the listing at all" "$log"; then
    echo "  FAIL control ${index} failed for the wrong reason." >&2
    echo "       Expected it to report that the engine market is not in the listing." >&2
    tail -20 "$log" >&2
    stop_indexer
    exit 1
  fi

  echo "  ok   it failed, reporting that the engine market was never indexed"
  stop_indexer
  engine_restore_config
}

stop_indexer

# 1. The factory pointed at a real contract from the same deployment that never emits
#    `EngineMarketDeployed`. The closest thing to a plausible mistake: every address is real,
#    every variable is set, the indexer is healthy, and it has nothing to say about any engine
#    market.
engine_control 1 wrong-factory "the wrong contract as the engine factory"

# 2. The engine not configured at all, which is what every deployment looks like today. This
#    is the state the gate exists to make impossible to ship unnoticed: a launchpad whose
#    markets launch on chain and never appear in it.
engine_control 2 unconfigured "no engine configured"

# 3. Three quarters of a deployment. `src/addresses.ts` refuses it rather than filling the
#    rest in from a record, and that refusal is load-bearing: a partial set describes a
#    deployment that cannot exist, and guessing would have the indexer follow one deployment's
#    factory with another deployment's hook.
engine_control 3 partial "only two of the three engine addresses"

step "restoring the correct configuration"
# And it passes again, from an empty database, with nothing about the chain having changed
# since the run that passed at the top. Without this the controls above would only establish
# that the assertion is capable of failing.
start_indexer restored
if ! wait_ready "reindexing with the correct engine configuration"; then exit 1; fi
assert_engine_feed
assert_engine_app

step "done"
echo "the market feed, the agent feed and the engine feed all agree with the contracts."
echo "the engine market launched through the app's own path, indexed, listed, and shows"
echo "both of its trades at the rates the hook charged. Logs in $LOGS."

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

And the engine-v1 market, which is the only one anywhere launched by the calldata
agen.space builds, on the engine this rig deployed. It has been bought and sold once
each, at 1% and 2%:

  engine market  $ENGINE_POOL_ID
                 token $ENGINE_TOKEN
                 vault $ENGINE_VAULT
                 build $(proof_field jobId) in $ENGINE_DATA_DIR

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
  STATE_VIEW=$STATE_VIEW
  PERMIT2=$PERMIT2

For agen.space against this rig. The four engine addresses are all or nothing: the app
refuses to prepare a launch without every one of them, because a build that prepared a
transaction to an address with no code at it is a market nobody can create.

  AGEN_FEED_URL=$API \\
  AGEN_DATA_DIR=$ENGINE_DATA_DIR \\
  AGEN_ENGINE_VERSION=1 \\
  AGEN_ENGINE_FACTORY=$ENGINE_FACTORY \\
  AGEN_ENGINE_DEPLOYER=$ENGINE_DEPLOYER \\
  AGEN_ENGINE_REGISTRY=$ENGINE_REGISTRY \\
  AGEN_ENGINE_HOOK=$ENGINE_HOOK \\
  NEXT_PUBLIC_CHAIN_ID=$CHAIN_ID \\
  NEXT_PUBLIC_RPC_URL=$RPC \\
    pnpm --filter @verdant/agen dev

For a wallet on that market, import anvil's fifth account, which created it:

  $ENGINE_CREATOR

INFO

  # `wait` rather than a sleep loop, so an interrupt reaches the trap immediately and
  # both children are stopped by group. If the indexer dies on its own, this returns
  # and the stack comes down rather than leaving a chain nobody is reading.
  wait "$ponder_pid" || true
  echo "the indexer stopped; bringing the stack down"
fi
