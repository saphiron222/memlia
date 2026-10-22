-- Copyright (c) 2026 Memlia. All rights reserved.
ALTER TABLE "memlia_desktop_agent_state" ADD COLUMN "observed_certificate_id" text REFERENCES "memlia_desktop_agent_certificate"("id"), ADD COLUMN "observed_session_id" text, ADD COLUMN "observed_windows_sid" text, ADD COLUMN "observed_at" timestamptz;
--> statement-breakpoint
ALTER TABLE "memlia_desktop_agent_state" ADD CONSTRAINT "memlia_agent_presence_complete" CHECK ((observed_at IS NULL AND observed_certificate_id IS NULL AND observed_session_id IS NULL AND observed_windows_sid IS NULL) OR (observed_at IS NOT NULL AND observed_certificate_id IS NOT NULL AND observed_session_id IS NOT NULL AND observed_windows_sid IS NOT NULL));
--> statement-breakpoint
ALTER TABLE "memlia_desktop_agent_command" ADD COLUMN "request_id" text, ADD COLUMN "request_digest" text;
--> statement-breakpoint
ALTER TABLE "memlia_desktop_agent_command" ADD CONSTRAINT "memlia_agent_request_complete" CHECK ((request_id IS NULL AND request_digest IS NULL) OR (request_id IS NOT NULL AND request_digest IS NOT NULL AND request_id ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' AND request_digest ~ '^sha256:[0-9a-f]{64}$'));
--> statement-breakpoint
CREATE UNIQUE INDEX "memlia_agent_command_request_uq" ON "memlia_desktop_agent_command" ("owner_user_id","workspace_id","request_id");
