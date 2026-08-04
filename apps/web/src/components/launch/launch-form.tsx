"use client";

import { BOUNDS, LAUNCH_MODELS, type LaunchModelId } from "@verdant/config";
import {
  formatAmount,
  formatCompact,
  formatDuration,
  formatFeeRate,
  formatPrice,
  quotePerToken,
} from "@verdant/ui";
import { useState } from "react";
import { useConnection } from "wagmi";

import {
  AmountInput,
  CardChoice,
  Field,
  FormSection,
  Segmented,
  Select,
  SummaryRow,
  TextArea,
  TextInput,
} from "../form";
import { AddressLink, Badge, Notice, TokenAvatar } from "../primitives";
import {
  blockingIssues,
  byteLength,
  derive,
  emptyDraft,
  issueFor,
  launchParams,
  metadataDocument,
  metadataUriOf,
  noteFor,
  readableParams,
  type Custody,
  type LaunchDraft,
  type RewardMode,
} from "../../lib/launch";
import { validate } from "../../lib/launch";
import { ImageUpload } from "./image-upload";
import { LaunchSubmit, useMinedLaunch } from "./launch-submit";
import { QuotePicker } from "./quote-picker";
import { ScheduleEditor } from "./schedule-editor";

const DAY = 86_400;

/**
 * The launch form.
 *
 * One component for both models, because Stock-Paired is Classic with a different asset on
 * the quote side — every other decision is identical, and two forms would be two places to
 * fix the same validation. The differences are exactly the two lines that read `paired`.
 *
 * Three principles hold the layout together:
 *
 *  - **Nothing is asked for twice.** The creator's fee share is derived from the registry,
 *    not entered, so it is shown as a consequence of the fee rather than as a field.
 *  - **Consequences sit beside their cause.** The opening price appears under the tick that
 *    sets it; what the initial buy would return appears under the amount.
 *  - **The summary is the transaction.** The right-hand rail renders the arguments the call
 *    would carry, so what is signed is what was read, and the form cannot quietly add a
 *    parameter the reader never saw.
 */
export function LaunchForm({ modelId }: { readonly modelId: LaunchModelId }) {
  const paired = modelId === "stock-paired";
  const model = LAUNCH_MODELS[modelId];

  const [draft, setDraft] = useState<LaunchDraft>(() => emptyDraft(paired ? "NVDA" : null));
  const { address } = useConnection();

  const issues = validate(draft);
  const blocking = blockingIssues(issues);
  const derived = derive(draft);

  // The token's address is knowable before the launch is sent, so it is shown. The
  // search is only started once the draft is one the contracts would accept, because
  // every keystroke in the name changes the init code hash and would otherwise be a
  // chain read.
  const { mined, reading, problem: miningProblem } = useMinedLaunch({
    draft,
    derived,
    creator: address,
    enabled: blocking.length === 0,
  });

  function set<K extends keyof LaunchDraft>(key: K, value: LaunchDraft[K]) {
    setDraft((previous) => ({ ...previous, [key]: value }));
  }

  const symbol = draft.symbol.replace(/^\$/, "") || "TOKEN";
  const price =
    derived.sqrtPriceX96 === null
      ? null
      : quotePerToken(derived.sqrtPriceX96, derived.quoteDecimals);

  const params =
    address === undefined || mined === undefined
      ? null
      : launchParams(draft, derived, { creator: address, salt: mined.salt });

  // The choices most launches never touch. Every one has a default that produces a valid
  // launch on its own — a billion supply, a mid-range opening price, one flat fee, no
  // allocation, the image as the on-chain URI, frozen — so this is where control lives
  // for the creator who wants it, not a set of blanks the rest have to fill in. Collapsed
  // for Classic (below), shown inline for Stock-Paired, whose creators are already past
  // the simple case by choosing it.
  const advancedSections = (
    <>
      {/* ------------------------------------------------ metadata and permanence */}
      <FormSection
        title="Metadata &amp; permanence"
        description="Where the token's details live, and whether that pointer can ever change. Left alone, the image you uploaded is what goes on chain, frozen forever."
      >
        <OnChainUri uri={metadataUriOf(draft)} />

        <Field
          label="Metadata document"
          htmlFor="metadataUrl"
          error={issueFor(issues, "metadataUrl")}
          counter={`${byteLength(draft.metadataUrl)} / ${BOUNDS.token.metadataUriLength.max}`}
          hint="Optional, and only if you host one. Leave it empty and the image you uploaded is what goes on chain."
        >
          <TextInput
            id="metadataUrl"
            value={draft.metadataUrl}
            onChange={(value) => set("metadataUrl", value)}
            placeholder="https://…/token.json"
            invalid={issueFor(issues, "metadataUrl") !== undefined}
          />
        </Field>

        <Field
          label="Can that link be changed later?"
          hint="A frozen token points at that one address forever, including for you. A mutable one says on chain that it is mutable, so a reader can weigh it."
        >
          <Segmented
            value={draft.metadataMutable ? "mutable" : "frozen"}
            onChange={(value) => set("metadataMutable", value === "mutable")}
            options={[
              { value: "frozen", label: "Frozen forever" },
              { value: "mutable", label: "Editable by me" },
            ]}
          />
        </Field>
      </FormSection>

      {/* ------------------------------------------------------- supply and price */}
      <FormSection
        title="Supply and opening price"
        description="The whole supply is minted once and placed into the pool as one-sided liquidity. The opening tick sets what the first buyer pays. Defaults to one billion at a mid-range price."
      >
        <div className="grid gap-5 sm:grid-cols-2">
          <Field
            label="Total supply"
            htmlFor="supply"
            error={issueFor(issues, "supplyTokens")}
            hint={
              derived.supplyTokens === null
                ? undefined
                : `${formatCompact(derived.supplyTokens, 0)} tokens, minted once`
            }
          >
            <AmountInput
              id="supply"
              value={draft.supplyTokens}
              onChange={(value) => set("supplyTokens", value)}
              unit="tokens"
              invalid={issueFor(issues, "supplyTokens") !== undefined}
            />
          </Field>

          <Field
            label="Opening tick"
            htmlFor="tick"
            error={issueFor(issues, "initialTick")}
            hint={`A multiple of ${BOUNDS.liquidity.tickSpacing}. Higher means more tokens per ${derived.quoteLabel}, so a cheaper token.`}
          >
            <AmountInput
              id="tick"
              value={draft.initialTick}
              onChange={(value) => set("initialTick", value)}
              invalid={issueFor(issues, "initialTick") !== undefined}
            />
          </Field>
        </div>

        <div className="rounded-xl border border-border bg-surface-sunken px-5 py-4">
          <div className="grid gap-4 sm:grid-cols-3">
            <div>
              <p className="text-[0.7rem] uppercase tracking-wider text-ink-muted">
                Opening price
              </p>
              <p className="numeric mt-1 text-[0.95rem] text-ink">
                {price === null ? "—" : `${formatPrice(price)} ${derived.quoteLabel}`}
              </p>
            </div>
            <div>
              <p className="text-[0.7rem] uppercase tracking-wider text-ink-muted">
                Per {derived.quoteLabel}
              </p>
              <p className="numeric mt-1 text-[0.95rem] text-ink">
                {derived.openingPrice === null
                  ? "—"
                  : `${formatCompact(derived.openingPrice)} ${symbol}`}
              </p>
            </div>
            <div>
              <p className="text-[0.7rem] uppercase tracking-wider text-ink-muted">
                Supply implies
              </p>
              <p className="numeric mt-1 text-[0.95rem] text-ink">
                {derived.impliedValueQuote === null
                  ? "—"
                  : `${formatAmount(derived.impliedValueQuote, { decimals: derived.quoteDecimals, places: 4 })} ${derived.quoteLabel}`}
              </p>
            </div>
          </div>
          <p className="mt-3 text-[0.72rem] leading-relaxed text-ink-muted">
            What the supply implies at the opening price is not a valuation and is not what
            it would fetch if sold. The pool is created with no {derived.quoteLabel} in it;
            the first buy brings the first of it, and that buy is yours if you set one below.
          </p>
        </div>
      </FormSection>

    </>
  );

  return (
    <div className="mx-auto grid max-w-6xl gap-6 px-6 lg:grid-cols-[1fr_22rem] lg:items-start">
      <div className="space-y-6">
        {/* ---------------------------------------------------------------- identity */}
        <FormSection
          title="Token details"
          description="The name and ticker are written into the token contract. Everything below them is material for a document you host yourself; the chain records only where it is."
        >
          <div className="grid gap-5 sm:grid-cols-2">
            <Field
              label="Name"
              htmlFor="name"
              error={issueFor(issues, "name")}
              counter={`${byteLength(draft.name)} / ${BOUNDS.token.nameLength.max}`}
            >
              <TextInput
                id="name"
                value={draft.name}
                onChange={(value) => set("name", value)}
                placeholder="Wildflower"
                invalid={issueFor(issues, "name") !== undefined}
              />
            </Field>

            <Field
              label="Ticker"
              htmlFor="symbol"
              error={issueFor(issues, "symbol")}
              note={noteFor(issues, "symbol")}
              counter={`${byteLength(draft.symbol.replace(/^\$/, ""))} / ${BOUNDS.token.symbolLength.max}`}
            >
              <TextInput
                id="symbol"
                mono
                value={draft.symbol}
                onChange={(value) => set("symbol", value.toUpperCase())}
                placeholder="FLOWER"
                invalid={issueFor(issues, "symbol") !== undefined}
              />
            </Field>
          </div>

          <Field
            label="Description"
            htmlFor="description"
            hint="What the token is for. Goes in the document you host, not on chain."
          >
            <TextArea
              id="description"
              rows={3}
              maxLength={600}
              value={draft.description}
              onChange={(value) => set("description", value)}
              placeholder="Describe what this token represents and who it is for."
            />
          </Field>

          <Field label="Image" error={issueFor(issues, "imageUrl")}>
            <ImageUpload value={draft.imageUrl} onChange={(uri) => set("imageUrl", uri)} />
          </Field>

          <div className="grid gap-5 sm:grid-cols-2">
            <Field label="Website" htmlFor="website" error={issueFor(issues, "website")}>
              <TextInput
                id="website"
                value={draft.website}
                onChange={(value) => set("website", value)}
                placeholder="https://project.com"
                invalid={issueFor(issues, "website") !== undefined}
              />
            </Field>

            <Field label="X" htmlFor="twitter">
              <TextInput
                id="twitter"
                value={draft.twitter}
                onChange={(value) => set("twitter", value)}
                placeholder="@project"
              />
            </Field>

            <Field label="Telegram" htmlFor="telegram">
              <TextInput
                id="telegram"
                value={draft.telegram}
                onChange={(value) => set("telegram", value)}
                placeholder="t.me/project"
              />
            </Field>
          </div>

        </FormSection>

        {/* ------------------------------------------------------------------- pair */}
        {paired ? (
          <FormSection
            title="Quote asset"
            description="The asset your token is priced in. It becomes part of the pool's identity and cannot be changed afterwards."
            aside={<Badge tone="neutral">{model.label}</Badge>}
          >
            <QuotePicker
              value={draft.quoteSymbol ?? ""}
              onChange={(value) => set("quoteSymbol", value)}
            />
            {issueFor(issues, "quoteSymbol") === undefined ? null : (
              <p className="text-[0.75rem] text-fall">{issueFor(issues, "quoteSymbol")}</p>
            )}
            <Notice tone="caution" title="Your token is not a share">
              A market priced in {derived.quoteLabel} gives its holders no claim on{" "}
              {derived.quote?.label ?? "the underlying company"}, no dividend, no vote and no
              redemption. The equity token on the other side of the pool stays subject to its
              issuer&apos;s terms, and an equity tracks a market that closes while this pool
              trades continuously.
            </Notice>
          </FormSection>
        ) : null}

        {/* -------------------------------------------------------------------- fees */}
        <FormSection
          title="Swap fee"
          description="Charged on every trade by the pool itself and split between you and the protocol. Written into the hook at creation and editable by nobody afterwards."
        >
          <Field label="Shape">
            <Segmented
              value={draft.feeShape}
              onChange={(value) => set("feeShape", value)}
              options={[
                { value: "flat", label: "One fee, forever" },
                { value: "scheduled", label: "A schedule" },
              ]}
            />
          </Field>

          {draft.feeShape === "flat" ? (
            <Field
              label="Fee"
              error={issueFor(issues, "buyFeePercent")}
              hint="Charged on every swap, buys and sells alike. Separate buy and sell fees are not live on chain yet."
            >
              <FeeInput
                value={draft.buyFeePercent}
                onChange={(value) => set("buyFeePercent", value)}
                invalid={issueFor(issues, "buyFeePercent") !== undefined}
              />
            </Field>
          ) : (
            <ScheduleEditor
              stages={draft.stages}
              onChange={(stages) => set("stages", stages)}
              issues={issues}
            />
          )}

          <div className="rounded-xl border border-accent-ring/40 bg-accent-soft px-5 py-4">
            <p className="text-[0.8rem] font-semibold text-accent-strong">
              {derived.openingFeePpm === null
                ? "Set a fee to see the split"
                : `Of a ${formatFeeRate(derived.openingFeePpm)} fee you keep ${formatFeeRate(derived.creatorFeePpm ?? 0)}`}
            </p>
            <p className="mt-1 text-[0.75rem] leading-relaxed text-ink-muted">
              The protocol keeps{" "}
              {derived.protocolFeePpm === null ? "—" : formatFeeRate(derived.protocolFeePpm)}, which
              is {derived.protocolBps / 100}% of fee revenue and is taken out of the fee rather
              than added on top. Your share is not a field on this form: it is whatever the fee
              leaves after the protocol&apos;s share, so it cannot be set to a number the
              contracts would refuse.
            </p>
          </div>
        </FormSection>

        {/* ----------------------------------------------------------------- rewards */}
        <FormSection
          title="Where the fees go"
          description="One address receives your share of every fee this market ever collects. It is fixed at creation, so nobody — including us — can redirect it later."
        >
          <Field
            label="Recipient"
            hint="On chain the market records one recipient. To split fees across several wallets, point this at a splitter or multisig you control."
          >
            <CardChoice
              columns={2}
              value={draft.rewardMode}
              onChange={(value) => set("rewardMode", value as RewardMode)}
              options={[
                {
                  value: "launch-wallet",
                  label: "This wallet",
                  description: "The wallet that signs the launch receives the fees.",
                },
                {
                  value: "another-wallet",
                  label: "Another address",
                  description: "A multisig, a treasury, or a splitter you already run.",
                },
              ]}
            />
          </Field>

          {draft.rewardMode === "another-wallet" ? (
            <Field
              label="Address"
              htmlFor="rewardWallet"
              error={issueFor(issues, "rewardWallet")}
              hint="Only this address can claim. Check it twice: it cannot be changed after launch."
            >
              <TextInput
                id="rewardWallet"
                mono
                value={draft.rewardWallet}
                onChange={(value) => set("rewardWallet", value)}
                placeholder="0x…"
                invalid={issueFor(issues, "rewardWallet") !== undefined}
              />
            </Field>
          ) : null}
        </FormSection>

        {/* -------------------------------------------------------------- allocation */}
        <FormSection
          title="Your allocation"
          description="A share of supply held back from the pool for you. Left at zero, the whole supply becomes launch liquidity — the initial buy below is delivered to you immediately either way."
        >
          <div className="grid gap-5 sm:grid-cols-2">
            <Field
              label="Share of supply"
              htmlFor="allocation"
              error={issueFor(issues, "allocationPercent")}
              hint={
                derived.allocationTokens === null || derived.allocationBps === 0
                  ? `Up to ${BOUNDS.token.creatorAllocationBps.max / 100}% of supply`
                  : `${formatCompact(derived.allocationTokens, 0)} ${symbol} withheld from the pool`
              }
            >
              <AmountInput
                id="allocation"
                value={draft.allocationPercent}
                onChange={(value) => set("allocationPercent", value)}
                unit="%"
                invalid={issueFor(issues, "allocationPercent") !== undefined}
              />
            </Field>
          </div>

          {derived.allocationBps > 0 ? (
            <>
              <Field
                label="Token access"
                hint="When this reserved allocation unlocks. Enforced by a vesting contract, not by a promise — a schedule cannot be shortened afterwards."
              >
                <CardChoice
                  columns={2}
                  value={draft.custody}
                  onChange={(value) => set("custody", value as Custody)}
                  options={[
                    {
                      value: "none",
                      label: "Immediately",
                      description: "Transferred to you in the launch transaction.",
                    },
                    {
                      value: "locked",
                      label: "Locked, then all at once",
                      description: "Nothing moves until the date, then all of it does.",
                    },
                    {
                      value: "linear",
                      label: "Vested steadily",
                      description: "Releases continuously from launch to the end date.",
                    },
                    {
                      value: "cliff-linear",
                      label: "Cliff, then vested",
                      description: "Nothing until the cliff, then continuously to the end.",
                    },
                  ]}
                />
              </Field>

              {draft.custody === "none" ? null : (
                <div className="grid gap-5 sm:grid-cols-2">
                  {draft.custody === "locked" ? (
                    <Field label="Locked for" error={issueFor(issues, "lockDays")}>
                      <AmountInput
                        value={draft.lockDays}
                        onChange={(value) => set("lockDays", value)}
                        unit="days"
                        invalid={issueFor(issues, "lockDays") !== undefined}
                      />
                    </Field>
                  ) : (
                    <Field label="Vests over" error={issueFor(issues, "vestDays")}>
                      <AmountInput
                        value={draft.vestDays}
                        onChange={(value) => set("vestDays", value)}
                        unit="days"
                        invalid={issueFor(issues, "vestDays") !== undefined}
                      />
                    </Field>
                  )}

                  {draft.custody === "cliff-linear" ? (
                    <Field
                      label="Cliff"
                      error={issueFor(issues, "cliffDays")}
                      hint="Nothing releases before this."
                    >
                      <AmountInput
                        value={draft.cliffDays}
                        onChange={(value) => set("cliffDays", value)}
                        unit="days"
                        invalid={issueFor(issues, "cliffDays") !== undefined}
                      />
                    </Field>
                  ) : null}
                </div>
              )}
            </>
          ) : null}
        </FormSection>

        {/* ------------------------------------------------------------ initial buy */}
        <FormSection
          title="Your first buy"
          description={`Bought as part of the launch, in the same transaction. The pool is created holding no ${derived.quoteLabel}, and this is what gives it a two-sided market.`}
        >
          <Field
            label="Amount"
            htmlFor="initialBuy"
            error={issueFor(issues, "initialBuy")}
            hint={
              derived.initialBuyTokens === null || derived.initialBuyQuote === 0n
                ? undefined
                : `≈ ${formatCompact(derived.initialBuyTokens)} ${symbol}, about ${((derived.initialBuyShareBps ?? 0) / 100).toFixed(2)}% of supply, at the opening price before price impact`
            }
          >
            <AmountInput
              id="initialBuy"
              value={draft.initialBuy}
              onChange={(value) => set("initialBuy", value)}
              unit={derived.quoteLabel}
              invalid={issueFor(issues, "initialBuy") !== undefined}
            />
          </Field>

          <Notice title="This happens inside the launch">
            The factory takes this {derived.quoteLabel === "ETH" ? "ether" : derived.quoteLabel}{" "}
            with the launch and buys in the same transaction, after the pool exists and before
            anybody else can reach it. That is why it is worth setting: leave it at zero and the
            pool opens holding only {symbol}, so the opening price goes to whoever trades first
            rather than to you.
          </Notice>
        </FormSection>

        {/* --------------------------------------------------------------- advanced */}
        {paired ? (
          advancedSections
        ) : (
          <details className="group">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-4 rounded-panel border border-border bg-surface px-6 py-4 text-[0.95rem] font-semibold text-ink shadow-card backdrop-blur-xl transition hover:border-border-strong [&::-webkit-details-marker]:hidden">
              <span>
                Advanced options
                <span className="ml-2 text-[0.8rem] font-normal text-ink-muted">
                  supply, opening price, and on-chain metadata
                </span>
              </span>
              <svg
                viewBox="0 0 16 16"
                aria-hidden="true"
                className="size-4 shrink-0 text-ink-muted transition-transform group-open:rotate-180"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M4 6.5 8 10.5l4-4" />
              </svg>
            </summary>
            <div className="mt-6 space-y-6">{advancedSections}</div>
          </details>
        )}
      </div>

      {/* ------------------------------------------------------------------ summary */}
      <aside className="lg:sticky lg:top-24">
        <div className="rounded-panel border border-border bg-surface p-6 shadow-card backdrop-blur-xl">
          <div className="flex items-center gap-3">
            <TokenAvatar symbol={symbol} uri={metadataUriOf(draft)} />
            <div className="min-w-0">
              <p className="numeric truncate text-[1rem] font-semibold text-ink">{symbol}</p>
              <p className="truncate text-[0.8rem] text-ink-muted">
                {draft.name.trim() === "" ? "Unnamed" : draft.name}
              </p>
            </div>
          </div>

          <div className="mt-5 border-t border-border pt-4">
            <SummaryRow label="Model" value={model.label} />
            <SummaryRow label="Pair" value={`${symbol} / ${derived.quoteLabel}`} />
            <SummaryRow
              label="Supply"
              value={derived.supplyTokens === null ? "—" : formatCompact(derived.supplyTokens, 0)}
            />
            <SummaryRow
              label="Opening price"
              value={price === null ? "—" : formatPrice(price)}
            />
            <SummaryRow
              label={draft.feeShape === "flat" ? "Fee" : "Opening fee"}
              value={
                derived.openingFeePpm === null ? "—" : formatFeeRate(derived.openingFeePpm)
              }
              tone="accent"
            />
            <SummaryRow
              label="Your share of it"
              value={derived.creatorFeePpm === null ? "—" : formatFeeRate(derived.creatorFeePpm)}
            />
            {draft.feeShape === "scheduled" ? (
              <SummaryRow label="Stages" value={derived.stages.length} />
            ) : null}
            <SummaryRow
              label="Your allocation"
              value={
                derived.allocationBps === 0 ? "None" : `${(derived.allocationBps / 100).toFixed(2)}%`
              }
            />
            {derived.vestingDuration > 0 ? (
              <SummaryRow
                label={derived.vestingCliff === derived.vestingDuration ? "Locked for" : "Vests over"}
                value={formatDuration(derived.vestingDuration)}
              />
            ) : null}
            <SummaryRow
              label="First buy"
              value={
                derived.initialBuyQuote === null || derived.initialBuyQuote === 0n
                  ? "None"
                  : `${formatAmount(derived.initialBuyQuote, { decimals: derived.quoteDecimals, places: 4 })} ${derived.quoteLabel}`
              }
            />
          </div>

          {/* The address is CREATE2 and is decided by a salt this form mines, so it is
              known before anything is signed. Showing it is not a nicety: for a market
              quoted in an equity the address is what makes the launch possible at all,
              and a creator should be able to see that it came out above the asset they
              chose. */}
          <div className="mt-5 border-t border-border pt-4">
            <p className="text-[0.72rem] font-semibold uppercase tracking-wider text-ink-muted">
              Token address
            </p>
            {mined === undefined ? (
              <p className="mt-1.5 text-[0.75rem] leading-relaxed text-ink-muted">
                {blocking.length > 0
                  ? "Known once the draft is one the contracts would accept."
                  : address === undefined
                    ? "Decided by your address and a salt, so it is known once a wallet is connected."
                    : reading
                      ? "Working it out…"
                      : "Not available."}
              </p>
            ) : (
              <>
                <p className="mt-1.5">
                  <AddressLink address={mined.token} className="text-[0.75rem]" />
                </p>
                <p className="mt-1 text-[0.7rem] leading-relaxed text-ink-muted">
                  {derived.quote === null
                    ? "Found on the first salt tried, as every ether-quoted launch is."
                    : `Found after ${mined.attempts} ${mined.attempts === 1 ? "salt" : "salts"}, sorting above ${derived.quoteLabel} as the factory requires.`}
                </p>
              </>
            )}
          </div>

          <div className="mt-5 border-t border-border pt-4">
            <p className="text-[0.72rem] font-semibold uppercase tracking-wider text-ink-muted">
              Fixed at creation
            </p>
            <ul className="mt-2 space-y-1.5">
              {[
                "The supply, with no way to mint more",
                draft.feeShape === "flat" ? "The fee" : "Every stage of the schedule",
                "The address your fees are paid to",
                "The locked position, with no early release",
                draft.metadataMutable ? "Nothing else" : "The name, image and description",
              ].map((item) => (
                <li key={item} className="flex gap-2 text-[0.75rem] leading-relaxed text-ink-muted">
                  <span aria-hidden="true" className="mt-1.5 size-1 shrink-0 rounded-full bg-accent" />
                  {item}
                </li>
              ))}
            </ul>
          </div>

          <div className="mt-6">
            {/* The list of blockers is ink on a red wash rather than red on it. The two
                move together as the wash thickens, and this is the panel a creator reads
                when the form will not let them launch. */}
            {blocking.length > 0 ? (
              <div className="rounded-xl border border-fall/40 bg-fall/14 px-4 py-3">
                <p className="text-[0.8rem] font-semibold text-ink">
                  {blocking.length} {blocking.length === 1 ? "thing" : "things"} to fix
                </p>
                <ul className="mt-1.5 space-y-1">
                  {blocking.slice(0, 4).map((issue) => (
                    <li key={`${issue.field}:${issue.message}`} className="text-[0.75rem] text-ink-muted">
                      {issue.message}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            <LaunchSubmit
              draft={draft}
              derived={derived}
              mined={mined}
              mining={reading}
              miningProblem={miningProblem}
              blockers={blocking.length}
              symbol={symbol}
            />
          </div>

          {/* The arguments, verbatim, from the same object the write path encodes — so
              what is signed is what was read, and this cannot drift into a description
              of a call rather than the call. */}
          <details className="mt-4 rounded-xl border border-border bg-surface-sunken px-4 py-3">
            <summary className="cursor-pointer text-[0.78rem] font-medium text-ink">
              The call this makes
            </summary>
            <pre className="numeric mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all text-[0.68rem] leading-relaxed text-ink-muted">
              {params === null
                ? "Connect a wallet: the salt and the fee recipient both depend on your address."
                : JSON.stringify(readableParams(params), null, 1)}
            </pre>
          </details>

          <details className="mt-2 rounded-xl border border-border bg-surface-sunken px-4 py-3">
            <summary className="cursor-pointer text-[0.78rem] font-medium text-ink">
              A document you could host
            </summary>
            <p className="mt-2 text-[0.7rem] leading-relaxed text-ink-muted">
              Built from what you filled in above. Put it somewhere you control and give
              its address as the metadata address; nothing here is uploaded for you.
            </p>
            <pre className="numeric mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all text-[0.68rem] leading-relaxed text-ink-muted">
              {JSON.stringify(metadataDocument(draft), null, 1)}
            </pre>
          </details>
        </div>
      </aside>
    </div>
  );
}

/**
 * The one string the token will record, resolved from the two fields that can fill it.
 *
 * Shown rather than explained because the rule is trivial and the consequence is not: this
 * is the only piece of the identity the chain keeps, every interface reads it, and a token
 * launched with it empty has no picture anywhere and no way to acquire one if the link was
 * frozen. Saying so once, next to the value, beats a paragraph nobody finishes.
 */
function OnChainUri({ uri }: { readonly uri: string }) {
  return (
    <div className="rounded-xl border border-border bg-surface-sunken px-4 py-3">
      <p className="text-[0.7rem] uppercase tracking-wide text-ink-faint">
        Recorded on chain
      </p>
      {uri === "" ? (
        <p className="mt-1 text-[0.8rem] leading-relaxed text-ink-muted">
          Nothing. The token will carry its name and ticker and no picture. Add an image
          above if you want one — nothing is uploaded on your behalf, so the link has to be
          somewhere you host.
        </p>
      ) : (
        <p className="mono mt-1 break-all text-[0.78rem] leading-relaxed text-ink">{uri}</p>
      )}
    </div>
  );
}

/**
 * A fee, with the four values most markets pick one click away.
 *
 * The contracts allow anything from 0.01% to 10%, so a dropdown of ten whole percentages
 * would be a narrower control than the protocol — but a free-text field with no anchors
 * makes every creator invent a number. Chips plus an input is both.
 */
function FeeInput({
  value,
  onChange,
  invalid,
}: {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly invalid: boolean;
}) {
  return (
    <div>
      <AmountInput value={value} onChange={onChange} unit="%" placeholder="1.00" invalid={invalid} />
      <div className="mt-2 flex flex-wrap gap-1.5">
        {["0.30", "1.00", "2.00", "5.00"].map((preset) => (
          <button
            key={preset}
            type="button"
            onClick={() => onChange(preset)}
            className={`numeric rounded-full border px-2.5 py-1 text-[0.72rem] transition ${
              value === preset
                ? "border-accent bg-accent-soft text-accent-strong"
                : "border-border bg-surface text-ink-muted hover:border-border-strong hover:text-ink"
            }`}
          >
            {preset}%
          </button>
        ))}
      </div>
    </div>
  );
}

/** Unused today; kept so the fee dropdown idiom is available if chips prove too loose. */
export function FeeSelect({
  value,
  onChange,
}: {
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  const options = Array.from({ length: 10 }, (_, index) => {
    const percent = `${index + 1}.00`;
    return { value: percent, label: `${percent}%` };
  });
  return <Select value={value} onChange={onChange} options={options} />;
}

/** Exported for the docs page, which explains the same durations in prose. */
export const VESTING_DAY_BOUNDS = {
    minimum: Math.ceil(BOUNDS.vesting.duration.min / DAY),
  maximum: Math.floor(BOUNDS.vesting.duration.max / DAY),
} as const;
