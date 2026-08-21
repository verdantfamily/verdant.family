import "server-only";

/**
 * The two platform keys behind an X launch, and the only place either is unlocked.
 *
 * A launch from a reply has nobody to pay for it: the person who asked has no wallet, by
 * design, and the whole product is that they do not need one. So the platform signs and pays,
 * which makes this module the one that spends real money on behalf of strangers' words.
 *
 * ## Why two keys and not one
 *
 * The **sponsor** pays gas and submits launches. It is a hot key that signs constantly, holds
 * only gas, and should be rotatable the way any hot key should be — on a schedule, or the
 * afternoon somebody suspects it leaked.
 *
 * The **seat opener** occupies every X `CreatorSeat` until its creator claims it. Its address is
 * part of the CREATE2 derivation of every one of those seats (`seatOf(opener, label)`), and the
 * vault of every X-launched market names the resulting address immutably. So the opener is not
 * rotatable in any meaningful sense: a new one derives new seats, and the old ones can only be
 * handed over by the key that occupies them.
 *
 * Those are opposite requirements, and one key cannot satisfy both. Sharing them meant that
 * rotating the hot key silently stranded every unclaimed creator entitlement that predated the
 * rotation — the fees kept accruing to seats the platform could no longer hand over. Separating
 * them makes sponsor rotation an ordinary operation with no effect on any existing entitlement,
 * which is the point of this split.
 *
 * It costs one thing: the opener wallet needs a little gas of its own, because `offer` is
 * occupant-only and an EOA pays for what it signs. It is a few transactions a day at most.
 *
 * ## What each key will sign
 *
 * Both are pinned by destination *and* by function selector, so "the minimum needed" is a
 * property the code enforces rather than a claim in a comment.
 *
 * The sponsor may reach:
 *
 *   - `InstantFactory`, to create a market.
 *   - `CreatorSeatFactory`, to open a seat — which it may pay for without occupying, because
 *     `deploy(opener, label)` is permissionless and takes the occupant as an argument.
 *   - A genuine seat, for `collect` and `sweep` only. Both are permissionless and can only pay
 *     the current occupant, so the sponsor covering that gas cannot redirect anything.
 *   - A genuine `InstantFeeVault`, for `claimCreator` only. The same reasoning: the vault's
 *     recipient is immutable, so the call has one possible destination and it is the creator's.
 *     This is what lets somebody who launched without a wallet be paid without ever needing one.
 *
 * The opener may reach:
 *
 *   - A genuine seat, for `offer` and `withdrawOffer` only. Nothing else. Not `collect`, not
 *     `sweep`, not `renounceArbitration`, not the factory, not the Instant factory.
 *
 * There is no exported "sign this" and no caller-chosen destination for either. That is the same
 * discipline as `agents/signer.ts` and it matters more here: an agent's wallet holds its owner's
 * money, and these hold the platform's — and the opener additionally holds every unclaimed
 * creator's seat. A route handler bug that let a target through would be a drain rather than a
 * mistake.
 *
 * Neither the seat case nor the vault case can be an address list, because there is one of each
 * per creator and per market. They are proven instead — `isGenuine` on the factory and a CREATE2
 * re-derivation for a seat, a registry lookup and a re-derived pool id for a vault — which is a
 * stronger check than a list would have been, and one that cannot go stale as markets are made.
 *
 * ## What it costs
 *
 * Every send reports the gas it actually burned, and the caller meters it against the daily
 * budget. Reporting rather than checking is deliberate: this module knows what a transaction
 * cost, and only the store knows what has been spent today.
 */

import {
  createWalletClient,
  getAddress,
  http,
  isAddress,
  toFunctionSelector,
  type Address,
  type Hex,
  type TransactionReceipt,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";

import { instant as instantSdk } from "@verdant/sdk";

import { CHAIN_ID, CREATOR_SEAT_FACTORY, INSTANT_ADDRESSES, chain } from "../chain";
import { readInstantVault } from "../instant-vault";
import { publicClient } from "../onchain";
import { XError } from "./errors";

/** Where sponsored launches are allowed to happen. Not a parameter, at any level. */
export const SPONSOR_CHAIN_ID = 4663;

export interface SponsoredSend {
  readonly hash: Hex;
  readonly receipt: TransactionReceipt;
  /** What this transaction cost the platform, in wei. Metered by the caller. */
  readonly gasWei: bigint;
}

export interface SponsoredCall {
  readonly to: Address;
  readonly data: Hex;
  readonly value: bigint;
}

/**
 * Told the hash the moment it exists, before the receipt is waited for.
 *
 * The narrow window this exists for is the one that could duplicate a token. Between the node
 * accepting a transaction and this process reading its receipt, the launch is real and unknown
 * — and a process that crashes there, having recorded nothing, comes back with a mention it
 * believes was never attempted. A caller that persists the hash here can tell the difference
 * afterwards. Awaited, so a slow write still happens before the receipt wait begins; a throw
 * from it is deliberately not caught, because a caller that cannot record the hash should not
 * proceed as though it had.
 */
export type OnHash = (hash: Hex) => void | Promise<void>;

/**
 * The handover calls the opener key exists to make, and the only ones it may.
 *
 * `offer` invites a creator's wallet; `withdrawOffer` takes back an invitation that was sent to
 * the wrong address. That is the whole of what `/useagen` needs from the occupant.
 *
 * What is deliberately absent is as much of the point as what is here. `renounceArbitration` is
 * irreversible and inherited by every later occupant, so a compromised opener key must not be
 * able to permanently strip Agen's recovery path from every unclaimed seat at once. `veto` has no
 * caller in this product. `collect` and `sweep` are permissionless, so the opener has no reason
 * to hold the ability — and while it occupies a seat, they would pay *it*.
 */
const OPENER_SELECTORS: readonly Hex[] = [
  toFunctionSelector("offer(address)"),
  toFunctionSelector("withdrawOffer()"),
];

/**
 * What the sponsor may call on a seat.
 *
 * Both move money and neither can choose where: they pay the occupant, whoever that is. So the
 * sponsor covering this gas is Agen paying for a creator's withdrawal, not Agen touching it.
 */
const SPONSOR_SEAT_SELECTORS: readonly Hex[] = [
  toFunctionSelector("collect(address)"),
  toFunctionSelector("sweep(address)"),
];

/**
 * What the sponsor may call on a market's fee vault.
 *
 * One function, and it is the reason a walletless launch is walletless after the launch too.
 * `claimCreator` pays `InstantFeeVault.creator`, which the factory fixed when the market was
 * created and nothing can change — so this call cannot be aimed. Whoever sends it, the money
 * goes to the address the creator named, and Agen covering the gas is Agen paying for a
 * creator's withdrawal rather than touching it.
 *
 * `claimPlatform` is deliberately absent even though it is the same shape. It pays the treasury,
 * and the treasury sweeping its own revenue is `sweep.ts`'s job with its own key; a hot wallet
 * that signs for strangers' requests all day has no reason to be able to move platform income.
 */
const SPONSOR_VAULT_SELECTORS: readonly Hex[] = [toFunctionSelector("claimCreator()")];

function keyOrNull(variable: string): Hex | null {
  const raw = process.env[variable]?.trim();
  if (raw === undefined || raw === "") return null;
  const prefixed = raw.startsWith("0x") ? raw : `0x${raw}`;
  return /^0x[0-9a-fA-F]{64}$/.test(prefixed) ? (prefixed as Hex) : null;
}

/**
 * An account, or a refusal.
 *
 * Built per call rather than held in a module constant. The cost is negligible next to a
 * transaction, and the benefit is that neither key sits in a long-lived closure for the lifetime
 * of the process, reachable from anything that can read a module's scope.
 */
function accountFor(variable: string, purpose: string): PrivateKeyAccount {
  const key = keyOrNull(variable);
  if (key === null) {
    throw new XError(
      "CONFIG_MISSING",
      `${variable} is not set or is not a private key, so ${purpose}.`,
    );
  }
  return privateKeyToAccount(key);
}

/**
 * Check a stated address against the key it claims to be.
 *
 * A mismatch is either a copy-paste error or a rotation done halfway, and for the opener both
 * end somewhere unrecoverable: seats derived from an address that cannot sign for them. So it
 * fails here rather than at the first handover a creator attempts.
 */
function assertStatedAddress(variable: string, derived: Address): void {
  const configured = process.env[variable]?.trim();
  if (configured === undefined || configured === "") return;
  if (!isAddress(configured, { strict: false })) {
    throw new XError("CONFIG_MISSING", `${variable} is not an address.`);
  }
  if (getAddress(configured).toLowerCase() !== derived.toLowerCase()) {
    throw new XError("CONFIG_MISSING", `${variable} is not the address of its private key.`);
  }
}

/**
 * The sponsor's address: the wallet that pays for launches.
 *
 * Public information and needed in a few places — it is the `msg.sender` a token's salt is mined
 * against, and the balance an operator watches. Derived from the key rather than configured
 * beside it, so the two cannot disagree.
 *
 * Note what it is *not*: it is no longer the seat opener, and nothing about a creator's
 * entitlement depends on it. That is what makes it rotatable.
 */
export function sponsorAddress(): Address {
  const derived = accountFor("X_SPONSOR_PRIVATE_KEY", "launches cannot be paid for").address;
  assertStatedAddress("X_SPONSOR_ADDRESS", derived);
  return derived;
}

/**
 * The seat opener's address: the initial occupant of every X creator seat.
 *
 * Part of the CREATE2 derivation of every seat this feature has ever named, and therefore
 * effectively permanent. Changing it does not migrate anything — it starts a second population of
 * seats and leaves the first reachable only through the old key.
 */
export function seatOpenerAddress(): Address {
  const derived = accountFor(
    "X_CREATOR_SEAT_OPENER_PRIVATE_KEY",
    "creator seats have no occupant and could never be handed over",
  ).address;
  assertStatedAddress("X_CREATOR_SEAT_OPENER_ADDRESS", derived);
  return derived;
}

/** Whether this deployment could sponsor a launch at all, and what is missing if not. */
export function sponsorProblems(): readonly string[] {
  const problems: string[] = [];

  if (keyOrNull("X_SPONSOR_PRIVATE_KEY") === null) {
    problems.push("X_SPONSOR_PRIVATE_KEY is not set, so no launch can be paid for.");
  }
  if (keyOrNull("X_CREATOR_SEAT_OPENER_PRIVATE_KEY") === null) {
    problems.push(
      "X_CREATOR_SEAT_OPENER_PRIVATE_KEY is not set, so creator seats would have no occupant " +
        "able to hand them over.",
    );
  }

  // Two keys that are the same key is the configuration this split exists to prevent, and it
  // would work perfectly until the day the sponsor was rotated — at which point every unclaimed
  // entitlement older than the rotation becomes unreachable. Refused up front, where it is
  // cheap, rather than discovered later, where it is not fixable.
  if (
    keyOrNull("X_SPONSOR_PRIVATE_KEY") !== null &&
    keyOrNull("X_CREATOR_SEAT_OPENER_PRIVATE_KEY") !== null &&
    sponsorAddress().toLowerCase() === seatOpenerAddress().toLowerCase()
  ) {
    problems.push(
      "X_SPONSOR_PRIVATE_KEY and X_CREATOR_SEAT_OPENER_PRIVATE_KEY are the same key. They must " +
        "differ, or rotating the sponsor would strand every unclaimed creator entitlement.",
    );
  }

  if (INSTANT_ADDRESSES === null) {
    problems.push("Instant is not configured on this deployment, so there is no factory to call.");
  }
  if (CREATOR_SEAT_FACTORY === null) {
    problems.push(
      "CREATOR_SEAT_FACTORY is not deployed or not configured, so creator fees would have " +
        "nowhere claimable to accrue.",
    );
  }
  if (CHAIN_ID !== SPONSOR_CHAIN_ID) {
    problems.push(
      `Sponsored launches are restricted to chain ${String(SPONSOR_CHAIN_ID)}; this process is on ${String(CHAIN_ID)}.`,
    );
  }

  return problems;
}

/** Whether the two platform keys are configured and distinct. Read by the status endpoint. */
export function keySeparation(): {
  readonly sponsor: boolean;
  readonly seatOpener: boolean;
  readonly separated: boolean;
} {
  const sponsor = keyOrNull("X_SPONSOR_PRIVATE_KEY") !== null;
  const seatOpener = keyOrNull("X_CREATOR_SEAT_OPENER_PRIVATE_KEY") !== null;

  return {
    sponsor,
    seatOpener,
    separated:
      sponsor &&
      seatOpener &&
      sponsorAddress().toLowerCase() !== seatOpenerAddress().toLowerCase(),
  };
}

function assertChain(): void {
  if (CHAIN_ID !== SPONSOR_CHAIN_ID || chain.id !== SPONSOR_CHAIN_ID) {
    throw new XError(
      "WRONG_CHAIN",
      `Sponsored launches are restricted to chain ${String(SPONSOR_CHAIN_ID)}.`,
      { details: { required: SPONSOR_CHAIN_ID, actual: CHAIN_ID } },
    );
  }
}

/** The two contracts a sponsored call may target without further proof. */
function staticTargets(): readonly Address[] {
  const found: Address[] = [];
  if (INSTANT_ADDRESSES !== null) found.push(INSTANT_ADDRESSES.factory);
  if (CREATOR_SEAT_FACTORY !== null) found.push(CREATOR_SEAT_FACTORY);
  return found;
}

/**
 * Refuse calldata that is not one of the functions this key exists to call.
 *
 * The check that turns "the opener is only authorised for handovers" from an intention into a
 * property. A caller that builds the wrong call against the right address gets a refusal rather
 * than a signature.
 */
function assertSelector(data: Hex, allowed: readonly Hex[], who: string): void {
  const selector = data.slice(0, 10).toLowerCase() as Hex;
  if (!allowed.some((entry) => entry.toLowerCase() === selector)) {
    throw new XError("UNAPPROVED_TARGET", `The ${who} key may not make that call.`, {
      details: { selector, allowed },
    });
  }
}

/**
 * Prove an address is a seat this platform's opener derives.
 *
 * Checked against the *opener*, never the sponsor: the opener is what the derivation is a
 * function of, and asking about the sponsor would reject every genuine seat.
 */
async function assertGenuineSeat(seat: Address, label: Hex): Promise<void> {
  const seatFactory = CREATOR_SEAT_FACTORY;
  if (seatFactory === null) {
    throw new XError("CONFIG_MISSING", "No CreatorSeat factory is configured.");
  }

  const genuine = await instantSdk.readSeatIsGenuine(publicClient(), {
    seatFactory,
    opener: seatOpenerAddress(),
    label,
    seat,
  });

  if (!genuine) {
    throw new XError("SEAT_MISMATCH", "That address is not a seat this platform opened.", {
      details: { seat },
    });
  }
}

/**
 * Send a call to the Instant factory or the seat factory, paid by the sponsor.
 *
 * Anything else throws, including a seat: a seat address has to be proven rather than allowed.
 */
export async function sendSponsored(
  call: SponsoredCall,
  onHash?: OnHash,
): Promise<SponsoredSend> {
  assertChain();

  const allowed = new Set(staticTargets().map((address) => address.toLowerCase()));
  if (!allowed.has(call.to.toLowerCase())) {
    throw new XError(
      "UNAPPROVED_TARGET",
      "The sponsor wallet may only call the Instant factory and the seat factory.",
      { details: { requested: call.to } },
    );
  }

  return signAndSend(accountFor("X_SPONSOR_PRIVATE_KEY", "launches cannot be paid for"), call, onHash);
}

/**
 * Collect or sweep a seat, at the platform's expense, having proved the seat is ours.
 *
 * Signed by the sponsor rather than the opener, and that is the right way round: these functions
 * pay the seat's current occupant and cannot be aimed anywhere, so the key that signs them needs
 * no authority over the seat — only gas. The opener stays reserved for the handover.
 */
export async function sendSponsoredToSeat(
  { seat, label }: { readonly seat: Address; readonly label: Hex },
  call: SponsoredCall,
): Promise<SponsoredSend> {
  assertChain();

  if (call.to.toLowerCase() !== seat.toLowerCase()) {
    throw new XError("UNAPPROVED_TARGET", "That call does not target the seat it was checked for.", {
      details: { requested: call.to, seat },
    });
  }
  assertSelector(call.data, SPONSOR_SEAT_SELECTORS, "sponsor");
  await assertGenuineSeat(seat, label);

  return signAndSend(
    accountFor("X_SPONSOR_PRIVATE_KEY", "launches cannot be paid for"),
    call,
    undefined,
  );
}

/**
 * Pay a market's creator what their vault owes them, at the platform's expense.
 *
 * The other half of a walletless launch. Somebody who launched with no wallet named an address
 * for their fees and has no way to send a transaction; this is how the fees get there without
 * one. Safe to expose because the destination is immutable and this call cannot choose it — the
 * only thing a caller decides is *when*, and the only thing it can waste is Agen's gas, which is
 * what the caller's own limits are for.
 *
 * The target is *derived*, not accepted. A caller names a token and `readInstantVault` reads the
 * registry, so a request cannot point this key at a contract of its own choosing. That matters
 * more than it looks: `claimCreator` cannot move the sponsor's money, but an attacker's contract
 * with a function of that name could burn nine million gas per call, and gas is the only thing
 * this wallet holds. The calldata is built from the proven address rather than checked against it,
 * which is why the argument is a function.
 */
export async function sendSponsoredToVault(
  { token }: { readonly token: Address },
  build: (vault: Address) => SponsoredCall,
): Promise<SponsoredSend & { readonly vault: Address }> {
  assertChain();

  const vault = await readInstantVault(token);
  const call = build(vault);

  if (call.to.toLowerCase() !== vault.toLowerCase()) {
    throw new XError("UNAPPROVED_TARGET", "That call does not target the vault it was proven for.", {
      details: { requested: call.to, vault },
    });
  }
  assertSelector(call.data, SPONSOR_VAULT_SELECTORS, "sponsor");

  const sent = await signAndSend(
    accountFor("X_SPONSOR_PRIVATE_KEY", "launches cannot be paid for"),
    call,
    undefined,
  );

  return { ...sent, vault };
}

/**
 * Offer or withdraw an offer on a seat, signed by its occupant.
 *
 * The only function in this module that unlocks the opener key, and the only calls it will make.
 * `offer` is occupant-only on the contract, so this cannot be delegated to the sponsor no matter
 * how convenient that would be operationally.
 */
export async function sendAsSeatOpener(
  { seat, label }: { readonly seat: Address; readonly label: Hex },
  call: SponsoredCall,
): Promise<SponsoredSend> {
  assertChain();

  if (call.to.toLowerCase() !== seat.toLowerCase()) {
    throw new XError("UNAPPROVED_TARGET", "That call does not target the seat it was checked for.", {
      details: { requested: call.to, seat },
    });
  }
  assertSelector(call.data, OPENER_SELECTORS, "seat opener");
  await assertGenuineSeat(seat, label);

  // The one cost of separating the keys, made into a clear error rather than a bare revert. A
  // creator pressing claim on a deployment whose opener wallet was never funded should be told the
  // platform is not ready — it is retryable, and the fix is an operator's rather than theirs.
  const client = publicClient();
  const [gas, gasPrice] = await Promise.all([
    client.estimateGas({ account: seatOpenerAddress(), to: call.to, data: call.data, value: call.value }),
    client.getGasPrice(),
  ]);
  await assertSeatOpenerFunded(gas * gasPrice);

  return signAndSend(
    accountFor(
      "X_CREATOR_SEAT_OPENER_PRIVATE_KEY",
      "creator seats have no occupant and could never be handed over",
    ),
    call,
    undefined,
  );
}

/**
 * Refuse to start a launch the wallet cannot finish paying for.
 *
 * Checked before the first of a launch's transactions rather than discovered between them.
 * Running out halfway is the worst available outcome: a seat deployed and no market, or worse
 * a market created and no reply, both of which cost money and leave a person with nothing.
 */
export async function assertSponsorFunded(estimateWei: bigint): Promise<bigint> {
  return assertFunded(sponsorAddress(), estimateWei, "The sponsor wallet cannot cover this launch.");
}

/**
 * The opener needs gas too, and it is worth a clear error rather than a bare revert.
 *
 * The one operational cost of separating the keys. A creator pressing claim on a deployment whose
 * opener wallet is empty should be told the platform is not ready, not shown a failed signature.
 */
export async function assertSeatOpenerFunded(estimateWei: bigint): Promise<bigint> {
  return assertFunded(
    seatOpenerAddress(),
    estimateWei,
    "The seat opener wallet has no gas, so a handover cannot be signed.",
  );
}

async function assertFunded(
  address: Address,
  estimateWei: bigint,
  message: string,
): Promise<bigint> {
  const balance = await publicClient().getBalance({ address });
  if (balance < estimateWei) {
    throw new XError("SPONSOR_UNFUNDED", message, {
      retryable: true,
      details: { address, balanceWei: balance.toString(), neededWei: estimateWei.toString() },
    });
  }
  return balance;
}

async function signAndSend(
  account: PrivateKeyAccount,
  call: SponsoredCall,
  onHash: OnHash | undefined,
): Promise<SponsoredSend> {
  const wallet = createWalletClient({ account, chain, transport: http() });

  const hash = await wallet.sendTransaction({
    to: call.to,
    data: call.data,
    value: call.value,
    chain,
  });

  if (onHash !== undefined) await onHash(hash);

  const receipt = await publicClient().waitForTransactionReceipt({ hash });
  const gasWei = receipt.gasUsed * receipt.effectiveGasPrice;

  if (receipt.status !== "success") {
    // The gas is spent either way, so it is reported on the error rather than lost: a reverted
    // launch still drew down the day's budget and the ledger has to hear about it.
    throw new XError("LAUNCH_REVERTED", "The sponsored transaction reverted.", {
      details: { hash, gasWei: gasWei.toString() },
    });
  }

  return { hash, receipt, gasWei };
}
