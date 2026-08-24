CREATE TABLE "program_claim_nonces" (
	"nonce" text PRIMARY KEY NOT NULL,
	"config_hash" text NOT NULL,
	"address" text NOT NULL,
	"action" text NOT NULL,
	"used_at" bigint NOT NULL,
	CONSTRAINT "program_claim_nonces_action_check" CHECK ("program_claim_nonces"."action" in ('claim', 'rename'))
);
--> statement-breakpoint
CREATE TABLE "program_slug_history" (
	"slug" text PRIMARY KEY NOT NULL,
	"config_hash" text NOT NULL,
	"retired_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "program_markets" ADD COLUMN "creator" text;--> statement-breakpoint
ALTER TABLE "programs" ADD COLUMN "slug" text;--> statement-breakpoint
ALTER TABLE "programs" ADD COLUMN "claimed_by" text;--> statement-breakpoint
ALTER TABLE "programs" ADD COLUMN "claimed_at" bigint;--> statement-breakpoint
ALTER TABLE "program_slug_history" ADD CONSTRAINT "program_slug_history_config_hash_programs_config_hash_fk" FOREIGN KEY ("config_hash") REFERENCES "public"."programs"("config_hash") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "program_claim_nonces_config_hash_idx" ON "program_claim_nonces" USING btree ("config_hash");--> statement-breakpoint
CREATE INDEX "program_slug_history_config_hash_idx" ON "program_slug_history" USING btree ("config_hash");--> statement-breakpoint
ALTER TABLE "programs" ADD CONSTRAINT "programs_slug_unique" UNIQUE("slug");