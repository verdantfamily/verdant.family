# ADR-013 — The repository is MIT, and two SPDX headers are frozen rather than wrong

Status: accepted. Resolves the contradiction between `LICENSE` and two source
headers. Does not change any licence grant.

## Decision

Every file in this repository is MIT licensed. That was already the intent —
commit `f386484`, "Relicense to MIT and correct the README's status", did it
deliberately and the README explains the reasoning — and this ADR does not change
it.

Two files nonetheless keep a `BUSL-1.1` SPDX header:

- `packages/contracts/src/VerdantFactory.sol`
- `packages/contracts/src/FeeForwarder.sol`

They are frozen there. The MIT grant over them is stated explicitly in `NOTICE`,
which governs, and `pnpm verify:licenses` prevents the header being either
propagated or quietly corrected.

## Why the headers cannot simply be fixed

Because an SPDX identifier is compiled into the bytecode.

solc records each source's licence in the metadata JSON, hashes that JSON, and
appends the hash to the runtime bytecode as a CBOR blob. Changing the header
changes the hash, which changes the bytecode. Measured rather than assumed:

```
VerdantFactory runtime code, BUSL-1.1 header   33 698 bytes, sha256 b645a799…
VerdantFactory runtime code, MIT header        33 698 bytes, sha256 a7f925ab…
```

Same length, different tail. Both of these files are inside contracts that are
deployed on chain 4663 and verified as a **full match** on Blockscout:

| File | Deployed as | Why it is reached |
| --- | --- | --- |
| `VerdantFactory.sol` | `VerdantFactory` | Directly. |
| `FeeForwarder.sol` | `FeeForwarderFactory` | Its creation code is embedded in the factory that deploys it, so its metadata is inside that factory's bytecode. |

So correcting the headers has a cost that is not cosmetic: `deployments/robinhood.json`
would record a `runtimeCodeHash` this repository can no longer produce, the
Blockscout verification would fall from full match to nothing, and the README's
first receipt — *the deployed code is the source in this repository* — would become
false.

## Why that is the right trade

A licence is a grant by the copyright holder, not a property of a comment. The
grant is MIT, it is stated in `LICENSE`, and `NOTICE` names these two files and
grants MIT over them in terms that leave nothing to infer. A reader who wants to
know what they may do with the code gets an unambiguous answer.

Reproducibility is not recoverable the same way. It is a fact about bytecode, and
once the source stops producing the deployed artefact there is no document that
restores it.

The asymmetry decides it: a stale identifier with an explicit override costs a
paragraph, and a broken deployment record costs the strongest claim the repository
makes.

## What the check enforces

`scripts/check-licenses.ts`, wired into CI, runs in both directions:

1. **Every Solidity file declares MIT**, unless it is one of the two frozen files
   or Uniswap's `HookMiner.sol`, which keeps its own upstream header.
2. **Each frozen file still declares the header it was deployed with.**

The second is the one worth having. Without it the freeze is a comment somebody
will tidy up; with it, a cleanup that corrects the header fails CI and says why,
and the reader is told that the fix is a redeployment rather than an edit.

The check also fails if a frozen file is not named in `NOTICE`, so the exception
cannot exist without being disclosed where a reader looks for it.

## When this ends

At the next redeployment of either contract. That change corrects the header,
updates `deployments/robinhood.json`, re-verifies on Blockscout, and removes the
entry from `FROZEN` and from `NOTICE` — all in one commit, because doing any of
them separately reintroduces exactly the inconsistency this ADR closes.

## Consequences

- [x] `packages/contracts/test/FeeForwarder.t.sol` corrected to MIT. It is a test,
      compiled into nothing that is deployed, so nothing froze it.
- [x] `NOTICE` states the MIT grant over both frozen files in explicit terms.
- [x] `scripts/check-licenses.ts` added and wired into CI as `pnpm verify:licenses`.
- [x] `README.md`'s licensing section names the exception rather than leaving a
      reader to find it in a header and conclude the repository is mixed.
- [x] No deployed bytecode changed. `VerdantFactory`'s runtime hash is byte-identical
      before and after this change.

## Rejected

- **Correct both headers.** Breaks byte-for-byte reproduction of two verified
  deployments, for a comment.
- **Relicense the repository to BUSL-1.1 to match the two headers.** Inverts a
  deliberate decision, and would be a real reduction in what anybody may do with
  the code in order to resolve a clerical error.
- **Declare the repository intentionally mixed-license.** It is not, and writing
  that down would be recording a fiction to avoid explaining a real constraint.
- **Say nothing and leave the headers.** The state the repository was already in.
  A file that says BUSL and a LICENSE that says MIT is a question every careful
  reader has to answer for themselves, and some of them will answer it wrongly.
