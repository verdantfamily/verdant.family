# ADR-006 — `beforeAddLiquidity` authenticates the initiator through `IMsgSender`, not the caller

Status: accepted. Resolves V11. Supersedes §9.3 (the liquidity guard) and the
`hookData` credential sketch in §7.4.

## Decision

`VerdantHook.beforeAddLiquidity` permits exactly one thing: the factory minting a
market's initial position through the one `PositionManager` the hook was mined
for. It establishes that in three checks, in this order:

1. `msg.sender == poolManager` — the hook is being called by v4 rather than
   directly.
2. `sender == positionManager` — the address v4 reports as *its* caller is the
   pinned PositionManager, held as an immutable.
3. `IMsgSender(sender).msgSender() == factory` — the PositionManager's own record
   of who asked it is the factory.

Everything else reverts. There is no allowlist, no owner, and no path that a
later transaction can open.

## Why the obvious check does not work

The intuitive check is `sender == factory`. It is wrong, and it fails closed in
the worst way — by rejecting the only mint Verdant ever makes.

`sender` in a v4 hook callback is *the PoolManager's caller*, not the origin of
the transaction. Every mint routed through periphery reaches the PoolManager from
the PositionManager inside `unlock`, so `sender` is the PositionManager for the
factory's mint and for everyone else's alike. The one value that would have
distinguished them is the one v4 does not forward:

```
creator ─→ VerdantFactory ─→ PositionManager.modifyLiquidities
                                   └─→ PoolManager.unlock
                                         └─→ PositionManager.unlockCallback
                                               └─→ PoolManager.modifyLiquidity
                                                     └─→ hook.beforeAddLiquidity(sender = PositionManager)
```

So the hook can tell "this came through periphery" from "this did not", and
cannot, on its own, tell one periphery caller from another.

## Why `hookData` is not the answer

`hookData` is caller-supplied bytes that v4 forwards verbatim. Anything the
factory could put there — its address, a signature, a nonce — is visible in
calldata and can be copied into somebody else's mint. A credential that the
untrusted party constructs is not a credential. It was in the original sketch and
it is removed.

## Why `IMsgSender` is

The pinned `PositionManager` (v4-periphery `3c31961fb9`, the commit matching the
bytecode deployed on 4663 — V1 in `docs/verification.md`) implements
`IMsgSender`, exposing `msgSender()`: the address that called *it*, recorded in
its own storage for the duration of the call. Uniswap added it for precisely this
problem, and its Permissioned Pools work uses it the same way (ADR-003, which
declines the standard but not this mechanism).

The trust is bounded and stated: the hook trusts *one* contract, at an address
fixed in an immutable at construction, to report its own caller honestly. That is
not a general trust in periphery — a second PositionManager, a fork, or a
malicious lookalike answering `msgSender()` with the factory's address gets past
check 3 and fails check 2. Both halves are needed, which is why they are separate
checks with separate errors rather than one condition.

## The cost, and why it is acceptable

This is the hook's only external call outside `afterInitialize`. It is a `view`
call to a fixed address, made once per market — `beforeAddLiquidity` runs on the
factory's mint and reverts on everything else, so it never appears in a trade.
`beforeSwap`, the function on the hot path, still reads nothing but its own
storage. ADR-004's argument for holding no external references at swap time is
unaffected.

## What this makes true

- A Verdant pool's liquidity is exactly what the factory minted. Nobody can add
  to it — not the creator, not the protocol, not the PositionManager's other
  users, not a contract that copies the factory's calldata.
- Combined with `PositionLocker` having no transfer, approve or decrease path,
  the position that exists at the end of `create` is the position that exists
  forever.
- The guard needs no state, so there is nothing to migrate, unpause or
  misconfigure later.

## Consequences

- [x] `VerdantHook` takes `positionManager` as a third constructor argument and
      holds it as an immutable. The mined address therefore changed; mining is
      done by `script/Deploy.s.sol` against the deployment's own PositionManager.
- [x] `VerdantFactory`'s constructor asserts `hook.positionManager() ==
      positionManager`, so a hook mined for different periphery cannot be wired
      to a factory — `PositionManagerMismatch`.
- [x] `hookData` is not read by any hook function. The initial mint passes empty
      bytes.
- [x] Tests: the success path, and one test per failing check with its own error
      (`NotPoolManager`, `NotPositionManager`, `NotFactory`), using a stub that
      answers `msgSender()` arbitrarily. In `VerdantLaunch.t.sol`, the creator
      and a third party both fail to add liquidity to a live market.
- [x] `docs/verification.md` V11 records the call path and the reason `sender`
      is not the initiator.

## Rejected

- **`sender == factory`.** Never true for a periphery mint; would reject every
  launch.
- **A credential in `hookData`.** Copyable from calldata.
- **`tx.origin == factory`.** The factory is a contract; `tx.origin` is the
  creator. Also unusable under account abstraction.
- **Minting from the factory directly against the PoolManager**, which would make
  `sender == factory` true honestly. It requires the factory to implement
  `unlockCallback` and settle deltas itself, and it gives up the
  PositionManager's position NFT — the thing `PositionLocker` locks and anyone can
  verify the owner of. A bespoke settlement path in exchange for a weaker
  artefact.
- **An allowlist of minters.** Storage plus an owner to write it, which is the
  shape of guarantee Verdant does not have anywhere else.
