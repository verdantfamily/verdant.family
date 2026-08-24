/**
 * What a Program is, as records.
 *
 * Types only. Nothing here reads a database, a chain or a clock — every timestamp and
 * every address is supplied by whatever observed it, so a Program can be assembled from
 * the indexer, from a launch that has not been indexed yet, or from a fixture, without
 * this package knowing which.
 *
 * ## A Program is its `configHash`, and nothing else
 *
 * There is no separate program id, no sequence and no slug that identity depends on. The
 * engine already produces a value that means "these exact economics" — `configHash`,
 * derived by the hook from what it actually stored — and inventing a second identifier
 * beside it would create the one thing the engine exists to prevent: two answers to
 * "is this the same market", which can disagree.
 *
 * The consequence, and it is the whole rule: **the first observed hash owns the
 * identity.** Two creators who independently launch identical economics launch the same
 * Program, and the second one is a new `MarketRef` under the existing `Program` rather
 * than a new Program. Nothing about a Program can be edited into a different Program,
 * because editing the economics produces a different hash and therefore a different
 * Program.
 *
 * ## Why the display fields are nullable and the economics are not
 *
 * `configHash` covers the economics alone — symbols, names and decimals are deliberately
 * outside it, because two markets differing only in what their token is called are the
 * same market to the engine. So a Program's name is a label some surface chose, it can be
 * absent, and it can never be load-bearing. Anything that must be true about a Program is
 * recoverable from its `encodedConfig` by `@verdant/market-engine`.
 */

/** A `0x`-prefixed hex string. Declared here so this package needs no viem at runtime. */
export type Hex = `0x${string}`;

/** EVM chain id. 4663 is Robinhood Chain mainnet; see `@verdant/config`. */
export type ChainId = number;

/**
 * Which canonical-config schema a Program is written in.
 *
 * The same number as `CanonicalConfig.engineVersion`, and it selects the encoding the
 * identity is taken over: `CONFIG_ABI` at 1, `CONFIG_V2_ABI` at 2. Named for the schema
 * rather than the engine because it is a fact about the configuration's shape, and because
 * a Program is a configuration — the engine that executes it is named by
 * `MarketRef`/`implementationHash`, which is a different question.
 */
export type SchemaVersion = 1 | 2;

/** Unix seconds. Supplied by the observer; this package never reads a clock. */
export type UnixSeconds = number;

/**
 * Whoever launched the market that first carried a Program.
 *
 * The address is the only field that is a fact. A handle and a display name are whatever
 * a surface has managed to associate with it and are null until then — an author who has
 * never connected an off-chain identity is the ordinary case, not a missing record.
 *
 * Deliberately not "owner". Authorship is a historical observation about who launched
 * first, and it grants nothing: a Program has no permissions, because a Program is a hash
 * and there is nothing to permit.
 */
export interface ProgramAuthor {
  /** Lowercased, so an address is one key rather than two. */
  readonly address: Hex;
  readonly handle: string | null;
  readonly displayName: string | null;
}

/**
 * One live market that runs a Program.
 *
 * A reference rather than a copy: everything about how the market is trading — price,
 * volume, holders, fees taken — belongs to the indexer and is not restated here. What this
 * carries is only what is needed to find the market and to prove it runs this Program.
 *
 * `configHash` and `implementationHash` are both kept, because they answer different
 * questions and a registry that kept one could not check the other. `configHash` says
 * which economics; `implementationHash` binds those economics to a chain, an engine
 * address and an engine version, so it is what establishes that this market's rules are
 * the Program's rules *as executed here*.
 */
export interface MarketRef {
  readonly chainId: ChainId;
  /** The v4 pool id: `keccak256(abi.encode(poolKey))`. Joins the indexer's `agen_market`. */
  readonly poolId: Hex;
  readonly token: Hex;
  /**
   * Who launched this market, lowercased. Optional, and absent is a real answer.
   *
   * The fact that decides who may name a Program: the right belongs to whoever launched the
   * earliest market running its economics. That question cannot be answered from `Program.author`,
   * which records whoever was observed first rather than whoever was earliest by block, and the two
   * differ exactly when it matters — when two people launched identical economics.
   *
   * Optional rather than required because a market observed before this field existed genuinely has
   * no answer, and because the honest response to an unknown author is to refuse a claim rather than
   * to fall back to a value that means something else.
   */
  readonly creator?: Hex;
  /** `AgenMarketRegistry`'s index, which is also creation order. */
  readonly marketIndex: number;
  readonly engineVersion: SchemaVersion;
  /** Equal to the Program's own `configHash`. Kept so a row is checkable in isolation. */
  readonly configHash: Hex;
  /** The commitment: economics bound to chain, engine and version. */
  readonly implementationHash: Hex;
  readonly launchTx: Hex;
  readonly launchBlock: number;
  readonly launchedAt: UnixSeconds;
}

/**
 * A Program: one set of economics, identified by the hash of its canonical form.
 *
 * `markets` is a list because economics are not exclusive. The same Program can be running
 * in several markets at once, launched by different people on different chains, and that is
 * the case the registry exists to make visible — "this mechanic has been used eleven
 * times" is the question a platform surface asks and neither the chain nor the indexer can
 * answer, because neither groups markets by their economics.
 */
export interface Program {
  /** The identity. First observed hash owns it; see the note at the top of this file. */
  readonly configHash: Hex;
  readonly schemaVersion: SchemaVersion;
  /**
   * The order-independent normal form's key, from `dedupeKeyFor`.
   *
   * Stored beside the hash rather than instead of it, because the two answer different
   * questions. `configHash` is exact and the chain agrees with it. `dedupeKey` is broader:
   * it also matches configurations that were written down differently — a different key
   * order, a rate as a string rather than an integer, rules listed in another sequence —
   * which is what a *submission* needs checking against before it becomes a launch.
   */
  readonly dedupeKey: string;
  readonly author: ProgramAuthor;
  /** A label. Never load-bearing: it is outside the commitment. */
  readonly name: string | null;
  readonly firstObservedAt: UnixSeconds;
  /** The market whose launch created this identity. */
  readonly firstObservedIn: MarketRef;
  /** Every market known to run these economics, `firstObservedIn` included. */
  readonly markets: readonly MarketRef[];
}

/**
 * One point in a Program's history.
 *
 * A version is itself a Program — it has its own `configHash`, because it has its own
 * economics — so this is a Program's membership of a lineage rather than a mutable record
 * that a Program points at. There is no "current version" field anywhere: a market runs
 * the configuration it launched with, immutably, and nothing a registry records can change
 * what a deployed market does.
 *
 * `encodedConfig` is the bytes the identity is taken over, kept because they are what makes
 * a version readable. Anything holding them can recover every rate, threshold, recipient
 * and ceiling through `decodeConfig`, with no model, no prompt and no second implementation
 * of what the rules mean.
 */
export interface ProgramVersion {
  /** This version's own identity, and a `Program.configHash` in its own right. */
  readonly configHash: Hex;
  /** The lineage root: the first Program in this chain of revisions. */
  readonly rootConfigHash: Hex;
  readonly schemaVersion: SchemaVersion;
  /** The canonical bytes. `decodeConfig` turns these back into the economics. */
  readonly encodedConfig: Hex;
  /**
   * Position in the lineage, counting from 0 at the root.
   *
   * A convenience for ordering a display, and not an identity: two siblings forked from
   * one parent share an ordinal, which is correct — they are the same distance from the
   * root — and is why the edges below are what actually describe the shape.
   */
  readonly ordinal: number;
  readonly createdAt: UnixSeconds;
}

/**
 * How one Program came from another.
 *
 * `REVISION` is the same author changing their own economics. `FORK` is someone else
 * taking them as a starting point. The distinction is authorship, not shape — the
 * configurations differ either way — and it is recorded rather than derived because only
 * the surface that accepted the edit knows which happened.
 */
export type LineageKind = "REVISION" | "FORK";

/**
 * A directed edge between two Programs.
 *
 * Edges rather than a parent pointer on `Program`, because a Program is a hash and the
 * same hash can be arrived at from more than one direction: two people editing different
 * parents can land on identical economics, at which point one Program genuinely has two
 * parents. A single `parentConfigHash` would force one of those to be discarded.
 *
 * A well-formed edge never points at itself, and a cycle is not expressible in a set of
 * edges that only ever grows forward in time — a child's `configHash` is not knowable
 * until its economics exist.
 */
export interface LineageEdge {
  readonly parentConfigHash: Hex;
  readonly childConfigHash: Hex;
  readonly kind: LineageKind;
  /** Who made the edit. A `FORK` is by definition not the parent's author. */
  readonly authorAddress: Hex;
  readonly createdAt: UnixSeconds;
}
