/**
 * What a Program may be called, and what it may not.
 *
 * A name is a label on a hash. It is not the identity, it can change, and nothing here can alter
 * what a Program *is* — that is `configHash` and it is settled before any of this runs. So these
 * rules are not about correctness of economics; they are about a string that will appear in a URL,
 * in a listing, and next to somebody else's money.
 *
 * ## Why the rules are this strict
 *
 * Three failures, each seen elsewhere and each cheap to prevent here.
 *
 * A slug that can look like an identity invites being read as one. `0x…` and a run of digits are
 * both things a reader could take for a hash or an index, and a Program called `44363849` sitting
 * next to a market launched in block 44363849 is a coincidence nobody should have to think about.
 *
 * A slug that can collide with a route is a Program that shadows the product. `/programs/api` is a
 * URL, and so is `/programs/new`; a reserved list is duller than discovering that a claim broke a
 * page.
 *
 * A slug that can impersonate is the expensive one. `official` and `verified` are claims about the
 * platform's opinion, and the platform has no opinion — so nobody gets to assert one by naming
 * themselves it.
 *
 * ## Pure, and staying that way
 *
 * No database, no chain, no clock. Uniqueness is not checked here because uniqueness is not a
 * property of a string: it belongs to the table with the constraint on it, and asking this module
 * would mean two answers to the same question.
 */

/** Why a label was refused. Enumerated because routes map these to statuses and copy. */
export type NamingRefusal = "NAME_INVALID" | "SLUG_INVALID" | "SLUG_RESERVED";

export interface NamingProblem {
  readonly refusal: NamingRefusal;
  /** One sentence, for the person who typed it. Says what is wrong, not merely that it is. */
  readonly detail: string;
}

export const NAME_MIN_LENGTH = 1;
export const NAME_MAX_LENGTH = 64;
export const SLUG_MIN_LENGTH = 3;
export const SLUG_MAX_LENGTH = 48;
export const DESCRIPTION_MAX_LENGTH = 500;

/**
 * Slugs nobody may hold.
 *
 * Four kinds, kept in one list because the check is the same and the reasons only matter when
 * somebody asks why their name was refused: routes and route-shaped words (`api`, `new`, `settings`),
 * words that assert the platform's endorsement (`official`, `verified`, `admin`), the product's own
 * names (`agen`, `verdant`, `v4`, `fun`), and the handful of strings that read as absence
 * (`null`, `none`, `undefined`) and would make a URL look broken.
 *
 * Deliberately not exhaustive against every future route. A route added later that collides with an
 * existing slug is a product decision to make then; a reserved list that tries to predict every one
 * is a list that gets stale and is trusted anyway.
 */
export const RESERVED_SLUGS: readonly string[] = [
  // Routes, and words that look like routes.
  "about",
  "account",
  "admin",
  "api",
  "assets",
  "auth",
  "docs",
  "health",
  "help",
  "home",
  "index",
  "launch",
  "login",
  "logout",
  "market",
  "markets",
  "me",
  "metrics",
  "new",
  "program",
  "programs",
  "public",
  "registry",
  "root",
  "search",
  "settings",
  "static",
  "status",
  "support",
  "system",
  // Endorsement, which the platform does not grant and nobody may assert.
  "official",
  "verified",
  "trusted",
  "staff",
  "team",
  "moderator",
  // The product's own names.
  "agen",
  "verdant",
  "instant",
  "engine",
  "v4",
  "fun",
  "v4fun",
  // Strings that read as absence.
  "null",
  "none",
  "nil",
  "undefined",
  "unknown",
  "untitled",
];

const RESERVED = new Set(RESERVED_SLUGS);

/** Lowercase words separated by single hyphens, starting and ending on a word. */
const SLUG_SHAPE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ONLY_DIGITS = /^[0-9]+$/;
const LOOKS_LIKE_HEX = /^0x[0-9a-fA-F]*$/;
const HAS_A_LETTER = /[a-zA-Z]/;

/**
 * A name, checked.
 *
 * Trimmed before it is judged and before it is stored, because trailing whitespace in a display
 * name is invisible and makes two names that look identical sort apart.
 */
export function validateProgramName(name: string): NamingProblem | null {
  const trimmed = name.trim();

  if (trimmed.length < NAME_MIN_LENGTH) {
    return { refusal: "NAME_INVALID", detail: "A program needs a name." };
  }

  if (trimmed.length > NAME_MAX_LENGTH) {
    return {
      refusal: "NAME_INVALID",
      detail: `A name must be ${String(NAME_MAX_LENGTH)} characters or fewer.`,
    };
  }

  if (LOOKS_LIKE_HEX.test(trimmed)) {
    return {
      refusal: "NAME_INVALID",
      detail:
        "A name cannot be a hash. The program already has one of those and it is the thing the " +
        "name exists to be readable instead of.",
    };
  }

  if (ONLY_DIGITS.test(trimmed)) {
    return {
      refusal: "NAME_INVALID",
      detail: "A name cannot be only digits, which reads as an index rather than a name.",
    };
  }

  if (!HAS_A_LETTER.test(trimmed)) {
    return { refusal: "NAME_INVALID", detail: "A name needs at least one letter in it." };
  }

  return null;
}

/** A slug, checked. Order matters only in that the message should name the first real problem. */
export function validateProgramSlug(slug: string): NamingProblem | null {
  if (slug.length < SLUG_MIN_LENGTH || slug.length > SLUG_MAX_LENGTH) {
    return {
      refusal: "SLUG_INVALID",
      detail: `A slug must be between ${String(SLUG_MIN_LENGTH)} and ${String(SLUG_MAX_LENGTH)} characters.`,
    };
  }

  if (!SLUG_SHAPE.test(slug)) {
    return {
      refusal: "SLUG_INVALID",
      detail:
        "A slug may use lowercase letters, digits and single hyphens between them — no capitals, " +
        "spaces, leading or trailing hyphens, or doubled hyphens.",
    };
  }

  if (ONLY_DIGITS.test(slug)) {
    return {
      refusal: "SLUG_INVALID",
      detail: "A slug cannot be only digits, which reads as an index rather than a name.",
    };
  }

  if (RESERVED.has(slug)) {
    return {
      refusal: "SLUG_RESERVED",
      detail: `"${slug}" is reserved and cannot be claimed.`,
    };
  }

  return null;
}

/** A description, checked. Absent is fine; a description is optional in every sense. */
export function validateProgramDescription(description: string | null): NamingProblem | null {
  if (description === null) return null;

  if (description.trim().length === 0) {
    return {
      refusal: "NAME_INVALID",
      detail: "A description that is only whitespace should be left out instead.",
    };
  }

  if (description.length > DESCRIPTION_MAX_LENGTH) {
    return {
      refusal: "NAME_INVALID",
      detail: `A description must be ${String(DESCRIPTION_MAX_LENGTH)} characters or fewer.`,
    };
  }

  return null;
}

/**
 * A slug from a name, as a suggestion.
 *
 * Offered rather than imposed: what it returns still has to pass `validateProgramSlug`, and a name
 * that produces a reserved or empty slug is a name whose owner has to choose one. It exists so that
 * the common case — a name that is already slug-shaped once lowercased — does not make somebody
 * type the same thing twice.
 */
export function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
