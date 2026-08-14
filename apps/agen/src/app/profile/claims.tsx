"use client";

/**
 * What your markets have earned you, and the button that pays it out.
 *
 * ## Why this reads the chain rather than the catalogue
 *
 * `Portfolio` below filters a list the server already had. That list is Agen's build
 * jobs, and neither a Verdant nor an Instant market has a build — each is created
 * straight through its own factory, so nothing on this server knows it exists. The
 * registries do: `marketsByCreator` is an indexed lookup on chain, and it is the only
 * source here that cannot be behind.
 *
 * ## Two deployments, two fee mechanisms, one list
 *
 * A wallet may have launched through either, and the two earn in genuinely different
 * ways rather than in two flavours of one way. So `Earning` is a discriminated union on
 * `source` and every difference is carried in the branch rather than smoothed into a
 * shared shape with holes in it:
 *
 *  - **`verdant`** — Uniswap charges the LP fee and it accrues *inside the locked
 *    position*, in both of the market's currencies. Nothing is owed to anybody until
 *    `PositionLocker.collect()` sweeps it into the market's `FeeSplitter`, so a market
 *    that has traded all week reports a splitter balance of zero. `readClaimOutlook`
 *    simulates the collection and reads the balance it would produce, which is why the
 *    figure shown is what a claim would actually pay. Claiming is then up to two
 *    transactions, because collecting and claiming are different contracts with
 *    different permissions.
 *
 *  - **`instant`** — the pool's LP fee is zero, so the position accrues nothing and
 *    there is nothing to collect. The hook takes 1.50% from the ether leg of every swap
 *    and credits the market's `InstantFeeVault` as it happens. The vault already knows
 *    the answer, so there is no simulation, no `needsCollect`, and no token side to
 *    report — an Instant creator never accrues a balance of the token they launched,
 *    which is the entire reason that hook exists. One transaction, and it is the claim.
 *
 * The registry row for an Instant market carries `creatorBps` and `protocolBps` of zero,
 * deliberately, because a split of 1.00% and 0.50% *of the trade* is two thirds and one
 * third of the fee and one third is not a whole number of basis points. Nothing here
 * reads those fields. `InstantFees` is the authority, and for this screen the vault is.
 * See ADR-014.
 */

import { useCallback, useEffect, useState } from "react";
import { formatEther, type Address, type Hex } from "viem";
import { useAccount, usePublicClient, useSendTransaction, useWaitForTransactionReceipt } from "wagmi";

import { fees, instant as instantFees, markets as marketReads } from "@verdant/sdk";
import type { PublicClient } from "viem";

import { INSTANT_ADDRESSES, VERDANT_ADDRESSES, chain } from "../lib/chain";

/** What both kinds of market have in common, which is less than it looks. */
interface Earned {
  readonly poolId: Hex;
  readonly token: Address;
  readonly symbol: string;
  /** False when this market's fees were pointed at somebody other than the viewer. */
  readonly recipientIsYou: boolean;
  /** Owed in the chain's native currency, in wei. The figure the row leads with. */
  readonly ether: bigint;
}

interface VerdantEarning extends Earned {
  readonly source: "verdant";
  readonly locker: Address;
  readonly splitter: Address;
  /** Base units of the launch token. A Verdant fee accrues on whichever side was crossed. */
  readonly tokens: bigint;
  /** Whether reaching the figure above needs a `collect()` first. */
  readonly needsCollect: boolean;
}

interface InstantEarning extends Earned {
  readonly source: "instant";
  readonly vault: Address;
}

type Earning = VerdantEarning | InstantEarning;

/** Four significant figures of ether, which is all a fee line needs. */
function ether(wei: bigint): string {
  const value = Number(formatEther(wei));
  if (value === 0) return "0";
  if (value >= 1) return value.toFixed(3);
  return value.toPrecision(3);
}

/**
 * Every Verdant market this wallet's fees point at.
 *
 * The quote side may not be ether — a Verdant market can be quoted in an equity — but
 * the overwhelming majority are, and the row states the currency it is showing.
 */
async function loadVerdant(client: PublicClient, viewer: Address): Promise<readonly Earning[]> {
  if (VERDANT_ADDRESSES === null) return [];

  const records = await marketReads.readMarketsByCreator(
    client,
    { hook: VERDANT_ADDRESSES.hook, marketRegistry: VERDANT_ADDRESSES.marketRegistry },
    viewer,
  );

  return Promise.all(
    records.map(async (record): Promise<VerdantEarning> => {
      const [info, outlook, recipient] = await Promise.all([
        marketReads.readToken(client, record.token),
        fees.readClaimOutlook(client, {
          locker: record.locker,
          splitter: record.splitter,
          recipient: viewer,
        }),
        fees.readFeeRecipient(client, { splitter: record.splitter }),
      ]);

      return {
        source: "verdant",
        poolId: record.poolId,
        token: record.token,
        symbol: info.symbol,
        locker: record.locker,
        splitter: record.splitter,
        recipientIsYou: recipient.toLowerCase() === viewer.toLowerCase(),
        ether: outlook.total.quote,
        tokens: outlook.total.token,
        needsCollect: outlook.needsCollect,
      };
    }),
  );
}

/**
 * Every Instant market this wallet's fees point at.
 *
 * `record.splitter` is the market's `InstantFeeVault` — the registry field is named for
 * what it does rather than for what it is, and for an Instant market the address a
 * creator claims from is the vault. Nothing else on the row is consulted.
 */
async function loadInstant(client: PublicClient, viewer: Address): Promise<readonly Earning[]> {
  if (INSTANT_ADDRESSES === null) return [];

  const records = await marketReads.readMarketsByCreator(
    client,
    { hook: INSTANT_ADDRESSES.hook, marketRegistry: INSTANT_ADDRESSES.registry },
    viewer,
  );

  return Promise.all(
    records.map(async (record): Promise<InstantEarning> => {
      const vault = record.splitter;

      const [info, owed, recipient] = await Promise.all([
        marketReads.readToken(client, record.token),
        // No simulation: the fee never entered the position, so this is already what a
        // claim would pay rather than what has happened to be swept so far.
        instantFees.readInstantClaimable(client, { vault, recipient: viewer }),
        instantFees.readInstantFeeRecipient(client, { vault }),
      ]);

      return {
        source: "instant",
        poolId: record.poolId,
        token: record.token,
        symbol: info.symbol,
        vault,
        recipientIsYou: recipient.toLowerCase() === viewer.toLowerCase(),
        ether: owed,
      };
    }),
  );
}

export function Claims() {
  const { address } = useAccount();
  const client = usePublicClient();

  const [earnings, setEarnings] = useState<readonly Earning[] | null>(null);
  const [reloadAt, setReloadAt] = useState(0);

  useEffect(() => {
    if (address === undefined || client === undefined) {
      setEarnings(null);
      return;
    }

    let live = true;

    void (async () => {
      try {
        // Settled rather than raced: an Instant registry that is not deployed yet, or a
        // Verdant read that fails, should not hide the other deployment's earnings.
        const [verdant, instant] = await Promise.all([
          loadVerdant(client, address).catch(() => [] as readonly Earning[]),
          loadInstant(client, address).catch(() => [] as readonly Earning[]),
        ]);

        if (live) setEarnings([...instant, ...verdant]);
      } catch {
        // A read that failed is not the same as no markets, so this leaves the section
        // absent rather than claiming the wallet has earned nothing.
        if (live) setEarnings(null);
      }
    })();

    return () => {
      live = false;
    };
  }, [address, client, reloadAt]);

  if (address === undefined || earnings === null || earnings.length === 0) return null;

  const yours = earnings.filter((row) => row.recipientIsYou);
  if (yours.length === 0) return null;

  const totalEther = yours.reduce((sum, row) => sum + row.ether, 0n);

  return (
    <section className="ax-section ax-reveal">
      <div className="ax-section-head">
        <h2>Fees to claim</h2>
      </div>

      <div className="ax-claims">
        <div className="ax-claim-total">
          <span>Across {yours.length === 1 ? "1 market" : `${String(yours.length)} markets`}</span>
          <strong>
            {ether(totalEther)} {chain.nativeCurrency.symbol}
          </strong>
        </div>

        {yours.map((row) => (
          <ClaimRow
            key={row.poolId}
            earning={row}
            onDone={() => {
              setReloadAt((was) => was + 1);
            }}
          />
        ))}
      </div>

      <p className="ax-claim-note">
        Instant markets pay you {chain.nativeCurrency.symbol} on every trade, in both
        directions, and claiming is one transaction. Older markets charge a Uniswap fee that
        builds up inside the locked position; claiming those realises whatever has accrued
        and pays your share.
      </p>
    </section>
  );
}

function ClaimRow({
  earning,
  onDone,
}: {
  readonly earning: Earning;
  readonly onDone: () => void;
}) {
  const send = useSendTransaction();
  const receipt = useWaitForTransactionReceipt({ hash: send.data });

  // Which transaction is in flight. Only a Verdant market whose fees are still in the
  // position ever sees `collecting`.
  const [step, setStep] = useState<"idle" | "collecting" | "claiming" | "done">("idle");

  const tokens = earning.source === "verdant" ? earning.tokens : 0n;
  const nothing = earning.ether === 0n && tokens === 0n;

  const claim = useCallback(() => {
    const call =
      earning.source === "instant"
        ? instantFees.buildInstantClaimCreator({ vault: earning.vault })
        : fees.buildClaim({ splitter: earning.splitter });

    setStep("claiming");
    send.sendTransaction({ to: call.to, data: call.data, value: call.value });
  }, [earning, send]);

  const start = useCallback(() => {
    // An Instant market has nothing to collect: the LP fee is zero, so `collect()` is
    // correctly inert and calling it would spend gas to move nothing.
    if (earning.source === "instant" || !earning.needsCollect) {
      claim();
      return;
    }

    const call = fees.buildCollect({ locker: earning.locker });
    setStep("collecting");
    send.sendTransaction({ to: call.to, data: call.data, value: call.value });
  }, [claim, earning, send]);

  // The collection landed, so the fees are in the splitter and the claim can follow.
  useEffect(() => {
    if (!receipt.isSuccess) return;

    if (step === "collecting") {
      claim();
      return;
    }

    if (step === "claiming") {
      setStep("done");
      onDone();
    }
  }, [receipt.isSuccess, step, claim, onDone]);

  const busy = step === "collecting" || step === "claiming";

  return (
    <div className="ax-claim">
      <span className="ax-claim-id">${earning.symbol}</span>

      <span className="ax-claim-figs">
        <b>
          {ether(earning.ether)} {chain.nativeCurrency.symbol}
        </b>
        {tokens > 0n ? (
          <em>
            + {ether(tokens)} ${earning.symbol}
          </em>
        ) : null}
      </span>

      <button
        type="button"
        className="ax-claim-go"
        disabled={nothing || busy || step === "done"}
        onClick={start}
      >
        {step === "collecting"
          ? "collecting…"
          : step === "claiming"
            ? "claiming…"
            : step === "done"
              ? "Claimed"
              : nothing
                ? "Nothing yet"
                : "Claim"}
      </button>
    </div>
  );
}
