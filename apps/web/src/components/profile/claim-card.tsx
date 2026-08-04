"use client";

import { fees } from "@verdant/sdk";
import { formatAmount, formatCompact, formatFeeRate, formatInstant } from "@verdant/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import type { Address } from "viem";
import { usePublicClient } from "wagmi";

import type { SerializedLaunch } from "../../app/api/markets/route";
import { CHAIN_ID } from "../../lib/chain";
import { Badge, TokenAvatar } from "../primitives";
import { TransactionNote, useTransaction } from "../transaction";

/**
 * One market a creator launched, and the control that pays them.
 *
 * ## Why claiming is two transactions
 *
 * A swap's fee accrues inside the locked Uniswap position and stays there. The splitter,
 * which is the only contract that will pay a creator, holds nothing until somebody calls
 * `collect()` on the locker to realise those fees into it. So "claim my fees" is:
 *
 *   1. `PositionLocker.collect()` — anyone may call it; it sweeps the position's accrued
 *      fees, in both currencies, into the splitter.
 *   2. `FeeSplitter.claim()` — only a recipient may call it; it pays the caller their
 *      share of everything the splitter holds.
 *
 * Both run every time, in that order, even when there is already a claimable balance. The
 * alternative — claiming what is in the splitter and leaving whatever accrued since the
 * last collection inside the position — would be a button labelled "claim" that
 * predictably left money behind, which is worse than a second signature.
 *
 * The collection is skipped only in the sense that it is cheap and harmless when there is
 * nothing to collect: the contract treats an empty collection as a no-op rather than an
 * error, which is what makes running it unconditionally safe.
 *
 * ## Why the recipient is read from the chain
 *
 * The indexer's `creator` is whoever sent the launch transaction. The address the splitter
 * pays is `feeRecipient`, chosen at launch, and a creator may have named a multisig or a
 * partner instead of themselves. Only the splitter knows, `claim()` takes no argument for
 * whom to pay, and it reverts for anybody else — so this asks the splitter rather than
 * assuming the two are the same address.
 */
export function ClaimCard({
  launch,
  address,
}: {
  readonly launch: SerializedLaunch;
  readonly address: Address;
}) {
  const client = usePublicClient();
  const queryClient = useQueryClient();
  const collect = useTransaction();
  const claim = useTransaction();

  const splitter = launch.splitter as Address;
  const locker = launch.locker as Address;

  const state = useQuery({
    queryKey: ["claimable", launch.poolId, address, CHAIN_ID],
    queryFn: async () => {
      if (client === undefined) throw new Error("not ready");
      const [outlook, recipient] = await Promise.all([
        fees.readClaimOutlook(client, { locker, splitter, recipient: address }),
        fees.readFeeRecipient(client, { splitter }),
      ]);
      return { outlook, recipient };
    },
    enabled: client !== undefined,
    staleTime: 15_000,
  });

  const yours = state.data !== undefined && sameAddress(state.data.recipient, address);
  const outlook = state.data?.outlook;
  const total = outlook?.total;
  const something = total !== undefined && (total.quote > 0n || total.token > 0n);

  /** What the creator keeps of each swap: their share of the fee, not the whole fee. */
  const creatorPpm = fees.creatorShareOfFee(launch.feePpm, launch.creatorBps);

  const busy = collect.busy || claim.busy;

  /**
   * Collect if the position is holding anything, then claim.
   *
   * The decision about whether to collect is made from the simulation, before either
   * transaction, rather than by re-reading the splitter between them. That re-read was the
   * bug in the first version of this: after a confirmed collection it asked the node for
   * the new balance, and a load-balanced RPC serving a block behind would answer zero — at
   * which point the code concluded there was nothing to claim and stopped, having just
   * made the creator pay for a collection whose proceeds it then declined to pay out.
   *
   * Deciding up front also means the second signature is only ever asked for when it will
   * succeed, and the first is skipped entirely when the splitter already holds everything.
   */
  async function claimEverything() {
    if (client === undefined || outlook === undefined) return;

    claim.reset();
    collect.reset();

    if (outlook.needsCollect) {
      const collected = await collect.send(fees.buildCollect({ locker }));
      if (collected === null || collected.status !== "success") return;
    }

    const paid = await claim.send(fees.buildClaim({ splitter }));
    if (paid !== null && paid.status === "success") {
      await queryClient.invalidateQueries({ queryKey: ["claimable", launch.poolId] });
    }
  }

  return (
    <div className="rounded-card border border-border bg-surface p-5 shadow-card backdrop-blur-xl">
      <div className="flex items-start gap-3">
        <TokenAvatar symbol={launch.symbol} size="default" uri={launch.metadataURI} />

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Link
              href={`/market/${launch.poolId}`}
              className="truncate text-[0.95rem] font-semibold tracking-tight text-ink transition-colors hover:text-accent"
            >
              {launch.name}
            </Link>
            <span className="numeric text-[0.8rem] text-ink-muted">${launch.symbol}</span>
            {yours ? null : <Badge tone="caution">fees go elsewhere</Badge>}
          </div>

          <p className="mt-1 text-[0.72rem] text-ink-muted">
            launched {formatInstant(launch.createdAt)} · {launch.swapCount}{" "}
            {launch.swapCount === 1 ? "trade" : "trades"}
          </p>
        </div>
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 border-t border-border pt-4 text-[0.8rem]">
        <div>
          <dt className="text-[0.68rem] text-ink-muted">Swap fee</dt>
          <dd className="numeric mt-0.5 text-ink">{formatFeeRate(launch.feePpm)}</dd>
        </div>
        <div>
          {/* The number a creator actually earns. The whole fee reaches the position and
              the protocol's share comes off in the splitter, so this is strictly less than
              the fee above — saying only the fee would overstate it. */}
          <dt className="text-[0.68rem] text-ink-muted">Your share of it</dt>
          <dd className="numeric mt-0.5 text-accent">{formatFeeRate(creatorPpm)}</dd>
        </div>
      </dl>

      <div className="mt-4 rounded-xl border border-border bg-surface-sunken px-4 py-3">
        <p className="text-[0.68rem] text-ink-muted">Yours to claim</p>

        {state.isPending ? (
          <p className="numeric mt-1 text-[0.95rem] text-ink-faint">reading…</p>
        ) : state.isError || total === undefined ? (
          <p className="mt-1 text-[0.78rem] text-ink-muted">
            The chain did not answer. Your fees are unaffected — they are held by the pool
            and the splitter either way.
          </p>
        ) : (
          <p className="numeric mt-1 text-[1.05rem] text-ink">
            {formatAmount(total.quote, { decimals: launch.quote.decimals, places: 6 })}{" "}
            <span className="text-[0.75rem] text-ink-muted">{launch.quote.symbol}</span>
            {total.token > 0n ? (
              <>
                {" · "}
                {formatCompact(total.token, launch.decimals)}{" "}
                <span className="text-[0.75rem] text-ink-muted">{launch.symbol}</span>
              </>
            ) : null}
          </p>
        )}

        {/* Says where the money currently is, because that decides how many signatures
            the button below will ask for. */}
        {outlook === undefined ? null : (
          <p className="mt-1.5 text-[0.68rem] leading-relaxed text-ink-faint">
            {!something
              ? "Nothing has accrued since this market's fees were last taken."
              : outlook.needsCollect
                ? "Still inside the pool. Claiming realises it into the splitter first, so this takes two transactions."
                : "Already in the splitter and ready to pay out in one transaction."}
          </p>
        )}
      </div>

      {yours ? (
        <>
          {/* Disabled when there is genuinely nothing, rather than offered and then
              reverting: `claim()` refuses an empty claim, and a button that spends gas to
              be told so is worse than one that says so for free. */}
          <button
            type="button"
            disabled={busy || client === undefined || !something}
            onClick={() => void claimEverything()}
            className="mt-4 inline-flex h-11 w-full items-center justify-center rounded-full bg-ink px-6 text-[0.9rem] font-medium text-ink-inverse shadow-card transition hover:bg-ink/90 active:scale-[0.985] disabled:cursor-not-allowed disabled:bg-surface-raised disabled:text-ink-faint disabled:active:scale-100"
          >
            {collect.busy
              ? "Collecting from the pool…"
              : claim.busy
                ? "Claiming…"
                : state.isPending
                  ? "Checking…"
                  : something
                    ? "Claim fees"
                    : "Nothing to claim yet"}
          </button>

          <TransactionNote
            run={collect}
            pending="Collecting the pool's fees into the splitter"
            confirmed="Collected. Your wallet will ask once more, to pay you."
          />
          <TransactionNote run={claim} pending="Paying out your share" confirmed="Claimed." />

          {outlook?.needsCollect === true ? (
            <p className="mt-2 text-[0.68rem] leading-relaxed text-ink-faint">
              Your wallet will ask twice: once to realise the pool&apos;s fees into the
              splitter, once to pay you. Anyone may run the first; only you can run the
              second.
            </p>
          ) : null}
        </>
      ) : (
        <p className="mt-4 rounded-xl border border-border bg-surface-sunken px-4 py-3 text-[0.75rem] leading-relaxed text-ink-muted">
          This market pays its creator share to{" "}
          <span className="numeric text-ink">
            {state.data === undefined ? "another address" : shorten(state.data.recipient)}
          </span>
          , which was named at launch. Only that address can claim it.
        </p>
      )}
    </div>
  );
}

function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function shorten(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
