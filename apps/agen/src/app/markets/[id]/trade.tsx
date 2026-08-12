"use client";

/**
 * The trade panel.
 *
 * Everything a trader expects on the right of a token page — a side, an amount, the
 * quick sizes they actually use, and the four lines that say what the trade will cost —
 * and behind it the real path: Uniswap's quoter for the numbers, Uniswap's Universal
 * Router for the swap.
 *
 * ## Why the quoter and not arithmetic
 *
 * A generated market's fee is whatever its hook decides, per swap, from state that can
 * include the trade being quoted. Nothing derived from the pool's stored fee can see
 * that. `V4Quoter` executes the hook and returns what the swap would return, which makes
 * it the only honest source for the output — and the reason the "market fee" line here
 * is derived from the quote rather than from the specification.
 *
 * ## Why selling takes three transactions the first time
 *
 * Buying spends ether, which v4 holds directly, so a buy is one transaction carrying its
 * input as `value`. Selling spends the token, and the router pulls ERC-20 input through
 * Permit2 — so the token must approve Permit2, and Permit2 must approve the router,
 * before the swap will settle. Both are checked before the button is offered and both
 * are one-time. Skipping either produces a revert deep inside `SETTLE_ALL`, which reads
 * as a broken market rather than as a missing approval.
 *
 * ## What it will not do
 *
 * Quote a pool it has not confirmed exists. The pool key is derived from the market's
 * own fields and checked against the pool id the registry recorded; if the page could
 * not resolve one, the panel says the market cannot be traded from here rather than
 * quoting into the dark.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { formatEther, parseEther, type Address } from "viem";
import {
  useAccount,
  usePublicClient,
  useReadContract,
  useSendTransaction,
  useSwitchChain,
  useWaitForTransactionReceipt,
} from "wagmi";

import { abi, agen, trade as sdkTrade } from "@verdant/sdk";

import { CHAIN_ID, EXTERNAL, chain } from "../../lib/chain";
import { DASH, eth, feeRate, tokens } from "../../lib/format";

type Side = "buy" | "sell";

const BUY_SIZES: readonly string[] = ["0.01", "0.05", "0.1", "0.5"];
const SELL_SHARES: readonly { readonly label: string; readonly share: bigint }[] = [
  { label: "25%", share: 25n },
  { label: "50%", share: 50n },
  { label: "75%", share: 75n },
  { label: "MAX", share: 100n },
];

/** One percent, the default everywhere a swap needs a floor. */
const SLIPPAGE_BPS = 100;

function Row({
  label,
  value,
  hint,
}: {
  readonly label: string;
  readonly value: string;
  readonly hint?: string;
}) {
  return (
    <div className="tp-row">
      <span className="tp-row-label">
        {label}
        {hint === undefined ? null : <span className="tp-row-hint">{hint}</span>}
      </span>
      <span className="tp-row-value">{value}</span>
    </div>
  );
}

export interface TradeMarket {
  readonly name: string;
  readonly symbol: string;
  readonly live: boolean;
  /** The market's declared base fee. Shown before a quote exists, then superseded. */
  readonly feePpm: number | null;
  readonly token: string | null;
  readonly hook: string | null;
  readonly poolId: string | null;
  readonly lpFee: number | null;
}

export function TradePanel({ market }: { readonly market: TradeMarket }) {
  const { name, symbol, live, feePpm } = market;

  const [side, setSide] = useState<Side>("buy");
  const [amount, setAmount] = useState("");

  const { address, chainId, status } = useAccount();
  const switchChain = useSwitchChain();
  const client = usePublicClient();
  const send = useSendTransaction();
  const receipt = useWaitForTransactionReceipt({ hash: send.data });

  const connected = status === "connected" && address !== undefined;
  const wrongNetwork = connected && chainId !== CHAIN_ID;
  const quoteSymbol = chain.nativeCurrency.symbol;
  const buying = side === "buy";

  /**
   * The pool, derived and then checked.
   *
   * `agenPoolKeyOf` returns null when the key does not hash to the recorded pool id,
   * which is the whole guard: a wrong fee produces a valid-looking key for a pool that
   * does not exist, and every quote against it would revert with nothing to explain.
   */
  const poolKey = useMemo(() => {
    if (market.token === null || market.hook === null || market.poolId === null) return null;
    if (market.lpFee === null) return null;

    return agen.agenPoolKeyFor({
      quoteAsset: agen.NATIVE_CURRENCY,
      token: market.token as Address,
      hook: market.hook as Address,
      lpFee: market.lpFee,
    });
  }, [market.token, market.hook, market.poolId, market.lpFee]);

  const tokenAddress = market.token as Address | null;

  // What the seller has to sell. Also what the percentage buttons are percentages of.
  const balance = useReadContract({
    abi: abi.verdantTokenAbi,
    address: tokenAddress ?? undefined,
    functionName: "balanceOf",
    args: address === undefined ? undefined : [address],
    query: { enabled: tokenAddress !== null && address !== undefined },
  });

  /** The two approvals a sell needs, asked for before the button is offered. */
  const allowance = useReadContract({
    abi: abi.permit2Abi,
    address: sdkTrade.PERMIT2,
    functionName: "allowance",
    args:
      address === undefined || tokenAddress === null
        ? undefined
        : [address, tokenAddress, EXTERNAL.universalRouter],
    query: { enabled: !buying && tokenAddress !== null && address !== undefined },
  });

  const erc20Allowance = useReadContract({
    abi: abi.verdantTokenAbi,
    address: tokenAddress ?? undefined,
    functionName: "allowance",
    args: address === undefined ? undefined : [address, sdkTrade.PERMIT2],
    query: { enabled: !buying && tokenAddress !== null && address !== undefined },
  });

  const amountIn = useMemo(() => {
    const text = amount.trim();
    if (text === "" || !/^\d*\.?\d*$/.test(text)) return 0n;
    try {
      return parseEther(text);
    } catch {
      return 0n;
    }
  }, [amount]);

  // --- the quote ------------------------------------------------------------

  const [quote, setQuote] = useState<agen.AgenQuote | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [quoteError, setQuoteError] = useState<string | null>(null);

  useEffect(() => {
    if (poolKey === null || client === undefined || amountIn === 0n || !live) {
      setQuote(null);
      setQuoteError(null);
      return;
    }

    let live_ = true;
    setQuoting(true);

    // Debounced, because this fires on every keystroke and each one is an eth_call that
    // executes the hook. A quote for a number the trader has already stopped typing is
    // wasted work and, worse, can land after the quote for the number they meant.
    const timer = setTimeout(() => {
      void agen
        .quoteAgenTrade(client, {
          quoter: EXTERNAL.quoter,
          poolKey,
          zeroForOne: buying,
          amountIn,
          slippageBps: SLIPPAGE_BPS,
        })
        .then((next) => {
          if (!live_) return;
          setQuote(next);
          setQuoteError(null);
        })
        .catch(async () => {
          if (!live_) return;
          setQuote(null);

          /**
           * Why the quote failed, established rather than guessed.
           *
           * Two very different things revert here. A trade larger than the bands can
           * serve is a size problem and a smaller one works. A market whose hook only
           * accepts swaps arriving through its own router — Ember is the built example,
           * and it reverts on the caller before it looks at the amount — is not a size
           * problem, and telling that trader to try less would send them hunting for a
           * number that does not exist.
           *
           * One more `eth_call`, for a dust amount, separates them: if even that is
           * refused, nothing about the amount is the problem.
           */
          const dust = await agen
            .quoteAgenTrade(client, {
              quoter: EXTERNAL.quoter,
              poolKey,
              zeroForOne: buying,
              amountIn: 1_000n,
            })
            .then(() => true)
            .catch(() => false);

          if (!live_) return;

          setQuoteError(
            dust
              ? "No route for that size. Try a smaller amount."
              : "This market's rules refuse trades sent this way. It may only accept its own router.",
          );
        })
        .finally(() => {
          if (live_) setQuoting(false);
        });
    }, 250);

    return () => {
      live_ = false;
      clearTimeout(timer);
    };
  }, [poolKey, client, amountIn, buying, live]);

  // --- acting ---------------------------------------------------------------

  const needsErc20Approval =
    !buying && (erc20Allowance.data ?? 0n) < amountIn && amountIn > 0n;

  const needsPermit2Approval =
    !buying &&
    !needsErc20Approval &&
    amountIn > 0n &&
    (() => {
      const current = allowance.data as readonly [bigint, number, number] | undefined;
      if (current === undefined) return true;
      const [permitted, expiration] = current;
      return permitted < amountIn || expiration * 1_000 <= Date.now();
    })();

  /**
   * The three transactions a trade can need, all sent the same way.
   *
   * Every one is built by the SDK and sent as raw calldata rather than through a
   * contract write, so the encoding of an approval and the encoding of a swap come from
   * the same place — the package that is tested against the vendored Uniswap source —
   * and this component holds no ABI knowledge of its own.
   */
  const submit = useCallback(() => {
    if (address === undefined || tokenAddress === null) return;

    const call = needsErc20Approval
      ? sdkTrade.buildErc20Approval({
          token: tokenAddress,
          spender: sdkTrade.PERMIT2,
          amount: sdkTrade.UNLIMITED_PERMIT2_AMOUNT,
        })
      : needsPermit2Approval
        ? sdkTrade.buildPermit2Approval({
            token: tokenAddress,
            spender: EXTERNAL.universalRouter,
            amount: sdkTrade.UNLIMITED_PERMIT2_AMOUNT,
            // Permit2's widest expiry, so a seller is asked once rather than per trade.
            // The allowance remains theirs to revoke and the router is its only spender.
            expiration: 2 ** 48 - 1,
          })
        : poolKey === null || quote === null
          ? null
          : sdkTrade.buildSwap({
              router: EXTERNAL.universalRouter,
              poolKey,
              zeroForOne: buying,
              amountIn,
              minAmountOut: quote.minAmountOut,
              recipient: address,
            });

    if (call === null) return;

    send.sendTransaction({
      to: call.to,
      data: call.data,
      value: call.value,
      chainId: CHAIN_ID,
    });
  }, [
    address,
    poolKey,
    quote,
    needsErc20Approval,
    needsPermit2Approval,
    tokenAddress,
    buying,
    amountIn,
    send,
  ]);

  const busy = send.isPending || receipt.isLoading;

  /**
   * What the button says, in the order the conditions actually bite.
   *
   * Not trading comes first because it is a fact about the market rather than about the
   * reader: connecting a wallet would not help, so offering that would waste their time.
   */
  const action = !live
    ? { label: "Not trading yet", disabled: true }
    : poolKey === null
      ? { label: "Pool not resolved", disabled: true }
      : !connected
        ? { label: "Connect wallet", disabled: true }
        : wrongNetwork
          ? { label: `Switch to ${chain.name}`, disabled: false }
          : amountIn === 0n
            ? { label: "Enter an amount", disabled: true }
            : busy
              ? { label: "Confirm in your wallet…", disabled: true }
              : needsErc20Approval
                ? { label: `Approve $${symbol}`, disabled: false }
                : needsPermit2Approval
                  ? { label: "Approve router", disabled: false }
                  : quoting
                    ? { label: "Quoting…", disabled: true }
                    : quote === null
                      ? { label: quoteError ?? "No quote", disabled: true }
                      : { label: `${buying ? "Buy" : "Sell"} $${symbol}`, disabled: false };

  const held = (balance.data as bigint | undefined) ?? 0n;

  return (
    <aside className="trade-panel" id="trade">
      <header className="tp-head">
        <span className="tp-mark" aria-hidden="true">
          {symbol.slice(0, 2)}
        </span>
        <div className="tp-who">
          <span className="tp-name">{name}</span>
          <span className="tp-symbol">{symbol}</span>
        </div>
        <span className="tp-fee" title="The fee this token's own rules charge">
          {feeRate(feePpm)}
        </span>
      </header>

      <div className="tp-sides" role="tablist" aria-label="side">
        <button
          type="button"
          role="tab"
          aria-selected={buying}
          className={buying ? "tp-side on buy" : "tp-side"}
          onClick={() => {
            setSide("buy");
            setAmount("");
          }}
        >
          Buy
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={!buying}
          className={!buying ? "tp-side on sell" : "tp-side"}
          onClick={() => {
            setSide("sell");
            setAmount("");
          }}
        >
          Sell
        </button>
      </div>

      {/* The two legs sit against each other with the direction between them, which is
          the arrangement every swap interface uses because it makes the trade readable
          as one sentence rather than as two fields. */}
      <div className="tp-legs">
        <div className="tp-leg">
          <div className="tp-leg-head">
            <span>you pay</span>
            <span className="tp-asset">{buying ? quoteSymbol : `$${symbol}`}</span>
          </div>

          <input
            className="tp-amount"
            inputMode="decimal"
            placeholder="0.0"
            value={amount}
            aria-label={`amount to ${side}`}
            onChange={(event) => {
              setAmount(event.currentTarget.value);
            }}
          />

          {buying || held === 0n ? null : (
            <span className="tp-held">{tokens(Number(formatEther(held)))} available</span>
          )}
        </div>

        <span className="tp-turn" aria-hidden="true">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M8 3.5v9M4.5 9l3.5 3.5L11.5 9" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>

        <div className="tp-leg tp-leg-out">
          <div className="tp-leg-head">
            <span>you receive</span>
            <span className="tp-asset">{buying ? `$${symbol}` : quoteSymbol}</span>
          </div>
          <span className="tp-out">
            {quote === null
              ? DASH
              : buying
                ? tokens(Number(formatEther(quote.amountOut)))
                : eth(Number(formatEther(quote.amountOut)))}
          </span>
        </div>
      </div>

      <div className="tp-sizes">
        {buying
          ? BUY_SIZES.map((size) => (
              <button
                type="button"
                key={size}
                onClick={() => {
                  setAmount(size);
                }}
              >
                {size} {quoteSymbol}
              </button>
            ))
          : SELL_SHARES.map((size) => (
              <button
                type="button"
                key={size.label}
                disabled={held === 0n}
                onClick={() => {
                  setAmount(formatEther((held * size.share) / 100n));
                }}
              >
                {size.label}
              </button>
            ))}
      </div>

      <div className="tp-rows">
        <Row
          label="Price impact"
          value={quote === null ? DASH : `${(quote.priceImpactBps / 100).toFixed(2)}%`}
          hint="fee included"
        />
        <Row
          label="Minimum received"
          value={
            quote === null
              ? DASH
              : buying
                ? tokens(Number(formatEther(quote.minAmountOut)))
                : eth(Number(formatEther(quote.minAmountOut)))
          }
          hint="1% slippage"
        />
        <Row
          label="Market fee"
          value={feeRate(feePpm)}
          {...(feePpm === null ? {} : { hint: "set by this token's rules" })}
        />
      </div>

      <button
        type="button"
        className={buying ? "tp-action buy" : "tp-action sell"}
        disabled={action.disabled}
        onClick={() => {
          if (wrongNetwork) {
            switchChain.mutate({ chainId: CHAIN_ID });
            return;
          }
          submit();
        }}
      >
        {action.label}
      </button>

      {receipt.isSuccess ? <p className="tp-done">Done. Your balance has updated.</p> : null}

      {send.error !== null && !isRejection(send.error) ? (
        <p className="tp-note tp-error">{shorten(send.error.message)}</p>
      ) : null}

      <p className="tp-note">
        {live
          ? "Priced by Uniswap at the moment you sign. Agen never takes custody."
          : "This token has been built and cleared but not launched, so there is no pool to trade against yet."}
      </p>
    </aside>
  );
}

/** A declined request is not an error worth reporting: they did it a second ago. */
function isRejection(error: Error): boolean {
  return /user rejected|user denied|rejected the request/i.test(error.message);
}

/** Wallet errors arrive as paragraphs. The first line is the part anybody reads. */
function shorten(message: string): string {
  return message.split("\n")[0]?.slice(0, 160) ?? "That did not go through.";
}
