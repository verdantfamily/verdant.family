import {
  BOUNDS,
  LAUNCH_MODELS,
  LAUNCH_MODEL_ORDER,
  LAUNCH_MODEL_STATUS_LABELS,
  MODELS,
  QUOTE_ASSETS,
  QUOTE_ASSET_MINIMUM_HOLDERS,
  isDeployed,
  robinhoodMainnet,
  ROBINHOOD_MAINNET_ID,
} from "@verdant/config";
import Link from "next/link";
import type { ReactNode } from "react";

import { AddressLink, Badge, Notice } from "../components/primitives";

/**
 * The documentation, as data.
 *
 * One module holds every page, so the sidebar, the routes and the content cannot drift from
 * each other: a section that exists is a section that is linked, and a link that exists
 * resolves. Adding a page means adding an entry here and nothing else.
 *
 * Numbers in the prose are read from `@verdant/config`, never typed out. A document that
 * claims a maximum of eight stages while the contracts allow nine is worse than no
 * document, and the only defence that survives a year of edits is not writing the number
 * down twice.
 */

export interface DocSection {
  readonly slug: string;
  readonly title: string;
  readonly summary: string;
  readonly group: "using" | "models" | "verify";
  readonly body: ReactNode;
}

export const DOC_GROUPS = {
  using: "Using Verdant",
  models: "Launch models",
  verify: "Verify",
} as const;

const DAY = 86_400;
const explorer = robinhoodMainnet.blockExplorers?.default.url;

function H({ children }: { readonly children: ReactNode }) {
  return (
    <h2 className="mt-10 text-[1.15rem] font-semibold tracking-tight text-ink first:mt-0">
      {children}
    </h2>
  );
}

function P({ children }: { readonly children: ReactNode }) {
  return <p className="mt-3 text-[0.92rem] leading-[1.75] text-ink-muted">{children}</p>;
}

function List({ children }: { readonly children: ReactNode }) {
  return (
    <ul className="mt-3 space-y-2 text-[0.92rem] leading-[1.7] text-ink-muted">{children}</ul>
  );
}

function Item({ children }: { readonly children: ReactNode }) {
  return (
    <li className="flex gap-2.5">
      <span aria-hidden="true" className="mt-2 size-1 shrink-0 rounded-full bg-accent" />
      <span>{children}</span>
    </li>
  );
}

function Term({ children }: { readonly children: ReactNode }) {
  return <span className="font-medium text-ink">{children}</span>;
}

function Table({
  head,
  rows,
}: {
  readonly head: readonly string[];
  readonly rows: readonly (readonly ReactNode[])[];
}) {
  return (
    <div className="mt-4 overflow-x-auto rounded-card border border-border">
      <table className="w-full text-[0.85rem]">
        <thead>
          <tr className="border-b border-border bg-surface-sunken text-[0.7rem] uppercase tracking-wider text-ink-muted">
            {head.map((cell) => (
              <th key={cell} className="px-4 py-2.5 text-left font-medium">
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((row, index) => (
            <tr key={index}>
              {row.map((cell, cellIndex) => (
                <td
                  key={cellIndex}
                  className={`px-4 py-2.5 ${cellIndex === 0 ? "font-medium text-ink" : "text-ink-muted"}`}
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export const DOC_SECTIONS: readonly DocSection[] = [
  {
    slug: "",
    title: "Overview",
    summary: "What a launch model is, and what it fixes for good.",
    group: "using",
    body: (
      <>
        <P>
          Verdant creates fixed-supply tokens on Uniswap v4. A launch mints the whole supply
          once, opens a pool for it, puts the supply into that pool as liquidity and hands the
          resulting position to a contract that will not give it back. The swap fee is written
          into a hook at the same moment and cannot be edited afterwards by the creator, by
          Verdant, or by a vote.
        </P>
        <P>
          What a creator chooses is a <Term>launch model</Term>: what the token is priced
          against, and how its fee behaves over time. Everything else about a market is the
          same in every model, because the guarantees are what the protocol is for.
        </P>

        <H>The three models</H>
        <Table
          head={["Model", "Priced in", "Status"]}
          rows={LAUNCH_MODEL_ORDER.map((id) => [
            <Link key={id} href="/docs/models" className="text-accent underline underline-offset-4">
              {LAUNCH_MODELS[id].label}
            </Link>,
            LAUNCH_MODELS[id].pair,
            <Badge key={`${id}-status`} tone={LAUNCH_MODELS[id].status === "ready" ? "ink" : "neutral"}>
              {LAUNCH_MODEL_STATUS_LABELS[LAUNCH_MODELS[id].status]}
            </Badge>,
          ])}
        />

        <H>What is true of every market</H>
        <List>
          <Item>
            <Term>The supply is final.</Term> The token has no mint function, no owner and no
            upgrade path. The number that exists at launch is the number that will ever exist.
          </Item>
          <Item>
            <Term>The fee is final.</Term> One fee, or a schedule of up to{" "}
            {BOUNDS.schedule.stageCount.max} stages, written into the hook at creation. A
            schedule advances on the clock and on nothing else — no oracle, no trigger, no
            discretion.
          </Item>
          <Item>
            <Term>The launch position is locked.</Term> It goes to a locker with no operator and
            no early-release path. Fees can be collected out of it; liquidity cannot.
          </Item>
          <Item>
            <Term>Fee recipients are final.</Term> Where the creator&apos;s share is paid is
            decided at creation and cannot be redirected by anyone afterwards.
          </Item>
          <Item>
            <Term>Nobody takes custody.</Term> Verdant never holds your funds, and the hook is
            deployed at an address whose bits make it incapable of taking value out of a swap.
          </Item>
        </List>

        <Notice tone="caution" title="What none of that guarantees">
          A locked position keeps liquidity in the pool; it says nothing about a price. A fixed
          fee earns nothing without trading, and Verdant cannot cause trading. The contracts
          have unit, fuzz, invariant and fork coverage, and have not had an independent audit.
        </Notice>
      </>
    ),
  },

  {
    slug: "launch-flow",
    title: "Launch flow",
    summary: "What the transaction does, step by step.",
    group: "using",
    body: (
      <>
        <P>
          A launch is one call to the factory. It either completes every step below or reverts
          entirely — there is no partially created market, and nothing is registered until the
          market fully exists.
        </P>

        <H>Inside the transaction</H>
        <List>
          <Item>
            <Term>Validate.</Term> The name, ticker, supply, model, schedule, opening tick and
            allocation are checked against the registry&apos;s bounds. The hook re-checks the
            schedule when the pool is initialised, so a market that reached the pool was
            validated twice by two contracts.
          </Item>
          <Item>
            <Term>Deploy the token.</Term> A fixed-supply ERC-20 at an address derived from your
            own address and a salt, so a memorable address is available to you without letting
            one creator occupy another&apos;s.
          </Item>
          <Item>
            <Term>Open the pool.</Term> At the opening tick you chose, with tick spacing{" "}
            {BOUNDS.liquidity.tickSpacing} and a dynamic fee flag that hands fee decisions to
            the hook.
          </Item>
          <Item>
            <Term>Provide the liquidity.</Term> The supply, less any allocation you withheld,
            goes into a single one-sided position. There is no ether in the pool at this point;
            the first buyer brings the first of it.
          </Item>
          <Item>
            <Term>Lock the position.</Term> The position NFT is transferred to a locker holding
            it for the market&apos;s life.
          </Item>
          <Item>
            <Term>Register.</Term> Last, so the public record only ever describes a market that
            exists in full.
          </Item>
        </List>

        <H>What you decide</H>
        <Table
          head={["Choice", "Range", "Changeable later"]}
          rows={[
            [
              "Name and ticker",
              `${BOUNDS.token.nameLength.max} and ${BOUNDS.token.symbolLength.max} bytes`,
              "No",
            ],
            [
              "Supply",
              `${BOUNDS.token.totalSupplyTokens.min.toLocaleString("en-US")} to ${BOUNDS.token.totalSupplyTokens.max.toLocaleString("en-US")} tokens`,
              "No",
            ],
            [
              "Fee",
              `${BOUNDS.schedule.feePpm.min / 10_000}% to ${BOUNDS.schedule.feePpm.max / 10_000}%`,
              "No",
            ],
            [
              "Schedule",
              `1 to ${BOUNDS.schedule.stageCount.max} stages, up to ${BOUNDS.schedule.startOffset.max / DAY} days out`,
              "No",
            ],
            [
              "Your allocation",
              `0% to ${BOUNDS.token.creatorAllocationBps.max / 100}% of supply`,
              "No",
            ],
            [
              "Vesting",
              `${BOUNDS.vesting.duration.min / DAY} to ${BOUNDS.vesting.duration.max / DAY} days, or none`,
              "No",
            ],
            ["Fee recipient", "Any address", "No"],
            ["Metadata", "A document the token points at", "Only if you choose mutable"],
          ]}
        />

        <H>Your first buy is a second transaction</H>
        <P>
          The factory does not accept ether, so the launch cannot include a purchase. Buying is
          an ordinary swap you sign afterwards, and in the gap between the two anyone else can
          trade. Bundling the first buy into the launch is planned work; until it lands, treat
          that gap as real.
        </P>
      </>
    ),
  },

  {
    slug: "trading",
    title: "Trading and pricing",
    summary: "Where the price comes from, and what the fee does to a trade.",
    group: "using",
    body: (
      <>
        <P>
          Every market is an ordinary Uniswap v4 pool. Trades go through Uniswap&apos;s router
          rather than through us, so a market is tradable whether or not this interface is
          running, and the price shown here is read from the pool rather than kept by us.
        </P>

        <H>The price</H>
        <P>
          A pool stores its price as a square root in fixed-point form, and every figure on a
          market page is derived from that value with integer arithmetic. The{" "}
          <Term>implied value</Term> shown beside it is the supply multiplied by that price. It
          is not a market capitalisation, is quoted in ether rather than dollars, and is not
          what the supply would fetch if it were sold — selling into a pool moves the price
          against the seller.
        </P>

        <H>The fee</H>
        <P>
          The hook tells the pool what fee to charge at the instant of each swap by reading the
          schedule and comparing it to the block&apos;s timestamp. The fee is taken by Uniswap
          in the currency being paid in and accrues inside the locked position, which is why the
          hook never needs to hold anything.
        </P>
        <P>
          Near a stage transition, a swap can land either side of the change, because which fee
          applies depends on the timestamp of the block that includes it. Within{" "}
          {BOUNDS.trading.transitionBoundaryWindow} seconds of a transition this interface
          quotes the higher of the two fees and says that it is doing so.
        </P>

        <H>Price impact</H>
        <P>
          A launch position is one-sided and concentrated, so a trade that is large relative to
          it moves the price a long way. The estimate beside a trade input is calculated at the
          current price net of the fee and is labelled as being before price impact — a real
          quote comes from Uniswap&apos;s quoter at the moment of the trade.
        </P>
      </>
    ),
  },

  {
    slug: "fees",
    title: "Creator fees",
    summary: "How a creator earns, and how the money is claimed.",
    group: "using",
    body: (
      <>
        <P>
          A market&apos;s swap fee is split between the creator and the protocol in shares fixed
          at creation. The protocol takes{" "}
          {BOUNDS.splits.protocolBps.default / 100}% of fee revenue, capped by contract at{" "}
          {BOUNDS.splits.protocolBps.max / 100}% for any future market, and the creator receives
          the rest — so on a 1% swap fee the creator&apos;s share is 0.9% of the trade and the
          protocol&apos;s is 0.1%.
        </P>
        <P>
          The creator&apos;s share is not a field on the launch form, and that is deliberate. It
          is whatever the fee leaves after the protocol&apos;s share, which means it cannot be
          set to a number the contracts would refuse, and there is only one contract that owns
          the arithmetic.
        </P>

        <H>Two steps, both permissionless</H>
        <List>
          <Item>
            <Term>Collect.</Term> Fees accrue inside the locked position until someone calls
            collect on the locker, which moves them to the market&apos;s splitter. Anyone may
            call it, for any market, at any time.
          </Item>
          <Item>
            <Term>Claim.</Term> Each recipient then claims their own balance from the splitter.
            Nothing is ever pushed to a recipient, so a recipient that cannot receive ether
            cannot block anyone else&apos;s claim.
          </Item>
        </List>

        <H>Which currency you earn in</H>
        <P>
          Because the fee is charged by Uniswap rather than skimmed by the hook, it accrues in
          whichever currency was paid in: ether from buys, and your own token from sells. That
          is the trade-off of a hook that cannot take custody, and it is stated on the launch
          form rather than discovered on the first claim.
        </P>

        <H>Nobody can redirect it</H>
        <P>
          The recipient address is immutable for the life of the market. There is no owner, no
          admin key and no takeover authority — if a project changes hands, the fee stream does
          not follow unless the recipient was a contract that already allowed for it. Choosing a
          multisig or your own splitter at launch is the way to keep that option.
        </P>
      </>
    ),
  },

  {
    slug: "models",
    title: "The models in detail",
    summary: "Classic, Stock-Paired and Evergreen, with what each fixes.",
    group: "models",
    body: (
      <>
        {LAUNCH_MODEL_ORDER.map((id) => {
          const model = LAUNCH_MODELS[id];
          return (
            <section key={id} className="mt-12 first:mt-0">
              <div className="flex flex-wrap items-center gap-3">
                <h2 className="text-[1.15rem] font-semibold tracking-tight text-ink">
                  {model.label}
                </h2>
                <Badge tone={model.status === "ready" ? "ink" : "neutral"}>
                  {LAUNCH_MODEL_STATUS_LABELS[model.status]}
                </Badge>
              </div>

              <P>{model.summary}</P>

              <h3 className="mt-6 text-[0.72rem] font-semibold uppercase tracking-wider text-ink-muted">
                Fixed at creation
              </h3>
              <List>
                {model.fixedBehaviour.map((item) => (
                  <Item key={item}>{item}</Item>
                ))}
              </List>

              <h3 className="mt-6 text-[0.72rem] font-semibold uppercase tracking-wider text-ink-muted">
                Risks
              </h3>
              <List>
                {model.risks.map((item) => (
                  <Item key={item}>{item}</Item>
                ))}
              </List>

              {model.remaining === undefined ? null : (
                <div className="mt-6">
                  <Notice title="Not finished">
                    <ul className="list-disc space-y-1 pl-5">
                      {model.remaining.map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ul>
                  </Notice>
                </div>
              )}

              {model.status === "design" ? null : (
                <Link
                  href={`/launch/${id}`}
                  className="mt-5 inline-flex text-[0.88rem] font-medium text-accent underline decoration-accent-ring underline-offset-4 transition hover:text-accent-strong"
                >
                  Open the {model.label} form
                </Link>
              )}
            </section>
          );
        })}

        <H>Fee shapes, inside any model</H>
        <P>
          A model decides what a market is priced against. How its fee moves over time is a
          second, independent choice, and the same two shapes are available in every model.
        </P>
        <Table
          head={["Shape", "Stages", "What it does"]}
          rows={[
            [MODELS.fixed.label, "1", MODELS.fixed.thesis],
            [
              MODELS.progressive.label,
              `2 to ${BOUNDS.schedule.stageCount.max}`,
              MODELS.progressive.thesis,
            ],
          ]}
        />
      </>
    ),
  },

  {
    slug: "quote-assets",
    title: "Quote assets",
    summary: "Which tokenized equities can price a market, and why those.",
    group: "models",
    body: (
      <>
        <P>
          A Stock-Paired market is priced in one of the chain&apos;s own tokenized equities
          rather than in ether. {QUOTE_ASSETS.length} assets are admitted. The list is a
          reviewed allowlist, not a live query of the chain: pairing a launch against an
          arbitrary ERC-20 is how a market ends up quoted in something that cannot be sold.
        </P>

        <H>What admission required</H>
        <List>
          <Item>
            A first-party issue — the token is one of the chain operator&apos;s own equity
            tokens, so there is no bridge or wrapper contract between the pool and the asset.
          </Item>
          <Item>
            Eighteen decimals, so a market&apos;s price has the same shape as an ether pair and
            the same arithmetic can derive it.
          </Item>
          <Item>A live price on the chain&apos;s explorer at review time.</Item>
          <Item>
            At least {QUOTE_ASSET_MINIMUM_HOLDERS.toLocaleString("en-US")} holders, as a floor on
            the asset being in real use.
          </Item>
        </List>

        <P>
          None of that is a guarantee of future liquidity, of a tradable spread, or that the
          issuer will keep redemption open. It is a floor, and a market priced in an asset that
          later becomes illiquid is hard to leave regardless of its own liquidity.
        </P>

        <H>The admitted assets</H>
        <Table
          head={["Ticker", "Asset", "Address"]}
          rows={QUOTE_ASSETS.map((asset) => [
            asset.symbol,
            asset.label,
            <AddressLink key={asset.address} address={asset.address} />,
          ])}
        />

        <Notice tone="caution" title="A launched token is not a share">
          Pairing against an equity token creates a price relationship and nothing else. A token
          launched here carries no claim on the underlying company, fund or security, no
          dividend, no vote and no redemption. The equity token on the other side of the pool
          stays subject to its issuer&apos;s terms, including any transfer or redemption
          controls, which Verdant does not control and cannot override.
        </Notice>
      </>
    ),
  },

  {
    slug: "network",
    title: "Network",
    summary: "The chain, and what its properties mean for a market.",
    group: "verify",
    body: (
      <>
        <P>
          Verdant runs on {robinhoodMainnet.name}, chain id {ROBINHOOD_MAINNET_ID}. Gas is paid
          in ether, and every market&apos;s quote side is either that ether or one of the
          chain&apos;s tokenized equities.
        </P>

        <Table
          head={["Property", "Value"]}
          rows={[
            ["Chain id", String(ROBINHOOD_MAINNET_ID)],
            ["Native currency", robinhoodMainnet.nativeCurrency.symbol],
            ["Explorer", explorer ?? "—"],
            ["Verdant deployed", isDeployed(ROBINHOOD_MAINNET_ID) ? "Yes" : "Not yet"],
          ]}
        />

        <H>Timestamps, not block numbers</H>
        <P>
          Every duration in the protocol — a fee stage, a vesting cliff, a lock — is measured in
          seconds against the block timestamp. On this kind of chain the block number tracks a
          different chain&apos;s blocks, so a schedule expressed in blocks would drift; a
          schedule expressed in seconds does not. It also means a transition can land a moment
          either side of a countdown, which is why a schedule&apos;s exact instants are shown
          alongside its delays.
        </P>
      </>
    ),
  },

  {
    slug: "contracts",
    title: "Contracts",
    summary: "What is deployed, and what each contract is allowed to do.",
    group: "verify",
    body: (
      <>
        {isDeployed(ROBINHOOD_MAINNET_ID) ? null : (
          <Notice tone="caution" title="Not deployed yet">
            The protocol is not on {robinhoodMainnet.name} yet. The contracts are written,
            tested and verified against a fork of the live chain, and this page will carry their
            addresses and runtime hashes the moment they exist. Until then there is nothing to
            trade and nothing to sign, and no page here will pretend otherwise.
          </Notice>
        )}

        <H>The six deployed once</H>
        <Table
          head={["Contract", "What it does", "Can it be changed"]}
          rows={[
            [
              "VerdantHook",
              "Answers the pool's fee question on every swap and refuses any pool it did not authorise.",
              "No. Its address encodes its permissions.",
            ],
            [
              "VerdantFactory",
              "Creates a market atomically: token, pool, liquidity, lock, registration.",
              "No. Its counterparties are immutables.",
            ],
            [
              "ModelRegistry",
              "Holds the bounds a launch is validated against and the protocol's fee share.",
              "Bounds for future markets only. A created market snapshots what applied to it.",
            ],
            [
              "MarketRegistry",
              "The public record of every market created.",
              "Append-only.",
            ],
            [
              "VerdantDeployer",
              "Deploys each market's token, splitter, locker and vesting.",
              "No.",
            ],
            [
              "FactoryOrigin",
              "The anchor the factory's address derives from. Can create once.",
              "No.",
            ],
          ]}
        />

        <H>Per market</H>
        <P>
          Every launch also creates its own token, splitter and locker, and a vesting contract
          if an allocation was withheld. They are listed on the market&apos;s page, with links
          to the explorer, because a claim about where fees go should be checkable against the
          contract that holds them rather than against this interface.
        </P>

        <H>What has no owner</H>
        <P>
          The token has no mint function and no owner. The locker has no operator and no
          early-release path. The splitter&apos;s recipients are immutable clone arguments. The
          hook has no admin function at all. The registry owner can change bounds for future
          markets and cannot touch an existing one.
        </P>
      </>
    ),
  },

  {
    slug: "verify",
    title: "How to verify",
    summary: "Checking every claim on this site against the chain.",
    group: "verify",
    body: (
      <>
        <P>
          Nothing here needs to be believed. Every figure this interface shows is derived from
          state a contract holds, and each can be read independently — which is the only reason
          a claim like &ldquo;the fee cannot change&rdquo; is worth making.
        </P>

        <H>The fee really is fixed</H>
        <P>
          Read the market&apos;s configuration from the hook. It returns the whole schedule:
          each stage&apos;s fee and the offset it starts at. There is no setter on the hook, so
          the schedule you read at creation is the schedule that will apply for the market&apos;s
          life. Compare it to the ladder on the market page — they are the same numbers, and a
          test in this repository asserts as much on every commit.
        </P>

        <H>The liquidity really is locked</H>
        <P>
          The market page names the locker and the position it holds. Read the position&apos;s
          owner from Uniswap&apos;s position manager: it is the locker. Read the locker&apos;s
          unlock time: for a permanent lock it is the sentinel value that can never be reached.
          The locker exposes a way to collect fees and no way to withdraw liquidity.
        </P>

        <H>The supply really is fixed</H>
        <P>
          The token&apos;s verified source has no mint function and no owner. Its total supply
          was set once in the constructor. Read it from the explorer and compare it with the
          figure on the market page.
        </P>

        <H>The fee split really is what we say</H>
        <P>
          The splitter stores its recipients and shares as immutable arguments. Read them
          directly, and read the balance waiting for each recipient. Anyone can call collect and
          move accrued fees from the locked position to the splitter, so nobody depends on us to
          make a claim possible.
        </P>

        <H>The interface is not the protocol</H>
        <P>
          If this site disappeared, every market would keep trading through any Uniswap
          interface, every fee would keep accruing, and every claim would still be callable
          directly. That is the test of whether a launchpad&apos;s guarantees live in its
          contracts or in its website.
        </P>
      </>
    ),
  },

  {
    slug: "risks",
    title: "Risks",
    summary: "What can go wrong, stated plainly.",
    group: "verify",
    body: (
      <>
        <P>
          The guarantees on this site are narrow on purpose. Here is what they do not cover.
        </P>

        <H>Nothing here is a claim about price</H>
        <P>
          A locked position, a fixed supply and an immutable fee are facts about mechanics. A
          token can be volatile, can be illiquid, and can lose all of its value with every one
          of those facts intact. Verdant does not review the projects that launch here, does not
          endorse them and does not give financial advice.
        </P>

        <H>The contracts have not been audited</H>
        <P>
          They have unit, fuzz, invariant and fork coverage, and are verified against a fork of
          the live chain before deployment. They have not received an independent audit or a
          public security contest. That is a real gap and it is stated rather than buried.
        </P>

        <H>A creator can still disappoint you</H>
        <P>
          The protocol constrains what a creator can do to a market&apos;s supply, fee and
          liquidity. It does not constrain what they say, whether they keep building, or what
          they do with an allocation once it vests. A market with a mutable metadata document
          can change its own description and image, and discloses that it can.
        </P>

        <H>Timing is approximate at the edges</H>
        <P>
          Fee stages advance on block timestamps, so a transition can occur slightly before or
          after a countdown, and a swap submitted close to one may execute under either fee.
        </P>

        <H>An equity pair adds the issuer&apos;s risks to yours</H>
        <P>
          A Stock-Paired market depends on a token issued by someone else, under terms they
          control. It can gap across a weekend while the pool trades continuously, and it can
          become illiquid independently of the market that is priced in it.
        </P>
      </>
    ),
  },
];

export function docSection(slug: string | undefined): DocSection | undefined {
  return DOC_SECTIONS.find((section) => section.slug === (slug ?? ""));
}

export function docNeighbours(slug: string | undefined): {
  readonly previous: DocSection | undefined;
  readonly next: DocSection | undefined;
} {
  const index = DOC_SECTIONS.findIndex((section) => section.slug === (slug ?? ""));
  return {
    previous: index > 0 ? DOC_SECTIONS[index - 1] : undefined,
    next: index >= 0 && index < DOC_SECTIONS.length - 1 ? DOC_SECTIONS[index + 1] : undefined,
  };
}
