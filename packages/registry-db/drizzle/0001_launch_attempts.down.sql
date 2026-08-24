-- The reverse of 0001_launch_attempts.sql.
--
-- Hand-written, because drizzle-kit generates forward migrations only. `attempts-migrate.test.ts`
-- applies it against a real Postgres and asserts the database is returned to the state migration
-- 0000 left it in — the four Program tables still there, `launch_attempts` and its indexes gone —
-- and that the forward migration can then be applied again. A reverse migration nothing executes
-- is a reverse migration that is wrong.
--
-- Shorter than 0000's reverse for one reason worth stating: `launch_attempts` has no foreign keys,
-- in either direction. It references nothing, because an attempt is written before the Program it
-- will create exists, and nothing references it, because the Program tables are rebuildable from
-- the chain and must not depend on a record of intent that may have expired. So there is no
-- ordering requirement here, and dropping this table cannot cascade into anybody's Programs.

DROP INDEX IF EXISTS "launch_attempts_config_creator_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "launch_attempts_status_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "launch_attempts_job_idx";--> statement-breakpoint
DROP TABLE IF EXISTS "launch_attempts";
