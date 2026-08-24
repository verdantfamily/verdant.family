-- The reverse of 0000_programs.sql.
--
-- Hand-written, because drizzle-kit generates forward migrations only. `migrate.test.ts`
-- applies it against a real Postgres and asserts the database is returned to empty — no tables,
-- no indexes, no constraints — and that the forward migration can then be applied again. A
-- reverse migration nothing executes is a reverse migration that is wrong.
--
-- Children before parents, so the foreign keys into `programs` are gone before it is. `cascade`
-- would make the order irrelevant, and is deliberately not used: an explicit order fails loudly
-- if a future table references `programs` and is not listed here, where `cascade` would silently
-- drop it.

DROP INDEX IF EXISTS "program_lineage_child_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "program_markets_config_hash_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "program_markets_token_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "program_versions_root_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "programs_dedupe_key_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "programs_author_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "programs_first_observed_at_idx";--> statement-breakpoint
DROP TABLE IF EXISTS "program_lineage";--> statement-breakpoint
DROP TABLE IF EXISTS "program_versions";--> statement-breakpoint
DROP TABLE IF EXISTS "program_markets";--> statement-breakpoint
DROP TABLE IF EXISTS "programs";
