CREATE TABLE "memlia_workflow_copy" (
	"workflow_id" text PRIMARY KEY NOT NULL,
	"source_workflow_id" text NOT NULL,
	"source_state_digest" text NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memlia_workflow_copy_source_digest_sha256" CHECK ("memlia_workflow_copy"."source_state_digest" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
ALTER TABLE "memlia_workflow_copy" ADD CONSTRAINT "memlia_workflow_copy_workflow_id_workflow_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflow"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memlia_workflow_copy" ADD CONSTRAINT "memlia_workflow_copy_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memlia_workflow_copy_created_by_idx" ON "memlia_workflow_copy" USING btree ("created_by_user_id");