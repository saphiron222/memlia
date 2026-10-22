CREATE TABLE "memlia_desktop_agent_state" (
 "agent_id" text PRIMARY KEY NOT NULL,
 "epoch" bigint DEFAULT 0 NOT NULL,
 CONSTRAINT "memlia_agent_state_epoch" CHECK ("epoch" BETWEEN 0 AND 9007199254740991)
);
--> statement-breakpoint
CREATE TABLE "memlia_desktop_agent_command" (
 "id" text PRIMARY KEY NOT NULL,
 "agent_id" text NOT NULL REFERENCES "memlia_desktop_agent_state"("agent_id"),
 "certificate_id" text NOT NULL REFERENCES "memlia_desktop_agent_certificate"("id"),
 "organization_id" text REFERENCES "organization"("id"),
 "workspace_id" text NOT NULL REFERENCES "workspace"("id"),
 "owner_user_id" text NOT NULL REFERENCES "user"("id"),
 "session_id" text NOT NULL, "windows_sid" text NOT NULL,
 "run_id" text NOT NULL, "capability_id" text NOT NULL,
 "status" text DEFAULT 'queued' NOT NULL,
 "created_at" timestamp with time zone DEFAULT now() NOT NULL,
 "expires_at" timestamp with time zone NOT NULL,
 "epoch" bigint, "lease_until" timestamp with time zone, "digest" text,
 "intent" jsonb NOT NULL, "command" jsonb, "capability" jsonb, "consent_id" text,
 "last_sequence" bigint DEFAULT -1 NOT NULL,
 CONSTRAINT "memlia_agent_command_status" CHECK ("status" IN ('queued','claimed','consented','running','hold','terminal')),
 CONSTRAINT "memlia_agent_command_lifetime" CHECK ("expires_at" > "created_at" AND "expires_at" <= "created_at" + interval '30 minutes'),
 CONSTRAINT "memlia_agent_command_counters" CHECK ("last_sequence" BETWEEN -1 AND 9007199254740991 AND ("epoch" IS NULL OR "epoch" BETWEEN 1 AND 9007199254740991)),
 CONSTRAINT "memlia_agent_command_claimed" CHECK ("status" = 'queued' OR ("command" IS NOT NULL AND "epoch" IS NOT NULL AND "digest" IS NOT NULL AND "lease_until" IS NOT NULL)),
 CONSTRAINT "memlia_agent_command_capability" CHECK (("capability" IS NULL) = ("consent_id" IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "memlia_agent_command_run_uq" ON "memlia_desktop_agent_command" ("run_id");
CREATE UNIQUE INDEX "memlia_agent_command_cap_uq" ON "memlia_desktop_agent_command" ("capability_id");
CREATE UNIQUE INDEX "memlia_agent_command_consent_uq" ON "memlia_desktop_agent_command" ("consent_id");
CREATE UNIQUE INDEX "memlia_agent_command_desktop_uq" ON "memlia_desktop_agent_command" ("agent_id") WHERE "status" IN ('claimed','consented','running','hold');
CREATE INDEX "memlia_agent_command_queue_idx" ON "memlia_desktop_agent_command" ("agent_id","status","created_at");
--> statement-breakpoint
CREATE TABLE "memlia_desktop_agent_receipt" (
 "id" text PRIMARY KEY NOT NULL,
 "command_id" text NOT NULL REFERENCES "memlia_desktop_agent_command"("id"),
 "sequence" bigint NOT NULL, "digest" text NOT NULL,
 "receipt" jsonb NOT NULL, "artifacts" jsonb NOT NULL,
 "created_at" timestamp with time zone DEFAULT now() NOT NULL,
 CONSTRAINT "memlia_agent_receipt_sequence" CHECK ("sequence" BETWEEN 0 AND 9007199254740991),
 CONSTRAINT "memlia_agent_receipt_digest" CHECK ("digest" ~ '^sha256:[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE UNIQUE INDEX "memlia_agent_receipt_sequence_uq" ON "memlia_desktop_agent_receipt" ("command_id","sequence");
