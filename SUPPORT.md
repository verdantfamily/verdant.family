# Support

| What you need | Where to go |
| --- | --- |
| How a model behaves | [MODELS.md](MODELS.md), then the model's own page under [`models/`](models/) |
| How the contracts fit together | [ARCHITECTURE.md](ARCHITECTURE.md) |
| Why something is built the way it is | [`docs/decisions/`](docs/decisions/) |
| Which addresses are live | [`deployments/robinhood.json`](deployments/robinhood.json) |
| A bug, or behaviour that contradicts the docs | [Open an issue](https://github.com/verdantfamily/verdant.family/issues/new/choose) |
| A security vulnerability | [Report it privately](https://github.com/verdantfamily/verdant.family/security/advisories/new) — **not** an issue. See [SECURITY.md](SECURITY.md) |
| A question, or a mechanism you want to argue about | [Discussions](https://github.com/verdantfamily/verdant.family/discussions) |

## What we cannot help with

**Recovering funds.** The contracts are immutable and nobody holds a key that
can move a market's liquidity, change its fees or reverse a trade. That is the
design, and it applies to us in exactly the way it applies to everyone else.

**Whether a token is a good idea.** Verdant creates markets. It does not review,
endorse or have an opinion about the tokens launched through it.

**Getting a token listed, promoted or featured.** There is no such process.

## Before opening an issue

Most "is this broken" questions resolve to a fact you can check yourself in about
a minute:

```bash
pnpm verify:deployment   # are the live addresses the ones published here?
pnpm chain:probe         # does every external address we depend on still have code?
```

Both are read-only, need no key, and run on a clean clone with no install step.
