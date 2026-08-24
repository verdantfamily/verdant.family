CREATE TABLE "program_lineage" (
	"parent_config_hash" text NOT NULL,
	"child_config_hash" text NOT NULL,
	"kind" text NOT NULL,
	"author_address" text NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "program_lineage_parent_config_hash_child_config_hash_pk" PRIMARY KEY("parent_config_hash","child_config_hash"),
	CONSTRAINT "program_lineage_kind_check" CHECK ("program_lineage"."kind" in ('REVISION', 'FORK')),
	CONSTRAINT "program_lineage_no_self_edge_check" CHECK ("program_lineage"."parent_config_hash" <> "program_lineage"."child_config_hash")
);
--> statement-breakpoint
CREATE TABLE "program_markets" (
	"chain_id" integer NOT NULL,
	"pool_id" text NOT NULL,
	"config_hash" text NOT NULL,
	"token" text NOT NULL,
	"market_index" integer NOT NULL,
	"engine_version" integer NOT NULL,
	"implementation_hash" text NOT NULL,
	"launch_tx" text NOT NULL,
	"launch_block" bigint NOT NULL,
	"launched_at" bigint NOT NULL,
	CONSTRAINT "program_markets_chain_id_pool_id_pk" PRIMARY KEY("chain_id","pool_id")
);
--> statement-breakpoint
CREATE TABLE "program_versions" (
	"config_hash" text PRIMARY KEY NOT NULL,
	"root_config_hash" text NOT NULL,
	"schema_version" integer NOT NULL,
	"encoded_config" text NOT NULL,
	"ordinal" integer NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "programs" (
	"config_hash" text PRIMARY KEY NOT NULL,
	"schema_version" integer NOT NULL,
	"dedupe_key" text NOT NULL,
	"author_address" text NOT NULL,
	"name" text,
	"description" text,
	"first_observed_at" bigint NOT NULL,
	"first_observed_chain_id" integer NOT NULL,
	"first_observed_pool_id" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "program_lineage" ADD CONSTRAINT "program_lineage_parent_config_hash_programs_config_hash_fk" FOREIGN KEY ("parent_config_hash") REFERENCES "public"."programs"("config_hash") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "program_lineage" ADD CONSTRAINT "program_lineage_child_config_hash_programs_config_hash_fk" FOREIGN KEY ("child_config_hash") REFERENCES "public"."programs"("config_hash") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "program_markets" ADD CONSTRAINT "program_markets_config_hash_programs_config_hash_fk" FOREIGN KEY ("config_hash") REFERENCES "public"."programs"("config_hash") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "program_versions" ADD CONSTRAINT "program_versions_config_hash_programs_config_hash_fk" FOREIGN KEY ("config_hash") REFERENCES "public"."programs"("config_hash") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "program_versions" ADD CONSTRAINT "program_versions_root_config_hash_programs_config_hash_fk" FOREIGN KEY ("root_config_hash") REFERENCES "public"."programs"("config_hash") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "program_lineage_child_idx" ON "program_lineage" USING btree ("child_config_hash");--> statement-breakpoint
CREATE INDEX "program_markets_config_hash_idx" ON "program_markets" USING btree ("config_hash");--> statement-breakpoint
CREATE INDEX "program_markets_token_idx" ON "program_markets" USING btree ("token");--> statement-breakpoint
CREATE INDEX "program_versions_root_idx" ON "program_versions" USING btree ("root_config_hash","ordinal");--> statement-breakpoint
CREATE INDEX "programs_dedupe_key_idx" ON "programs" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "programs_author_idx" ON "programs" USING btree ("author_address");--> statement-breakpoint
CREATE INDEX "programs_first_observed_at_idx" ON "programs" USING btree ("first_observed_at");