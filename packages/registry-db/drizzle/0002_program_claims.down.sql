-- The reverse of 0002_program_claims.sql.
--
-- Hand-written, because drizzle-kit generates forward migrations only, and executed by
-- `migration-pinning.test.ts`, which requires every migration in the journal to have one.
--
-- Reversing this one drops data rather than merely dropping structure, which the other two do not:
-- a claim is a fact somebody proved with a signature, and rolling back takes their name off their
-- Program. Nothing about identity is lost — configHash, lineage, dedupe_key and every market row are
-- untouched, because a label was never part of any of them — so the reverse is safe in the sense
-- that matters. It is not safe in the sense of being free, and an operator running it should expect
-- every claim to need making again.
--
-- Order: the two new tables before the columns they describe, and the constraint before the column
-- it constrains. `program_slug_history` references `programs`, so it goes first for the same reason
-- 0000's reverse orders children before parents — explicitly, rather than relying on cascade, so a
-- future table that references one of these fails loudly here instead of being dropped silently.

DROP INDEX IF EXISTS "program_slug_history_config_hash_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "program_claim_nonces_config_hash_idx";--> statement-breakpoint
DROP TABLE IF EXISTS "program_slug_history";--> statement-breakpoint
DROP TABLE IF EXISTS "program_claim_nonces";--> statement-breakpoint
ALTER TABLE "programs" DROP CONSTRAINT IF EXISTS "programs_slug_unique";--> statement-breakpoint
ALTER TABLE "programs" DROP COLUMN IF EXISTS "claimed_at";--> statement-breakpoint
ALTER TABLE "programs" DROP COLUMN IF EXISTS "claimed_by";--> statement-breakpoint
ALTER TABLE "programs" DROP COLUMN IF EXISTS "slug";--> statement-breakpoint
ALTER TABLE "program_markets" DROP COLUMN IF EXISTS "creator";
