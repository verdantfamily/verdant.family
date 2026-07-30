# Verdant — architecture review of `Implementation Architecture v0.1`

Review date 30 July 2026 · Reviewer: implementing engineer · Status: pre-implementation

This review tests the claims and open questions in `Implementation Architecture v0.1`
against primary evidence: live read-only RPC against Robinhood Chain 4663 and 46630,
and the **verified deployed source** of Uniswap v4 on 4663.

The document asked for exactly this before any contract is written (§27 tasks 1–2), on
the grounds that four of the investigation items can invalidate architectural decisions.
Two of them did.

---

## 0. Method and epistemic note

Every claim below is either a probe output or a line of deployed source. Nothing is
inferred from documentation or from upstream `main` alone.

**Sources of truth used**

| Source | Identifier |
|---|---|
| Mainnet RPC | `https://rpc.mainnet.chain.robinhood.com` |
| Testnet RPC | `https://rpc.testnet.chain.robinhood.com` |
| Deployed PoolManager source | Blockscout verified, `0x8366a39cc670b4001a1121b8f6a443a643e40951`, solc `v0.8.26+commit.8a97fa7a`, optimizer on, 44 444 444 runs, 45 source files |
| Deployed PositionManager source | Blockscout verified, `0x58daec3116aae6d93017baaea7749052e8a04fa7`, solc `v0.8.26+commit.8a97fa7a`, optimizer on, 30 000 runs, 71 source files |
| Upstream `v4-core` | `main` @ `46c6834698c4` (2026-04-02) |
| Upstream `v4-periphery` | `main` @ `3245c3cb99c4` (2026-07-13) |

**Important methodological point.** The first pass of this review read upstream `main`.
That is *not* the code Verdant integrates with. All findings were then re-verified against
the Blockscout-verified deployed bundles, and **all line numbers cited below are from the
deployed source**, not from `main`.

That distinction turned out to matter. `v4-core` deployed here is byte-identical to `main`,
but the deployed `PositionManager` is **not** — `main` has since added a `ModifyPosition`
event and `virtual` modifiers that the deployed contract lacks. The deployed source is
byte-for-byte `v4-periphery` @ **`3c31961fb9`**, whose submodules pin `v4-core`
@ `59d3ecf53afa` and `permit2` @ `cc56ad0f3439`. Those are the pins P0 uses. Full detail,
including the indexing consequence of the missing event, is in `verification.md`.

**One correction to my own process, recorded because it changed a conclusion.** My first
scan of v4 `Initialize` events decoded `topics[1]` as `currency0`. `Initialize` has three
indexed parameters, so `topics[1]` is the pool id and `currency0` is `topics[2]`. The
mis-indexed scan reported **zero** native-ETH pools on 4663 and I briefly concluded that
decision D4 was unsupported by the ecosystem. Corrected, the same data shows native ETH is
the *most common* quote currency on the chain. The corrected numbers are in §1.4.

---

## 1. Contingencies that can be deleted

These are cases where the document hedges against a risk that does not exist. Each hedge
carries real cost — an alternative environment, an extra contract, a reversal path — and
each can now be removed.

### 1.1 V1 — Uniswap v4 **is** deployed on testnet 46630

The document's §0.2 states that chain 46630 is absent from Uniswap's deployments page and
plans for the possibility that Verdant must deploy its own v4-core to testnet and treat
forked mainnet as the only authoritative pre-production environment (§10.4 even reserves a
"non-canonical v4" label for it).

`eth_getCode` against **testnet 46630** returns code at every mainnet v4 address:

| Contract | Address | Code size, both chains |
|---|---|---|
| PoolManager | `0x8366a39cc670b4001a1121b8f6a443a643e40951` | 24 009 bytes |
| PositionManager | `0x58daec3116aae6d93017baaea7749052e8a04fa7` | 23 877 bytes |
| V4Quoter | `0x8dc178efb8111bb0973dd9d722ebeff267c98f94` | 6 118 bytes |
| StateView | `0xf3334192d15450cdd385c8b70e03f9a6bd9e673b` | 3 531 bytes |
| Universal Router | `0x8876789976decbfcbbbe364623c63652db8c0904` | 24 546 bytes |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` | 9 152 bytes |

Byte lengths are **identical on mainnet and testnet** for every contract, which is what
deterministic deployment of the same artifacts produces.

Two negative controls confirm these are genuinely distinct chains rather than one node
answering both URLs: the documented testnet WETH
`0x7943e237c7F95DA44E0301572D358911207852Fa` has 2 202 bytes on 46630 and **no code** on
4663, while the canonical mainnet WETH `0x0Bd7D308…` has 2 202 bytes on 4663 and **no code**
on 46630.

**Recommendation.** Delete the "deploy our own v4-core to 46630" branch and the
"non-canonical v4" label from §10.4. Testnet 46630 is a real environment with canonical v4
at canonical addresses, so §22's acceptance criteria can run there as originally intended.
The absence of 46630 from Uniswap's published deployments page is a documentation gap on
Uniswap's side, not a deployment gap — worth one sentence in `docs/verification.md` so the
next reader does not re-derive it.

### 1.2 V2 — the canonical CREATE2 deployer is present on both chains

`0x4e59b44847b379578588920cA78FbF26c0B4956C` returns 69 bytes of code on **both** 4663 and
46630. That is the expected length of the Arachnid deterministic deployer that Foundry uses
by default.

**Recommendation.** Delete `VerdantCreate2Factory` from the contract inventory and from
step 1 of §10.1. Hook mining targets the canonical deployer on both chains, which also
means a mined hook address is reproducible across environments.

### 1.3 V3 — canonical mainnet WETH

`0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73`, cross-checked three ways: your own earlier
`robinhood-launchpad/docs/CHAIN-RECON.md` read it from both `SwapRouter02.WETH9()` and
`NonfungiblePositionManager.WETH9()` and got the same address, and it independently appears
as the second-most-common v4 `currency0` on the chain (§1.4).

This only matters if D4 reverses, so it is recorded rather than acted on.

### 1.4 V4 — native ETH is the dominant quote currency, not a risk

The document treats `currency0 = address(0)` as a decision that external tooling might not
surface, and reserves a reversal to WETH with token-salt mining.

Decoding all 1 566 v4 `Initialize` events in a 300 000-block window on 4663
(blocks 23 048 919 – 23 348 919):

- `currency0 == address(0)` (native ETH): **788** — the single largest group
- `currency0 == WETH`: 489
- non-zero `hooks`: **721** (46%)
- `fee == 0x800000` (dynamic fee): **466** (30%)
- native ETH **and** dynamic fee **and** hooked: **6**

Native-ETH v4 pools are not an edge case on this chain; they are the norm. Hooks and
dynamic fees are both in heavy production use, which is the more important signal: the
machinery Verdant's whole design rests on is exercised daily by other protocols here.

The combination Verdant specifically needs — native ETH, dynamic fee, non-zero hook — is
rare in absolute terms (6 pools in the window). That is worth knowing but is not a red
flag; it reflects that most hooked pools on this chain are one incumbent's (§4.3) and it
pairs against WETH.

**Recommendation.** Keep D4. Reduce V4 from "blocks the currency decision" to "confirm the
Uniswap interface renders one Verdant pool", which is a launch-day nicety rather than an
architectural gate. The one part of V4 still genuinely open is whether third-party
*aggregators* quote these pools correctly, which is V5 and remains open (§5).

### 1.5 V7 — `block.number` is the L1 block number, confirmed

The latest mainnet block header carries both numbers at once:

- L2 height (header `number`): **23 348 377** — `ArbSys.arbBlockNumber()` returned
  23 348 372 on a separate call moments earlier, agreeing
- `l1BlockNumber` field in the same header: **25 645 948**

The document already forbids `block.number` and this confirms it. Two things are worth
promoting into a code comment.

First, the drift rate is now measured rather than reasoned about: across two probes the L2
height advanced 21 705 while `l1BlockNumber` advanced 182, so `block.number` runs **≈119×
slower** than the L2 clock. A two-hour stage keyed on it would last about ten days.

Second, and worse: on mainnet the two counters are within ~10% of each other, so the wrong one
still looks like a plausible block height. On testnet they are 8.4× apart (95 278 886 against
11 382 912, because 46630 settles to a much younger L1). A `block.number` bug would therefore
look obviously broken on testnet and almost right on mainnet — the worst possible arrangement,
and the reason this is a prohibition rather than something a test is expected to catch.

**Recommendation.** Keep the ban. Put the two measured numbers in the `ScheduleLib` comment
so the reason survives contact with a future maintainer.

---

## 2. Corrections that change contract design

These are the two findings the investigation was for.

### 2.1 V14 refuted — `reinforce()` as specified does not match the PositionManager API

**This is the most consequential finding in the review.**

The document specifies `reinforce()` in §7.5 and §5.2 as: pull the splitter's reserve
balances, call `increaseLiquidity` "with those amounts as maxima", and return the unused
remainder to reserve — with the explicit guarantee that "there is no swap: reinforcement
adds whatever ratio of ETH and token the reserve holds, up to the amounts the position's
range accepts, and leaves the remainder in reserve."

The deployed `PositionManager` does not offer those semantics.

`INCREASE_LIQUIDITY` takes an explicit **liquidity** amount. The `amount0Max` / `amount1Max`
parameters are not fill limits; they are revert-only slippage ceilings:

```
288:    /// @dev Calling increase with 0 liquidity will credit the caller with any underlying fees of the position
289:    function _increase(
        uint256 tokenId,
        uint256 liquidity,
        uint128 amount0Max,
        uint128 amount1Max,
        bytes calldata hookData
    ) internal virtual onlyIfApproved(msgSender(), tokenId) {
        ...
302:        (liquidityDelta - feesAccrued).validateMaxIn(amount0Max, amount1Max);
```

and `SlippageCheck.validateMaxIn` reverts rather than clamping:

```solidity
if (amount0 < 0 && amount0Max < uint128(uint256(-amount0))) {
    revert MaximumAmountExceeded(amount0Max, uint128(uint256(-amount0)));
}
```

So "pass the reserves as maxima and let the position take what it needs" is not a behaviour
that exists. Passing reserves as maxima with a liquidity figure that happens to need more
than the reserve holds does not partially fill — it reverts.

There *is* an action with exactly the semantics the document describes,
`INCREASE_LIQUIDITY_FROM_DELTAS`, which derives the liquidity from whatever credit is
available via `LiquidityAmounts.getLiquidityForAmounts` (deployed line 319). It is
explicitly deprecated, in two places, in the deployed code:

```
202:            } else if (action == Actions.INCREASE_LIQUIDITY_FROM_DELTAS) {
203:                // DEPRECATED - vulnerable to sandwich attacks, do not use. See _increaseFromDeltas().
```

and on the function itself:

```
/// @notice DEPRECATED: Vulnerable to sandwich attacks - do not use this function.
/// @dev Same issue as _mintFromDeltas -- the delta-based approach provides no minimum
/// liquidity protection. Use _increase() instead, which takes an explicit liquidity
/// amount with proper slippage protection.
```

The parallel comment on `_mintFromDeltas` spells out the attack precisely: *"If the price is
manipulated, fewer tokens are used (the rest are swept back), less liquidity is minted, and
the max check never triggers."*

**Consequences for Verdant.**

1. `reinforce()` must compute the liquidity figure itself:
   read `slot0.sqrtPriceX96`, then
   `LiquidityAmounts.getLiquidityForAmounts(sqrtPriceX96, sqrtLower, sqrtUpper, reserve0, reserve1)`,
   then call `INCREASE_LIQUIDITY` with that explicit liquidity and the reserves as maxima.
2. That computation reads the **current spot price**, which is the exact dependence the
   deprecation warning is about. Verdant would be reimplementing the deprecated path's
   risk in its own contract, in a function that is **permissionless by design** and driven
   by a keeper on a threshold.
3. `minLiquidityOut` is the right *shape* of mitigation, but the document justifies it as a
   dust/no-op guard ("reverts if liquidity added is below `minLiquidityOut`"), not as
   sandwich protection. As sandwich protection it is circular unless someone can choose the
   bound from a source the attacker does not control: if the keeper derives
   `minLiquidityOut` from the same manipulable spot price it just read, the guard adds
   nothing.
4. The "no swap, leaves the remainder in reserve" guarantee is still deliverable, but the
   mechanism is different from what §5.2/§7.5 describe: the remainder comes back by taking
   the unspent credit (`CLEAR_OR_TAKE` / `TAKE_PAIR`) after an explicit-liquidity increase,
   not because `increaseLiquidity` partially filled. The public-facing sentence stays true;
   the internal description does not.

**What this does not do.** It does not kill Evergreen and it does not touch the swap path.
The decoupling decision in §5.3 is vindicated: because reinforcement is out-of-band, this
entire problem is confined to one isolated, permissionless call that can revert without
affecting trading. That is the design working as intended.

**Recommendation.** Before any P4 code:

- Rewrite §7.5 and §5.2 to describe explicit-liquidity increase plus remainder-take.
- Write the sandwich analysis as a document deliverable, covering: what an attacker gains
  by moving the price before a `reinforce()` (they cause the reserve to be deployed at a
  skewed ratio into a position that cannot be withdrawn, so the loss is borne by locked
  liquidity and is not directly extractable by them — this needs to be established, not
  assumed), and what bound makes it uneconomic.
- Decide the `minLiquidityOut` policy explicitly. Candidate: derive the bound from the
  position's own tick range and the reserve amounts rather than from spot, and additionally
  require that spot sits within the position's range, so a price pushed outside the range
  makes `reinforce()` revert instead of minting single-sided at a manipulated price.
- Add an invariant test that `reinforce()` under an adversarially moved price either reverts
  or adds liquidity at no worse than the bound.

Raise P4's risk label from "High" to reflect that it now contains an unresolved economic
question rather than only accounting work, and expect the 4–6 day estimate to grow.

### 2.2 V11 answered — `beforeAddLiquidity` authentication, with a canonical mechanism

The document's §7.3 restricts `beforeAddLiquidity` to
`sender == VERDANT_LIQUIDITY_LOCKER || sender == VERDANT_FACTORY`, and §10.3 flags the doubt
correctly: the `sender` argument is whoever called `PoolManager.modifyLiquidity`.

Deployed `Hooks.sol` confirms the doubt. `sender` is the PoolManager's `msg.sender`:

```
201:        if (params.liquidityDelta > 0 && self.hasPermission(BEFORE_ADD_LIQUIDITY_FLAG)) {
202:            self.callHook(abi.encodeCall(IHooks.beforeAddLiquidity, (msg.sender, key, params, hookData)));
```

When Verdant mints through periphery, that is `PositionManager`. The allowlist as written is
unreachable and would reject every legitimate Verdant mint, including the factory's own.

The document offers two candidate fixes and defers the choice. There is a third that is
better than both, and it is canonical: v4-periphery ships an interface for exactly this
purpose, and the deployed PositionManager implements it.

```solidity
/// @title IMsgSender
/// @notice Interface for contracts that expose the original caller
interface IMsgSender {
    /// @notice Returns the address of the original caller (msg.sender)
    /// @dev Uniswap v4 periphery contracts implement a callback pattern which lose
    /// the original msg.sender caller context. This view function provides a way for
    /// integrating contracts (e.g. hooks) to access the original caller address.
    function msgSender() external view returns (address);
}
```

`BaseActionsRouter` declares `IMsgSender` and the deployed PositionManager implements it:

```
191:    function msgSender() public view override returns (address) {
192:        return _getLocker();
193:    }
```

`_getLocker()` is the reentrancy-lock holder — the address that entered `modifyLiquidities`.
For a Verdant mint that is the factory or the locker, which is precisely the value §7.3
wants.

**Recommended form of the check**, three assertions, none of them guesses:

```solidity
// beforeAddLiquidity
if (msg.sender != POOL_MANAGER) revert NotPoolManager();
if (sender != POSITION_MANAGER) revert LiquidityRestricted(sender);
address initiator = IMsgSender(sender).msgSender();
if (initiator != FACTORY && initiator != LOCKER) revert LiquidityRestricted(initiator);
```

Note what each does. The second assertion is what makes the third safe: `msgSender()` is
only trustworthy because `sender` has been pinned to the one immutable periphery contract
whose implementation we have read. Calling `msgSender()` on an arbitrary `sender` would be
trusting attacker-chosen code.

A **secondary binding** is available if belt-and-braces is wanted, and it resolves a
question the document raises about hook-data forwarding. In deployed `_mint`, the ERC-721 is
minted *before* liquidity is modified:

```
352:    function _mint(...)
368:        _mint(owner, tokenId);          // receipt token exists from here
383:            _modifyLiquidity(info, poolKey, liquidity.toInt256(), bytes32(tokenId), hookData);
```

and the position's salt is `bytes32(tokenId)`. So inside `beforeAddLiquidity` the hook can
read `IERC721(sender).ownerOf(uint256(params.salt))` and require it to equal the locker —
proving the *destination* of the liquidity, not just the caller. This costs an extra
external call on a non-swap path, which is acceptable.

**On the hookData option the document floats:** reject it as authentication. `hookData` is
forwarded verbatim from caller-supplied action parameters, so anyone can put anything in it.
It is a data channel, not a credential. Worth stating in the review so it is not revisited.

**Recommendation.** Rewrite §7.3's `beforeAddLiquidity` bullet and §9.2's table row to the
three-assertion form, add `POSITION_MANAGER` to the hook's immutable constructor arguments,
and close V11. P3's budget note in §25 ("budget a full day for reading v4-periphery") can be
reduced — the reading is done and the answer is definite.

### 2.3 V15 answered — `BaseHook` and `HookMiner` no longer exist in v4-periphery

§24's P3 prompt says to implement the hook "extending v4-periphery BaseHook (or
implementing IHooks directly if BaseHook's assumptions conflict — justify in a comment)",
and P3 deliverable 3 says to write the mining script "using HookMiner".

Neither exists. Upstream `v4-periphery` `main` @ `3245c3cb99c4` ships 69 Solidity files
under `src/`, and the only path containing "Hook" is
`src/interfaces/external/IHookStats.sol`. There is no `BaseHook.sol` at
`src/utils/`, `src/base/hooks/`, or `src/`, and no `HookMiner.sol` anywhere.

**Consequences.**

- The BaseHook-versus-IHooks question is not a choice to be justified; implementing `IHooks`
  directly is the only option against current periphery. This suits Verdant: `BaseHook`'s
  value is its custody and settlement helpers, and the design's central decision (§4.1) is
  that the hook never takes custody or settles. The document's instinct was right for the
  wrong reason.
- The mining script needs a miner. Options: vendor `HookMiner` from a pinned older
  v4-periphery commit, or write it — it is a short loop over salts checking
  `uint160(addr) & 0x3FFF == flags` against
  `keccak256(0xff ‖ deployer ‖ salt ‖ keccak256(initCode))`. Writing it is preferable to
  vendoring an unmaintained file, and it belongs in `script/` with a unit test that asserts
  a mined address actually has the target bits.
- Note `src/libraries/VanityAddressLib.sol` and `src/UniswapV4DeployerCompetition.sol` exist
  and are about vanity-address scoring, not permission-flag mining. They are not substitutes.

**Recommendation.** Amend P3's prompt to "implement `IHooks` directly" with no alternative,
and to "write `HookMiner` in `script/` with a test", and pin the periphery commit in P0 so
this does not shift again mid-build.

---

## 3. Confirmations

Points where the document is right and the deployed source says so. Recorded because each
underwrites a security claim that should cite evidence rather than intuition.

**V13 — `collect()` by zero-liquidity decrease works.** The deployed comment is explicit:

```
335:    /// @dev Calling decrease with 0 liquidity will credit the caller with any underlying fees of the position
```

with the mirror at line 288 for increase. §7.5's collection design stands.

A detail worth adding to the design: a zero `liquidityDelta` takes the `<= 0` branch in
`beforeModifyLiquidity` (line 203) and so routes to `beforeRemoveLiquidity` — a permission
Verdant's `0x3880` deliberately does not hold. Therefore **fee collection invokes no Verdant
hook callback at all.** That is a stronger statement than §19.14 currently makes and it
should be made explicitly: the collect path cannot be affected by hook logic because no hook
logic runs.

**§9.4's fee return is exactly right.** Deployed `Hooks.beforeSwap` requires a 96-byte
return and parses the fee only for dynamic-fee pools:

```
259:            if (result.length != 96) InvalidHookResponse.selector.revertWith();
263:            if (key.fee.isDynamicFee()) lpFeeOverride = result.parseFee();
```

There is also a short-circuit at line 253, `if (msg.sender == address(self)) return ...`,
which skips `beforeSwap` when the hook itself is the swapper. Irrelevant to Verdant, since
the hook never swaps, but worth a one-line note so a reviewer does not mistake it for a
bypass.

**The permission-bit arithmetic in §0.1 and §9.1 checks out** against deployed `Hooks.sol`
constants: `BEFORE_INITIALIZE_FLAG = 1 << 13`, `AFTER_INITIALIZE_FLAG = 1 << 12`,
`BEFORE_ADD_LIQUIDITY_FLAG = 1 << 11`, `BEFORE_SWAP_FLAG = 1 << 7`, giving
`0x2000 | 0x1000 | 0x0800 | 0x0080 = 0x3880`. `validateHookPermissions` compares all
fourteen flags against the address bits, so a mis-mined hook fails at the first
`initialize` as §19.2 claims.

---

## 4. Decisions to re-open

Not errors — places where new evidence should force a deliberate second look before
something is frozen into an audited artifact.

### 4.1 `tickSpacing = 60` is not this chain's convention

The document pins `tickSpacing = 60` in the `PoolKey`, re-asserts it in the hook's
`beforeInitialize`, and lists it in the parameter register as fixed with min = max = 60.
After the hook is mined and audited, this is effectively permanent.

Observed tick spacings in the same 1 566-pool window:

- **200: 1 212**
- 8: 67
- **60: 52**
- 1: 22
- various large values (18 000, 19 977, 19 981, 19 988): ~85 combined

60 is a distant third. The dominant 200 corresponds to the 1% fee tier convention carried
over from v3, which is what token-launch pools on this chain use — and Verdant's own default
`initialFeePpm` is 10 000, i.e. 1%.

This is not evidence that 60 is wrong. Tick spacing and fee are independent in v4, and a
tighter spacing gives finer control over bootstrap ranges, which Verdant needs. But the
argument for 60 should be made and written down rather than inherited, because:

- it interacts with the single-sided bootstrap range (§2.1), where the granularity of the
  "bounded tick range above the initial price" is exactly `tickSpacing`;
- it interacts with gas: narrower spacing means more initialized ticks crossed per unit of
  price movement, so swaps are marginally more expensive;
- the large tick spacings in the data (≈19 980) suggest at least one protocol is using
  very coarse spacing deliberately, which is worth understanding before choosing.

**Recommendation.** Make this an explicit decision with written reasoning in
`docs/verification.md` before P3 mines the hook. If it stays 60, say why in one paragraph.
Consider whether `tickSpacing` should be a bounded creator choice from a small allowlist
(60 or 200) rather than a hard constant — noting that this widens the hook's validation
surface and the SDK's range presets, and so is not free.

### 4.2 Uniswap now ships a permissioned-pool pattern

§9.5 implements the liquidity restriction as a bespoke revert in `beforeAddLiquidity`, and
is admirably honest about the cost ("the single most restrictive choice in the design").

Upstream v4-periphery now contains a canonical pattern for this:

```
src/hooks/permissionedPools/PermissionedPositionManager.sol
src/hooks/permissionedPools/PermissionsAdapter.sol
src/hooks/permissionedPools/PermissionsAdapterFactory.sol
src/hooks/permissionedPools/BaseAllowListChecker.sol
src/hooks/permissionedPools/interfaces/IAllowlistChecker.sol
src/hooks/permissionedPools/libraries/PermissionFlags.sol
```

I have **not** audited these or confirmed whether the deployed 4663 PositionManager bundle
includes them (it does not appear to — the deployed bundle is the standard
`PositionManager`), so this is flagged, not recommended. The reason it matters is that a
reviewer will ask why Verdant hand-rolled a restriction that Uniswap has a named pattern
for, and the answer should be a considered one. It is also possible the pattern is a poor
fit: Verdant's restriction is not an allowlist of LPs to be maintained but a permanent
"only these two contracts, forever" rule, which a bespoke immutable check expresses more
simply and audits more cheaply.

**Recommendation.** One engineer-hour reading these files, and a paragraph in the review
record either adopting the pattern or stating why the bespoke check is preferred. Do this
before P3 rather than after, because it touches the hook.

### 4.3 Doppler is the incumbent on 4663, and it is the design Verdant argues against

The document's §0.3 says it does not claim any hook registry or prior art exists, and §2.2
rejects bonding curves, graduation, and in-swap fee capture on design grounds. Those
arguments now have a named counterparty on the same chain.

The most-used hook on 4663 is `0x4e3468951d49f2eea976ed0d6e75ffcb44a9a544`, verified on
Blockscout as **`DopplerHookInitializer`**, solc `0.8.26`. It initialized **578** pools in
the 300 000-block window — 80% of all hooked pools in that period.

Its permission bits are `0xa544 & 0x3FFF = 0x2544`:

`beforeInitialize | afterAddLiquidity | afterRemoveLiquidity | afterSwap | afterSwapReturnsDelta`

That is a hook that takes deltas inside the swap path — structurally the design §5.3
rejects, and closer to the "take a cut in `afterSwap` and donate it back" implementation the
document explicitly argues against.

Two further hooks in the window are worth noting for the same reason:
`0x5cf8e499…65dc` (bits `0x25dc`, including `beforeSwapReturnsDelta` *and*
`afterSwapReturnsDelta`) and `0x48b8f6ad…e8cc` (bits `0x28cc`).

**Why this belongs in an architecture review.** It does not change a contract. It changes
three things that the document treats as settled:

1. **§0.3's framing.** "Verdant does not claim prior art exists" is now false in a specific,
   checkable way. The verification record should name Doppler.
2. **§2.2's non-goals.** "We reject bonding curves" reads differently when the dominant
   protocol on your chain is a bonding-curve-adjacent v4 launchpad with hundreds of pools.
   The rejection is still defensible — the arguments in §5.1 are about risk surface, not
   popularity — but it now has to be *argued* rather than asserted, and the honest framing
   is "we are making a different bet than the incumbent", not "nobody does this".
3. **The liquidity-restriction cost in §9.5.** Verdant markets being a closed LP venue is a
   sharper competitive disadvantage when an open alternative is already liquid on the same
   chain.

**Recommendation.** Read the verified `DopplerHookInitializer` source before P3. Not to copy
it — its design is the one Verdant rejects — but because it is a working, audited-by-usage
example of a v4 launchpad hook on the exact chain and compiler Verdant targets, and because
knowing what the incumbent does wrong (or right) is the cheapest available research. Add a
positioning paragraph to §1 that names it.

### 4.4 V6 and V9 remain measurement-bound

**V6 (timestamp drift).** `ArbSys.arbOSVersion()` returns `0x74` on 4663, and the client is
`nitro/v3.11.3-rc.5-4130f4c`. ArbOS is modern and EIP-1153 transient storage evidently works
(v4 is deployed and in use, and v4 requires it), so the document's inference in §0.1 holds.
But the *drift bound* — the actual figure that justifies the 300-second minimum stage gap —
is still not cited. The 300 s choice is almost certainly conservative enough; it just is not
yet evidenced.

Note `arbOSVersion()` returns `55 + version` by historical convention, so `0x74` = 116
implies ArbOS 61. That mapping should be confirmed rather than trusted, since it is the kind
of detail that is easy to get wrong and that nothing else depends on.

**V9 (gas ceiling for atomic creation).** The latest header reports
`gasLimit = 0x4000000000000` (1.125 × 10¹⁵), which is Arbitrum's nominal per-block value and
tells us nothing useful — the real constraints are the per-transaction cap and the L1 data
posting component. `baseFeePerGas` was 0x1346920 (≈0.0202 gwei) at the time of probing.
V9 stays exactly where the document puts it: a P5 measurement of the real
`createMarket` transaction at 8 stages in seeded mode.

---

## 5. Items still open after this review

- **V5** — third-party router and aggregator behaviour against hooked, dynamic-fee pools on
  4663. Partly de-risked by the existence of 466 dynamic-fee and 721 hooked pools trading on
  this chain, but not closed. Needs a real swap through Universal Router against a Verdant
  test pool. P6.
- **V6** — timestamp drift bound and the ArbOS version mapping. P1.
- **V8** — Blockscout programmatic standard-JSON verification. Encouraging that both v4
  contracts are verified there with full source bundles, but `forge verify-contract` has not
  been exercised. P6.
- **V9** — atomic creation gas. P5.
- **V10** — Ponder sync and reorg behaviour on 4663. P8.
- **V12** — whether `V4Quoter` reflects the `beforeSwap` fee override across a stage
  boundary. The mechanism in deployed `Hooks.beforeSwap` (line 263) makes this near-certain,
  since the quoter simulates a real swap, but the document is right to require a fork test.
  P6.
- **V16** — sequencer mempool visibility and practical reorg depth. P8.

---

## 6. Summary of recommended edits to `Implementation Architecture v0.1`

Ordered by blast radius.

1. **§7.5, §5.2, §5.3, §7.3 (`reinforce`)** — rewrite to explicit-liquidity increase plus
   remainder-take. Add a sandwich analysis and a non-circular `minLiquidityOut` policy as a
   P4 prerequisite. Re-estimate P4.
2. **§7.3, §9.2 (`beforeAddLiquidity`)** — replace the `{factory, locker}` allowlist with the
   three-assertion `IMsgSender` form. Add `POSITION_MANAGER` to the hook's immutables. Close
   V11 and shrink P3's reading budget.
3. **§24 P3, §25** — implement `IHooks` directly, no BaseHook alternative; write the hook
   miner rather than importing `HookMiner`.
4. **§0.2, §10.4, §22** — delete the testnet-v4-absent contingency and the "non-canonical
   v4" label; testnet 46630 is authoritative.
5. **§6.3, §10.1** — delete `VerdantCreate2Factory`.
6. **§19.1, §9.2** — record the `tickSpacing = 60` decision with reasoning, or make it a
   two-value allowlist.
7. **§0.3, §1, §2.2, §9.5** — name Doppler; reframe the non-goals as a different bet rather
   than an empty field.
8. **§19.14** — strengthen the collect claim: no hook callback runs during fee collection at
   all, because `0x3880` excludes `beforeRemoveLiquidity`.
9. **§5.4, P1** — put the measured L2/L1 block numbers into the `block.number` prohibition
   comment.
10. **§0.1** — add the deployed-source verification facts (both v4 contracts verified on
    Blockscout, solc 0.8.26, optimizer runs 44 444 444 and 30 000) and pin the periphery and
    core commits Verdant builds against.

Nothing in this review changes §4's product principles, §6.2's five architectural decisions
(D1–D5 all survive), the `0x3880` permission set, or the no-custody swap path. The two
corrections are both in the value-routing layer and in one authentication check, and the
decoupling decision in §5.3 is what kept the `reinforce()` problem out of the swap path.
