# ADR-004 — `VerdantHook` implements `IHooks` directly, not `BaseHook`

Status: accepted. Supersedes nothing; resolves V15 in `docs/verification.md`.

## Decision

`VerdantHook` inherits `IHooks` from v4-core and implements all ten callbacks
itself. It does not extend v4-periphery's `BaseHook`.

## The reason this was not a judgement call

`BaseHook` **does not exist at the commit this repository pins.**

```
$ find packages/contracts/vendor/v4-periphery -name BaseHook.sol
$        # no output
```

The pin is v4-periphery `3c31961fb9`, chosen in P0 because the Blockscout
verified source of the `PositionManager` deployed on Robinhood Chain 4663 is
byte-for-byte identical to it. `BaseHook` was added to v4-periphery later, along
with `HookMiner` — which is why `test/utils/HookMiner.sol` in this repository is
a reimplementation rather than a vendored file.

So adopting `BaseHook` would mean vendoring a *newer* v4-periphery than the one
deployed on the chain we deploy to, for the sake of a base class. That trades a
verified dependency graph for a convenience, and the property being traded away
is the one that makes claims like "the PositionManager will behave as documented"
checkable at all. Nothing about a base class is worth that.

## What would have been decided had it been available

Still `IHooks` directly, for three reasons that survive the availability
question and are worth recording because a later phase will be tempted to
revisit this when the pin moves.

**One. `BaseHook` assumes it owns the authentication.** Its `onlyPoolManager`
modifier checks `msg.sender == poolManager`, which is exactly one of the two
checks `beforeInitialize` needs. The second — `sender == factory`, where `sender`
is the *argument* v4 passes rather than `msg.sender` — has no equivalent in
`BaseHook`, so `beforeInitialize` would carry a modifier plus an inline check and
a reader would have to know which one covered which caller. Verdant's
authentication is two lines; splitting them across an inherited modifier and a
function body makes it harder to see, not easier.

**Two. Its unimplemented-callback pattern is weaker than the address bits.**
`BaseHook` provides ten virtual `_beforeSwap`-style internals that revert
`HookNotImplemented`, and a subclass silently gains a callback by overriding one.
Implementing `IHooks` directly means every callback this hook does not want is
visibly and individually `revert CallbackNotEnabled()` in this file, next to
`getHookPermissions()`, next to the constructor that refuses to deploy at an
address granting anything else. The three statements are reviewable together on
one screen.

**Three. There is nothing to reuse.** `BaseHook` contributes an immutable, a
modifier, a permissions abstract method and an address self-check. This contract
has all four in twelve lines, and the self-check it needs is stricter: `BaseHook`
validates permissions against the address, while this constructor additionally
refuses an address with *no* permission bits, which is the case v4 itself does
not catch (`Hooks.isValidHookAddress` accepts it whenever the pool fee is
dynamic — and every Verdant pool's fee is dynamic).

## Does any `BaseHook` assumption conflict with the design?

**No-custody: no conflict.** `BaseHook` takes no custody and imposes no
settlement. Custody in a v4 hook comes from the `*_RETURNS_DELTA` permission
bits, which are a property of the deployed address, not of a base class. This
hook's address has all four of them clear, which is asserted three ways in
`test/VerdantHook.permissions.t.sol`.

**Reading the factory in `beforeInitialize`: no conflict, and no longer
relevant.** `BaseHook` would not have obstructed an external read. The design
changed for a different reason: the factory is now a plain immutable on the hook,
so `beforeInitialize` reads nothing external and the hook's only external call in
its entire lifetime is `updateDynamicLPFee`. The construction cycle that an
address book was meant to break is broken by ordering instead — deploy the
factory, mine the hook against the factory's address, then let the factory
resolve the hook. See the deployment note in `script/MineHook.s.sol`.

## Consequences

- [x] `VerdantHook` declares `contract VerdantHook is IHooks` and implements all
      ten callbacks. Four do work; `beforeAddLiquidity` reverts `NotImplemented`
      until P3.2; the remaining six revert `CallbackNotEnabled`.
- [x] The permissions struct is declared by hand in `getHookPermissions()` and
      cross-checked against the address with Uniswap's own
      `Hooks.validateHookPermissions`.
- [x] The address self-check lives in the constructor *and* in
      `beforeInitialize`. The constructor catches every wrong address including
      one with no bits; the runtime check catches code placed at an address by
      means other than construction, and is what makes
      "a wrong address cannot initialise a pool" testable.
- [x] `HookMiner` is reimplemented under `test/utils/`, not vendored.
- [ ] When the pin moves — the next time the deployed periphery on 4663 changes —
      revisit this file rather than the code. The reasoning above, not the
      availability, is what should decide it.

## Rejected alternatives

**Vendor a newer v4-periphery for `BaseHook` and `HookMiner`.** Rejected: it
breaks the invariant that every vendored path is the commit deployed on the
target chain, which is the basis of every claim in `docs/verification.md`.

**Vendor `BaseHook` alone, as a single file.** Rejected: a hand-picked file from
an unpinned commit is the worst of both — the audit surface of a dependency with
none of the provenance.

**Do not inherit `IHooks` either, and declare only the four callbacks used.**
Tempting: it would remove six reverting stubs from the deployed bytecode.
Rejected because inheriting the interface is what makes the compiler check that
the four real callbacks have exactly the signatures v4 will call. A selector
typo in an immutable, address-mined contract is unrecoverable, and six `revert`
statements are a cheap price for the compiler ruling it out.
