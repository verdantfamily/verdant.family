"use client";

import { BOUNDS } from "@verdant/config";
import { pool, trade } from "@verdant/sdk";
import { formatAmount, formatCompact, formatDuration, formatFeeRate } from "@verdant/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { erc20Abi } from "viem";
import { useConnection, usePublicClient } from "wagmi";

import { CHAIN_ID, EXTERNAL, VERDANT_ADDRESSES, chain, type AddressProblem } from "../lib/chain";
import { describeError } from "../lib/errors";
import type { Market } from "../lib/feed";
import { parseDecimal } from "../lib/launch";
import { describeQuote, formatQuoteAmount } from "../lib/quote";
import {
  anyApprovalNeeded,
  approvalsNeeded,
  inputAsset,
  isNativeInput,
  minimumReceived,
  permit2Expiration,
  PERMIT2_APPROVAL_SECONDS,
  zeroForOne,
  type Allowances,
  type Side,
} from "../lib/trade";
import { ConnectButton } from "./connect-button";
import { AmountInput, Segmented } from "./form";
import { MissingAddresses, TransactionNote, useTransaction } from "./transaction";

/**
 * Buying and selling one market.
 *
 * ## Where the numbers come from
 *
 * The quote is Uniswap's `V4Quoter`, simulated against the real pool, and it is the
 * only correct source for one here: a Verdant pool's stored `slot0.lpFee` is written
 * once at initialisation and never updated, because the fee is a `beforeSwap` override.
 * Anything that derived a price from stored state would quote the opening stage's fee
 * forever and would do it silently. The quoter executes the hook, so the number it
 * returns is what the swap would return.
 *
 * The one thing the quoter cannot know is which fee will be in force when the block
 * lands. Inside the boundary window a swap may execute either side of a stage change,
 * so the minimum received is recomputed as though the worse of the two fees applied —
 * see `minimumReceived` in `../lib/trade.ts`. A quote that assumes the favourable side
 * of a race is a quote that is sometimes a lie.
 *
 * ## What has to happen before a swap
 *
 * Nothing, if the input is ether: v4 holds ether directly and the input is the
 * transaction's `value`. Everything else is an ERC-20, and the Universal Router pulls
 * an ERC-20 through Permit2 rather than holding an allowance itself — so two approvals
 * are needed and they are not interchangeable. Both are offered as explicit steps
 * before the swap, because a missing one reverts inside `SETTLE_ALL` and reads as a
 * broken market rather than as a missing signature.
 *
 * Note that a **sell always needs them**, whatever the market is quoted in: the input
 * is then the launch token. "Ether market, no approvals" is true of buying only.
 */
export function TradePanel({
  market,
  initialAmount,
}: {
  readonly market: Market;
  /** Prefilled after a launch, where the creator already said what they meant to buy. */
  readonly initialAmount?: string | undefined;
}) {
  const quote = describeQuote(market.quote);
  const router = useRouter();
  const client = usePublicClient();
  const queryClient = useQueryClient();
  const { address, chainId, status } = useConnection();

  const [side, setSide] = useState<Side>("buy");
  const [amount, setAmount] = useState(initialAmount ?? "");
  const [slippagePercent, setSlippagePercent] = useState(
    (BOUNDS.trading.defaultSlippageBps / 100).toFixed(2),
  );

  const approval = useTransaction();
  const swap = useTransaction();

  const connected = status === "connected" && address !== undefined;
  const wrongNetwork = connected && chainId !== CHAIN_ID;

  const inputDecimals = side === "buy" ? quote.decimals : market.decimals;
  const amountIn = parseDecimal(amount, inputDecimals) ?? 0n;
  const debouncedAmountIn = useDebounced(amountIn, 350);

  const slippageBps = parseSlippageBps(slippagePercent);

  const nextFeePpm = market.stages[market.fee.stageIndex + 1]?.feePpm ?? null;
  const nearTransition =
    market.fee.secondsToNextTransition !== null &&
    nextFeePpm !== null &&
    market.fee.secondsToNextTransition <= BOUNDS.trading.transitionBoundaryWindow;
  const worstFeePpm = nearTransition && nextFeePpm !== null
    ? Math.max(market.fee.ppm, nextFeePpm)
    : market.fee.ppm;

  const addresses = VERDANT_ADDRESSES.ok ? VERDANT_ADDRESSES.addresses : null;
  const poolKey = useMemo(
    () =>
      addresses === null
        ? null
        : pool.poolKeyFor(market.quote.asset, market.token, addresses.hook),
    [addresses, market.quote.asset, market.token],
  );

  const input = inputAsset({ side, token: market.token, quoteAsset: market.quote.asset });
  const native = isNativeInput(input);

  // --- the quote -----------------------------------------------------------------

  const quoted = useQuery({
    queryKey: [
      "quote",
      market.poolId,
      side,
      debouncedAmountIn.toString(),
      addresses?.hook,
    ],
    queryFn: async (): Promise<bigint> => {
      if (client === undefined || poolKey === null) throw new Error("not ready");
      const answer = await trade.quoteExactIn(client, {
        quoter: EXTERNAL.quoter,
        poolKey,
        zeroForOne: zeroForOne(side),
        exactAmount: debouncedAmountIn,
      });
      return answer.amountOut;
    },
    enabled: client !== undefined && poolKey !== null && debouncedAmountIn > 0n,
    // A price moves. Nothing here is cached long enough to be traded on, and the
    // interval is what makes a quote left on screen stop being a claim about now.
    staleTime: 10_000,
    refetchInterval: 15_000,
    retry: false,
  });

  // --- what the chain thinks the time is ------------------------------------------

  // Permit2's expiry is a chain timestamp and the reader's clock is not the chain's:
  // on an Orbit chain the sequencer's time drifts from it (V6 in docs/verification.md).
  // The feed's own anchor is the fallback, which is the same clock one block earlier.
  const chainTime = useQuery({
    queryKey: ["chain-time", CHAIN_ID],
    queryFn: async (): Promise<number> => {
      if (client === undefined) throw new Error("not ready");
      return Number((await client.getBlock()).timestamp);
    },
    enabled: client !== undefined,
    staleTime: 30_000,
  });
  const at = chainTime.data ?? market.fee.at;

  // --- approvals ------------------------------------------------------------------

  const allowanceKey = ["allowances", input, address, CHAIN_ID] as const;

  const allowances = useQuery({
    queryKey: allowanceKey,
    queryFn: async (): Promise<Allowances> => {
      if (client === undefined || address === undefined) throw new Error("not ready");
      const [erc20ToPermit2, permit2ToRouter] = await Promise.all([
        client.readContract({
          address: input,
          abi: erc20Abi,
          functionName: "allowance",
          args: [address, EXTERNAL.permit2],
        }),
        trade.readPermit2Allowance(client, {
          owner: address,
          token: input,
          spender: EXTERNAL.universalRouter,
        }),
      ]);
      return {
        erc20ToPermit2,
        permit2ToRouter: {
          amount: permit2ToRouter.amount,
          expiration: permit2ToRouter.expiration,
        },
      };
    },
    enabled: client !== undefined && address !== undefined && !native,
    staleTime: 15_000,
  });

  const needed = approvalsNeeded({
    input,
    amountIn,
    allowances: native ? null : (allowances.data ?? null),
    at,
  });
  const needsApproval = connected && !wrongNetwork && anyApprovalNeeded(needed);

  // Between connecting and the first allowance read, `approvalsNeeded` answers "both",
  // which is the safe direction but would flash an approve button at somebody who has
  // already approved. Saying what is happening is better than either guess.
  const checkingApprovals = connected && !native && allowances.isPending;

  const amountOut = quoted.data;
  const minOut =
    amountOut === undefined
      ? null
      : minimumReceived({
          amountOut,
          slippageBps,
          quotedFeePpm: market.fee.ppm,
          worstFeePpm,
        });

  // A confirmed swap changes the price, the volume and the trade list, all of which are
  // server-rendered from the indexer. Refreshing is what stops the page from continuing
  // to show the market as it was before the reader traded it.
  useEffect(() => {
    if (swap.phase === "confirmed") router.refresh();
  }, [swap.phase, router]);

  async function approve() {
    if (address === undefined) return;

    const call = needed.erc20
      ? trade.buildErc20Approval({
          token: input,
          spender: EXTERNAL.permit2,
          amount: (1n << 256n) - 1n,
        })
      : trade.buildPermit2Approval({
          token: input,
          spender: EXTERNAL.universalRouter,
          amount: trade.UNLIMITED_PERMIT2_AMOUNT,
          expiration: permit2Expiration(at),
        });

    const receipt = await approval.send(call);
    if (receipt !== null && receipt.status === "success") {
      await queryClient.invalidateQueries({ queryKey: allowanceKey });
      approval.reset();
    }
  }

  async function send() {
    if (address === undefined || poolKey === null || minOut === null || amountIn <= 0n) return;

    // `recipient` is not a field the router carries: `TAKE_ALL` pays whoever called
    // `execute`. So this transaction has to be sent from the address named here, which
    // it is — the connected account signs it.
    await swap.send(
      trade.buildSwap({
        router: EXTERNAL.universalRouter,
        poolKey,
        zeroForOne: zeroForOne(side),
        amountIn,
        minAmountOut: minOut,
        recipient: address,
      }),
    );
  }

  const outputLabel = side === "buy" ? market.symbol : quote.symbol;
  const outputDecimals = side === "buy" ? market.decimals : quote.decimals;

  return (
    <div className="rounded-panel border border-border bg-surface p-6 shadow-card backdrop-blur-xl">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-[0.95rem] font-semibold tracking-tight text-ink">
          Trade {market.symbol}
        </h2>
        <span className="numeric text-[0.78rem] text-accent">
          {formatFeeRate(worstFeePpm)} fee
        </span>
      </div>
      <p className="mt-1 text-[0.75rem] text-ink-muted">
        Priced in {quote.symbol}
        {quote.reviewed || quote.isNative ? "" : ", which is not on Verdant's reviewed list"}
      </p>

      <div className="mt-4">
        <Segmented
          value={side}
          onChange={(value) => {
            setSide(value);
            setAmount("");
            swap.reset();
          }}
          options={[
            { value: "buy", label: "Buy" },
            { value: "sell", label: "Sell" },
          ]}
        />
      </div>

      <div className="mt-4">
        <p className="mb-1.5 text-[0.78rem] font-medium text-ink">You pay</p>
        <AmountInput
          value={amount}
          onChange={setAmount}
          placeholder="0.0"
          unit={side === "buy" ? quote.symbol : market.symbol}
        />
      </div>

      <div className="mt-3 rounded-xl border border-border bg-surface-sunken px-4 py-3">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-[0.78rem] text-ink-muted">You receive</span>
          <span className="numeric text-[0.9rem] text-ink">
            {amountIn <= 0n
              ? "—"
              : quoted.isFetching || debouncedAmountIn !== amountIn
                ? "Quoting…"
                : quoted.error !== null
                  ? "—"
                  : amountOut === undefined
                    ? "—"
                    : `${side === "buy" ? formatCompact(amountOut, outputDecimals) : formatAmount(amountOut, { decimals: outputDecimals, places: 6 })} ${outputLabel}`}
          </span>
        </div>

        {minOut === null || amountIn <= 0n ? (
          <p className="mt-1.5 text-[0.7rem] leading-relaxed text-ink-muted">
            Quoted by Uniswap&apos;s quoter against this pool, with the fee the hook will
            actually charge.
          </p>
        ) : (
          <div className="mt-2 flex items-baseline justify-between gap-3 border-t border-border pt-2">
            <span className="text-[0.72rem] text-ink-muted">Minimum received</span>
            <span className="numeric text-[0.75rem] text-ink-muted">
              {side === "buy"
                ? `${formatCompact(minOut, outputDecimals)} ${outputLabel}`
                : formatQuoteAmount(minOut, quote)}
            </span>
          </div>
        )}

        {quoted.error === null ? null : (
          <p className="mt-2 border-t border-border pt-2 text-[0.7rem] leading-relaxed text-ink-muted">
            The pool would not quote this trade: {describeError(quoted.error)} A trade
            larger than the pool&apos;s liquidity is the usual reason.
          </p>
        )}
      </div>

      {/* Slippage sits under the quote it modifies, because the number it changes is the
          minimum above and nowhere else. */}
      <div className="mt-3">
        <div className="mb-1.5 flex items-baseline justify-between gap-3">
          <span className="text-[0.78rem] font-medium text-ink">Slippage tolerance</span>
          <span className="numeric text-[0.7rem] text-ink-muted">
            {slippageBps} bps
          </span>
        </div>
        <AmountInput value={slippagePercent} onChange={setSlippagePercent} unit="%" />
        <div className="mt-2 flex flex-wrap gap-1.5">
          {["0.10", "0.50", "1.00", "3.00"].map((preset) => (
            <button
              key={preset}
              type="button"
              onClick={() => setSlippagePercent(preset)}
              className={`numeric rounded-full border px-2.5 py-1 text-[0.72rem] transition ${
                slippagePercent === preset
                  ? "border-accent bg-accent-soft text-accent-strong"
                  : "border-border bg-surface text-ink-muted hover:border-border-strong hover:text-ink"
              }`}
            >
              {preset}%
            </button>
          ))}
        </div>
      </div>

      {nearTransition ? (
        <p className="mt-3 rounded-xl border border-caution/30 bg-caution-soft px-4 py-3 text-[0.72rem] leading-relaxed text-ink-muted">
          The fee changes in {formatDuration(market.fee.secondsToNextTransition ?? 0)}. A
          swap submitted now may execute under either fee, so the minimum above is
          computed at the higher of the two.
        </p>
      ) : null}

      <div className="mt-4">
        <Action
          connected={connected}
          wrongNetwork={wrongNetwork}
          missing={VERDANT_ADDRESSES.ok ? null : VERDANT_ADDRESSES.problems}
          amountIn={amountIn}
          quoting={quoted.isFetching || debouncedAmountIn !== amountIn}
          hasQuote={minOut !== null}
          needsErc20={needed.erc20}
          needsPermit2={needed.permit2}
          needsApproval={needsApproval}
          checkingApprovals={checkingApprovals}
          inputLabel={side === "buy" ? quote.symbol : market.symbol}
          approval={approval}
          swap={swap}
          onApprove={() => void approve()}
          onSwap={() => void send()}
        />
      </div>

      <p className="mt-3 text-[0.7rem] leading-relaxed text-ink-muted">
        Trading is a swap against the Uniswap v4 pool, routed through the Universal
        Router. Verdant never holds your funds, and the hook that charges the fee cannot
        take custody of them either.
      </p>
    </div>
  );
}

/**
 * The one control, in whichever of its states applies.
 *
 * They are mutually exclusive and ordered by what stands in the way first: an interface
 * with no addresses, then no wallet, then the wrong chain, then no amount, then a quote
 * still arriving, then approvals, then the swap. Rendering them as one control rather
 * than a stack of conditionally disabled buttons is what keeps a reader from wondering
 * which of three things to press.
 */
function Action({
  connected,
  wrongNetwork,
  missing,
  amountIn,
  quoting,
  hasQuote,
  needsErc20,
  needsPermit2,
  needsApproval,
  checkingApprovals,
  inputLabel,
  approval,
  swap,
  onApprove,
  onSwap,
}: {
  readonly connected: boolean;
  readonly wrongNetwork: boolean;
  readonly missing: readonly AddressProblem[] | null;
  readonly amountIn: bigint;
  readonly quoting: boolean;
  readonly hasQuote: boolean;
  readonly needsErc20: boolean;
  readonly needsPermit2: boolean;
  readonly needsApproval: boolean;
  readonly checkingApprovals: boolean;
  readonly inputLabel: string;
  readonly approval: ReturnType<typeof useTransaction>;
  readonly swap: ReturnType<typeof useTransaction>;
  readonly onApprove: () => void;
  readonly onSwap: () => void;
}) {
  if (missing !== null) return <MissingAddresses problems={missing} />;

  if (!connected) return <ConnectButton size="large" label="Connect wallet to trade" className="w-full" />;

  if (wrongNetwork) {
    return (
      <div>
        <ConnectButton size="large" className="w-full" />
        <p className="mt-2 text-[0.72rem] leading-relaxed text-ink-muted">
          This pool is on {chain.name}. A swap signed against another chain would go
          somewhere else entirely.
        </p>
      </div>
    );
  }

  if (checkingApprovals && amountIn > 0n) {
    return (
      <button type="button" disabled className={PRIMARY}>
        Checking approvals…
      </button>
    );
  }

  if (needsApproval) {
    return (
      <div>
        <button
          type="button"
          disabled={approval.busy}
          onClick={onApprove}
          className={PRIMARY}
        >
          {approval.busy
            ? "Approving…"
            : needsErc20
              ? `Approve ${inputLabel} for Permit2`
              : `Allow the router to spend ${inputLabel}`}
        </button>

        <TransactionNote
          run={approval}
          pending={needsErc20 ? "Approving the token" : "Granting the router an allowance"}
          confirmed="Approved."
        />

        {/* Both approvals are unlimited, and saying so is not optional: an interface
            that signs an unbounded allowance and describes it as "approving a token"
            has told the reader less than the transaction does. The expiry is what
            bounds the router's reach, which is the arrangement Permit2 exists for. */}
        <p className="mt-2 text-[0.72rem] leading-relaxed text-ink-muted">
          {needsErc20 && needsPermit2
            ? "Two approvals, then the swap. The router holds no allowances of its own — it pulls an ERC-20 through Permit2 — so the token is approved to Permit2 and Permit2 is approved to the router."
            : needsErc20
              ? "The token is approved to Permit2, which is what the router pulls through. One standing approval per token."
              : "Permit2 already holds this token's approval; the router still needs an allowance from it."}{" "}
          {needsErc20
            ? `Both are for an unlimited amount, so you are not asked again for every trade. Permit2's grant to the router expires in ${PERMIT2_APPROVAL_DAYS} days; the token's approval to Permit2 does not expire and can be revoked by approving zero.`
            : `Unlimited, and it expires in ${PERMIT2_APPROVAL_DAYS} days.`}
        </p>
      </div>
    );
  }

  const ready = amountIn > 0n && hasQuote && !quoting && !swap.busy;

  return (
    <div>
      <button type="button" disabled={!ready} onClick={onSwap} className={PRIMARY}>
        {swap.phase === "signing"
          ? "Confirm in your wallet"
          : swap.phase === "pending"
            ? "Swapping…"
            : amountIn <= 0n
              ? "Enter an amount"
              : quoting
                ? "Quoting…"
                : hasQuote
                  ? "Swap"
                  : "No quote"}
      </button>

      <TransactionNote run={swap} pending="Swapping" confirmed="Swapped." />
    </div>
  );
}

/** The Permit2 grant's life, in the unit the copy states it in. */
const PERMIT2_APPROVAL_DAYS = PERMIT2_APPROVAL_SECONDS / 86_400;

const PRIMARY =
  "inline-flex h-12 w-full items-center justify-center rounded-full bg-ink px-6 text-[0.95rem] font-medium text-ink-inverse shadow-card transition hover:bg-ink/90 active:scale-[0.985] disabled:cursor-not-allowed disabled:bg-surface-raised disabled:text-ink-faint disabled:active:scale-100";

/**
 * A percentage as basis points, clamped to something a pool will accept.
 *
 * An unparseable or absent value falls back to the default rather than to zero: zero is
 * a valid and very strict tolerance, and arriving at it by mistyping would revert every
 * swap for a reason nobody would guess.
 */
function parseSlippageBps(percent: string): number {
  const parsed = parseDecimal(percent, 2);
  if (parsed === null) return BOUNDS.trading.defaultSlippageBps;
  const bps = Number(parsed);
  return bps > 5_000 ? 5_000 : bps;
}

/**
 * A value that stops changing while it is being typed.
 *
 * Every keystroke in the amount field would otherwise be a simulated swap against the
 * node. The delay is on the parsed amount rather than the text, so "1.0" and "1.00" do
 * not each cost a quote.
 */
function useDebounced<T>(value: T, milliseconds: number): T {
  const [settled, setSettled] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), milliseconds);
    return () => clearTimeout(timer);
  }, [value, milliseconds]);

  return settled;
}
