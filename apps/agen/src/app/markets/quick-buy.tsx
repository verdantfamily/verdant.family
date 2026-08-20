"use client";

/**
 * Buy from a card, without opening the token page.
 *
 * Three sizes, one transaction. The full trade panel quotes on every keystroke and
 * explains the fee; this one quotes the size they tapped and sends. A card is where
 * commitment happens, and every extra click after "this looks fun" is a lost trade.
 */

import { useCallback, useState } from "react";
import { parseEther, type Address } from "viem";
import {
  useAccount,
  usePublicClient,
  useSendTransaction,
  useSwitchChain,
  useWaitForTransactionReceipt,
} from "wagmi";

import { agen } from "@verdant/sdk";

import { AGEN_ROUTER, CHAIN_ID, chain } from "../lib/chain";

const SIZES = ["0.01", "0.05", "0.1"] as const;
const SLIPPAGE_BPS = 100;

export interface QuickBuyMarket {
  readonly symbol: string;
  readonly token: string;
  readonly hook: string;
  readonly poolId: string;
  readonly lpFee: number;
}

export function QuickBuy({ market }: { readonly market: QuickBuyMarket }) {
  const { address, chainId, status } = useAccount();
  const client = usePublicClient();
  const switchChain = useSwitchChain();
  const send = useSendTransaction();
  const receipt = useWaitForTransactionReceipt({ hash: send.data });
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const connected = status === "connected" && address !== undefined;
  const busy = send.isPending || receipt.isLoading || pending !== null;

  const buy = useCallback(
    async (size: string) => {
      setError(null);

      if (!connected) {
        setError("Connect a wallet first.");
        return;
      }
      if (chainId !== CHAIN_ID) {
        switchChain.mutate({ chainId: CHAIN_ID });
        return;
      }
      if (client === undefined || AGEN_ROUTER === null) return;

      const poolKey = agen.agenPoolKeyFor({
        quoteAsset: agen.NATIVE_CURRENCY,
        token: market.token as Address,
        hook: market.hook as Address,
        lpFee: market.lpFee,
      });
      if (poolKey === null) {
        setError("This pool could not be resolved.");
        return;
      }

      const amountIn = parseEther(size);
      setPending(size);

      try {
        const quote = await agen.quoteAgenSwap(client, {
          router: AGEN_ROUTER,
          poolKey,
          zeroForOne: true,
          amountIn,
          trader: address,
          slippageBps: SLIPPAGE_BPS,
        });
        if (quote === null) {
          setError("No route for that size.");
          return;
        }

        const call = agen.buildAgenBuy({
          router: AGEN_ROUTER,
          poolKey,
          amountIn,
          minAmountOut: quote.minAmountOut,
        });

        send.sendTransaction({
          to: call.to,
          data: call.data,
          value: call.value,
          chainId: CHAIN_ID,
        });
      } catch (caught) {
        const text = caught instanceof Error ? caught.message : "";
        if (!/user rejected|user denied|rejected the request/i.test(text)) {
          setError("That buy did not go through.");
        }
      } finally {
        setPending(null);
      }
    },
    [address, chainId, client, connected, market, send, switchChain],
  );

  return (
    <div
      className="ax-qbuy"
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      {SIZES.map((size) => (
        <button
          key={size}
          type="button"
          disabled={busy}
          onClick={() => {
            void buy(size);
          }}
        >
          {pending === size ? "…" : `${size} ${chain.nativeCurrency.symbol}`}
        </button>
      ))}
      {error === null ? null : <em>{error}</em>}
    </div>
  );
}
