# @verdant/contracts

Foundry project. Solidity 0.8.26, optimizer on, 1 000 000 runs, `cancun` EVM.

## Dependencies are vendored, not submoduled

Run `pnpm contracts:deps` (from the repo root) before `forge build`. It fetches
immutable commit tarballs into `vendor/`, which is gitignored (39 MB).

`vendor/` rather than the conventional `lib/` on purpose: Foundry treats a plain
directory under `lib/` as an uninitialised git submodule and tries to install it
on every single build, printing errors and reaching for the network in CI.
`libs = ["vendor"]` sidesteps that.

The pins are not arbitrary and must not be bumped casually:

| Dependency | Pin | Why |
|---|---|---|
| `v4-periphery` | `3c31961fb9` | The deployed `PositionManager` source on 4663 is **byte-for-byte identical** to this commit |
| `v4-core` | `59d3ecf53afa` | `lib/v4-core` submodule of periphery at that commit |
| `permit2` | `cc56ad0f3439` | `lib/permit2` submodule of periphery at that commit |
| `solmate` | `4b47a190…` | `lib/solmate` submodule of v4-core at that commit |
| `openzeppelin-contracts` | `dbb6104c…` (v5.0.2) | `lib/openzeppelin-contracts` submodule of v4-core |
| `forge-std` | `v1.16.2` | Ours, test-only; not part of any deployed artifact |

**Do not track `main`.** Current v4-periphery `main` adds a `ModifyPosition`
event and `virtual` modifiers that the contract deployed on 4663 does not have.
Building against `main` would mean testing against code that is not on the
chain. See `docs/verification.md`.

## Why one OpenZeppelin copy

`@openzeppelin/contracts/` is remapped to **v4-core's own** OpenZeppelin pin
(v5.0.2) rather than to a second, newer copy. Two OpenZeppelin versions in one
build is a footgun: the same import path resolves differently depending on which
source tree the importing file sits in. `VerdantToken` needs only `ERC20` and
`ERC20Permit`, both present at this version.

If P2 needs a newer OpenZeppelin, move v4's copy behind a distinct remapping
prefix rather than shadowing this one.

## Verification is Blockscout

Etherscan does not index chain 4663. Every verification goes through
`forge verify-contract --verifier blockscout --verifier-url <explorer>/api/`.

## Commands

```bash
pnpm contracts:deps      # from repo root; fetch pinned vendor/
forge build
forge test
forge test --gas-report
pnpm snapshot            # rewrite the committed gas baseline
pnpm snapshot:check      # CI gate: fails on regression
FOUNDRY_PROFILE=quick forge test   # 256 fuzz runs instead of 10 000
bash ../../scripts/fork-test.sh    # the fork suite, as CI runs it; needs network
                                   # (sets the fork profile itself; runs from anywhere)
forge coverage

# deployment; simulate first, and read the address book it prints
POOL_MANAGER=0x... POSITION_MANAGER=0x... TREASURY=0x... \
  forge script script/Deploy.s.sol --rpc-url robinhood --sender 0xYOU
POOL_MANAGER=0x... POSITION_MANAGER=0x... FACTORY=0x... \
  forge script script/MineHook.s.sol   # reproduce the hook's salt, deploy nothing

# the whole market feed, end to end, with no network: starts a chain, deploys a
# Uniswap and a Verdant onto it, launches and trades three markets across a fee
# transition, indexes it, and asks the contracts to confirm what the indexer says.
# The three scripts below marked "rig only" exist for this and are never run on 4663.
bash ../../scripts/indexer-proof.sh

# and afterwards, before publishing the addresses: reads the deployment back and
# checks every wiring from both ends. Broadcasts nothing, needs no key.
FACTORY=0x... ORIGIN=0x... EXPECTED_TREASURY=0x... EXPECTED_REGISTRY_OWNER=0x... \
  forge script script/Verify.s.sol --rpc-url robinhood
```

The full sequence, with the reason for each step and the two addresses that cannot
be changed afterwards, is in [docs/deployment.md](../../docs/deployment.md).

Run the fork suite through `scripts/fork-test.sh` rather than calling
`FOUNDRY_PROFILE=fork forge test` directly. Three reasons, all learned the hard way:
`forge test` exits **0** when it matches no tests, so a run that executed nothing
looks exactly like a run that passed; the default profile excludes `test/fork`, so an
ordinary `forge test` can leave a cache state in which the fork profile finds no tests
at all; and forgetting the profile runs the *default* suite, whose 352 passing tests
say nothing whatsoever about the deployed chain. The script fails on the first,
rebuilds once to clear the second, and sets the profile itself for the third.
If you do hit "No tests found in project" while invoking forge yourself,
`forge build --force` is the fix.

The snapshot scripts wrap `forge snapshot --match-contract "GasTest"` — the
schedule read and the hook's `beforeSwap` — rather than calling it bare. A whole-project snapshot would include fuzz averages
(which move with the fuzzer's seed) and the vector suites (whose cost is
dominated by JSON parsing), so it would fail for reasons unrelated to what a user
of the protocol pays.

## Measured cost of the swap-path read

`feeAt` runs inside `beforeSwap` on every trade for the life of a market, so its
cost is paid forever by traders rather than once by a creator. Measured around
the external call, so the figures include the CALL and the cold SLOADs:

| Stages | Storage slots read | Gas |
|---|---|---|
| 1 | 1 | 7 186 |
| 3 | 1 | 7 186 |
| 4 | 1 | 7 186 |
| 8 | 2 | 9 008 |
| 8, first stage still active | 2 | 13 735 |

The flatness across 1–4 stages is the point of the two-word encoding: the header
plus four stages occupy 56 + 4 × 48 = 248 of `word0`'s 256 bits, so a schedule of
four stages or fewer never reads `word1`. The 1 816 gas step from four stages to
eight is the second cold SLOAD (2 100, less what the shorter backwards scan gives
back).

`ScheduleLibGas.t.sol` asserts the slot count directly with `vm.record` /
`vm.accesses` rather than inferring it from gas, because a gas number can drift
for a dozen reasons and still look plausible.

## Layout

Read in this order to understand a launch: `VerdantFactory`, then `VerdantHook`,
then `PositionLocker` and `FeeSplitter`.

```
src/
  VerdantFactory.sol            a market and its first buy, atomically. Opens the pool
  VerdantHook.sol               the scheduled fee, and the liquidity guard
  VerdantDeployer.sol           CREATE2s a market's four contracts for the factory
  VerdantToken.sol              fixed supply, no mint, no owner
  PositionLocker.sol            permanent custody of the position NFT
  FeeSplitter.sol               immutable shares, pull-based claims
  TokenVesting.sol              the creator's allocation, released linearly
  ModelRegistry.sol             bounds for FUTURE markets. Owner-controlled
  MarketRegistry.sol            append-only record, factory-written
  FactoryOrigin.sol             publishes the factory's address before it exists
  libraries/ScheduleLib.sol     the fee schedule, in two storage words
  libraries/LaunchBounds.sol    the bounds no registry governs
  libraries/VerdantConstants.sol  tick grid and pool-key constants
script/
  Deploy.s.sol                  the whole system, in the only order that works
  Verify.s.sol                  reads a deployment back and checks it from both ends
  MineHook.s.sol                reproduces a hook salt for review. Deploys nothing
  LocalUniswap.s.sol            a Uniswap v4 for a machine with no chain. Rig only
  Multicall3Lite.sol            aggregate3 and nothing else, because anvil has none
  Seed.s.sol                    markets, trades and claims, in phases. Rig only
test/
  VerdantLaunch.t.sol           a launch, a trade, a fee claim, end to end
  Deploy.t.sol                  runs Deploy.s.sol, then launches on its output
  Verify.t.sol                  every check in Verify.s.sol, shown failing
  ScriptEnv.t.sol               the only suite that may touch the environment
  fork/Launch.fork.t.sol        the launch path against the v4 deployed on 4663
  VerdantHook.permissions.t.sol real mining, and the address's permission bits
  ScheduleLib.vectors.t.sol     differential harness against the SDK vectors
  *Gas.t.sol                    the committed cost baselines
  utils/Abi.sol                 asserts absent functions against the built ABI
  utils/DeployHarness.sol       the deploy script, from the environment or injected
  utils/VerifyHarness.sol       the verifier, with its inputs injected
  utils/HookMiner.sol           CREATE2 salt search; absent at the pinned commit
```
