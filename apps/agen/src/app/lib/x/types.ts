/**
 * What the bot knows about X, and what it records about what it did.
 *
 * These shapes are the boundary. Everything above them — the intent router, the generator,
 * the launch engine — is written against this file and not against X's JSON, which is what
 * lets the delivery method change without the engine noticing. `client.ts` is the only
 * module that has read an X response.
 */

import type { Address, Hex } from "viem";

/**
 * An X account, as the bot needs it.
 *
 * `id` is the immutable one and the only field anything is keyed on. `username` is a
 * setting: it is stored and displayed because a creator recognises themselves by it, and it
 * is never the answer to "whose fee is this".
 */
export interface XAuthor {
  readonly id: string;
  readonly username: string;
  readonly name: string;
  /** Where the account's picture is, when X gave one. Used as a token's last-resort logo. */
  readonly avatarUrl: string | null;
  readonly followers: number | null;
  /** ISO 8601, when X gave one. Read by the account-age check. */
  readonly createdAt: string | null;
  readonly verified: boolean;
}

/**
 * An account looked up on purpose, rather than one that arrived attached to a post.
 *
 * The same account, with the fields X only serves when it is the subject of the request.
 * It extends `XAuthor` instead of restating it so that anything already written against an
 * author — the age check, the seat derivation, the reply composer — accepts one of these
 * unchanged, and so that there is one definition of "who posted this" rather than two that
 * drift. Every added field is nullable because the fields are a request X may decline: a
 * protected or suspended account answers with far less than a public one, and an absent
 * count is not the same fact as a zero.
 */
export interface XAccount extends XAuthor {
  /** The bio. The most useful single field for deciding whether an account is what it claims. */
  readonly description: string | null;
  /** How many accounts this one follows. Read against `followers` rather than alone. */
  readonly following: number | null;
  /** Posts ever made, including replies. X counts this as `tweet_count`. */
  readonly postCount: number | null;
  readonly location: string | null;
  /** The one link in the profile header, as X serves it — usually a `t.co` redirect. */
  readonly url: string | null;
}

/** A picture or video attached to a post. Only stills are usable as a token logo. */
export interface XMedia {
  readonly kind: "photo" | "video" | "animated_gif";
  /** The still image. For a video this is its preview frame. */
  readonly url: string | null;
  readonly altText: string | null;
}

export interface XPost {
  readonly id: string;
  readonly text: string;
  readonly author: XAuthor;
  readonly createdAt: string | null;
  /** The post this one replies to, when it is a reply. */
  readonly inReplyToPostId: string | null;
  /** The post this one quotes, when it quotes one. Distinct from the parent. */
  readonly quotedPostId: string | null;
  readonly media: readonly XMedia[];
  /** Links the post carries, already expanded past `t.co` where X expanded them. */
  readonly links: readonly string[];
  readonly language: string | null;
}

/**
 * A mention of the bot, and the post it is about.
 *
 * `source` is the parent — the post a launch would be *of* — and it is null when the bot was
 * mentioned in a post that replies to nothing. That case is not an error: a question is
 * answerable without a parent, and only a launch requires one.
 */
export interface XMention {
  /** The post containing the mention. The idempotency key for everything downstream. */
  readonly command: XPost;
  readonly source: XPost | null;
  /** A quoted post on the command or the source, when one was fetched. */
  readonly quoted?: XPost | null;
  /**
   * Ancestors of the command, oldest first, not including the command itself.
   *
   * Empty when the mention was not enriched, or when it replies to nothing. The source post
   * is usually the last entry.
   */
  readonly thread?: readonly XPost[];
}

/**
 * What the X surface recorded that it did.
 *
 * The runtime does not think in these words — it plans, calls tools, and either replies or
 * hands an execution to this surface. They are what the store settles a mention as.
 *
 * `LAUNCH`, `QUESTION` and `UNKNOWN` are the model's three outcomes, and new *capabilities* of
 * the model are new tools rather than new members here. `TRADE` and `WALLET` are the
 * exception, and they are one because they never involve the model at all: both are decided by
 * the deterministic parse in `command.ts` before a model is called, because both spend or
 * disclose the balance of a wallet belonging to the person who posted.
 */
export type XIntent = "LAUNCH" | "QUESTION" | "TRADE" | "WALLET" | "UNKNOWN";

/**
 * A launch the model proposed, before anything has checked it.
 *
 * Deliberately not the same type as the draft that reaches the launcher. Everything here is
 * a suggestion from a model that has read a stranger's post, and the conversion to a draft
 * is where it stops being one — see `generate.ts`.
 */
export interface ProposedToken {
  readonly name: string;
  readonly ticker: string;
  readonly description: string;
  /** The model's own confidence, 0 to 1. A low one is refused rather than launched. */
  readonly confidence: number;
}

export interface RoutedMention {
  readonly intent: XIntent;
  /** Present only for `LAUNCH`. */
  readonly token: ProposedToken | null;
  /** Present only for `QUESTION`: what to say back, or the first post of it. */
  readonly answer: string | null;
  /**
   * The answer as the posts it should be sent as, in order.
   *
   * Usually one, and `answer` is always its first element. Longer when the question genuinely
   * needed more room than a post has — the runtime decides that, and only for questions that
   * asked to be researched. Empty for a launch and for a silence.
   */
  readonly answers: readonly string[];
  /**
   * Which tools the runtime called, in order.
   *
   * For logs, for the routing probe, and for answering "why did this take nine seconds" without
   * re-running anything. Never shown to a user: the tool names are the closest thing the runtime has
   * to visible reasoning, and publishing them is how a prompt leaks.
   */
  readonly tools: readonly string[];
  /**
   * What the user stated outright, as opposed to what the model inferred.
   *
   * Kept separate because an explicit ticker is honoured and an inferred one is only a
   * suggestion. "launch this as $DOG" is an instruction; the model deciding on `$DOG` is a
   * guess, and the two should not be indistinguishable by the time they are validated.
   */
  readonly explicit: {
    readonly name: string | null;
    readonly ticker: string | null;
  };
}

/** Where a launch record is in its life. */
export type XLaunchStatus =
  /** Claimed by this process. No transaction has been sent. */
  | "reserved"
  /** A launch transaction is in flight or its receipt has not been read. */
  | "sending"
  /** On chain, confirmed. */
  | "launched"
  /** Refused or failed before any transaction was sent. */
  | "failed"
  /**
   * A transaction was sent and its outcome is unknown.
   *
   * The one status that must never be retried automatically. See `engine.ts`.
   */
  | "indeterminate";

/** Whether the creator has taken their seat. */
export type XClaimStatus = "unclaimed" | "offered" | "claimed";

/**
 * One sponsored launch, as it is recorded.
 *
 * The X user id is the creator identity and the seat is where the money is. Everything else
 * is either provenance — which post, which command, which transaction — or a copy of what
 * was generated, kept so that a record can be read without the chain or a model.
 */
export interface XLaunchRecord {
  readonly id: string;
  /** Immutable X user id. The entitlement key, and never the username. */
  readonly xUserId: string;
  /** The handle at the time of the launch. Metadata, for display only. */
  readonly xUsername: string;
  /** The post a token was made of. */
  readonly sourcePostId: string | null;
  /** The post that asked for it. Unique, which is what makes a launch idempotent. */
  readonly commandPostId: string;
  readonly token: Address | null;
  readonly poolId: Hex | null;
  readonly txHash: Hex | null;
  /** The seat named as the market's fee recipient. Where the creator's 1.00% accrues. */
  readonly seat: Address | null;
  /** The market's `InstantFeeVault`, once known. What the seat collects from. */
  readonly vault: Address | null;
  readonly name: string | null;
  readonly ticker: string | null;
  readonly status: XLaunchStatus;
  readonly claimStatus: XClaimStatus;
  /** The wallet the seat was offered to or taken by, once there is one. */
  readonly claimWallet: Address | null;
  readonly claimedAt: number | null;
  /** Gas actually spent by the platform on this launch, in wei. */
  readonly gasSpentWei: bigint;
  /** The reply the bot posted, so a record shows what the user was told. */
  readonly replyPostId: string | null;
  readonly createdAt: number;
  readonly error: string | null;
}

/** A verified X identity, as held by a signed-in session. */
export interface XIdentity {
  readonly xUserId: string;
  readonly xUsername: string;
  readonly name: string;
  readonly avatarUrl: string | null;
}
