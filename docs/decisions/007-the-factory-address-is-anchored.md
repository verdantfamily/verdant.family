# ADR-007 — The factory's address is anchored to a contract, not predicted from an operator's nonce

Status: accepted. Supersedes §21.1 (deployment order).

## Decision

`FactoryOrigin` is deployed first. It computes the address of its own first
creation in its constructor, publishes it as `factory()`, and can create exactly
once, for one operator. The rest of the deployment reads that address off the
chain and hands it to the three contracts that need it before the factory exists;
the factory is then created through the anchor, which lands it there.

Nothing in `script/Deploy.s.sol` computes an address from the sender's transaction
count.

## The problem

Verdant has no setters. `MarketRegistry` takes its writer, `VerdantDeployer` takes
its factory, and `VerdantHook` takes its factory, each in a constructor, each into
an immutable. That is what makes "a live market's fee split cannot be changed" a
statement about bytecode. The price is that three contracts must be deployed
naming an address that has no code yet, and the factory's constructor checks all
three wirings so a wrong address is a failed deployment rather than a live factory
that cannot create markets.

The usual way to get that address is `keccak(rlp(sender, nonce))` with the nonce
guessed from the script's own shape — "four transactions happen before this one,
so add four". It works, and it has a property that should disqualify it here: it
cannot be exercised anywhere except production. An account's nonce counts
transactions; a contract's nonce counts creations. A test harness is a contract,
so the offset that is correct in CI is legitimately different from the offset that
is correct on chain, and the deployment path CI runs is not the one that will run.

For a system where a mistake is not recoverable, that is the wrong place to have
an untested step. The hook's permissions are read from its address by v4 on every
call, every wiring is immutable, and there is no upgrade path — a mis-deployment
is not patched, it is abandoned, and any market created against it in the meantime
is stranded on a factory nobody should use.

## Why an anchor fixes it

A contract's nonce starts at 1 (EIP-161) and only moves when it creates. A
contract that has never created anything therefore has a first-creation address
that depends on nothing but its own address:

```
factory = keccak(rlp([address(this), 1]))[12:]
        = keccak(0xd6 ++ 0x94 ++ address(this) ++ 0x01)[12:]
```

`used` makes that first creation the only one, so the derivation cannot go stale.
Because no operator state enters it, the arithmetic in CI *is* the arithmetic on
Robinhood — which is what makes `test/Deploy.t.sol` meaningful: it runs the real
script, with real mining, and then launches and trades a market through what the
script deployed. The script has one test seam, `_sender()`, because a contract
cannot send a transaction; every address, every ordering and every assertion is
the production one.

The counterparties are also now told an address *read from the chain* rather than
one a script computed. Two independent computations of the same address is a class
of bug that no longer has anywhere to live.

## Why it is gated

The anchored address is public and empty, which without a gate is an invitation:
anyone could call `deployFactory` with initcode of their choosing and occupy it,
leaving the registries permanently wired to a factory somebody else wrote. So
`deployFactory` is operator-only and single-use, and it takes the initcode as
calldata rather than building it — `FactoryOrigin` must not embed
`VerdantFactory`'s bytecode, which is close enough to the EIP-170 limit that a
contract carrying a copy could not be deployed.

The anchor is spent in the transaction that uses it and is never referred to
again. A market's provenance rests on the factory's own constructor checks, not on
who created the factory, so nothing downstream trusts this contract.

## Consequences

- [x] `src/FactoryOrigin.sol`, with unit tests, and `deployments.ts` records it
      alongside the six addresses a deployment produces.
- [x] `script/Deploy.s.sol` brings up the whole system in four phases — anchor,
      registries and deployer, mined hook, factory — and re-asserts the wirings
      from outside afterwards.
- [x] `test/Deploy.t.sol` runs the script and launches a market on the result.
- [x] The hook is deployed by an explicit call to the canonical CREATE2 deployer
      rather than `new VerdantHook{salt: ...}`, so the creating account is the one
      the salt was mined against under `forge test` and `--broadcast` alike. This
      is the same class of bug as the nonce offset: a difference that only appears
      in the environment you cannot rehearse.
- [x] `script/MineHook.s.sol` no longer deploys anything. It prints the salt and
      address for a given factory so the mining can be reproduced and reviewed;
      salts count up from zero, so anyone can confirm the deployed hook is the
      first address carrying `0x3880` for that factory.

## Rejected

- **Nonce prediction with an offset constant.** The status quo. Untestable, and
  its failure mode is a wasted deployment on a chain where the artefacts cannot be
  reused.
- **A one-time `setFactory` on each counterparty.** Removes the ordering problem
  and replaces it with three contracts that have a setter, which has to be argued
  about — "it can only be called once" is a claim a reader must verify in three
  places rather than a shape they can see.
- **CREATE2 for the factory as well.** Its initcode contains the hook's address
  and the hook's salt is mined against the factory's, so the two addresses would
  depend on each other. Circular.
- **A bootstrap contract that deploys everything.** It would embed the creation
  code of five contracts, including the factory, and exceed EIP-170 several times
  over.
