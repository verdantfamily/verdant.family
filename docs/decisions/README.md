# Decisions of record

Each file here resolves something that was blocking implementation. They are
written to be read by someone who was not in the conversation, and specifically
to answer "why is it like this?" two years from now when the reasoning is no
longer in anyone's head.

A decision recorded here supersedes `Implementation Architecture v0.1` wherever
the two disagree. The architecture document is not edited; it stays as the
original design intent, and these files are the diff.

| ADR | Decision | Supersedes |
|---|---|---|
| [001](001-tick-spacing.md) | `tickSpacing` is 200 for every Verdant pool | §19.1, §7.2, §8.3 range presets |
| [002](002-reinforce-liquidity-delta.md) | `reinforce()` computes the liquidity delta caller-side and is a slippage-bearing transaction | §7.5, §5.3 |
| [003](003-reject-permissioned-pools.md) | Uniswap's Permissioned Pools standard is not adopted | §9.5 (confirms, does not change) |

## Format

Decision, then reasoning, then consequences, then what was rejected. Consequences
are written as a checklist of what has to change, because an ADR whose
consequences are not enumerated tends to be applied to one file and forgotten in
four others.

Every quantitative claim cites where the number came from — a probe in
`docs/verification.md`, a line of deployed source, or arithmetic that is shown
rather than asserted.
