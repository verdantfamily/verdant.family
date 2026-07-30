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
forge coverage
```

The snapshot scripts wrap `forge snapshot --match-contract ScheduleLibGasTest`
rather than calling it bare. A whole-project snapshot would include fuzz averages
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

```
src/
  libraries/ScheduleLib.sol     P1 — the fee-schedule primitive
test/
  Remappings.t.sol              P0 — proves imports resolve, pins upstream constants
  ScheduleLib.vectors.t.sol     P1 — differential harness against the SDK vectors
  ScheduleLib.t.sol             P1 — validation, fuzz, invariants
  ScheduleLibGas.t.sol          P1 — gas baseline at 1/3/8 stages
```
