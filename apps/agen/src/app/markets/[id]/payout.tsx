"use client";

/**
 * The button that sends a market's creator fees to its creator, paid for by Agen.
 *
 * ## Why it has no wallet in it
 *
 * The whole point. A market launched with "Launch Instant NOW" was signed and paid for by the
 * platform, and its creator may have no wallet at all — they typed an address and left. Their
 * fees accrue in the market's `InstantFeeVault` correctly and unreachably, one transaction away.
 *
 * `claimCreator` pays the vault's `creator`, which the factory fixed at creation and nothing can
 * change. So this button needs no signature, no connection and no authorisation: whoever presses
 * it, the money goes to the same address, and the only thing spent that is not the creator's is
 * Agen's gas. That is why it is a `fetch` rather than a transaction, and why it is offered to
 * everyone rather than gated on being someone.
 *
 * ## Why it can be absent
 *
 * Nothing renders until the server says there is something worth sending. A market with nothing
 * accrued, or with too little to be worth the gas, shows no card at all rather than a button that
 * explains itself after being pressed. The wallet-holding creator's own claim on `/profile` is
 * unaffected and remains the faster route for anyone who has one.
 */

import { useCallback, useEffect, useState } from "react";
import { formatEther, type Address, type Hex } from "viem";

import { EXPLORER_URL, shortAddress } from "../../lib/chain";

interface Standing {
  readonly available: boolean;
  readonly owedWei: bigint;
  /** Whether there is enough for Agen to be willing to pay the gas. */
  readonly claimable: boolean;
}

interface Sent {
  readonly recipient: Address;
  readonly amountWei: bigint;
  readonly txHash: Hex;
}

export function CreatorPayout({
  token,
  symbol,
}: {
  readonly token: Address | null;
  readonly symbol: string;
}) {
  const [standing, setStanding] = useState<Standing | null>(null);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<Sent | null>(null);
  const [error, setError] = useState<string | null>(null);

  const read = useCallback(async (): Promise<void> => {
    if (token === null) return;

    try {
      const response = await fetch(`/api/instant/payout?token=${token}`);
      if (!response.ok) return;

      const body = (await response.json()) as {
        available?: boolean;
        owedWei?: string;
        claimable?: boolean;
      };

      setStanding({
        available: body.available === true,
        owedWei: BigInt(body.owedWei ?? "0"),
        claimable: body.claimable === true,
      });
    } catch {
      // Nothing to say. A card that cannot read what is owed shows nothing, which is the same
      // as a market with nothing owed — and the difference is not one a reader could act on.
    }
  }, [token]);

  useEffect(() => {
    void read();
  }, [read]);

  const send = useCallback(async (): Promise<void> => {
    if (token === null) return;

    setError(null);
    setSending(true);

    try {
      const response = await fetch("/api/instant/payout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token }),
      });

      const body = (await response.json()) as {
        recipient?: Address;
        amountWei?: string;
        txHash?: Hex;
        error?: string;
      };

      if (!response.ok || body.recipient === undefined || body.txHash === undefined) {
        setError(body.error ?? "The fees could not be sent.");
        return;
      }

      setSent({
        recipient: body.recipient,
        amountWei: BigInt(body.amountWei ?? "0"),
        txHash: body.txHash,
      });
      // Re-read rather than assume zero: the vault is credited by every trade, so something may
      // have accrued between the claim and this line.
      await read();
    } catch {
      setError("Agen could not be reached. Nothing was moved.");
    } finally {
      setSending(false);
    }
  }, [read, token]);

  if (token === null) return null;
  if (sent === null && (standing === null || !standing.available || standing.owedWei === 0n)) {
    return null;
  }

  return (
    <section className="ax-boost">
      <div className="ax-boost-head">
        <p className="ax-tk-label">Creator fees</p>
      </div>

      {sent === null ? (
        <>
          <p className="ax-boost-all">
            {formatEther(standing?.owedWei ?? 0n)} ETH waiting for {symbol}&rsquo;s creator
          </p>

          <p className="ax-boost-note">
            {standing?.claimable === true
              ? "Agen will pay the network fee to send this to the address the creator named at " +
                "launch. That address was fixed when the market was created, so this cannot be " +
                "sent anywhere else — anyone can press it, including the creator, with no wallet."
              : "Not enough yet to be worth a transaction. It keeps accruing on every trade, and " +
                "this will work once there is more."}
          </p>

          {standing?.claimable === true ? (
            <div className="ax-boost-do">
              <button
                type="button"
                className="ax-boost-on-go"
                disabled={sending}
                onClick={() => {
                  void send();
                }}
              >
                {sending ? "sending…" : "Send fees to the creator"}
              </button>
            </div>
          ) : null}
        </>
      ) : (
        <>
          <p className="ax-boost-all">
            {formatEther(sent.amountWei)} ETH sent to {shortAddress(sent.recipient)}
          </p>
          <p className="ax-boost-note">
            Agen paid the network fee. Fees keep accruing on every trade from here.
          </p>
          {EXPLORER_URL === undefined ? null : (
            <p className="ax-boost-away">
              <a href={`${EXPLORER_URL}/tx/${sent.txHash}`} target="_blank" rel="noreferrer">
                transaction
              </a>
            </p>
          )}
        </>
      )}

      {error === null ? null : <p className="ax-boost-note ax-boost-bad">{error}</p>}
    </section>
  );
}
