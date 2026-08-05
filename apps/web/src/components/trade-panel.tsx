"use client";

import { BOUNDS } from "@verdant/config";
import { pool, trade } from "@verdant/sdk";
import {
  formatAmount,
  formatCompact,
  formatDuration,
  formatFeeRate,
  quotePerToken,
} from "@verdant/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { erc20Abi, formatUnits } from "viem";
import { useConnection, usePublicClient } from "wagmi";

import { CHAIN_ID, EXTERNAL, VERDANT_ADDRESSES, chain, type AddressProblem } from "../lib/chain";
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
import { formatUsd, usdPriceOf, usdValueOf } from "../lib/usd";
import { ConnectButton } from "./connect-button";
import { AmountInput, Segmented } from "./form";
import { TokenAvatar } from "./primitives";
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
 *
 * ## Two boxes and an arrow, rather than a Buy/Sell switch
 *
 * The direction is chosen by swapping which asset is on top, which is the arrangement
 * every exchange interface uses and the one this panel now follows. It says the same
 * thing as a pair of labelled tabs and says it in the terms of the trade — you are
 * selling *this* for *that* — so the assets are on screen rather than implied by which
 * tab is lit.
 *
 * There is no Limit or Orders tab beside it, and there will not be one until there is
 * something on chain behind it. Verdant markets are v4 pools; a limit order is not a
 * thing the hook or the router can be asked for, and a tab that opened onto "coming
 * soon" would be the interface promising what the contracts do not do.
 */
export function TradePanel({
  market,
  initialAmount,
  usdPerEth = null,
}: {
  readonly market: Market;
  /** Prefilled after a launch, where the creator already said what they meant to buy. */
  readonly initialAmount?: string | undefined;
  /** For the dollar line under each amount. Absent on an equity-quoted market. */
  readonly usdPerEth?: number | null;
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
  /* Folded away by default. It is one number, it has a sane value, and most readers
     never touch it — but the ones who do want it here rather than in a settings modal
     two clicks from the trade it applies to. */
  const [adjustingSlippage, setAdjustingSlippage] = useState(false);

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

  /*
   * The largest trade this pool could actually fill, found only once one has failed.
   *
   * A Verdant market opens one-sided: the locked position holds the token and no ether at
   * all, so the only ether a seller can be paid with is what buyers have put in. A
   * creator holding a tenth of the supply on a market that has taken one small first buy
   * therefore cannot sell any meaningful part of it, and the pool does not explain
   * itself — `V4Quoter` wraps the failure in `UnexpectedRevertBytes`, whose payload on
   * this path is empty. There is nothing to read and nothing to report.
   *
   * So the ceiling is measured rather than parsed: bisect between zero and the amount
   * that failed until the largest quotable size is known to within a fraction of a per
   * cent. Fourteen quoter calls, on a path that is already an error, in exchange for
   * being able to name the number instead of saying "try less".
   */
  const ceiling = useQuery({
    queryKey: ["fillable", market.poolId, side, debouncedAmountIn.toString()],
    queryFn: async (): Promise<bigint> => {
      if (client === undefined || poolKey === null) throw new Error("not ready");

      const fits = async (amount: bigint): Promise<boolean> => {
        if (amount <= 0n) return true;
        try {
          await trade.quoteExactIn(client, {
            quoter: EXTERNAL.quoter,
            poolKey,
            zeroForOne: zeroForOne(side),
            exactAmount: amount,
          });
          return true;
        } catch {
          return false;
        }
      };

      let low = 0n;
      let high = debouncedAmountIn;
      for (let step = 0; step < 14 && high - low > 1n; step++) {
        const middle = (low + high) / 2n;
        if (await fits(middle)) low = middle;
        else high = middle;
      }
      return low;
    },
    // Only after a quote has actually failed, and only for a size worth bisecting.
    enabled:
      client !== undefined &&
      poolKey !== null &&
      quoted.error !== null &&
      debouncedAmountIn > 0n,
    staleTime: 15_000,
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

  // --- what the reader has to spend ------------------------------------------------

  const balance = useQuery({
    queryKey: ["balance", input, address, CHAIN_ID],
    queryFn: async (): Promise<bigint> => {
      if (client === undefined || address === undefined) throw new Error("not ready");
      return native
        ? client.getBalance({ address })
        : client.readContract({
            address: input,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [address],
          });
    },
    enabled: client !== undefined && address !== undefined,
    staleTime: 15_000,
  });

  /*
   * What "Max" fills in, which is not the balance when the balance is also the gas.
   *
   * Spending every last wei of ether would leave nothing to pay for the swap that spends
   * it, and a Max button whose transaction always fails is worse than no Max button. The
   * reserve is the chain's current gas price times a generous allowance for one swap,
   * rather than a fixed fraction or a round number of ether: gas here costs a fraction of
   * what it costs on Ethereum, and a constant tuned for either chain is wrong on the other.
   */
  const gasPrice = useQuery({
    queryKey: ["gas-price", CHAIN_ID],
    queryFn: async (): Promise<bigint> => {
      if (client === undefined) throw new Error("not ready");
      return client.getGasPrice();
    },
    enabled: client !== undefined && native,
    staleTime: 30_000,
  });

  const spendable = useMemo(() => {
    if (balance.data === undefined) return null;
    if (!native) return balance.data;
    if (gasPrice.data === undefined) return null;
    const reserve = gasPrice.data * SWAP_GAS_ALLOWANCE;
    return balance.data > reserve ? balance.data - reserve : 0n;
  }, [balance.data, gasPrice.data, native]);

  const overBalance = balance.data !== undefined && amountIn > balance.data;

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

  /** An amount of whatever is being spent, labelled with the asset it is an amount of. */
  const formatInputAmount = (value: bigint): string =>
    side === "buy"
      ? formatQuoteAmount(value, quote)
      : `${formatCompact(value, market.decimals)} ${market.symbol}`;

  // --- the dollar line under each amount -------------------------------------------

  // The token has no dollar price of its own; it has a pool price in the quote asset,
  // and that asset has a dollar price. So the conversion goes through the pool, and it
  // is `null` for an equity-quoted market for the same reason every other dollar figure
  // in this app is: there is no rate to reach the quote asset through.
  const usdPerToken = usdPriceOf(
    quotePerToken(market.sqrtPriceX96, quote.decimals),
    quote,
    usdPerEth,
  );

  const usdOfQuote = (value: bigint): number | null => usdValueOf(value, quote, usdPerEth);
  const usdOfToken = (value: bigint): number | null =>
    usdPerToken === null ? null : (Number(value) / 10 ** market.decimals) * usdPerToken;

  const usdIn = side === "buy" ? usdOfQuote(amountIn) : usdOfToken(amountIn);
  const usdOut =
    amountOut === undefined
      ? null
      : side === "buy"
        ? usdOfToken(amountOut)
        : usdOfQuote(amountOut);

  /** Whether the box below is waiting on the quoter rather than showing an answer. */
  const quoting = amountIn > 0n && (quoted.isFetching || debouncedAmountIn !== amountIn);

  /** What the receive box shows, which is a quote in progress as often as a number. */
  const receiving =
    amountIn <= 0n
      ? "0"
      : quoting
        ? "…"
        : quoted.error !== null || amountOut === undefined
          ? "0"
          : side === "buy"
            ? formatCompact(amountOut, outputDecimals)
            : formatAmount(amountOut, { decimals: outputDecimals, places: 6 });

  function flip() {
    setSide(side === "buy" ? "sell" : "buy");
    setAmount("");
    swap.reset();
  }

  return (
    // `relative z-20` lifts this card — and the wallet popover that opens from its
    // Connect button — above the sibling panels below it. The panel's own
    // `backdrop-blur` makes it a stacking context, which would otherwise trap the
    // popover's z-index inside it and let the later "Where the fees go" card paint over.
    <div className="relative z-20 rounded-panel border border-border bg-surface p-6 shadow-card backdrop-blur-xl">
      <div className="flex items-center gap-3">
        <TokenAvatar symbol={market.symbol} size="default" uri={market.metadataURI} />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[1.05rem] font-semibold tracking-tight text-ink">
            {market.name}
          </h2>
          <p className="numeric truncate text-[0.75rem] text-ink-muted">{market.symbol}</p>
        </div>
        <span className="numeric shrink-0 text-[0.78rem] text-accent">
          {formatFeeRate(worstFeePpm)}
        </span>
      </div>

      {/* The direction, named. The screener layout this follows puts order types here —
          Market, Limit, Orders — and only one of those three exists on a Uniswap pool, so
          the row carries the choice that does: which way round the trade goes. */}
      <div className="mt-4">
        <Segmented
          full
          value={side}
          onChange={(value) => {
            if (value !== side) flip();
          }}
          options={[
            { value: "buy" as Side, label: "Buy" },
            { value: "sell" as Side, label: "Sell" },
          ]}
        />
      </div>

      {/* --- what you give up ------------------------------------------------ */}
      <Leg
        label="Sell"
        amount={
          <input
            type="text"
            inputMode="decimal"
            autoComplete="off"
            value={amount}
            placeholder="0"
            aria-label={`Amount to sell in ${side === "buy" ? quote.symbol : market.symbol}`}
            aria-invalid={overBalance || undefined}
            onChange={(event) => setAmount(event.target.value.replace(/[^\d.]/g, ""))}
            /* Bare rather than `AmountInput`. This box is already a well, and a second
               bordered well inside it reads as a field inside a field; here the box is the
               field. The size is the point — it is the number being decided. */
            className={`numeric w-full bg-transparent text-[2rem] leading-none placeholder:text-ink-faint focus:outline-none ${
              overBalance ? "text-fall" : "text-ink"
            }`}
          />
        }
        usd={usdIn}
        asset={
          side === "buy" ? (
            <QuoteChip symbol={quote.symbol} />
          ) : (
            <TokenChip symbol={market.symbol} uri={market.metadataURI} />
          )
        }
        footnote={
          !connected
            ? "Wallet not connected"
            : balance.data === undefined
              ? ""
              : formatInputAmount(balance.data)
        }
        className="mt-3"
      />

      {/* The same flip as the pills above, where the assets are. It overlaps both boxes
          because that is what it does to them — they change places. */}
      <div className="relative z-10 -my-3 flex justify-center">
        <button
          type="button"
          onClick={flip}
          aria-label={side === "buy" ? "Switch to selling" : "Switch to buying"}
          className="grid size-9 place-items-center rounded-xl border border-border bg-surface-raised text-ink-muted shadow-card transition hover:border-border-strong hover:text-ink"
        >
          <svg
            viewBox="0 0 16 16"
            aria-hidden="true"
            className="size-3.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M8 3v10" />
            <path d="M4.5 9.5 8 13l3.5-3.5" />
          </svg>
        </button>
      </div>

      {/* --- what the pool would give back ----------------------------------- */}
      <Leg
        label="Buy"
        amount={
          /* A block the size of the answer rather than an ellipsis. The ellipsis occupied
             none of the room the number needs, so the panel resized the instant a quote
             landed — and said nothing about whether the quoter was working. */
          quoting ? (
            <div
              role="status"
              aria-label="Fetching a quote"
              className="shimmer h-[2rem] w-32 rounded-lg bg-surface-raised"
            />
          ) : (
            <div className="numeric truncate text-[2rem] leading-none text-ink">
              {receiving}
            </div>
          )
        }
        usd={usdOut}
        asset={
          side === "buy" ? (
            <TokenChip symbol={market.symbol} uri={market.metadataURI} />
          ) : (
            <QuoteChip symbol={quote.symbol} />
          )
        }
        footnote={
          minOut === null || amountIn <= 0n
            ? side === "buy"
              ? `0 ${market.symbol} available`
              : ""
            : `Min ${
                side === "buy"
                  ? `${formatCompact(minOut, outputDecimals)} ${outputLabel}`
                  : formatQuoteAmount(minOut, quote)
              }`
        }
      />

      {/* --- how much of the balance ----------------------------------------- */}
      <div className="mt-3 grid grid-cols-4 gap-2">
        {[25, 50, 75, 100].map((percent) => (
          <button
            key={percent}
            type="button"
            disabled={spendable === null || spendable === 0n}
            onClick={() =>
              spendable === null
                ? undefined
                : setAmount(formatUnits((spendable * BigInt(percent)) / 100n, inputDecimals))
            }
            className="numeric rounded-full border border-border py-2 text-[0.75rem] text-ink-muted transition hover:border-border-strong hover:text-ink disabled:cursor-not-allowed disabled:text-ink-faint disabled:hover:border-border disabled:hover:text-ink-faint"
          >
            {percent}%
          </button>
        ))}
      </div>

      {native && spendable !== null && balance.data !== undefined && spendable < balance.data ? (
        <p className="mt-1.5 text-[0.7rem] text-ink-muted">
          100% leaves {formatInputAmount(balance.data - spendable)} behind for gas.
        </p>
      ) : null}

      {/* --- slippage, folded away -------------------------------------------- */}
      <div className="mt-4">
        <div className="flex items-center justify-between gap-3">
          <span className="text-[0.8rem] text-ink-muted">Slippage</span>
          <div className="flex items-center gap-1.5 rounded-full border border-border py-1 pl-3 pr-1.5">
            <span className="numeric text-[0.75rem] text-ink">{slippagePercent}%</span>
            <button
              type="button"
              aria-expanded={adjustingSlippage}
              onClick={() => setAdjustingSlippage(!adjustingSlippage)}
              className="rounded-full px-2 py-0.5 text-[0.72rem] text-ink-muted transition hover:text-ink"
            >
              Adjust
            </button>
          </div>
        </div>

        {adjustingSlippage ? (
          <div className="mt-2.5 border-t border-border pt-2.5">
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
            <p className="numeric mt-2 text-[0.68rem] text-ink-faint">{slippageBps} bps</p>
          </div>
        ) : null}
      </div>

      {/*
       * What used to be here printed the quoter's own words, which on this path are a
       * four-byte selector wrapping an empty payload — "the contract function
       * quoteExactInputSingle reverted with the following signature: 0x6190b2b0" — under
       * a guess at what it meant. It is the right guess and it is unreadable, and it
       * leaves out the one thing a seller can act on: how much they could sell instead.
       */}
      {quoted.error === null || amountIn <= 0n ? null : (
        <div className="mt-3 rounded-xl border border-border bg-surface-sunken px-4 py-3 text-[0.72rem] leading-relaxed text-ink-muted">
          <p className="font-medium text-ink">
            {side === "sell"
              ? "This market cannot pay for a sale that size."
              : "The pool cannot fill a trade that size."}
          </p>

          {side === "sell" ? (
            <p className="mt-1">
              A launch opens holding only {market.symbol} and no {quote.symbol}, so the
              only {quote.symbol} a sale can be paid in is what buyers have put in so far.
            </p>
          ) : null}

          {ceiling.isFetching ? (
            <p className="mt-1.5 text-ink-faint">Working out the most it can take…</p>
          ) : ceiling.data === undefined || ceiling.data === 0n ? (
            <p className="mt-1.5">Try a smaller amount.</p>
          ) : (
            <p className="mt-1.5">
              The most it can take right now is about{" "}
              <button
                type="button"
                onClick={() => setAmount(formatUnits(ceiling.data, inputDecimals))}
                className="numeric text-ink underline decoration-border-strong decoration-dotted underline-offset-4 transition-colors hover:decoration-ink"
              >
                {formatAmount(ceiling.data, { decimals: inputDecimals, places: 4 })}{" "}
                {side === "buy" ? quote.symbol : market.symbol}
              </button>
              .
            </p>
          )}
        </div>
      )}

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
          overBalance={overBalance}
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
        Priced in {quote.symbol}
        {quote.reviewed || quote.isNative
          ? ""
          : ", which is not on Verdant's reviewed list"}. Trading is a swap against the
        Uniswap v4 pool, routed through the Universal Router. Verdant never holds your
        funds, and the hook that charges the fee cannot take custody of them either.
      </p>
    </div>
  );
}

/**
 * One side of the trade: a big number, what it is worth, and which asset it is.
 *
 * Both boxes are the same shape whichever direction the trade is going, so flipping the
 * arrow moves the assets and nothing else. The amount is a slot rather than a value
 * because one of them is an input and the other is the pool's answer, and making the
 * output an editable field would invite somebody to type into a number they cannot set.
 */
function Leg({
  label,
  amount,
  usd,
  asset,
  footnote,
  className = "",
}: {
  readonly label: string;
  readonly amount: ReactNode;
  readonly usd: number | null;
  readonly asset: ReactNode;
  readonly footnote: string;
  readonly className?: string;
}) {
  return (
    <div className={`rounded-2xl border border-border bg-surface-sunken px-4 py-3.5 ${className}`}>
      <p className="text-[0.78rem] text-ink-muted">{label}</p>

      <div className="mt-1 min-w-0">{amount}</div>

      {/* An empty line rather than none, so the two boxes stay the same height whether or
          not there is a dollar rate to show and the arrow between them does not move. */}
      <p className="numeric mt-1 h-4 text-[0.75rem] text-ink-faint">
        {usd === null || usd === 0 ? "$0.00" : formatUsd(usd)}
      </p>

      {/* The asset and what you hold of it, on one line under the amount. Together they
          answer "in what, and how much have I got" without either becoming a heading. */}
      <div className="mt-3 flex items-center justify-between gap-3">
        {asset}
        <span className="numeric truncate text-[0.72rem] text-ink-faint">{footnote}</span>
      </div>
    </div>
  );
}

function TokenChip({ symbol, uri }: { readonly symbol: string; readonly uri: string }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-border bg-surface px-2 py-1 text-[0.75rem] font-medium text-ink">
      <TokenAvatar symbol={symbol} size="small" uri={uri} />
      <span className="numeric max-w-24 truncate">{symbol}</span>
    </span>
  );
}

function QuoteChip({ symbol }: { readonly symbol: string }) {
  return (
    <span className="numeric inline-flex shrink-0 items-center rounded-full border border-border bg-surface px-3 py-2 text-[0.75rem] font-medium text-ink">
      {symbol}
    </span>
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
  overBalance,
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
  readonly overBalance: boolean;
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

  // Before the approvals, because approving a token you do not hold enough of is a
  // signature that buys nothing and the swap behind it would revert anyway.
  if (overBalance) {
    return (
      <button type="button" disabled className={PRIMARY}>
        Not enough {inputLabel}
      </button>
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
      {/* A wallet opens in its own window, sometimes on another monitor. The ring is what
          makes somebody look back at the button that is telling them so. */}
      <button
        type="button"
        disabled={!ready}
        onClick={onSwap}
        className={`${PRIMARY} ${swap.phase === "signing" ? "awaiting" : ""}`}
      >
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

/**
 * Gas held back from a Max on an ether balance: enough for one swap, generously.
 *
 * A v4 swap through the router with a hook that overrides the fee costs well under this;
 * the margin is deliberate, because the cost of overestimating is a slightly smaller
 * trade and the cost of underestimating is a transaction that cannot be sent.
 */
const SWAP_GAS_ALLOWANCE = 500_000n;

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
