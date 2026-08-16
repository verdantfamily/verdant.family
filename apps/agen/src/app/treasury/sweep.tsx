"use client";

/**
 * What Agen has earned and the one button that collects it.
 *
 * ## Why this screen exists at all
 *
 * `profile/claims.tsx` finds a wallet's earnings through `marketsByCreator`, which is the right
 * question for a creator and the wrong one for the platform: the treasury launched nothing, so
 * that screen is empty for it and the platform's 0.50% had no surface anywhere. It went
 * uncollected for the whole life of the product — every vault's `platformClaimed` was zero —
 * which is what an absent button costs.
 *
 * ## Why there is no login on it
 *
 * Because there is nothing to gate. `InstantFeeVault.claimPlatform()` takes no argument and
 * pays `treasury`, an immutable snapshotted when the market was created, so the only thing a
 * stranger can do here is spend their own gas sending Agen's money to Agen. A login would
 * protect nothing and would need a server session for an action that is purely on chain. A
 * wallet is still required, but for the ordinary reason: somebody has to sign and pay gas.
 *
 * The page is simply not linked from the navigation, and asks not to be indexed.
 *
 * ## Why one transaction rather than twenty
 *
 * The ledger is per market — one vault each, immutable, ownerless — so there is no contract
 * that could be added to sweep them, and nothing to upgrade. The batch is assembled by the
 * caller instead, through the Multicall3 that `chains.ts` already records and `readMarketPage`
 * already uses. Twenty markets is one `aggregate3`, simulated at 877k gas.
 *
 * ## Why every figure is read from the chain
 *
 * The indexer knows these numbers and is not asked. It sums `Accrued` events, which is the
 * right source for `/metrics` — an accrual is a historical fact — but this screen is about to
 * spend gas moving a balance, and the only thing that can answer what a claim would pay is the
 * vault. A row here is `outstanding()`, and the destination is the vault's own `treasury()`
 * rather than the address in the deployment record, so the page states where the money will
 * actually land instead of where it was meant to.
 */

import { useCallback, useEffect, useState } from "react";
import { formatEther, type Address } from "viem";
import { useAccount, usePublicClient, useSendTransaction, useWaitForTransactionReceipt } from "wagmi";

import { abi, instant as instantFees, markets as marketReads } from "@verdant/sdk";
import type { PublicClient } from "viem";

import { INSTANT_ADDRESSES, INSTANT_TREASURY, chain, shortAddress } from "../lib/chain";

/** One market with something owed to the platform. */
interface Owing {
  readonly vault: Address;
  readonly token: Address;
  readonly symbol: string;
  readonly owed: bigint;
  /**
   * The vault's own `treasury()`.
   *
   * Read rather than assumed so the total can say where it is going. Every vault from one
   * Instant deployment shares it, and a vault that disagreed with the record would mean a
   * market created by some other factory had ended up in this registry — worth showing rather
   * than quietly summing into a figure labelled as Agen's.
   */
  readonly destination: Address;
}

interface Sheet {
  readonly rows: readonly Owing[];
  /** Markets read, including those owing nothing. The denominator the screen reports. */
  readonly markets: number;
  readonly total: bigint;
}

/** Ether to a fixed six places, which is enough to see a five-microether row is not zero. */
function ether(wei: bigint): string {
  const value = Number(formatEther(wei));
  if (value === 0) return "0";
  if (value >= 1) return value.toFixed(4);
  return value.toFixed(6);
}

/**
 * Every Instant market, and what each still owes the platform.
 *
 * Enumerated from the registry rather than from the feed: `marketCount` and `marketAt` are one
 * multicall, and a page about to move money should not be able to miss a market because an
 * indexer is behind.
 */
async function load(client: PublicClient): Promise<Sheet> {
  if (INSTANT_ADDRESSES === null) return { rows: [], markets: 0, total: 0n };

  const registry = {
    hook: INSTANT_ADDRESSES.hook,
    marketRegistry: INSTANT_ADDRESSES.registry,
  } as const;

  const count = await marketReads.readMarketCount(client, registry);
  if (count === 0) return { rows: [], markets: 0, total: 0n };

  /*
   * In pages rather than one call per market and rather than one call for all of them.
   *
   * `readMarketPage` batches a page into a single multicall, so the page size is the number of
   * `marketAt` calls in one request. Asking for the whole registry at once works today and gets
   * slower every launch until some RPC refuses the request — which would present as this screen
   * saying the chain did not answer, on the day somebody wanted their money.
   */
  const markets: marketReads.MarketRecord[] = [];
  for (let offset = 0; offset < count; offset += 50) {
    markets.push(...(await marketReads.readMarketPage(client, registry, { offset, limit: 50 })));
  }

  const owed = await instantFees.readInstantPlatformOwed(client, {
    vaults: markets.map((market) => market.splitter),
  });

  const owing = markets
    .map((market, index) => ({ market, owed: owed[index]?.owed ?? 0n }))
    .filter((entry) => entry.owed > 0n);

  if (owing.length === 0) return { rows: [], markets: markets.length, total: 0n };

  // Two multicalls rather than a read per market: the symbol is what a person recognises a row
  // by, and the destination is the assurance that the total is Agen's.
  const [symbols, destinations] = await Promise.all([
    client.multicall({
      allowFailure: true,
      contracts: owing.map((entry) => ({
        address: entry.market.token,
        abi: abi.verdantTokenAbi,
        functionName: "symbol" as const,
      })),
    }),
    client.multicall({
      allowFailure: true,
      contracts: owing.map((entry) => ({
        address: entry.market.splitter,
        abi: abi.instantFeeVaultAbi,
        functionName: "treasury" as const,
      })),
    }),
  ]);

  const rows = owing.map((entry, index) => {
    const symbol = symbols[index];
    const destination = destinations[index];

    return {
      vault: entry.market.splitter,
      token: entry.market.token,
      symbol: symbol?.status === "success" ? symbol.result : "?",
      owed: entry.owed,
      destination:
        destination?.status === "success" ? destination.result : ("0x" as unknown as Address),
    };
  });

  return {
    // Largest first: the tail of an Instant registry is microether dust, and a sweep is read
    // top-down to see whether it is worth the gas.
    rows: [...rows].sort((a, b) => (b.owed > a.owed ? 1 : -1)),
    markets: markets.length,
    total: rows.reduce((sum, row) => sum + row.owed, 0n),
  };
}

export function Sweep() {
  const { address } = useAccount();
  const client = usePublicClient();

  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [failed, setFailed] = useState(false);
  const [reloadAt, setReloadAt] = useState(0);

  const send = useSendTransaction();
  const receipt = useWaitForTransactionReceipt({ hash: send.data });
  const [claiming, setClaiming] = useState(false);

  useEffect(() => {
    if (client === undefined) return;

    let live = true;

    void (async () => {
      try {
        const loaded = await load(client);
        if (live) {
          setSheet(loaded);
          setFailed(false);
        }
      } catch {
        // A failed read is not the same as nothing owed, and a zero here would be a lie about
        // revenue. The screen says it could not read instead.
        if (live) setFailed(true);
      }
    })();

    return () => {
      live = false;
    };
  }, [client, reloadAt]);

  // The sweep landed. Re-read rather than assuming the balances are now zero: `allowFailure` is
  // on, so a vault that did not pay must reappear as a remaining row.
  useEffect(() => {
    if (!receipt.isSuccess || !claiming) return;
    setClaiming(false);
    setReloadAt((was) => was + 1);
  }, [receipt.isSuccess, claiming]);

  const multicall = chain.contracts?.multicall3?.address;

  const sweep = useCallback(() => {
    if (sheet === null || sheet.rows.length === 0 || multicall === undefined) return;

    const call = instantFees.buildInstantClaimPlatformSweep({
      vaults: sheet.rows.map((row) => row.vault),
      multicall,
    });

    setClaiming(true);
    send.sendTransaction({ to: call.to, data: call.data, value: call.value });
  }, [sheet, multicall, send]);

  if (INSTANT_ADDRESSES === null) {
    return (
      <p className="ax-empty">
        This build has no Instant deployment recorded, so there are no vaults to sweep.
      </p>
    );
  }

  if (failed) {
    return (
      <p className="ax-empty">
        The chain did not answer, so there is nothing to report. These figures are read from each
        market&rsquo;s vault rather than from the indexer, and a zero here would be a guess.
      </p>
    );
  }

  if (sheet === null) return <p className="ax-empty">Reading every market&rsquo;s vault…</p>;

  if (sheet.rows.length === 0) {
    return (
      <p className="ax-empty">
        Nothing to claim. All {sheet.markets} markets have paid out everything they have accrued
        to the platform.
      </p>
    );
  }

  /*
   * Where the money goes, from the vaults rather than from the record.
   *
   * Normally one address. More than one would mean this registry holds markets from more than
   * one Instant deployment, which is worth saying out loud on the screen that is about to sweep
   * them together.
   */
  const byAddress = new Map<string, Address>();
  for (const row of sheet.rows) byAddress.set(row.destination.toLowerCase(), row.destination);

  // Deduplicated on the lowercase form and displayed in the checksummed one, which is what the
  // vault returns and what a person compares against their wallet.
  const destinations = [...byAddress.values()];
  const expected = INSTANT_TREASURY?.toLowerCase();
  const unexpected =
    expected === undefined
      ? []
      : destinations.filter((to) => to.toLowerCase() !== expected);

  const busy = claiming || send.isPending || receipt.isLoading;
  const symbol = chain.nativeCurrency.symbol;

  return (
    <div className="ax-claims">
      <div className="ax-claim-total">
        <span>
          Across {sheet.rows.length === 1 ? "1 market" : `${String(sheet.rows.length)} markets`} of{" "}
          {String(sheet.markets)}
        </span>
        <strong>
          {ether(sheet.total)} {symbol}
        </strong>
      </div>

      {sheet.rows.map((row) => (
        <div className="ax-claim" key={row.vault}>
          <span className="ax-claim-id">${row.symbol}</span>
          <span className="ax-claim-figs">
            <b>
              {ether(row.owed)} {symbol}
            </b>
          </span>
        </div>
      ))}

      <div className="ax-claim-total" style={{ marginTop: "8px" }}>
        <span>
          {destinations.length === 1 && unexpected.length === 0 ? (
            <>Pays the treasury at {shortAddress(destinations[0]!)}</>
          ) : (
            <>
              Pays {String(destinations.length)} different addresses — check before sending
            </>
          )}
        </span>

        <button type="button" className="ax-claim-go" disabled={busy || address === undefined} onClick={sweep}>
          {busy
            ? "claiming…"
            : address === undefined
              ? "Connect a wallet"
              : `Claim all ${String(sheet.rows.length)}`}
        </button>
      </div>

      {send.isError ? (
        <p className="ax-claim-note">
          The wallet refused or the transaction failed, and nothing moved. Balances above are
          unchanged.
        </p>
      ) : null}

      <p className="ax-claim-note">
        One transaction, through Multicall3: each market&rsquo;s vault holds its own ledger and
        there is no contract that could sweep them, so the batch is assembled here. Any wallet
        can send it — the recipient is fixed in each vault when the market is created, so this
        cannot be aimed anywhere else. Whoever signs pays the gas; the {symbol} goes to the
        treasury.
      </p>
    </div>
  );
}
