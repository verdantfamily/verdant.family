# The interface

`apps/web` is a Next.js App Router application that reads the indexer's API and the
generated bounds, and writes nothing. It holds no keys, has no session, no account and no
database of its own: every page is a projection of chain state, and the only thing a
reader is ever asked for is a wallet, at the point where a transaction has to be signed.

That is the constraint the whole design follows from. If the interface cannot hold value
and cannot change a market, then the only harm it can do is misinform — so the parts of
this document that go on at length are the ones about numbers.

`apps/landing` is a different deployment and not part of this: one static page, no data
source, exported to plain files so it can be public before anything is deployed. See
[`apps/landing/README.md`](../apps/landing/README.md).

## Routes

| Route | What it is |
|---|---|
| `/` | Explore: every market, searchable by name, ticker, token or pool id, sortable by age, implied value, volume or fee, filterable by fixed against scheduled |
| `/market/[id]` | One market: a price chart at seven intervals, buying and selling, live trades, the live fee, the whole fee ladder, where the fees go, every contract behind it, and the model's own disclosure |
| `/launch` | The model chooser: Classic, Stock-Paired, Evergreen, each with what it quotes against, what it fixes at creation and whether it is live |
| `/launch/classic` | The launch form, quoted in ether |
| `/launch/stock-paired` | The same form, quoted in a reviewed equity token |
| `/profile` | What a creator will see about their own markets. Described rather than stubbed, because claiming is a transaction and the write path is not built |
| `/docs/[[...slug]]` | Ten sections, from `src/content/docs.tsx`, which is also what generates the sidebar and the static params |

A market page and the explore page are server-rendered per request and revalidate every
five seconds. Everything else is static: the launch form is a client component with no
server dependency beyond the bounds it was compiled against.

## The design

Dark, and not switchable, because the launchpad stands on the same photograph the teaser
does. A theme toggle doubles the number of colour pairs every future surface has to be
checked against, and it would now also mean a second background image, a second scrim and a
second set of contrast measurements to keep in agreement with the first.

The palette in `src/app/globals.css` is derived from `#362627`, the photograph's own mean
colour, which is what `--void` is on the teaser. `--color-canvas` is that tone deepened
until white body type clears its contrast target over it. The surfaces are not colours but
degrees of translucency — a card is white lifted off the picture, a well is black pressed
into it — because an opaque card would punch a hole in the photograph, and the reason for
laying one behind the app is that it shows through. Radii are large and the tokens are
`oklch` so that lightening a colour does not shift its hue. Elevation is rebuilt for dark:
a soft grey shadow under a translucent card is invisible, so what reads as raised here is a
one-pixel light line along the top edge plus a deeper, wider cast below than a light theme
would ever need.

Four fixed layers sit under every route, mounted by the root layout: the photograph, a
scrim, light that drifts across it, and grain. They are the teaser's, with one deliberate
difference. The teaser has one sentence over that picture, set large; this app has price
tables, fee ladders, address rows and forms — small type, a lot of it, and much of it
numbers that are read rather than glanced at. So the scrim's thinnest point is raised from
0.2 to 0.76 and the drifting light is cut to roughly a third of its strength. Measured
against the brightest patch of the photograph with the light at the peak of its cycle, that
puts body copy at `--color-ink-muted` at 6.1:1 directly on the background and 5.5:1 inside
a card, where the teaser's own settings give 2.6 and 2.4. `--color-ink-faint` measures
between 3.4 and 3.8:1 there, which is why it is used only for a placeholder, a chevron or a
disabled control and never for a number or a label somebody has to read.

Two type families, for two kinds of thing. Prose is in Inter Tight, the brand's face,
downloaded at build time by `next/font` and served from our own origin — the same face and
the same variable name the teaser uses, so the two front ends can be described in one
sentence. Every number that could be compared against another number — a price, a fee, an
amount, an address — carries the `.numeric` class: the mono face at tabular width, so a
column of prices has aligned decimal points and a live-updating value does not jitter as
its digits change width.

Reusable pieces live in two files. `src/components/primitives.tsx` has the surfaces —
`Card`, `Panel`, `Stat`, `Badge`, `Notice`, `TokenAvatar`, the address and transaction
links — and `src/components/form.tsx` has the controls: `Field` with its label, hint,
counter and error; `TextInput`; `AmountInput` with a unit and an optional action;
`Segmented`; `CardChoice`; `SummaryRow`. Nothing in a page renders a raw `<input>`.

## Launch models

The three models on `/launch` are how a launch is described. They are not a third layer of
mechanism: each maps onto the models the registry already knows about.

| Model | On chain | Status |
|---|---|---|
| Classic | `fixed` for one fee, `progressive` for a schedule, quoted in ether | Live — deployed on Robinhood Chain and launchable from the form |
| Stock-Paired | The same, with a tokenized equity as `currency0` | Live — the factory takes a quote asset, the deployed `ModelRegistry` admits the reviewed ones, and the splitter pays out in whichever was chosen. See ADR-008. The first buy is funded in the equity itself; nothing routes ether into it for you |
| Evergreen | `evergreen` — a reserve share of fees, convertible into locked liquidity by anyone | Designed. The reserve share and the reinforce path exist in the contracts; the model is disabled in the registry and has no acceptance record |

`packages/config/src/launch-models.ts` holds the copy for all three, and both the chooser
and the forms read it. `status` there describes contract readiness rather than interface
readiness, because a form that takes input for a contract that cannot execute it is worse
than no form: it is what decides whether a card offers a launch or a design to read.

What a model still needs is not on its chooser card. Three cards a screen tall are harder
to compare than three short ones, and the only model with anything left is the one whose
badge already says `Design` and whose button already goes to the design. The list itself
lives with the rest of the model's documentation, on `/docs/models`.

## The launch form

One component renders both models, because Stock-Paired is Classic with a different asset
on the quote side and two forms would be two places to fix the same validation. The state
is a `LaunchDraft` of strings — exactly what was typed — and three functions in
`src/lib/launch.ts` act on it:

`validate` returns a list of issues, each carrying the draft key that caused it, so a
control can render its own message, and a `blocking` flag that separates "the chain will
reject this" from "you should look at this". Only blocking issues stop a launch. Every
limit it checks comes from `BOUNDS` in `@verdant/config`, which is generated from the
contracts: a limit written into this file would be a second copy of a rule the chain
already enforces, and the copy is the one that goes stale.

`derive` converts the draft once, into integers, for both the preview and the call. It is
where the fee becomes hundredths of a basis point, the supply becomes wei, the opening
tick becomes a `sqrtPriceX96` and the creator's share of the fee is computed from what the
registry keeps rather than asked for — see ADR-005.

`createParams` shapes what would be submitted, and the form renders it verbatim in a
disclosure beside the summary. What is signed is what was read.

### Units, and why they have their own tests

Nothing in this form throws when it is wrong. The three failures it has actually had were
all off by a factor and all rendered as plausible numbers:

- A percentage was scaled twice, so a 1% fee derived as `100` rather than `10_000`. It
  passed every bound, because 100 is the floor — the market would have been created
  charging one hundredth of what the creator chose.
- `impliedValueWei(totalSupply, sqrtPriceX96)` was called with its arguments reversed,
  which put a billion-token supply's implied value at 10^19 ether.
- Whole tokens were formatted as if they were wei, so a supply of one billion read as `0`
  and a first buy read as 484 631 836 995 230 976% of supply.

`src/lib/launch.test.ts` pins each of them, and pins them against magnitudes rather than
against whatever the code currently returns: a fee is asserted equal to the registry's own
default, and a derived amount is bracketed by a range computed independently in the test.
`packages/ui/src/format/` carries the same discipline — every conversion is integer
arithmetic on `bigint`, and `tick.ts` is Uniswap's own `getSqrtPriceAtTick`,
transliterated, so the price a form shows and the price the pool opens at agree to the
digit.

### What the form cannot do yet

Two things are disclosed on the form itself rather than hidden:

Separate buy and sell fees are selectable and warned about. The hook can enforce a
direction-dependent fee without holding value, by reading `zeroForOne` in `beforeSwap`,
but that is not what is deployed; a market created today charges one fee both ways.

Splitting the creator's share across several addresses is selectable and warned about. One
address receives the creator share today; it may be a splitter the creator runs.

The initial buy is no longer among them: the factory is payable and performs it inside the
same call that creates the token, the pool and the locked position, so there is no window
between creation and the creator's purchase for anyone to trade in. See ADR-009.

## Trading

`src/components/trade-panel.tsx` buys and sells one market. Every number in it comes from
Uniswap's `V4Quoter`, simulated against the real pool, because a Verdant pool's stored
`slot0.lpFee` is written once at initialisation and never updated — the fee is a
`beforeSwap` override, so anything deriving a price from stored state would quote the
opening stage's fee forever and would do it silently. The quoter executes the hook.

The balance beside the amount field is read from the chain rather than from the feed, and
`Max` on an ether balance holds back the current gas price times an allowance for one swap:
spending the last wei of the asset that pays for the transaction is a Max button whose
transaction always fails. An amount above the balance stops at the button, before the
approvals, since approving a token you do not hold enough of buys nothing.

Approvals are explicit steps rather than a bundle. Ether needs none — v4 holds it directly
and the input is the transaction's `value` — but everything else is pulled by the Universal
Router through Permit2, which is two approvals that are not interchangeable, and a missing
one reverts inside `SETTLE_ALL` where it reads as a broken market. Note that a **sell needs
them whatever the market is quoted in**: the input is then the launch token.

## Price history

The chart is `lightweight-charts` drawing the closes of the candles the indexer buckets, at
1m, 5m, 15m, 1h, 4h, 1D or 1W. Three things about it are decisions rather than defaults.

A bucket nobody traded in still has a price, so the series arrives gapless. A
constant-function pool quotes whatever the last trade left it at until somebody moves it,
which is why `candles.fill` in the SDK forward-fills the holes and marks what it invented
— and why the chart does no filling of its own. A client that invented points would be
inventing prices.

Prices cross every boundary as integers scaled by 10^36 and are formatted from those
integers. Only the canvas sees a float, because a token here can be worth 10^-14 of an
ether and a double loses the tail of that. The axis is labelled by the same `formatPrice`
as the heading above it, with the digit count derived from the gridline spacing so that no
two lines carry the same label — there is no exponential notation anywhere, since `2.3e-9`
beside a heading reading `0.00000000234` is two notations for one number.

The colours are the theme's, read from the cascade at mount and converted through a
one-pixel canvas: the stylesheet is authored in `oklch`, the library parses colours itself
and its parser predates that function, and handing it one throws hard enough to take the
whole chart down. Converting is what keeps a single palette in `globals.css`.

The chart and the trades table both poll — a tenth of the bucket for the chart, five
seconds for the table — so a page left open follows the market without a reload.

## Quote assets

`packages/config/src/quote-assets.ts` is a reviewed allowlist of thirty of Robinhood
Chain's own equity tokens — Apple, NVIDIA, Tesla, the S&P 500, silver, oil — each with
eighteen decimals and at least five hundred holders when it was reviewed. They are
first-party assets on this chain rather than wrapped representations of something
elsewhere, which is the reason Stock-Paired is worth building here and would be a much
weaker proposition on Ethereum.

The floor is a floor and not a promise, and the interface says so where the list is shown:
an asset can become illiquid, an equity tracks a market that closes while a pool trades
continuously, and a token paired against one gives its holders no claim on the company —
no dividend, no vote, no redemption.

The list is no longer enforced by this interface. `ModelRegistry` holds the admitted set on
chain, seeded from this file at deployment and checked by the factory on every creation, so
a quote asset the registry has not admitted is refused by a contract rather than by a form.
`packages/contracts/test/BoundsParity.t.sol` asserts the two copies agree. Which side of a
pool the launch token lands on is also a contract's business now: the factory reverts
unless the token's address sorts above the quote asset's, and the SDK mines a salt that
reaches that ordering — ADR-008 explains why the invariant is worth the salt search.

## Reading the feed

`src/lib/feed.ts` is the only place the indexer's JSON becomes the app's types. It parses
every amount into `bigint` at the boundary, and it distinguishes two failures that pages
must never conflate: a market that does not exist, and a feed that is not answering. An
unreachable indexer renders as "the feed is unavailable, the market is unaffected" — a
statement about our server. An empty list renders as "nothing has launched" — a statement
about the chain. `src/lib/feed.test.ts` pins the distinction.

See [`docs/feed.md`](feed.md) for what the indexer stores, what it derives at read time,
and the proof that its answers equal the contracts'.

## Running and checking it

```bash
pnpm dev:stack                                        # anvil, Uniswap, Verdant, three markets, the indexer
VERDANT_FEED_URL=http://127.0.0.1:42069 pnpm --filter @verdant/web dev
```

```bash
pnpm --filter @verdant/web test        # feed parsing, launch validation, candles and the axis
pnpm --filter @verdant/ui test         # formatting and tick maths
pnpm --filter @verdant/web lint
pnpm --filter @verdant/web exec tsc --noEmit
```

With no feed reachable the interface still builds and renders every page.
