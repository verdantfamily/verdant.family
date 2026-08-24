CREATE TABLE "launch_attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"job_id" text NOT NULL,
	"chain_id" integer NOT NULL,
	"config_hash" text NOT NULL,
	"implementation_hash" text NOT NULL,
	"encoded_config" text NOT NULL,
	"schema_version" integer NOT NULL,
	"creator" text NOT NULL,
	"fee_receiver" text NOT NULL,
	"factory" text NOT NULL,
	"predicted_vault" text,
	"calldata_hash" text NOT NULL,
	"observed_block" bigint NOT NULL,
	"lineage_parent_config_hash" text,
	"lineage_kind" text,
	"status" text NOT NULL,
	"tx_hash" text,
	"prepared_at" bigint NOT NULL,
	"sent_at" bigint,
	"updated_at" bigint NOT NULL,
	"error" text,
	CONSTRAINT "launch_attempts_status_check" CHECK ("launch_attempts"."status" in ('reserved', 'sending', 'launched', 'failed', 'indeterminate')),
	CONSTRAINT "launch_attempts_lineage_kind_check" CHECK ("launch_attempts"."lineage_kind" is null or "launch_attempts"."lineage_kind" in ('REVISION', 'FORK')),
	CONSTRAINT "launch_attempts_lineage_complete_check" CHECK (("launch_attempts"."lineage_parent_config_hash" is null) = ("launch_attempts"."lineage_kind" is null))
);
--> statement-breakpoint
CREATE INDEX "launch_attempts_config_creator_idx" ON "launch_attempts" USING btree ("config_hash","creator");--> statement-breakpoint
CREATE INDEX "launch_attempts_status_idx" ON "launch_attempts" USING btree ("status");--> statement-breakpoint
CREATE INDEX "launch_attempts_job_idx" ON "launch_attempts" USING btree ("job_id");