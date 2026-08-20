import "server-only";

/**
 * "Launch first, account later" — the later half.
 *
 * A market launched from a reply pays a seat derived from the launcher's X id. This is where a
 * person who has since proved control of that X account, and who now has a wallet, takes it.
 *
 * ## What the claim actually is
 *
 * Two transactions, and only the first is Agen's. Agen signs `offer(wallet)` on the seat with the
 * dedicated seat-opener key — the seat's occupant, and the only key that can — which invites an
 * address and moves nothing. The wallet signs `take()`, which moves the seat. So the
 * handover cannot be completed by Agen alone, a mistyped address is an unaccepted invitation
 * rather than a redirected fee stream, and after `take` the seat is the creator's and Agen has
 * no further part in it.
 *
 * ## What is proved before the offer
 *
 * That the session holds a verified X id — OAuth, not a claim in a request body — and that the
 * seat named in Agen's own records is the one the factory derives from that id. The second check
 * is not redundant: the records are Agen's, the derivation is the chain's, and only the
 * derivation can prove the address the markets actually pay belongs to the person asking.
 *
 * ## Collecting
 *
 * `CreatorSeat.collect(vault)` is permissionless and can only pay the occupant, so Agen can
 * spend the gas on a creator's behalf — a creator with no ETH still gets their fees. The gas comes
 * from the sponsor wallet rather than the opener, precisely because this call needs no authority
 * over the seat and the opener's authority should be spent on nothing but the handover. It is
 * refused while the seat is unclaimed, and that check is the one thing standing between this
 * feature and taking a stranger's money: before the handover the occupant is Agen's opener, so
 * collecting early would sweep the creator's fees into Agen's own wallet.
 */

import { getAddress, isAddress, type Address } from "viem";

import { abi, instant as instantSdk } from "@verdant/sdk";

import { publicClient } from "../onchain";
import { readAgentHoldings } from "../agents/holdings";
import { agentStore } from "../agents/store";
import { XError } from "./errors";
import { assertSeatBelongsTo, seatFor } from "./seat";
import { seatOpenerAddress, sendAsSeatOpener, sendSponsoredToSeat, sponsorAddress } from "./sponsor";
import { xStore, type XStore } from "./store";
import { isClaimed, linkXWalletOwner } from "./wallet";
import type { XIdentity, XLaunchRecord } from "./types";

/** One market as the dashboard shows it: the record, plus what the chain says about the money. */
export interface ClaimableLaunch {
  readonly record: XLaunchRecord;
  /** Lifetime creator fees this market has generated, in wei. */
  readonly earnedWei: bigint;
  /** What is sitting in the vault unclaimed, in wei. */
  readonly claimableWei: bigint;
  /** Whether the vault really pays this launch's seat. Read from the vault, not the record. */
  readonly seated: boolean;
}

export interface SeatSummary {
  readonly seat: Address | null;
  readonly deployed: boolean;
  /** Who the seat pays right now. Agen's opener until the handover. */
  readonly beneficiary: Address | null;
  /** Who has been invited, when an offer is open. */
  readonly offered: Address | null;
  /** Whether the seat has left Agen's hands. */
  readonly claimed: boolean;
}

/**
 * The account's trading wallet, when it has one.
 *
 * `owner` is the field that matters and it is reported rather than hidden: until an address is
 * linked, nothing can withdraw from this wallet, and somebody who has funded it is entitled to
 * know that before they add more. It becomes their address the moment they claim a seat.
 */
export interface WalletSummary {
  readonly address: Address;
  readonly ethWei: bigint;
  readonly positions: readonly {
    readonly token: Address;
    readonly symbol: string;
    readonly amount: string;
  }[];
  /** The address that may withdraw, or null while none has been proved. */
  readonly owner: Address | null;
}

export interface CreatorView {
  readonly identity: XIdentity;
  readonly seat: SeatSummary;
  /** Null when this account has never traded, because a wallet is made on first use. */
  readonly wallet: WalletSummary | null;
  readonly launches: readonly ClaimableLaunch[];
  readonly totals: {
    readonly launches: number;
    readonly earnedWei: bigint;
    readonly claimableWei: bigint;
  };
}

function asWallet(value: unknown): Address {
  if (typeof value !== "string" || !isAddress(value, { strict: false })) {
    throw new XError("VALIDATION_FAILED", "That is not a wallet address.");
  }
  const wallet = getAddress(value);
  if (wallet === "0x0000000000000000000000000000000000000000") {
    throw new XError("VALIDATION_FAILED", "That is the zero address.");
  }
  // Both platform addresses, not just the one that occupies seats. Offering a seat to its own
  // occupant reverts as `AlreadySeated`, and offering it to the sponsor would hand a creator's
  // fees to the hot key that is meant to be rotatable — a claim that looks completed and pays
  // the wrong wallet. Neither is a plausible request, which is why both are refused rather than
  // handled.
  const ours = [sponsorAddress(), seatOpenerAddress()].map((address) => address.toLowerCase());
  if (ours.includes(wallet.toLowerCase())) {
    throw new XError("VALIDATION_FAILED", "That is Agen's own address.");
  }
  return wallet;
}

/**
 * Everything this X account has launched, with the money as the chain reports it.
 *
 * The fee figures are read live rather than indexed, and that is a deliberate cost. A creator
 * looking at this page is asking one question — how much is mine — and an indexer that is
 * thirty seconds behind answers it wrongly at exactly the moment somebody is deciding whether
 * to press claim. The vault is the authority, so the vault is asked.
 */
export async function creatorView(
  identity: XIdentity,
  store: XStore = xStore(),
): Promise<CreatorView> {
  const records = store.launchesByUser(identity.xUserId);
  const client = publicClient();

  const launches = await Promise.all(
    records.map(async (record): Promise<ClaimableLaunch> => {
      if (record.vault === null || record.seat === null || record.status !== "launched") {
        return { record, earnedWei: 0n, claimableWei: 0n, seated: false };
      }

      try {
        const [earned, claimable, seated] = await Promise.all([
          client.readContract({
            address: record.vault,
            abi: abi.instantFeeVaultAbi,
            functionName: "creatorAccrued",
          }),
          instantSdk.readSeatClaimable(client, { seat: record.seat, vault: record.vault }),
          instantSdk.readSeatedAt(client, { seat: record.seat, vault: record.vault }),
        ]);
        return { record, earnedWei: earned, claimableWei: claimable, seated };
      } catch {
        // A node that will not answer must not blank the whole page. Zeroes with the record
        // intact is the honest degradation: the launch is still shown, the figures are stale.
        return { record, earnedWei: 0n, claimableWei: 0n, seated: false };
      }
    }),
  );

  return {
    identity,
    seat: await seatSummary(identity),
    wallet: await walletSummary(identity.xUserId, store),
    launches,
    totals: {
      launches: records.filter((record) => record.status === "launched").length,
      earnedWei: launches.reduce((sum, entry) => sum + entry.earnedWei, 0n),
      claimableWei: launches.reduce((sum, entry) => sum + entry.claimableWei, 0n),
    },
  };
}

/**
 * This account's trading wallet, or null if it has never made one.
 *
 * Deliberately does not create one. A wallet appears when somebody asks to trade or asks for
 * their address, and making one for every visitor to the dashboard would generate keys for
 * people who never asked for an account.
 */
async function walletSummary(xUserId: string, store: XStore): Promise<WalletSummary | null> {
  const row = store.walletFor(xUserId);
  if (row === null) return null;

  const agents = agentStore();
  const agent = agents.getAgent(row.agentId);
  if (agent === null) return null;

  const holdings = await readAgentHoldings(agents, agent);
  return {
    address: row.address,
    ethWei: holdings.ethWei,
    positions: holdings.positions.map((position) => ({
      token: position.token,
      symbol: position.symbol,
      amount: position.amount,
    })),
    owner: isClaimed(agent) ? agent.ownerAddress : null,
  };
}

/** Who holds this account's seat, according to the chain. */
export async function seatSummary(identity: XIdentity): Promise<SeatSummary> {
  let derived: Awaited<ReturnType<typeof seatFor>>;
  try {
    derived = await seatFor(identity.xUserId);
  } catch {
    return { seat: null, deployed: false, beneficiary: null, offered: null, claimed: false };
  }

  if (!derived.deployed) {
    return {
      seat: derived.seat,
      deployed: false,
      beneficiary: null,
      offered: null,
      claimed: false,
    };
  }

  const state = await instantSdk.readSeatState(publicClient(), { seat: derived.seat });
  const opener = seatOpenerAddress();

  return {
    seat: derived.seat,
    deployed: true,
    beneficiary: state.beneficiary,
    offered:
      state.offered === "0x0000000000000000000000000000000000000000" ? null : state.offered,
    // Claimed means the seat has left Agen. Derived from the chain rather than from the
    // database column, because the column records what Agen did and this records what is true.
    claimed: state.beneficiary.toLowerCase() !== opener.toLowerCase(),
  };
}

export interface OfferResult {
  readonly seat: Address;
  readonly wallet: Address;
  readonly txHash: string | null;
  /** The call the wallet must send to finish the handover. */
  readonly take: { readonly to: Address; readonly data: string; readonly value: string };
  readonly alreadyClaimed: boolean;
}

/**
 * Invite a verified creator's wallet to take their seat.
 *
 * Idempotent in the way that matters: offering the same wallet twice is harmless, and a seat
 * that has already moved is reported rather than re-offered. The unsigned `take` call is handed
 * back so the interface can ask the wallet to sign it without building calldata in the browser.
 */
export async function offerSeat(
  identity: XIdentity,
  walletInput: unknown,
  store: XStore = xStore(),
): Promise<OfferResult> {
  const wallet = asWallet(walletInput);
  const derived = await seatFor(identity.xUserId);

  if (!derived.deployed) {
    throw new XError(
      "NOT_FOUND",
      "There is no seat for this account yet, which means nothing has been launched from it.",
    );
  }

  await assertSeatBelongsTo(identity.xUserId, derived.seat);

  const state = await instantSdk.readSeatState(publicClient(), { seat: derived.seat });
  const opener = seatOpenerAddress();
  const take = instantSdk.buildSeatTake({ seat: derived.seat });

  if (state.beneficiary.toLowerCase() !== opener.toLowerCase()) {
    // Already somebody's. Not an error — a creator revisiting the page should be told the
    // handover is done, and told it by the chain rather than by a stored flag.
    store.setClaimWallet(identity.xUserId, state.beneficiary);
    store.setClaimStatusForUser(identity.xUserId, "claimed", state.beneficiary);
    // The strongest proof available that this address is theirs: they took the seat, which
    // needed a signature from it. If they also have a trading wallet, this is the address that
    // may empty it.
    linkXWalletOwner(identity.xUserId, state.beneficiary, { store });
    return {
      seat: derived.seat,
      wallet: state.beneficiary,
      txHash: null,
      take: { to: take.to, data: take.data, value: "0" },
      alreadyClaimed: true,
    };
  }

  let txHash: string | null = null;
  if (state.offered.toLowerCase() !== wallet.toLowerCase()) {
    const call = instantSdk.buildSeatOffer({ seat: derived.seat, next: wallet });
    // The opener key, necessarily: `offer` is occupant-only, and the occupant is the opener. This
    // is the one operation that key exists for.
    const sent = await sendAsSeatOpener({ seat: derived.seat, label: derived.label }, call);
    txHash = sent.hash;
  }

  store.setClaimStatusForUser(identity.xUserId, "offered", wallet);
  /*
   * The address a signed-in account nominated, recorded as the one that may withdraw from its
   * trading wallet.
   *
   * Weaker proof than the branch above — nothing here has signed from that address yet — and
   * accepted at the same level of trust the seat handover already runs at, because it is the
   * same decision by the same verified identity: this is the wallet I want my money to go to.
   * What stops it being a way in is that naming an address grants nothing on its own. Recovery
   * still demands a signature from it, so the worst a mistake here can do is point a person's
   * own funds at an address they typed wrong, and the worst an X account takeover can do is
   * what it could already do to that account's fee stream.
   */
  linkXWalletOwner(identity.xUserId, wallet, { store });

  return {
    seat: derived.seat,
    wallet,
    txHash,
    take: { to: take.to, data: take.data, value: "0" },
    alreadyClaimed: false,
  };
}

/**
 * Sweep a market's outstanding creator fees into the seat's occupant.
 *
 * Only after the handover. The guard below is the whole reason this function can exist at all:
 * `collect` pays whoever holds the seat, so running it on an unclaimed seat would pay Agen —
 * which is the custody this feature is built to avoid. Agen pays the gas and receives nothing.
 */
export async function collectFees(
  identity: XIdentity,
  launchId: string,
  store: XStore = xStore(),
): Promise<{ readonly txHash: string; readonly amountWei: bigint }> {
  const record = store.launchById(launchId);
  if (record === null || record.xUserId !== identity.xUserId) {
    throw new XError("NOT_FOUND", "No such launch for this account.");
  }
  if (record.vault === null || record.seat === null) {
    throw new XError("VALIDATION_FAILED", "That launch has no vault to collect from.");
  }

  const summary = await seatSummary(identity);
  if (!summary.claimed) {
    throw new XError(
      "CONFLICT",
      "Take the seat with your wallet first. Until then these fees stay in the market's vault, " +
        "where only you can end up with them.",
    );
  }

  // Derived once, and used for both the check and the send. `assertSeatBelongsTo` would re-derive
  // it, so this asserts against the same answer rather than making the chain say it three times.
  const derived = await seatFor(identity.xUserId);
  if (derived.seat.toLowerCase() !== record.seat.toLowerCase()) {
    throw new XError("SEAT_MISMATCH", "That seat is not derived from this X account.", {
      details: { expected: derived.seat, found: record.seat },
    });
  }

  const amountWei = await instantSdk.readSeatClaimable(publicClient(), {
    seat: record.seat,
    vault: record.vault,
  });
  if (amountWei === 0n) {
    throw new XError("CONFLICT", "There is nothing outstanding in that market's vault.");
  }

  const call = instantSdk.buildSeatCollect({ seat: record.seat, vault: record.vault });
  // The sponsor, not the opener. `collect` is permissionless and pays the occupant — who by this
  // point is the creator — so this is Agen buying a stranger a transaction, and it needs none of
  // the seat authority the opener key holds.
  const sent = await sendSponsoredToSeat({ seat: derived.seat, label: derived.label }, call);

  return { txHash: sent.hash, amountWei };
}
