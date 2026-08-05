"use client";

import { abi, launch, trade } from "@verdant/sdk";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useMemo, useState } from "react";
import type { Address, Hex } from "viem";
import { erc20Abi, formatEther, formatUnits, parseEventLogs, zeroAddress } from "viem";
import { useConnection, usePublicClient } from "wagmi";

import { CHAIN_ID, VERDANT_ADDRESSES, chain } from "../../lib/chain";
import { describeError } from "../../lib/errors";
import { launchParams, tokenIdentity, type DerivedLaunch, type LaunchDraft } from "../../lib/launch";
import { ConnectButton } from "../connect-button";
import { AddressLink, Notice } from "../primitives";
import { MissingAddresses, TransactionNote, useTransaction } from "../transaction";

/**
 * What a launch needs that a draft cannot supply.
 *
 * The token's address is CREATE2 and therefore known before the transaction is sent —
 * but only after one chain read. The init code hash is the hash of a compiled artefact
 * held by `VerdantDeployer`, so it comes from the chain; everything after it is
 * arithmetic. That asymmetry is why the search is one read and then a local loop rather
 * than a loop of reads.
 */
export interface MinedLaunch {
  readonly salt: Hex;
  readonly token: Address;
  readonly attempts: number;
}

/**
 * Mine the salt this launch will be created under.
 *
 * Always, not only for an equity-quoted market. An ether-quoted launch qualifies on its
 * first candidate — the zero address sorts below everything — but the search still runs,
 * because the address it produces is the address the summary shows, and a form that
 * skipped mining for ether would have nothing truthful to put there.
 *
 * For an equity-quoted launch the search is the launch: `VerdantFactory` reverts
 * `TokenNotAboveQuote` unless the new token sorts strictly above the quote asset, since
 * the launch token is always `currency1`. The creator's only lever over that is the
 * salt.
 */
export function useMinedLaunch({
  draft,
  derived,
  creator,
  enabled,
}: {
  readonly draft: LaunchDraft;
  readonly derived: DerivedLaunch;
  readonly creator: Address | undefined;
  readonly enabled: boolean;
}): {
  readonly mined: MinedLaunch | undefined;
  readonly reading: boolean;
  readonly problem: string | undefined;
} {
  const client = usePublicClient();
  const addresses = VERDANT_ADDRESSES.ok ? VERDANT_ADDRESSES.addresses : null;
  const identity = creator === undefined ? null : tokenIdentity(draft, derived, creator);

  const hash = useQuery({
    // Every field of the identity is in the key because every one of them changes the
    // token's address. A hash cached against a stale supply would mine a salt for a
    // token that will never exist.
    queryKey: [
      "token-init-code-hash",
      addresses?.deployer,
      identity?.name,
      identity?.symbol,
      identity?.supplyTokens?.toString(),
      identity?.metadataURI,
      identity?.metadataMutable,
      identity?.creator,
    ],
    queryFn: async (): Promise<Hex> => {
      if (client === undefined || addresses === null || identity === null) {
        throw new Error("not ready");
      }
      return launch.readTokenInitCodeHash(client, {
        ...identity,
        deployer: addresses.deployer,
      });
    },
    enabled: enabled && client !== undefined && addresses !== null && identity !== null,
    staleTime: Infinity,
  });

  const mined = useMemo((): MinedLaunch | undefined => {
    if (hash.data === undefined || addresses === null || creator === undefined) return undefined;
    try {
      return launch.mineTokenSalt({
        deployer: addresses.deployer,
        creator,
        initCodeHash: hash.data,
        above: derived.quoteAsset,
      });
    } catch {
      // `mineTokenSalt` throws only when the constraint is unsatisfiable, which for a
      // quote asset from the reviewed list cannot happen. Treated as "no salt yet"
      // rather than crashing the form.
      return undefined;
    }
  }, [hash.data, addresses, creator, derived.quoteAsset]);

  return {
    mined,
    reading: hash.isFetching,
    problem: hash.error === null ? undefined : describeError(hash.error),
  };
}

/**
 * The button that sends the launch, and everything that stands between a reader and it.
 *
 * The order of the gates is the order the reader meets them: an interface that does not
 * know where Verdant is cannot offer anything, a wallet that is not connected cannot
 * sign, a wallet on the wrong chain would sign against a chain with no factory, and a
 * draft the contracts would reject should not reach a wallet at all.
 */
export function LaunchSubmit({
  draft,
  derived,
  mined,
  mining,
  miningProblem,
  blockers,
  symbol,
}: {
  readonly draft: LaunchDraft;
  readonly derived: DerivedLaunch;
  readonly mined: MinedLaunch | undefined;
  readonly mining: boolean;
  readonly miningProblem: string | undefined;
  readonly blockers: number;
  readonly symbol: string;
}) {
  const { address, chainId, status } = useConnection();
  const [created, setCreated] = useState<{
    poolId: Hex;
    token: Address;
    bought: bigint;
  } | null>(null);

  if (!VERDANT_ADDRESSES.ok) return <MissingAddresses problems={VERDANT_ADDRESSES.problems} />;
  const addresses = VERDANT_ADDRESSES.addresses;

  if (created !== null) {
    return (
      <MarketCreated
        poolId={created.poolId}
        token={created.token}
        bought={created.bought}
        initialBuy={draft.initialBuy}
        quoteLabel={derived.quoteLabel}
        symbol={symbol}
      />
    );
  }

  if (status !== "connected" || address === undefined) {
    return <ConnectButton size="large" label="Connect wallet to launch" className="w-full" />;
  }

  if (chainId !== CHAIN_ID) {
    return (
      <div>
        <ConnectButton size="large" className="w-full" />
        <p className="mt-2 text-[0.75rem] leading-relaxed text-ink-muted">
          Your wallet is on another network. Verdant&apos;s factory is on {chain.name}.
        </p>
      </div>
    );
  }

  if (blockers > 0) return null;

  const params =
    mined === undefined
      ? null
      : launchParams(draft, derived, { creator: address, salt: mined.salt });

  return (
    <LaunchAction
      factory={addresses.factory}
      params={params}
      creator={address}
      quoteLabel={derived.quoteLabel}
      quoteDecimals={derived.quoteDecimals}
      initialBuy={draft.initialBuy}
      symbol={symbol}
      mining={mining}
      miningProblem={miningProblem}
      onCreated={setCreated}
    />
  );
}

/**
 * The approval, the launch, and the one order they can happen in.
 *
 * Separate from `LaunchSubmit` because an allowance is a chain read and a read is a
 * hook: the gates above return early, and a hook after an early return is a hook that
 * runs on some renders and not others. Splitting the component is what lets the gates
 * stay in reading order.
 *
 * An ether-quoted launch has no approval — the ether rides along with the call. An
 * equity-quoted launch with a first buy needs one, because the factory pulls the equity
 * with `transferFrom`, and it is for the exact amount rather than unlimited: this
 * allowance exists to fund one buy in one transaction, so an unbounded one would grant
 * the factory a standing claim on an equity position for no benefit to the creator.
 */
function LaunchAction({
  factory,
  params,
  creator,
  quoteLabel,
  quoteDecimals,
  initialBuy,
  symbol,
  mining,
  miningProblem,
  onCreated,
}: {
  readonly factory: Address;
  readonly params: launch.LaunchParams | null;
  readonly creator: Address;
  readonly quoteLabel: string;
  /** For rendering a balance of the quote asset in its own units. */
  readonly quoteDecimals: number;
  readonly initialBuy: string;
  readonly symbol: string;
  readonly mining: boolean;
  readonly miningProblem: string | undefined;
  readonly onCreated: (created: { poolId: Hex; token: Address; bought: bigint }) => void;
}) {
  const client = usePublicClient();
  const queryClient = useQueryClient();
  const approval = useTransaction();
  const run = useTransaction();

  const quoteAsset = params?.quoteAsset ?? zeroAddress;
  const buying = params !== null && params.initialBuyAmount > 0n;
  const paysErc20 = buying && quoteAsset !== zeroAddress;

  const allowanceKey = ["launch-allowance", quoteAsset, creator, factory, CHAIN_ID] as const;
  const allowance = useQuery({
    queryKey: allowanceKey,
    queryFn: async (): Promise<bigint> => {
      if (client === undefined) throw new Error("not ready");
      return client.readContract({
        address: quoteAsset,
        abi: erc20Abi,
        functionName: "allowance",
        args: [creator, factory],
      });
    },
    enabled: client !== undefined && paysErc20,
    staleTime: 15_000,
  });

  // Undefined while the read is in flight, which is not the same as zero. Treating it as
  // zero would flash an approve button at somebody who has already approved.
  const approved = allowance.data;
  const needsApproval =
    paysErc20 && params !== null && approved !== undefined && approved < params.initialBuyAmount;

  /*
   * Whether the creator can actually pay for the launch they have described.
   *
   * Nothing checked this, and the way it failed was the worst available: the form was
   * satisfied, the button said "Launch", and the wallet answered with its own words —
   * Phantom's being "There was an error attempting to sign the transaction", which names
   * neither the shortfall nor the amount. A creator holding 0.0025 ether who asked for a
   * 0.005 ether first buy had no way to learn that from anything on screen.
   *
   * The gas is estimated only when the value alone already fits, because estimating is
   * itself a call that fails for want of funds — the node answers "the total cost exceeds
   * the balance of the account" rather than a gas figure, so asking in the case that
   * matters would replace a known shortfall with an unexplained error. Where it cannot be
   * had, the check falls back to the value, which is the part a creator chose and the part
   * large enough to matter.
   */
  const funds = useQuery({
    queryKey: [
      "launch-funds",
      creator,
      quoteAsset,
      params?.initialBuyAmount.toString(),
      CHAIN_ID,
    ] as const,
    queryFn: async () => {
      if (client === undefined || params === null) throw new Error("not ready");
      const call = launch.buildCreate({ factory, params });

      const [balance, block, quoteBalance] = await Promise.all([
        client.getBalance({ address: creator }),
        client.getBlock(),
        paysErc20
          ? client.readContract({
              address: quoteAsset,
              abi: erc20Abi,
              functionName: "balanceOf",
              args: [creator],
            })
          : Promise.resolve(null),
      ]);

      let gas: bigint | null = null;
      if (balance > call.value) {
        try {
          const units = await client.estimateGas({
            account: creator,
            to: call.to,
            data: call.data,
            value: call.value,
          });
          gas = units * (block.baseFeePerGas ?? 0n);
        } catch {
          // Estimation can fail for reasons that are not affordability. Not knowing the
          // gas is not evidence of anything, so the check proceeds on the value alone.
          gas = null;
        }
      }

      return { balance, value: call.value, gas, quoteBalance };
    },
    enabled: client !== undefined && params !== null,
    staleTime: 10_000,
  });

  /** What the launch costs against what the creator holds, once both are known. */
  const shortfall = ((): { needed: bigint; held: bigint; gas: bigint | null } | null => {
    const read = funds.data;
    if (read === undefined) return null;

    const needed = read.value + (read.gas ?? 0n);
    if (read.balance >= needed) return null;
    return { needed, held: read.balance, gas: read.gas };
  })();

  /** The equity-quoted twin: the first buy is pulled in the quote asset, not in ether. */
  const shortOfQuote =
    params !== null &&
    funds.data?.quoteBalance != null &&
    funds.data.quoteBalance < params.initialBuyAmount
      ? { needed: params.initialBuyAmount, held: funds.data.quoteBalance }
      : null;

  async function approve() {
    if (params === null) return;

    const receipt = await approval.send(
      trade.buildErc20Approval({
        token: quoteAsset,
        spender: factory,
        amount: params.initialBuyAmount,
      }),
    );

    if (receipt !== null && receipt.status === "success") {
      await queryClient.invalidateQueries({ queryKey: allowanceKey });
      approval.reset();
    }
  }

  async function submit() {
    if (params === null) return;

    const receipt = await run.send(launch.buildCreate({ factory, params }));
    if (receipt === null || receipt.status !== "success") return;

    // The factory's own event is the only place the pool id appears. Deriving it from
    // the token address would work — `pool.poolIdFor` is a twin of the Solidity — but
    // reading it from the receipt is the market's own account of itself, and if the two
    // ever disagreed the receipt would be right.
    const [event] = parseEventLogs({
      abi: abi.verdantFactoryAbi,
      eventName: "MarketCreated",
      logs: receipt.logs,
    });

    if (event === undefined) return;

    // What the buy actually delivered, read off the token's own transfers rather than
    // taken from the form's estimate. The estimate is computed at the opening price and
    // ignores price impact, which against a one-sided position is not a rounding
    // difference — so showing it here would be reporting a number the transaction did
    // not produce.
    const bought = parseEventLogs({
      abi: erc20Abi,
      eventName: "Transfer",
      logs: receipt.logs,
    })
      .filter((log) => log.address.toLowerCase() === event.args.token.toLowerCase())
      .filter((log) => log.args.to.toLowerCase() === creator.toLowerCase())
      .reduce((total, log) => total + log.args.value, 0n);

    onCreated({ poolId: event.args.poolId, token: event.args.token, bought });
  }

  const preparing = mining || params === null;
  const cannotAfford = shortfall !== null || shortOfQuote !== null;

  if (needsApproval) {
    return (
      <div>
        <button
          type="button"
          disabled={approval.busy}
          onClick={() => void approve()}
          className="inline-flex h-12 w-full items-center justify-center rounded-full bg-ink px-6 text-[0.95rem] font-medium text-ink-inverse shadow-card transition hover:bg-ink/90 active:scale-[0.985] disabled:cursor-not-allowed disabled:bg-surface-raised disabled:text-ink-faint disabled:active:scale-100"
        >
          {approval.phase === "signing"
            ? "Confirm in your wallet"
            : approval.phase === "pending"
              ? `Approving ${quoteLabel}…`
              : `Approve ${initialBuy} ${quoteLabel}`}
        </button>

        <TransactionNote
          run={approval}
          pending={`Allowing the factory to take ${initialBuy} ${quoteLabel}`}
          confirmed="Approved. The launch is next."
        />

        <p className="mt-3 text-[0.7rem] leading-relaxed text-ink-muted">
          The factory takes your first buy out of this allowance during the launch, so it
          is for {initialBuy} {quoteLabel} and no more. Then one transaction creates the
          token, the pool, the locked position and buys.
        </p>
      </div>
    );
  }

  return (
    <div>
      <button
        type="button"
        disabled={preparing || run.busy || cannotAfford}
        onClick={() => void submit()}
        className="inline-flex h-12 w-full items-center justify-center rounded-full bg-ink px-6 text-[0.95rem] font-medium text-ink-inverse shadow-card transition hover:bg-ink/90 active:scale-[0.985] disabled:cursor-not-allowed disabled:bg-surface-raised disabled:text-ink-faint disabled:active:scale-100"
      >
        {run.phase === "signing"
          ? "Confirm in your wallet"
          : run.phase === "pending"
            ? "Launching…"
            : preparing
              ? "Preparing…"
              : cannotAfford
                ? "Not enough to cover this launch"
                : buying
                  ? `Launch ${symbol} and buy ${initialBuy} ${quoteLabel}`
                  : `Launch ${symbol}`}
      </button>

      {/* Named amounts rather than "insufficient funds", because the creator chose one of
          these numbers and can change it: the first buy is a field on this form, and a
          launch with no first buy costs only gas. */}
      {shortfall === null ? null : (
        <div className="mt-3 rounded-xl border border-fall/40 bg-fall/14 px-4 py-3 text-[0.78rem] leading-relaxed text-ink-muted">
          <p className="font-medium text-ink">This wallet cannot cover the launch.</p>
          <p className="mt-1">
            It holds {formatEther(shortfall.held)} ETH.{" "}
            {funds.data === undefined || funds.data.value === 0n
              ? "The launch needs enough to pay for gas."
              : `The first buy alone spends ${formatEther(funds.data.value)} ETH`}
            {shortfall.gas === null
              ? funds.data !== undefined && funds.data.value > 0n
                ? ", before gas."
                : ""
              : `, and gas is about ${formatEther(shortfall.gas)} ETH.`}
          </p>
          <p className="mt-1.5">
            Lower the first buy, or fund this wallet with at least{" "}
            {formatEther(shortfall.needed - shortfall.held)} ETH more.
          </p>
        </div>
      )}

      {shortOfQuote === null ? null : (
        <div className="mt-3 rounded-xl border border-fall/40 bg-fall/14 px-4 py-3 text-[0.78rem] leading-relaxed text-ink-muted">
          <p className="font-medium text-ink">
            This wallet does not hold enough {quoteLabel}.
          </p>
          <p className="mt-1">
            The first buy spends {initialBuy} {quoteLabel} and the wallet holds{" "}
            {formatUnits(shortOfQuote.held, quoteDecimals)} {quoteLabel}.
          </p>
        </div>
      )}

      {miningProblem === undefined ? null : (
        <p className="mt-3 rounded-xl border border-fall/40 bg-fall/14 px-4 py-3 text-[0.78rem] leading-relaxed text-ink-muted">
          The token&apos;s address could not be worked out: {miningProblem} Without it there
          is no salt to launch under, and for a market quoted in {quoteLabel} the launch
          would be rejected.
        </p>
      )}

      <TransactionNote
        run={run}
        pending={
          buying
            ? "Creating the token, the pool and the locked position, and buying"
            : "Creating the token, the pool and the locked position"
        }
        confirmed={buying ? "The market exists and you hold the first of it." : "The market exists."}
      />

      <p className="mt-3 text-[0.7rem] leading-relaxed text-ink-muted">
        {buying ? (
          <>
            One transaction creates the token, the pool, the locked position and the fee
            splitter, and spends {initialBuy} {quoteLabel} on your first buy. The buy is
            part of the launch rather than a trade afterwards, so nobody can take the
            opening price ahead of you.
          </>
        ) : (
          <>
            One transaction creates the token, the pool, the locked position and the fee
            splitter. With no first buy the pool opens holding only {symbol}, and whoever
            trades first takes the opening price.
          </>
        )}
      </p>
    </div>
  );
}

/**
 * What happened, in the past tense, with the amount the chain reported.
 *
 * `bought` is summed from the token's own `Transfer` logs rather than from the form's
 * estimate, so it includes a creator allocation that was delivered outright and excludes
 * one that went to a vesting wallet — which is the same thing as saying it is what the
 * wallet now holds, and it is the number a creator will check against their balance.
 */
function MarketCreated({
  poolId,
  token,
  bought,
  initialBuy,
  quoteLabel,
  symbol,
}: {
  readonly poolId: Hex;
  readonly token: Address;
  readonly bought: bigint;
  readonly initialBuy: string;
  readonly quoteLabel: string;
  readonly symbol: string;
}) {
  const amount = initialBuy.trim();
  const spent = amount === "" ? "0" : amount;
  const bought_ = bought === 0n ? null : formatUnits(bought, 18);

  return (
    <div>
      <div className="rounded-xl border border-accent-ring/40 bg-accent-soft px-4 py-3">
        <p className="text-[0.85rem] font-semibold text-accent-strong">
          {bought_ === null ? "Market created" : "Market created, and bought"}
        </p>
        <p className="mt-1 text-[0.75rem] leading-relaxed text-ink-muted">
          The token is at <AddressLink address={token} />. Its pool is open and anyone may
          trade it from now on.
          {bought_ === null ? null : (
            <>
              {" "}
              You spent {spent} {quoteLabel} and hold{" "}
              <span className="font-medium text-ink">
                {Number(bought_).toLocaleString(undefined, { maximumFractionDigits: 0 })}{" "}
                {symbol}
              </span>
              .
            </>
          )}
        </p>
      </div>

      <Link
        href={`/market/${poolId}`}
        className="mt-3 inline-flex h-12 w-full items-center justify-center rounded-full bg-ink px-6 text-[0.95rem] font-medium text-ink-inverse shadow-card transition hover:bg-ink/90 active:scale-[0.985]"
      >
        Go to the market
      </Link>

      {bought_ !== null ? null : (
        <div className="mt-3">
          <Notice title="The pool opened one-sided">
            You launched without a first buy, so the pool holds only {symbol} and no{" "}
            {quoteLabel === "ETH" ? "ether" : quoteLabel}. Whoever trades first takes the
            opening price, and it does not have to be you.
          </Notice>
        </div>
      )}

      <p className="mt-3 text-[0.7rem] leading-relaxed text-ink-muted">
        The listing shows this market once the indexer has read the block it was created
        in, which is usually a few seconds behind the chain.
      </p>
    </div>
  );
}
