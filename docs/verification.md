# Verdant — verification record (V1–V16)

Status of every blocking question in `Implementation Architecture v0.1` §0.2 and §26.

Last updated 30 July 2026. Probes are read-only; no key was used and no transaction was
sent. Re-run the chain probes with `pnpm chain:probe`.

**Legend.** `RESOLVED` — closed with primary evidence. `OPEN` — not closed; method recorded.
`CARRIED` — resolved but re-opened as a design decision (see `REVIEW.md`).

---

## Summary

| # | Question | Status | Blocks |
|---|---|---|---|
| V1 | v4 on testnet 46630 | **RESOLVED — yes** | Testnet is authoritative; fork-only plan dropped |
| V2 | CREATE2 deployer on both chains | **RESOLVED — yes** | Hook mining; `VerdantCreate2Factory` dropped |
| V3 | Canonical mainnet WETH | **RESOLVED** | Only if D4 reverses |
| V4 | Native-ETH v4 pools first-class | **RESOLVED — dominant** | D4 confirmed |
| V5 | Third-party routers vs hooked dynamic-fee pools | **OPEN — test written, awaiting its first run** | Whether `VerdantRouter` needs to exist at all |
| V6 | ArbOS version and `block.timestamp` drift bound | **OPEN (partial)** | 300 s minimum stage gap margin |
| V7 | `block.number` is the L1 block number | **RESOLVED — confirmed** | Ban on `block.number` |
| V8 | Blockscout programmatic verification | **OPEN (encouraging)** | Automated verify in deploy script |
| V9 | Atomic creation gas ceiling | **RESOLVED — 3.2M of a 32M per-tx limit** | One transaction, confirmed |
| V10 | Ponder on 4663 | **OPEN — RPC log cap now known** | Ponder vs Envio; range splitting |
| V11 | `sender` in `beforeAddLiquidity` | **RESOLVED — PositionManager; implemented, ADR-006** | Liquidity-restriction mechanism |
| V12 | `V4Quoter` reflects the fee override | **RESOLVED — yes, to the wei; `slot0.lpFee` proven stale** | Trade panel reads the quoter or the hook, never slot0 |
| V13 | Zero-liquidity decrease as fee collection | **RESOLVED — yes** | `collect()` implementation |
| V14 | Unbalanced `increaseLiquidity` with remainder | **RESOLVED — NO, refuted** | `reinforce()` redesign required |
| V15 | `BaseHook` suitability | **CLOSED — absent at the pin; ADR-004** | `IHooks` directly; `initialize` carries no `hookData` |
| V16 | Sequencer mempool and reorg depth | **OPEN** | Indexer finality depth; MEV disclosure |
| — | tickSpacing convention | **CARRIED** | `PoolKey` constant, frozen at audit |
| — | Deployment ordering / factory address | **RESOLVED — anchored, ADR-007** | `FactoryOrigin`; the deploy script is testable |
| — | Prior art on 4663 | **CARRIED** | Positioning; §0.3 and §2.2 |

---

## Chain baseline

Probed 30 July 2026.

| Field | Mainnet | Testnet |
|---|---|---|
| `eth_chainId` | `0x1237` = 4663 | `0xb626` = 46630 |
| `eth_blockNumber` at probe | 23 347 642 (`0x16441ba`) | 95 269 745 (`0x5adb371`) |
| `web3_clientVersion` | `nitro/v3.11.3-rc.5-4130f4c` | `nitro/v3.11.3-rc.5-4130f4c` |
| `ArbSys.arbOSVersion()` | 116 | 116 |
| `ArbSys.arbBlockNumber()` | agrees with L2 height | agrees with L2 height |
| header `l1BlockNumber` | 25 645 948 | 11 382 912 |
| `baseFeePerGas` at probe | ≈0.0202 gwei | ≈0.0100 gwei |
| header `gasLimit` | `0x4000000000000` (nominal) | `0x4000000000000` (nominal) |

The client string's architecture suffix is **not stable**: repeated probes returned
`linux-arm64` and `linux-amd64` for the *same* chain, so both endpoints are load-balanced
across a heterogeneous fleet. Only the `nitro/v3.11.3-rc.5-4130f4c` version portion should be
treated as a fact about the chain.

---

## V1 — Is Uniswap v4 deployed on Robinhood testnet 46630?

**RESOLVED: yes, at the same addresses as mainnet.**

Uniswap's published deployments page does not list chain 46630, which is what prompted this
question. The chain disagrees with the page.

```
eth_getCode against https://rpc.testnet.chain.robinhood.com
```

| Contract | Address | Mainnet | Testnet |
|---|---|---|---|
| PoolManager | `0x8366a39cc670b4001a1121b8f6a443a643e40951` | 24 009 B | 24 009 B |
| PositionManager | `0x58daec3116aae6d93017baaea7749052e8a04fa7` | 23 877 B | 23 877 B |
| V4Quoter | `0x8dc178efb8111bb0973dd9d722ebeff267c98f94` | 6 118 B | 6 118 B |
| StateView | `0xf3334192d15450cdd385c8b70e03f9a6bd9e673b` | 3 531 B | 3 531 B |
| Universal Router | `0x8876789976decbfcbbbe364623c63652db8c0904` | 24 546 B | 24 546 B |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` | 9 152 B | 9 152 B |

Negative controls proving the two RPCs are different chains and not one node: testnet WETH
`0x7943e237…` is 2 202 B on 46630 and absent on 4663; mainnet WETH `0x0Bd7D308…` is 2 202 B
on 4663 and absent on 46630.

**Decision unblocked.** Testnet 46630 is a canonical-v4 environment. Delete the
"deploy our own v4-core to testnet" branch and the "non-canonical v4" label in §10.4. §22
acceptance runs on 46630 as originally written.

## V2 — Is the canonical CREATE2 deployer present on 4663 and 46630?

**RESOLVED: yes, 69 bytes on both.**

`0x4e59b44847b379578588920cA78FbF26c0B4956C` — 69 bytes on 4663 and 69 bytes on 46630, the
expected size of the Arachnid deterministic deployer that Foundry uses by default.

**Decision unblocked.** Hook mining targets the canonical deployer, so a mined hook address
is reproducible across both chains. `VerdantCreate2Factory` is removed from the inventory
(§6.3) and from §10.1 step 1.

## V3 — Canonical mainnet WETH on 4663

**RESOLVED: `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73`** (2 202 bytes, symbol `WETH`,
18 decimals).

Three independent confirmations: `SwapRouter02.WETH9()` and
`NonfungiblePositionManager.WETH9()` both return it (recorded in
`robinhood-launchpad/docs/CHAIN-RECON.md`), and it is the second most common v4 `currency0`
on the chain by pool count (V4 below).

**Decision unblocked.** Nothing, unless D4 reverses. Recorded for that contingency.

## V4 — Does the 4663 ecosystem treat native-ETH v4 pools as first-class?

**RESOLVED: native ETH is the most common quote currency on the chain.**

All 1 566 `Initialize` events emitted by PoolManager in blocks 23 048 919 – 23 348 919
(300 000 blocks) were decoded. `Initialize` has three indexed parameters, so
`topics[1]` = pool id, `topics[2]` = `currency0`, `topics[3]` = `currency1`; `fee`,
`tickSpacing` and `hooks` are the first three words of `data`.

- `currency0 == address(0)` (native ETH): **788** (50.3%)
- `currency0 == WETH 0x0Bd7D308…`: 489 (31.2%)
- `currency0 == USDG 0x5fc5360d…`: 52
- `currency0 == SPCX 0x4a0e65a3…`: 38
- non-zero `hooks`: **721** (46.0%)
- `fee == 0x800000` (dynamic): **466** (29.8%)
- native ETH **and** dynamic fee **and** hooked: **6**

> A whole-chain query for this event returns `logs matched by query exceeds limit of 10000`,
> so there are more than 10 000 v4 pools on 4663. The 300 000-block window is a sample, not
> a census.

**Decision unblocked.** D4 (`currency0 = address(0)`) is confirmed as the ecosystem norm, not
a bet. The WETH reversal path and token-salt mining are not needed. What remains of V4 —
whether the Uniswap *interface* renders a Verdant pool — is cosmetic and folded into V5.

## V5 — Do third-party routers correctly quote and execute against hooked, dynamic-fee pools on 4663?

**OPEN.** Partly de-risked: 721 hooked and 466 dynamic-fee pools were created in a
300 000-block window on this chain, so routers here demonstrably handle both. That is
circumstantial, not a test of Verdant's own pool.

**Method, now implemented.** `test_aThirdPartyRouterChargesTheScheduledFee` in
`test/fork/Launch.fork.t.sol` launches a market on a 4663 fork and swaps through the
Universal Router at `0x8876789976dEcBfCbBbe364623C63652db8C0904`, asserting the tokens
received equal what the quoter predicts.

Two details make it the right test rather than a plausible one. It runs **after a stage
transition**, because that is the case a router can get wrong while looking correct: the
pool's stored fee stays at stage 0 forever (V12), so a router consulting `slot0` instead
of executing the hook would charge 1% where the schedule says 0.3%, and a test at the
opening stage would pass either way. And it compares against the quoter, which is only
legitimate because V12 established the quoter agrees with an executed swap to the wei.

The comparison against a `VerdantRouter` that the original method called for is dropped,
because the point of the question is whether that contract needs to exist. If the
Universal Router is correct here, every wallet and aggregator already routing through it
works with no further work, and building a router would add audit surface to no end. If
it is wrong, the router becomes necessary and its absence is the finding.

The test is written, compiles, and lints clean; it has not been run against the chain
yet, so this stays open until it has. Phase P6 in the original plan; brought forward
because it is the only open question that could still require new contract code.

## V6 — ArbOS version and `block.timestamp` drift bound

**OPEN (partial).**

Resolved: the client is `nitro/v3.11.3-rc.5-4130f4c` and `ArbSys.arbOSVersion()` returns
`0x74` = 116. EIP-1153 transient storage works, established by the fact that v4 is deployed
and actively used here and v4 requires TSTORE — an inference from deployment, as §0.1 says,
not from a Robinhood document.

Not resolved: the actual L2/L1 timestamp drift bound that justifies the 300-second minimum
stage gap. Also unconfirmed is the `arbOSVersion()` convention of returning `55 + version`,
which would imply ArbOS 61; that mapping should be checked rather than assumed, since
nothing else depends on it and it is easy to get wrong.

**Method to close.** Read `ArbOwnerPublic` / `ArbSys` for the version, then confirm the drift
bound against Nitro's documented sequencer behaviour for this ArbOS version, and sample
`block.timestamp` monotonicity over a few thousand blocks. Phase P1.

## V7 — Does `block.number` return the L1 block number?

**RESOLVED: confirmed.**

A single mainnet block header carries both counters:

```
eth_getBlockByNumber("latest") →
  number:        0x1644499  = 23 348 377   (L2 height)
  l1BlockNumber: 0x187537c  = 25 645 948   (what block.number returns in the EVM)
  timestamp:     0x6a6b505e = 2026-07-30T13:23:42Z
```

`ArbSys.arbBlockNumber()` returned 23 348 372 on a call moments earlier, agreeing with
`number` and confirming that `eth_blockNumber` is the L2 height while `block.number` inside a
contract is the L1 number.

**The drift rate is measured, not assumed.** Two probes 21 705 L2 blocks apart:

| | first probe | second probe | advance |
|---|---|---|---|
| L2 height | 23 348 377 | 23 370 082 | **21 705** |
| `l1BlockNumber` | 25 645 948 | 25 646 130 | **182** |

So `block.number` advances **≈119× slower** than the L2 clock (21 705 / 182). A fee schedule
keyed on `block.number` with offsets chosen in L2 blocks would therefore run roughly 119×
long — a two-hour stage would last about ten days.

**Why the bug would be silent on mainnet.** The two counters are within ~10% of each other
(23.3M against 25.6M), so the wrong one still looks like a plausible block height. An
out-of-range value would be caught immediately; this would not.

**And why testnet would not catch it.** On 46630 the same two fields read 95 278 886 (L2) and
11 382 912 (`l1BlockNumber`) — a factor of 8.4 apart, not 10% — because the testnet settles to
a different, much younger L1. A `block.number` bug would look obviously wrong on testnet and
almost right on mainnet, which is the worst possible arrangement. Hence the outright ban
rather than a test.

**Decision unblocked.** The ban on `block.number` stands and both measured numbers go into
the `ScheduleLib` comment so the reason survives.

## V8 — Does Blockscout support programmatic standard-JSON verification here?

**OPEN, encouraging.** Both deployed v4 contracts are fully verified on Blockscout with
complete multi-file source bundles (45 files for PoolManager, 71 for PositionManager), solc
`v0.8.26+commit.8a97fa7a`, which is strong evidence the verifier handles standard-JSON
multi-contract input. `forge verify-contract --verifier blockscout` has not itself been run.

**Method to close.** Run `forge verify-contract` against a real testnet deployment. Phase P6.

## V9 — Does atomic create-token + init-pool + mint-position fit under the gas ceiling?

**RESOLVED: yes, with a factor of eight to spare in the worst case the bounds allow.**
The header's `gasLimit` of `0x4000000000000` (1.125 × 10¹⁵) is Arbitrum's nominal
per-block figure and is not the binding constraint. The binding one is the per-transaction cap, which `ArbGasInfo` at
`0x…006C` reports directly:

```
eth_call 0x…006C getGasAccountingParams() ->
  speedLimitPerSecond  7 000 000
  gasPoolMax          32 000 000
  maxTxGasLimit       32 000 000
```

Identical on both chains, and now printed by `pnpm chain:probe`. Measured against the
PoolManager and PositionManager actually deployed on 4663 rather than this repo's build
of them, a launch costs **3 275 941 gas** — about 10% of what one transaction may spend.
At the ≈0.02 gwei base fee observed at probe time that is on the order of 0.00007 ETH
plus the L1 data component, which `eth_estimateGas` folds into the returned units on
Nitro.

Reading the header's figure as the limit would have made this question look answered
without answering it, which is why the probe now prints both and labels which is which.

The worst case the bounds permit is measured too, because a ceiling is only cleared by
the most expensive thing that can reach it:
`test_theMostExpensiveLaunchTheBoundsAllowStillFits` launches with eight stages (the
packing maximum, which writes ScheduleLib's second word), the maximum creator allocation
with a real cliff and duration so a `TokenVesting` is deployed and funded, and name,
symbol and metadata URI all at their maximum lengths with the metadata left mutable. Each
of those is read from a bound rather than chosen, so the number it logs is the ceiling of
what any creator can spend: **4 104 701 gas**, or 12.8% of the cap.

That is the figure to reason with, not the 3.27M of a typical launch. The gap between
them — 829k, a quarter again — is one extra schedule word and a `TokenVesting`
deployment, and it is the whole cost of every bound being at its maximum
simultaneously. The cap is clear by a factor of nearly eight, so no combination of
parameters a creator can choose comes close to it, and no future addition to the launch
path threatens it without roughly septupling the cost of creation.

Both figures come from `test/fork/Launch.fork.t.sol`, which asserts them against the 32M
cap, so they stop being local estimates and stay measured on every run of the fork
profile.

## V10 — Ponder's sync performance and reorg behaviour on 4663

**OPEN, but the RPC's shape is now known.** The public endpoint caps `eth_getLogs` at
**10 000 matched logs per query**, and refuses wide spans by timing out against the node
behind it:

```
1 000 blocks,  PoolManager only  -> 972 logs, ok
10 000 blocks, PoolManager only  -> "logs matched by query exceeds limit of 10000"
77 000 blocks, PoolManager only  -> upstream i/o timeout
```

Two things follow. The cap is on *matched* logs rather than block span, so an indexer
filtered to Verdant's own addresses — which will emit a tiny fraction of what the whole
PoolManager does — can use far wider ranges than these numbers suggest. And range
splitting on that error is mandatory regardless of filter, which Ponder already does by
halving. So the public RPC looks sufficient, and a paid provider is not a prerequisite.

**Method to close.** Run Ponder against 4663 for 24 h on an existing high-traffic contract;
record cold-sync time and observed reorg depth. Phase P8.

## V11 — What is `sender` in `beforeAddLiquidity` when minting through PositionManager?

**RESOLVED: `sender` is the `PositionManager`. Authenticate with a pinned `sender` plus
`IMsgSender.msgSender()`. `hookData` survives the path intact but is not a credential.**

Implemented and recorded in
[`docs/decisions/006-msgsender-authenticates-liquidity.md`](decisions/006-msgsender-authenticates-liquidity.md);
the three checks and what each one rules out are stated there.

All line numbers below are from the vendored, pinned copies — v4-periphery `3c31961fb9`,
v4-core `59d3ecf53afa` — which are the deployed bytecode on 4663. Every quotation was read
from those files, not from upstream `main`, except where explicitly marked.

### The call path, and where the original caller is lost

| step | file | line | what happens |
|---|---|---|---|
| 1 | `PositionManager.sol` | 173–179 | `modifyLiquidities` enters under `isNotLocked`, which sets the transient locker to `msg.sender` — the real initiator |
| 2 | `PositionManager.sol` | 195–225 | `_handleAction` decodes `INCREASE_LIQUIDITY` / `MINT_POSITION` and calls `_increase` / `_mint` |
| 3 | `PositionManager.sol` | 501–514 | `_modifyLiquidity` calls `poolManager.modifyLiquidity(...)` — **the initiator is not among the arguments** |
| 4 | `PoolManager.sol` | 156 | `key.hooks.beforeModifyLiquidity(key, params, hookData)` |
| 5 | `Hooks.sol` | 201–202 | the hook is called with **`msg.sender`**, which at this point is the PositionManager |

Step 5, quoted from `lib/v4-core/src/libraries/Hooks.sol`:

```solidity
if (params.liquidityDelta > 0 && self.hasPermission(BEFORE_ADD_LIQUIDITY_FLAG)) {
    self.callHook(abi.encodeCall(IHooks.beforeAddLiquidity, (msg.sender, key, params, hookData)));
```

`IHooks` documents the parameter as "the initial msg.sender for the add liquidity call", which
is true of the call into the PoolManager and misleading about the transaction. v4-core's own
test asserts the router address, not the user:

```solidity
bytes memory beforeParams = abi.encode(address(modifyLiquidityRouter), key, LIQUIDITY_PARAMS, ZERO_BYTES);
```

The same address is used as the position owner in pool state (`PoolManager.sol` 159–167 passes
`owner: msg.sender`), so from the pool's point of view the PositionManager is the LP and the
user is a detail it never sees.

**Consequence for the architecture document.** §7.3's allowlist of `{factory, locker}` compared
against `sender` is unreachable: it would reject every legitimate Verdant mint, since `sender`
is always the PositionManager. This is the finding that made V11 a P3 blocker.

### Does `hookData` survive the path?

**Yes, byte for byte, and it cannot be silently altered.**

`hookData` is decoded as a *calldata slice* rather than copied — `CalldataDecoder.toBytes`
(lines 365–385) sets `res.offset` and `res.length` into the original calldata and does no
transformation. It is then passed unchanged through `_increase`/`_mint` → `_modifyLiquidity`
→ `poolManager.modifyLiquidity` → `Hooks.beforeModifyLiquidity` → the hook.

The failure mode is a revert, not truncation: `toBytes` bounds-checks the slice against the
enclosing calldata and reverts `SliceOutOfBounds`, and `decodeActionsRouterParams` enforces a
strict ABI layout. So a hook receiving `hookData` receives exactly what the caller encoded.

**And that is precisely why it is not a credential.** It survives intact because it is a
verbatim copy of caller-supplied bytes. Any value a legitimate caller can put there, an
attacker can put there too. `hookData` is a data channel; treating "it arrived unmodified" as
"it arrived from someone trustworthy" is the mistake this section exists to prevent.

### `IMsgSender` — present at the pinned commit

v4-periphery ships an interface for exactly this loss of context, and the **deployed**
PositionManager implements it. `src/interfaces/IMsgSender.sol`:

```solidity
/// @notice Interface for contracts that expose the original caller
/// @dev Uniswap v4 periphery contracts implement a callback pattern which lose
/// the original msg.sender caller context. This view function provides a way for
/// integrating contracts (e.g. hooks) to access the original caller address.
interface IMsgSender { function msgSender() external view returns (address); }
```

`BaseActionsRouter` declares it (`abstract contract BaseActionsRouter is IMsgSender, SafeCallback`)
and `PositionManager` implements it at lines 191–193:

```solidity
function msgSender() public view override returns (address) {
    return _getLocker();
}
```

The locker is transient storage, set on entry and cleared on exit (`ReentrancyLock`):

```solidity
modifier isNotLocked() {
    if (Locker.get() != address(0)) revert ContractLocked();
    Locker.set(msg.sender);
    _;
    Locker.set(address(0));
}
```

The lifetime is what makes this usable: the unlock callback, and therefore the hook call, runs
inside the modifier's body, so during `beforeAddLiquidity` the locker is still set to whoever
entered `modifyLiquidities`. Both entry points carry `isNotLocked` — `modifyLiquidities`
(line 173) and `modifyLiquiditiesWithoutUnlock` (line 182) — so there is no way to reach the
liquidity path with an unset or stale locker. `packages/contracts/test/Remappings.t.sol` asserts
the interface resolves against the pinned copy, so a dependency bump that removed it fails in CI.

### A secondary binding: the NFT exists before the hook runs

In `_mint` the receipt token is minted at line 368, *before* `_modifyLiquidity` at line 383, and
the position salt is the token id:

```solidity
_mint(owner, tokenId);
// ...
(BalanceDelta liquidityDelta,) =
    _modifyLiquidity(info, poolKey, liquidity.toInt256(), bytes32(tokenId), hookData);
```

`INCREASE_LIQUIDITY` uses `bytes32(tokenId)` for the existing token as well (lines 298–300).
So a hook can read `uint256(params.salt)` as a token id and query `ownerOf` on it during the
callback, which proves where the liquidity is *going* rather than only who asked.

### How Uniswap's Permissioned Pools solves the same problem

Same problem, and worth reading because it is the only production answer available.

**Provenance, stated plainly:** Permissioned Pools is **not present at the pinned commit** —
`vendor/v4-periphery/src/hooks/` does not exist there. Upstream `main` has
`src/hooks/permissionedPools/` (adapter, factory, permissioned position manager and router),
and the *hook* itself lives in a different repository, `Uniswap/v4-hooks-public`. The code below
was fetched from that repository's `main` branch and is **not** part of any pinned dependency;
treat it as prior art that was read, not as a dependency that was verified.

Its `beforeAddLiquidity` does not use `hookData` and does not read the NFT owner. It resolves
the LP by calling back into `sender`:

```solidity
function _beforeAddLiquidity(address sender, PoolKey calldata key, ModifyLiquidityParams calldata, bytes calldata)
    internal view override returns (bytes4 selector)
{
    selector = IHooks.beforeAddLiquidity.selector;
    _verifyAllowlist(IMsgSender(sender), key, selector);
}

function _verifyAllowlist(IMsgSender sender, PoolKey calldata poolKey, bytes4 selector) internal view {
    address msgSender = sender.msgSender();
    _isAllowed(Currency.unwrap(poolKey.currency0), msgSender, address(sender), selector);
    _isAllowed(Currency.unwrap(poolKey.currency1), msgSender, address(sender), selector);
}
```

and the check that makes that trustworthy:

```solidity
if (
    !IPermissionsAdapter(permissionsAdapter).isAllowed(sender, permission)
    || !IPermissionsAdapter(permissionsAdapter).allowedWrappers(router)
) revert Unauthorized();
```

The technique, reduced to its load-bearing part: **`IMsgSender(sender).msgSender()` for identity,
and a check that `sender` itself is a registered wrapper.** The second half is not decoration.
`msgSender()` is a value reported by `sender`, so any contract can implement the interface and
return whatever address it likes; the registry is what stops an attacker from deploying a
contract that claims to have been called by an allowlisted LP. Uniswap says so in the contract's
own comment: *"Trusts wrapper-reported `msgSender()`; wrappers must be registered in adapter
`allowedWrappers`."*

Verdant borrows that technique and nothing else. ADR-003 rejects the adapter, the wrapper token,
the permissioned position manager, and the admin unwind power.

### Recommended mechanism for Verdant

Three assertions in `beforeAddLiquidity`, in this order:

1. `msg.sender == POOL_MANAGER` — the callback came from the pool manager and not from someone
   calling the hook directly.
2. `sender == POSITION_MANAGER` — an immutable on the hook, pinned to the one deployed periphery
   contract whose implementation has been read.
3. `IMsgSender(sender).msgSender() == LOCKER` — a single immutable address, not a set.

Assertion 2 is what makes 3 sound, and it is the same insight as Uniswap's `allowedWrappers`
check: without it, `msgSender()` is a claim made by an arbitrary contract. With `sender` pinned
to one immutable address, the claim comes from code that has been read at a known commit.

Verdant's requirement is narrower than the standard's — exactly one address may ever add
liquidity — so where Permissioned Pools needs an adapter and a registry, Verdant needs one
equality check. That asymmetry is most of the argument in ADR-003.

**Recommended in addition, not instead:** `IERC721(sender).ownerOf(uint256(params.salt)) == LOCKER`.
It costs one external call and proves the position's *destination*, which assertions 1–3 do not.
The reason to want both is that they fail differently: 1–3 establish provenance, and this
establishes that the liquidity lands somewhere Verdant controls.

**Tradeoffs, stated so they are not discovered later:**

- **The PositionManager address is frozen into the hook.** If Uniswap deploys a new
  PositionManager on 4663, Verdant pools will reject liquidity through it until a new hook is
  mined — and the hook cannot be upgraded. This is a deliberate consequence of the immutability
  guarantee, not an oversight, but it must be disclosed: Verdant's pools are permanently bound
  to one periphery deployment. The mitigation is that Verdant's own locker is the only party that
  ever needs to add liquidity, so a new PositionManager affects new markets rather than existing
  ones.
- **It depends on periphery behaviour, not just on an interface.** `msgSender()` returning the
  locker depends on `ReentrancyLock` keeping the locker set across the unlock callback. That is
  true of the pinned implementation, verified above, and it is not guaranteed by the interface.
  A fork test against 4663 must assert it against deployed bytecode rather than against the
  vendored source (P3).
- **It authenticates provenance, not intent.** The check proves the Verdant locker initiated the
  call. It says nothing about whether the locker *should* have. Access control inside the locker
  remains load-bearing, and this mechanism must not be mistaken for it.
- **Third-party liquidity is impossible by construction.** No router, aggregator, or user can add
  liquidity to a Verdant pool. That is the intent — it is what makes the lock meaningful — but it
  means Verdant pools will not appear as addable in any third-party LP interface, and the failure
  will look like a bug to anyone who tries.

**Rejected: authenticating via `hookData`.** It survives the path intact, and it is caller-supplied
either way. Unforgeable transport of forgeable content.

## V12 — Does `V4Quoter` reflect the `beforeSwap` fee override?

**RESOLVED — the quoter is honest, and `slot0` is not.** Confirmed against the quoter
deployed at `0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94` on 4663 by
`test_theQuoterSeesTheHooksFeeAndAgreesWithTheSwap`: a quote taken and then the same
swap executed, with nothing touching the pool in between, agree **exactly**. Not
approximately — to the wei. A quoter reading the pool's stored fee would have returned a
plausible number and disagreed by the ratio of 10 000 to 3 000.

The original reasoning, which the test now replaces as evidence: the quoter simulates a
real swap, and deployed `Hooks.beforeSwap`
parses the override for any dynamic-fee pool (line 263, below). Still requires the fork test
the document asks for.

**Method to close.** Fork test: quote, `vm.warp` across a stage transition, quote again,
assert both match `hook.feeAt`. Phase P6.


### What `slot0.lpFee` says, and why nothing may trust it

Established by the fork suite, on its first run, by getting it wrong.

`VerdantHook.beforeSwap` returns `feePpm | LPFeeLibrary.OVERRIDE_FEE_FLAG`. An override
applies to the swap it is returned from and **does not write the pool's stored fee**. So
`slot0.lpFee` holds whatever `afterInitialize` set at the open — stage 0's fee — for the
rest of the market's life, however many transitions the schedule passes through.

The fork test asserted the transition by reading `slot0` and failed with
`10000 != 3000`, having concluded the schedule had not moved. What had actually happened
is that the deployed PoolManager charged 3 000 and recorded nothing. The corrected test
measures the fees two swaps really earn on either side of the boundary and compares
their ratio, which is also the only form of the assertion that shows the *deployed*
PoolManager honours the override at all.

Consequences for anything that displays a fee:

- **`StateView` and any `slot0` read give the opening fee, forever.** The obvious way to
  build a trade panel is wrong, and it is wrong quietly — it shows a plausible number.
- **`V4Quoter` is the honest source, confirmed on chain.** It simulates the swap, so
  `beforeSwap` runs and the override applies. `test_theQuoterSeesTheHooksFeeAndAgreesWithTheSwap`
  takes a quote and then executes that same swap with nothing touching the pool in
  between, and the two agree to the wei.
- **`VerdantHook.feeAt(poolId, timestamp)` is the authority**, and it takes a timestamp,
  so a preview across a boundary can quote both sides honestly.

`test/fork/Launch.fork.t.sol` pins the stale value with an explicit assertion, so that a
future reader who finds `slot0.lpFee` and assumes it is live has a test telling them
otherwise.
## V13 — Does a zero-liquidity `decreaseLiquidity` collect fees, and at what cost?

**RESOLVED: yes, stated explicitly in the deployed source.**

```
288:    /// @dev Calling increase with 0 liquidity will credit the caller with any underlying fees of the position
335:    /// @dev Calling decrease with 0 liquidity will credit the caller with any underlying fees of the position
```

`_decrease` is gated by `onlyIfApproved(msgSender(), tokenId)`, which the locker satisfies as
owner of the position NFT.

**Additional finding worth encoding as a claim.** With `liquidityDelta == 0`, the
`beforeModifyLiquidity` branch at deployed `Hooks.sol` line 203 routes to
`beforeRemoveLiquidity` — a permission `0x3880` deliberately excludes. Therefore **no Verdant
hook callback runs during fee collection at all.** §19.14 can state this outright.

Gas cost not yet measured; deferred to P4's snapshot.

## V14 — Does `increaseLiquidity` accept unbalanced maxima and return the remainder?

**RESOLVED: NO. The premise is refuted.** This invalidates `reinforce()` as specified in
§7.5 and §5.2. See `REVIEW.md` §2.1 for the full analysis.

`INCREASE_LIQUIDITY` takes an explicit **liquidity** amount; the maxima are revert-only
slippage ceilings, not fill limits:

```
289:    function _increase(
            uint256 tokenId, uint256 liquidity,
            uint128 amount0Max, uint128 amount1Max, bytes calldata hookData
        ) internal virtual onlyIfApproved(msgSender(), tokenId) {
302:        (liquidityDelta - feesAccrued).validateMaxIn(amount0Max, amount1Max);
```

`SlippageCheck.validateMaxIn` reverts rather than clamping:

```solidity
if (amount0 < 0 && amount0Max < uint128(uint256(-amount0)))
    revert MaximumAmountExceeded(amount0Max, uint128(uint256(-amount0)));
```

The action with the semantics the document assumed, `INCREASE_LIQUIDITY_FROM_DELTAS`
(which derives liquidity from available credit via `LiquidityAmounts.getLiquidityForAmounts`,
deployed line 319), is deprecated in the deployed code, twice:

```
202:            } else if (action == Actions.INCREASE_LIQUIDITY_FROM_DELTAS) {
203:                // DEPRECATED - vulnerable to sandwich attacks, do not use. See _increaseFromDeltas().
```

with the sibling comment on `_mintFromDeltas` naming the attack: *"If the price is
manipulated, fewer tokens are used (the rest are swept back), less liquidity is minted, and
the max check never triggers."*

**Consequence.** `reinforce()` must compute liquidity itself from `slot0.sqrtPriceX96` and
the reserve amounts, which reintroduces spot-price dependence inside a permissionless
function. `minLiquidityOut` becomes sandwich protection rather than a dust guard, and is
circular if derived from the same spot price. The "no swap, remainder stays in reserve"
guarantee remains deliverable, but via taking unspent credit after an explicit-liquidity
increase — not via partial fill.

**Blocked until decided (P4 prerequisite).** A written sandwich analysis and a non-circular
`minLiquidityOut` policy. Candidate policy: require spot to sit inside the position's tick
range so a price pushed outside makes `reinforce()` revert rather than mint single-sided at a
manipulated price.

## V15 — Is `BaseHook` a safe base for the hook?

**RESOLVED: the question is moot. `BaseHook` no longer exists in v4-periphery.**

Upstream `v4-periphery` `main` @ `3245c3cb99c4` ships 69 Solidity files under `src/`. The only
path containing "Hook" is `src/interfaces/external/IHookStats.sol`. There is no
`BaseHook.sol` at `src/utils/`, `src/base/hooks/` or `src/` (all three probed, all 404), and
**no `HookMiner.sol` anywhere**.

**Decisions unblocked.**

- The hook implements `IHooks` directly. This aligns with §4.1 anyway: `BaseHook`'s value is
  its custody and settlement helpers, and Verdant's hook takes no custody and settles
  nothing.
- The mining script must include its own miner: a salt loop asserting
  `uint160(addr) & 0x3FFF == 0x3880` against
  `keccak256(0xff ‖ deployer ‖ salt ‖ keccak256(initCode))`, with a unit test that a mined
  address really has the target bits. `VanityAddressLib.sol` and
  `UniswapV4DeployerCompetition.sol` exist but score vanity addresses and are not
  substitutes.
- P0 must pin `v4-core` and `v4-periphery` to commits matching the deployed bytecode rather
  than tracking `main`.

**Closed in P3.1, and confirmed against the pin rather than against `main`.**
`find packages/contracts/vendor/v4-periphery -name BaseHook.sol` returns nothing at
`3c31961fb9` either, so the file is absent from both the deployed commit and current `main`.
The decision and the reasoning that would have applied had it existed are recorded in
[ADR-004](decisions/004-ihooks-not-basehook.md). `HookMiner` is likewise absent and is
reimplemented in `packages/contracts/test/utils/HookMiner.sol` — 40 lines against the CREATE2
address formula, with tests that a mined address carries the target bits and that mining is
deterministic.

One thing this probe did **not** anticipate, found while implementing: at the pinned commit
neither `IPoolManager.initialize(PoolKey, uint160)` nor
`IHooks.beforeInitialize(address, PoolKey, uint160)` carries `hookData`. v4 removed it from
the initialise path. A hook therefore cannot receive configuration during initialisation, so
Verdant's factory writes the schedule in a separate `configure` call and `beforeInitialize`
refuses to let a pool exist unless a configuration is already present for its PoolId. Since
`PoolId` is a hash of the whole `PoolKey`, validating the key at configure time and requiring
a configuration at initialise time means the pool that comes into existence is necessarily
the pool whose key was checked.

## V16 — Sequencer mempool visibility and practical reorg depth

**OPEN.** Untouched. Affects the indexer's finality depth (§12.3 starts at 32 blocks) and the
honesty of the MEV disclosure in §19.11.

**Method to close.** Observe 4663 for reorgs over 24 h alongside the Ponder run; probe
whether the sequencer exposes pending transactions. Phase P8.

---

## Dependency pins (resolved exactly)

The review flagged that Verdant must build against the code actually deployed on 4663 rather
than upstream `main`. That correspondence has now been established exactly.

The deployed `PositionManager` source is **byte-for-byte identical** to
`Uniswap/v4-periphery` @ **`3c31961fb9`** (2026-03-13, *"Add warning comments to deltas
functions (#517)"*). That commit's submodule pointers give the rest:

| Dependency | Pin | Evidence |
|---|---|---|
| `v4-periphery` | `3c31961fb9` | Deployed `PositionManager.sol` diffs clean against it |
| `v4-core` | `59d3ecf53afa` | `lib/v4-core` submodule of periphery @ `3c31961fb9` |
| `permit2` | `cc56ad0f3439` | `lib/permit2` submodule of periphery @ `3c31961fb9` |

Deployed `PoolManager.sol` and `Hooks.sol` are byte-identical to `v4-core` `main`
(@ `46c6834698c4`) as well, so core has not moved on those files since the pin.

**How the deployed periphery differs from current `main`** (@ `3245c3cb99c4`), i.e. what
Verdant must *not* assume exists on 4663:

1. **No `ModifyPosition` event.** Upstream `main` emits
   `ModifyPosition(poolId, msgSender, tickLower, tickUpper, liquidityDelta, salt)` from
   `_modifyLiquidity` and `_burn`. The deployed contract **does not emit it at all**. Any
   indexing plan that reaches for a PositionManager-level liquidity event will find nothing.
   Index `ModifyLiquidity` from PoolManager instead, which is what §12.2 already specifies —
   so this is a confirmation of that choice rather than a change, but it would have been a
   silent dead end.
2. **No `virtual` on the internal mutators.** `main` marks `_increase`, `_decrease`, `_mint`,
   `_sweep` and `_pay` `virtual` so `PermissionedPositionManager` can override them. The
   deployed contract does not. This dates the deployment to before Permissioned Pools
   (`363226d9e1`, 2026-05-27) and confirms that **the permissioned-pool pattern postdates the
   PositionManager on 4663** — see the note below.

Supporting evidence for the V11 resolution: v4-periphery at the pinned commit ships
`test/mocks/MockMsgSenderHook.sol`, i.e. the `IMsgSender`-from-a-hook pattern is exercised by
Uniswap's own test suite. The pinned commit also confirms V15 independently — its `src/` tree
contains neither `BaseHook.sol` nor `HookMiner.sol`.

---

## Carried forward as design decisions

These were not in V1–V16 but emerged from the same evidence. Full treatment in `REVIEW.md`.

### tickSpacing convention — RESOLVED, see ADR-001

Observed in the same 1 566-pool window:

- 200: **1 212**
- 8: 67
- 60: **52**
- 1: 22
- ≈18 000–19 988: ~85 combined

The architecture document's 60 is a distant third. **Resolved in
[`docs/decisions/001-tick-spacing.md`](decisions/001-tick-spacing.md): `TICK_SPACING = 200`**,
which also moves the usable ticks to ±887 200. Applied in `packages/config` and
`VerdantConstants.sol`, with alignment asserted against `TickMath` in both languages.

### Prior art on 4663 — Doppler

§0.3 declines to claim prior art exists. It does, specifically.

The most-used hook on the chain, `0x4e3468951d49f2eea976ed0d6e75ffcb44a9a544`, is verified on
Blockscout as **`DopplerHookInitializer`** (solc 0.8.26) and initialized **578** pools in the
window — 80% of all hooked pools in that period. Its permission bits are `0x2544`:

`beforeInitialize | afterAddLiquidity | afterRemoveLiquidity | afterSwap | afterSwapReturnsDelta`

That is a hook taking deltas inside the swap path — the design §5.3 rejects. Two further
in-swap-delta hooks appear in the window: `0x5cf8e499…65dc` (`0x25dc`) and
`0x48b8f6ad…e8cc` (`0x28cc`).

Also relevant, from the earlier launchpad recon: several `BondingCurve` contracts and
"Hood/Quiver/Stonk Launchpad" deployments already exist on 4663.

Action: read the verified Doppler source before P3, and add a positioning paragraph naming it.

### Uniswap's permissioned-pool pattern — RESOLVED, see ADR-003

Upstream v4-periphery `main` ships `src/hooks/permissionedPools/` (`PermissionsAdapter`,
`PermissionsAdapterFactory`, `PermissionedPositionManager`, `BaseAllowListChecker`,
`IAllowlistChecker`, `PermissionFlags`); the hook itself lives in `Uniswap/v4-hooks-public`.
None of it is present at the pinned commit, and the deployed 4663 bundle is the standard
`PositionManager`.

**Rejected in [`docs/decisions/003-reject-permissioned-pools.md`](decisions/003-reject-permissioned-pools.md)**
— the adapter admin can call `unwindPosition` on an LP's position, which is exactly the lever
Verdant's disclosure position (§6.2, D5) states does not exist. Its LP-identity technique is
borrowed and recorded in V11 above; nothing else is taken.

### `IMsgSender` is in the deployed bytecode, not just the pinned source — CONFIRMED

V11 established the mechanism by reading the pinned v4-periphery source, and the pin
itself was established by diffing Blockscout's verified bundle. That is one inference
away from the thing Verdant depends on. Asked of the deployed contract directly:

```
eth_call 0x58daec31…04fa7  msgSender()   -> 0x00…00   (present; transient slot empty)
eth_call 0x58daec31…04fa7  poolManager() -> 0x8366a39c…40951
```

A dispatcher without that selector reverts, so a successful call **is** the presence
of the function. The zero address is the expected answer outside a transaction. The
second call closes the pair: the deployed PositionManager names the deployed
PoolManager Verdant pins, rather than the two merely both having code.

Both are now in `pnpm chain:probe`, and a missing `msgSender()` is a hard probe
failure rather than an observation — without it ADR-006's liquidity guard has no
mechanism and Verdant cannot be deployed against that PositionManager at all.

### Deployment ordering, and why the factory's address is not predicted — RESOLVED, see ADR-007

Three contracts (`MarketRegistry`, `VerdantDeployer`, `VerdantHook`) take the factory's
address in a constructor, so the factory is deployed last and its address must be known
first. The question was how to know it.

Two facts settle it:

1. **A contract's nonce starts at 1 and only moves when it creates** (EIP-161). An
   account's nonce moves on every transaction. So the offset that predicts a `CREATE`
   address from a test harness is legitimately different from the one that predicts it
   from an operator's account, and a nonce-offset prediction is a step that can only be
   exercised in production.
2. **The canonical CREATE2 deployer `0x4e59b448…4956C` is present in Foundry's test EVM
   at 69 bytes** — the same length probed on both Robinhood chains (V2). Verified by
   reading `.code.length` inside `forge test`.

Together they make a faithful test of the deployment possible: anchor the factory's
address to a fresh contract's first creation (`FactoryOrigin`), and reach the hook through
the same CREATE2 deployer by explicit call in both environments. `test/Deploy.t.sol` then
runs the real script and launches a real market on its output.

Note the second fact is the one that decides `_create2` over `new Hook{salt: ...}`: under
`--broadcast` Foundry routes a salted `new` through the deterministic deployer, and under
`forge test` it does not, so the mined salt would be right on chain and wrong in CI. The
explicit call is the same in both.

---

## Reproducing the probes

```bash
pnpm chain:probe          # chain id, height, client, and code at every pinned address
```

The v4 source citations were taken from Blockscout's verified bundles:

```bash
curl -s https://robinhoodchain.blockscout.com/api/v2/smart-contracts/0x8366a39cc670b4001a1121b8f6a443a643e40951
curl -s https://robinhoodchain.blockscout.com/api/v2/smart-contracts/0x58daec3116aae6d93017baaea7749052e8a04fa7
```

All line numbers in this document refer to those deployed bundles, not to upstream `main`.
