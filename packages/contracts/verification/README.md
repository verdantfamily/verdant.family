# Verification artefacts

One file: the Solidity Standard JSON Input for `VerdantToken`, which is the contract every
Instant launch deploys.

## Why it is committed rather than generated per launch

Every Instant token is the same contract. Only six constructor arguments differ, and all
six are readable back off the deployed token — `name`, `symbol`, `totalSupply`, `creator`,
`metadataURI`, `metadataMutable` are each a public getter. So the compiler input is a
constant of the deployment and the arguments are a function of the address.

Generating the input per launch would mean running `solc` over eighteen sources on the web
host for every token, to produce bytes identical to the last time. Worse, it would make
verification depend on the build environment at launch time: a vendored dependency that
resolved differently, or a `foundry.toml` edited months later, would silently produce an
input that no longer matches the bytecode already on chain.

This file is a snapshot of what production was compiled with. It is self-contained — every
source is embedded with its content, including the vendored Uniswap and OpenZeppelin files
that are not in git — so it needs nothing else present to compile.

## Regenerating it

Only when `VerdantToken` or the compiler settings change, and only alongside a new
deployment. Verifying a token against an input it was not compiled with does not produce a
wrong answer; it produces no answer, which is the correct failure but a confusing one.

```
pnpm --filter @verdant/contracts verification:emit
```

The settings inside must match `foundry.toml`: solc 0.8.26, optimizer enabled at 1 000 000
runs, `evmVersion` cancun, `bytecodeHash` ipfs. A mismatch in any one of them changes the
metadata hash at the end of the bytecode and the match fails.
