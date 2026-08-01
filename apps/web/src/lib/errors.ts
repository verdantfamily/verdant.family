/**
 * Turning what a wallet or a node threw into a sentence.
 *
 * Every write path in this app funnels its failures through here, because the raw
 * material is unusable: viem wraps a revert in three or four nested errors whose
 * combined `message` runs to twenty lines of ABI, request body and version footer,
 * and a wallet's own rejection arrives as an object whose only useful field is a
 * numeric code. Rendering either verbatim tells a reader nothing and looks broken.
 *
 * The rule this file follows is that it never invents a cause. If the chain said why,
 * that is what is shown; if it did not, the message says that a transaction failed and
 * stops, rather than guessing at a reason that would be believed.
 */

import { abi } from "@verdant/sdk";
import {
  BaseError,
  ContractFunctionRevertedError,
  UserRejectedRequestError,
  decodeErrorResult,
  type Abi,
  type Hex,
} from "viem";

/**
 * The ABIs a revert from a Verdant write path could be declared in.
 *
 * Custom errors are four bytes of selector on the wire, so naming one means having
 * the ABI that declares it. These four are the contracts a launch or a swap actually
 * calls into: the factory refuses a launch, the hook refuses a pool it does not own,
 * an ERC-20 refuses a transfer, and Permit2 refuses an expired approval.
 */
const KNOWN_ABIS: readonly Abi[] = [
  abi.verdantFactoryAbi as unknown as Abi,
  abi.verdantHookAbi as unknown as Abi,
  abi.verdantTokenAbi as unknown as Abi,
  abi.permit2Abi as unknown as Abi,
];

/** Whether the person declined in their wallet, which is not a failure to report. */
export function isUserRejection(error: unknown): boolean {
  if (error instanceof UserRejectedRequestError) return true;
  if (!(error instanceof BaseError)) return false;
  return error.walk((cause) => cause instanceof UserRejectedRequestError) !== null;
}

/**
 * A custom error's name and arguments, if the revert data matches something we know.
 *
 * Returns `null` rather than a placeholder when nothing matches, because an
 * unrecognised selector means the revert came from a contract this build does not
 * have the ABI for — and a made-up name would be worse than an honest silence.
 */
function nameRevert(data: Hex): string | null {
  for (const candidate of KNOWN_ABIS) {
    try {
      const decoded = decodeErrorResult({ abi: candidate, data });
      const args = decoded.args ?? [];
      return args.length === 0
        ? decoded.errorName
        : `${decoded.errorName}(${args.map((argument) => String(argument)).join(", ")})`;
    } catch {
      // This ABI does not declare that selector. Try the next.
    }
  }
  return null;
}

/**
 * The raw revert bytes carried somewhere in a viem error chain.
 *
 * Reached for only when viem has not already decoded the revert itself, which is the
 * usual case here: this app sends most of its transactions as calldata built by the
 * SDK, so viem has no ABI to decode against and passes the four selector bytes
 * through as an opaque `data` field on whichever error was innermost.
 */
function revertData(error: BaseError): Hex | null {
  const carrier = error.walk((cause) => {
    const { data } = cause as { data?: unknown };
    return typeof data === "string" && data.startsWith("0x");
  }) as { data?: unknown } | null;

  return carrier !== null && typeof carrier.data === "string" ? (carrier.data as Hex) : null;
}

/**
 * One sentence a reader can act on.
 *
 * The order is deliberate: a rejection is not an error and is said so first, then a
 * named revert, then viem's own short message, and only then the raw text. Each step
 * down is a step further from something the reader can do anything about.
 */
export function describeError(error: unknown): string {
  if (error === null || error === undefined) return "The transaction failed.";

  if (isUserRejection(error)) return "You declined the request in your wallet.";

  if (error instanceof BaseError) {
    const reverted = error.walk(
      (cause) => cause instanceof ContractFunctionRevertedError,
    );
    if (reverted instanceof ContractFunctionRevertedError) {
      const named = reverted.data?.errorName ?? reverted.reason;
      if (named !== undefined && named !== "") return `The contract refused: ${named}.`;
    }

    const data = revertData(error);
    if (data !== null && data !== "0x") {
      const named = nameRevert(data);
      if (named !== null) return `The contract refused: ${named}.`;
    }

    // viem's own one-line summary, which is written for a person and is usually the
    // best available answer for the failures that are not reverts at all: no funds for
    // gas, a nonce already used, a node that would not answer.
    if (error.shortMessage !== "") return error.shortMessage;
  }

  if (error instanceof Error && error.message !== "") return error.message;
  return "The transaction failed.";
}
