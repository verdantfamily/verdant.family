"use client";

/**
 * Agen Boost, on a token's own page.
 *
 * Two audiences, one card. A holder wants to know whether the creator's fees are buying the
 * token back and how much has gone to the dead address; the creator wants the switch. So the
 * numbers are always shown when Boost is or has been on, and the switch appears only for the
 * wallet that owns the escrow.
 *
 * ## Why the card can be absent entirely
 *
 * A market is Boost-capable only if it named a `BoostEscrow` as its fee recipient at launch,
 * and `InstantFeeVault.creator` is immutable — so a market that named a wallet can never be
 * Boosted, and every market that predates Boost is in that category. There is nothing useful
 * to render for those, and a disabled switch would imply the opposite of the truth, so the
 * card returns null.
 *
 * ## What is read live and what is not
 *
 * Everything. The escrow's `boostStateOf` is one call returning the whole card, and it is
 * re-read after each action rather than optimistically updated: the amounts move when anybody
 * trades, so a locally-guessed number would be wrong within seconds of being shown.
 */

import { useCallback, useEffect, useState } from "react";
import { formatEther, type Address } from "viem";
import { useAccount, usePublicClient, useSendTransaction, useWaitForTransactionReceipt } from "wagmi";

import { instant as instantSdk } from "@verdant/sdk";

import { BOOST_ADDRESSES, EXPLORER_URL, shortAddress } from "../../lib/chain";
import {
  BOOST_PROMISE,
  BOOST_SINK_NOTE,
  agenContributionNote,
  boostBreakdown,
  boostCapabilityOf,
  boostCommitment,
  boostStatusLabel,
  boostTotalLine,
  lastBoostLabel,
  nextBoostLabel,
  queuedForBoost,
  sunkPercent,
  type BoostState,
} from "../../lib/boost";
import { tokens } from "../../lib/format";
import { INSTANT_SUPPLY_TOKENS } from "../../lib/instant";

type Pending = "enable" | "disable" | "lock" | null;

/**
 * Resolves whether this market can be Boosted at all, then renders the card or nothing.
 *
 * Capability is a chain question — is the vault's immutable recipient a genuine escrow for this
 * creator — so it is asked here rather than on the server. That keeps every Boost read in one
 * client component and means a page for a market without Boost does no Boost work at all.
 */
export function BoostCard({
  token,
  symbol,
  vault,
  creator,
}: {
  readonly token: Address | null;
  readonly symbol: string;
  /** The market's `InstantFeeVault`, which is the authority on who gets paid. */
  readonly vault: Address | null;
  /** Whoever launched the market. The escrow, if there is one, is derived from this. */
  readonly creator: Address | null;
}) {
  const client = usePublicClient();
  const [escrow, setEscrow] = useState<Address | null>(null);

  useEffect(() => {
    if (client === undefined || BOOST_ADDRESSES === null) return;
    if (token === null || vault === null || creator === null) return;

    let live = true;
    void (async () => {
      const capable = await boostCapabilityOf(client, { vault, creator });
      if (live) setEscrow(capable?.escrow ?? null);
    })();

    return () => {
      live = false;
    };
  }, [client, token, vault, creator]);

  if (BOOST_ADDRESSES === null || escrow === null || token === null || creator === null) return null;

  return <BoostPanel token={token} symbol={symbol} escrow={escrow} owner={creator} />;
}

function BoostPanel({
  token,
  symbol,
  escrow,
  owner,
}: {
  readonly token: Address;
  readonly symbol: string;
  readonly escrow: Address;
  /**
   * Who may throw the switch.
   *
   * The escrow's `owner` immutable, which is the address the escrow was derived from — so
   * establishing that the escrow is genuine has already established this, and the panel takes
   * it rather than making another call. The contract is the real authority: a wallet that is
   * not the owner has its `enableBoost` reverted with `NotOwner`, so this only decides whether
   * a button is drawn.
   */
  readonly owner: Address;
}) {
  const { address } = useAccount();
  const client = usePublicClient();
  const send = useSendTransaction();
  const receipt = useWaitForTransactionReceipt({ hash: send.data });

  const [state, setState] = useState<BoostState | null>(null);
  const [pending, setPending] = useState<Pending>(null);
  const [confirmingLock, setConfirmingLock] = useState(false);

  const read = useCallback(async () => {
    if (client === undefined) return;
    try {
      setState(await instantSdk.readBoostState(client, { escrow, token }));
    } catch {
      // Leave whatever was last shown rather than blanking the card on one failed poll.
    }
  }, [client, escrow, token]);

  useEffect(() => {
    void read();
  }, [read]);

  // Re-read once a transaction has actually landed, not when it was sent.
  useEffect(() => {
    if (!receipt.isSuccess) return;
    setPending(null);
    setConfirmingLock(false);
    void read();
  }, [receipt.isSuccess, read]);

  const act = useCallback(
    (which: Exclude<Pending, null>) => {
      const build =
        which === "enable"
          ? instantSdk.buildEnableBoost
          : which === "disable"
            ? instantSdk.buildDisableBoost
            : instantSdk.buildLockBoostForever;

      const call = build({ escrow, token });
      setPending(which);
      send.sendTransaction({ to: call.to, data: call.data, value: call.value });
    },
    [escrow, token, send],
  );

  // Nothing is known yet. An empty slot is better than a skeleton for a card that is often
  // simply off. Note that `enrolled: false` is *not* a reason to hide it: enrolment happens
  // inside `enableBoost`, so an untouched Boost-capable market reports false and still needs
  // its switch.
  if (state === null) return null;

  const isOwner = address !== undefined && address.toLowerCase() === owner.toLowerCase();
  const showNumbers = state.enabled || state.locked || state.pending > 0n || state.sunk > 0n;
  const waiting = send.isPending || receipt.isLoading;

  /*
   * The supply, from the factory's constant rather than from a call.
   *
   * `InstantFactory.SUPPLY` is fixed at a billion whole tokens for every Instant market, so
   * reading `totalSupply()` would spend a round trip to be told a number this build already
   * knows — and knows is right, because the token has no mint and no burn. That second fact is
   * also why the share below is of a supply that never moves: tokens at the dead address leave
   * circulation without leaving the total.
   */
  const sunkShare = sunkPercent({
    totalSupply: INSTANT_SUPPLY_TOKENS * 10n ** 18n,
    deadBalance: state.deadBalance,
  });

  return (
    <section className="ax-boost">
      <div className="ax-boost-head">
        <p className="ax-tk-label">Agen Boost</p>

        {state.locked ? (
          <span className="ax-boost-lock">BOOST LOCKED</span>
        ) : (
          <span className={state.enabled ? "ax-boost-pill ax-boost-on" : "ax-boost-pill"}>
            {state.enabled ? "ON" : "OFF"}
          </span>
        )}
      </div>

      <p className="ax-boost-say">{BOOST_PROMISE}</p>

      {/*
        The number, from state rather than from a constant.

        A market whose Instant deployment routes both fee streams recycles 1.50%; one that routes
        only the creator's recycles 1.00%. Hardcoding the first would make this card lie about the
        second, which is the single mistake this feature cannot afford — so the figure is derived
        and the breakdown beneath it names who is giving up what.
      */}
      {state.enabled || state.locked ? (
        <>
          <p className="ax-boost-all">{boostTotalLine(state)}</p>

          <dl className="ax-boost-split">
            {boostBreakdown(state).map((row) => (
              <div key={row.label}>
                <dt>{row.label}</dt>
                <dd>{row.percent}</dd>
              </div>
            ))}
          </dl>
        </>
      ) : null}

      {showNumbers ? (
        <dl className="ax-boost-facts">
          <div>
            <dt>Pending Boost</dt>
            {/* Everything the next cycle will spend: the escrow's commitment, Agen's share
                waiting at the treasury, and the creator's share still in the vault. All three are
                already committed while Boost is on, so showing only the first would understate the
                queue by roughly a third on a market that routes both streams. */}
            <dd>{formatEther(queuedForBoost(state))} ETH</dd>
          </div>

          <div>
            <dt>Total bought back</dt>
            <dd>{formatEther(state.spent)} ETH</dd>
          </div>

          <div>
            <dt>Sent to dead address</dt>
            <dd>
              {tokens(Number(formatEther(state.sunk)))} ${symbol}
              {sunkShare === null ? null : <em> · {sunkShare.toFixed(3)}% of supply</em>}
            </dd>
          </div>

          <div>
            <dt>Last Boost</dt>
            <dd>{lastBoostLabel(state)}</dd>
          </div>

          <div>
            <dt>Next Boost</dt>
            <dd>{nextBoostLabel(state)}</dd>
          </div>

          <div>
            <dt>Status</dt>
            <dd>{boostStatusLabel(state)}</dd>
          </div>
        </dl>
      ) : null}

      {/*
        The switch, for the escrow's owner only.

        `enableBoost` enrols the market if it has to, so this is one signature whether or not
        the market has ever been attached. `disableBoost` settles before it flips, which is why
        the note beneath says what it says: a creator cannot switch off to recover fees that
        were earned while Boost was on.
      */}
      {isOwner ? (
        <div className="ax-boost-do">
          {state.locked ? (
            <p className="ax-boost-note">
              Boost is permanently on for this market. It cannot be switched off by anyone,
              including Agen.
            </p>
          ) : state.enabled ? (
            <>
              <button type="button" className="ax-boost-off" disabled={waiting} onClick={() => { act("disable"); }}>
                {pending === "disable" && waiting ? "switching off…" : "Turn Boost off"}
              </button>

              {confirmingLock ? (
                <button type="button" className="ax-boost-lockgo" disabled={waiting} onClick={() => { act("lock"); }}>
                  {pending === "lock" && waiting ? "locking…" : `Yes — lock $${symbol} Boost forever`}
                </button>
              ) : (
                <button
                  type="button"
                  className="ax-boost-lockask"
                  disabled={waiting}
                  onClick={() => { setConfirmingLock(true); }}
                >
                  Lock Boost forever
                </button>
              )}

              <p className="ax-boost-note">
                Turning Boost off keeps whatever your fees have already committed — those still
                buy back. Only fees earned after you switch off come back to you. Locking cannot
                be undone by anyone, ever.
              </p>
            </>
          ) : (
            <>
              <button type="button" className="ax-boost-on-go" disabled={waiting} onClick={() => { act("enable"); }}>
                {pending === "enable" && waiting ? "switching on…" : "Turn Boost on"}
              </button>

              <p className="ax-boost-note">
                {boostCommitment(state)} Fees you have already earned stay yours and remain
                claimable on your profile.
              </p>
            </>
          )}

          {send.error !== null && !isRejection(send.error) ? (
            <p className="ax-boost-note ax-boost-bad">{send.error.message}</p>
          ) : null}
        </div>
      ) : null}

      <p className="ax-boost-fine">
        {BOOST_SINK_NOTE} {agenContributionNote(state)}
      </p>

      {EXPLORER_URL === undefined ? null : (
        <p className="ax-boost-away">
          <a href={`${EXPLORER_URL}/address/${escrow}`} target="_blank" rel="noreferrer">
            escrow {shortAddress(escrow)}
          </a>
          <a
            href={`${EXPLORER_URL}/address/${BOOST_ADDRESSES?.deadAddress ?? ""}?tab=tokens`}
            target="_blank"
            rel="noreferrer"
          >
            dead address
          </a>
        </p>
      )}
    </section>
  );
}

/** A declined request is not an error worth reporting: they did it a second ago. */
function isRejection(error: Error): boolean {
  return /user rejected|user denied|rejected the request/i.test(error.message);
}
