"use client";

import type { Address, Hex, TransactionReceipt } from "viem";
import { useCallback, useState } from "react";
import { useConnection, usePublicClient, useSendTransaction } from "wagmi";

import { CHAIN_ID, EXPLORER_URL, type AddressProblem } from "../lib/chain";
import { describeError, isUserRejection } from "../lib/errors";
import { Notice } from "./primitives";

/**
 * One transaction, as a state machine.
 *
 * Both write paths in this app — a launch and a swap — send unsigned calls the SDK
 * built, so both need the same six states and the same honesty about which one they
 * are in. Sharing the machine rather than the rendering is deliberate: a launch and a
 * swap say very different things at each stage, but they must not be able to *disagree*
 * about what "confirmed" means.
 *
 * The states, and what each is true of:
 *
 *  - `idle` — nothing has been sent.
 *  - `signing` — the wallet has been asked and has not answered. Cancellable by the
 *    reader, and a cancellation returns here rather than to a failure.
 *  - `pending` — a hash exists and the chain has not included it yet.
 *  - `confirmed` — mined, with a receipt whose status is success.
 *  - `reverted` — mined, and the chain rejected it. A distinct state from `failed`
 *    because gas was spent and there is a transaction to look at.
 *  - `failed` — never mined: the wallet refused, the node refused, or the pre-flight
 *    found a revert before anything was signed.
 */
export type TransactionPhase =
  | "idle"
  | "signing"
  | "pending"
  | "confirmed"
  | "reverted"
  | "failed";

export interface UnsignedCall {
  readonly to: Address;
  readonly data: Hex;
  readonly value: bigint;
}

export interface TransactionRun {
  readonly phase: TransactionPhase;
  readonly hash: Hex | undefined;
  readonly receipt: TransactionReceipt | undefined;
  /** A sentence, already written for a person. `undefined` unless something went wrong. */
  readonly problem: string | undefined;
  readonly busy: boolean;
  /** Resolves to the receipt, or to `null` if the transaction never landed. */
  send: (call: UnsignedCall) => Promise<TransactionReceipt | null>;
  reset: () => void;
}

/**
 * Send a call and follow it to a receipt.
 *
 * ## Why there is a pre-flight
 *
 * Because a wallet's own simulation failure is unreadable. Left to itself, a launch
 * that violates a bound reaches the wallet, which reports "this transaction is likely
 * to fail" and offers to send it anyway — and if the reader accepts, they pay for a
 * revert whose reason is four bytes in a trace. So the call is made against the node
 * first, from the reader's own address, and a revert there is decoded and named before
 * a wallet is ever opened. The same round trip yields the gas limit the wallet is then
 * handed, for the reason `send` gives where it asks for it.
 */
interface RunState {
  readonly phase: TransactionPhase;
  readonly hash?: Hex | undefined;
  readonly receipt?: TransactionReceipt | undefined;
  readonly problem?: string | undefined;
}

const IDLE: RunState = { phase: "idle" };

export function useTransaction(): TransactionRun {
  const client = usePublicClient();
  const { address } = useConnection();
  const { sendTransactionAsync } = useSendTransaction();
  const [state, setState] = useState<RunState>(IDLE);

  const reset = useCallback(() => setState(IDLE), []);

  const send = useCallback(
    async (call: UnsignedCall): Promise<TransactionReceipt | null> => {
      if (client === undefined) {
        setState({
          phase: "failed",
          problem: "This page has no connection to the chain to send through.",
        });
        return null;
      }

      setState({ phase: "signing" });

      try {
        // Made against the node before a wallet is opened, so that a revert is the
        // contract's own named error rather than a gas estimate that failed. Costs one
        // `eth_call`, and turns the wallet's "this is likely to fail" into a reason.
        //
        // `account` is the whole of why this is useful. Without it the call is made
        // from the zero address, which holds no balance and has approved nothing — so
        // every swap of an ERC-20 would appear to revert and no launch would ever be
        // offered. A pre-flight from the wrong sender is worse than none.
        await client.call({
          ...(address === undefined ? {} : { account: address }),
          to: call.to,
          data: call.data,
          value: call.value,
        });

        // A limit, found here rather than left to the wallet.
        //
        // A launch is 3.5 million gas and Robinhood Chain is new enough that wallets
        // support it unevenly: one that cannot estimate on it fails at the moment of
        // signing, with no reason to show, on a transaction the chain would have
        // accepted. Estimating from the reader's own address costs one call and turns
        // that into a signature. The buffer is for the drift between this block and
        // the one that includes it; unused gas is not charged.
        const gas = await client
          .estimateGas({
            ...(address === undefined ? {} : { account: address }),
            to: call.to,
            data: call.data,
            value: call.value,
          })
          .then((estimate) => (estimate * 125n) / 100n)
          .catch(() => undefined);

        const hash = await sendTransactionAsync({
          to: call.to,
          data: call.data,
          value: call.value,
          chainId: CHAIN_ID,
          ...(gas === undefined ? {} : { gas }),
        });
        setState({ phase: "pending", hash });

        const receipt = await client.waitForTransactionReceipt({ hash });
        setState({
          phase: receipt.status === "success" ? "confirmed" : "reverted",
          hash,
          receipt,
        });
        return receipt;
      } catch (error) {
        // A declined request is not a failure to report. The reader did it deliberately
        // a moment ago, and an error panel about it reads as a malfunction — so the
        // phase returns to idle and the control is simply offered again.
        if (isUserRejection(error)) {
          setState(IDLE);
          return null;
        }
        setState({ phase: "failed", problem: describeError(error) });
        return null;
      }
    },
    [address, client, sendTransactionAsync],
  );

  return {
    phase: state.phase,
    hash: state.hash,
    receipt: state.receipt,
    problem: state.problem,
    busy: state.phase === "signing" || state.phase === "pending",
    send,
    reset,
  };
}

/**
 * What is happening, in one line under the button that started it.
 *
 * Nothing is rendered while idle, because a control that describes its own inactivity
 * is noise. Every other state gets a sentence and, once there is a hash, a link — a
 * reader who wants to know more should not have to find the transaction themselves.
 */
export function TransactionNote({
  run,
  pending,
  confirmed,
}: {
  readonly run: TransactionRun;
  /** What this particular transaction is doing, e.g. "Creating the market". */
  readonly pending: string;
  readonly confirmed: string;
}) {
  if (run.phase === "idle") return null;

  const body =
    run.phase === "signing"
      ? "Waiting for your wallet."
      : run.phase === "pending"
        ? `${pending}. This usually takes a few seconds.`
        : run.phase === "confirmed"
          ? confirmed
          : run.phase === "reverted"
            ? "The chain rejected this transaction. It was mined, so the gas was spent; nothing else changed."
            : (run.problem ?? "The transaction failed.");

  /*
   * The tint carries which of the six states this is; the sentence in it stays ink-muted
   * whichever one that is. A dark restyle is where a red sentence on a red wash becomes
   * illegible, and the state a reader most needs to be able to read is the failure.
   */
  const tone =
    run.phase === "confirmed"
      ? "border-accent-ring/40 bg-accent-soft"
      : run.phase === "reverted" || run.phase === "failed"
        ? "border-fall/40 bg-fall/14"
        : "border-border bg-surface-sunken";

  return (
    <div className={`mt-3 rounded-xl border px-4 py-3 ${tone}`}>
      <p className="text-[0.78rem] leading-relaxed text-ink-muted">{body}</p>
      {run.hash === undefined ? null : (
        <p className="mt-1.5 text-[0.72rem]">
          {EXPLORER_URL === undefined ? (
            <span className="numeric break-all text-ink-muted">{run.hash}</span>
          ) : (
            <a
              href={`${EXPLORER_URL}/tx/${run.hash}`}
              target="_blank"
              rel="noreferrer"
              className="numeric text-ink-muted underline decoration-border-strong decoration-dotted underline-offset-4 transition-colors hover:text-ink"
            >
              {run.hash.slice(0, 18)}…
            </a>
          )}
        </p>
      )}
    </div>
  );
}

/**
 * What to render instead of a button when this build does not know where Verdant is.
 *
 * `DEPLOYMENTS` in `@verdant/config` is `null` for both chains, because nothing is
 * deployed. That is the true state of the protocol and the interface says so rather
 * than offering a control that would encode a transaction to an address it does not
 * have. Naming the variables is the point: an operator running a local rig has the
 * addresses and needs to be told where to put them.
 */
export function MissingAddresses({ problems }: { readonly problems: readonly AddressProblem[] }) {
  const absent = problems.filter((problem) => problem.reason === "missing");
  const malformed = problems.filter((problem) => problem.reason === "malformed");

  return (
    <Notice tone="caution" title="Verdant is not deployed on this chain yet">
      {absent.length > 0 ? (
        <p>
          This build has no address for {list(absent.map((problem) => problem.label))}, so
          there is nothing for a launch or a swap to be sent to. Chain {CHAIN_ID} has no
          recorded deployment; set{" "}
          <span className="numeric">{absent.map((problem) => problem.variable).join(", ")}</span>{" "}
          to point this interface at one.
        </p>
      ) : null}
      {malformed.length > 0 ? (
        <p className={absent.length > 0 ? "mt-2" : undefined}>
          <span className="numeric">
            {malformed.map((problem) => problem.variable).join(", ")}
          </span>{" "}
          {malformed.length === 1 ? "is" : "are"} set but not a 20-byte hexadecimal
          address.
        </p>
      ) : null}
    </Notice>
  );
}

/** "the factory", "the factory and the hook", "the factory, the hook and the deployer". */
function list(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}
