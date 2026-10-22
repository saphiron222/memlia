-- Copyright (c) 2026 Memlia. All rights reserved.
-- Personal procedure metadata, never executable qualification or shared bytes.
CREATE TABLE "memlia_desktop_procedure" (
 "id" text PRIMARY KEY, "workspace_id" text NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
 "owner_user_id" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
 "revision" bigint NOT NULL, "created_at" timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT "memlia_procedure_revision" CHECK(revision BETWEEN 1 AND 9007199254740991)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "memlia_procedure_scope_uq" ON "memlia_desktop_procedure"(id,workspace_id,owner_user_id);
CREATE INDEX "memlia_procedure_owner_idx" ON "memlia_desktop_procedure"(workspace_id,owner_user_id,created_at);
--> statement-breakpoint
CREATE TABLE "memlia_desktop_procedure_version" (
 "id" text PRIMARY KEY, "procedure_id" text NOT NULL, "workspace_id" text NOT NULL, "owner_user_id" text NOT NULL,
 "revision" bigint NOT NULL, "request_id" text NOT NULL, "request_digest" text NOT NULL,
 "command_id" text NOT NULL REFERENCES memlia_desktop_agent_command(id), "artifact_id" text NOT NULL, "artifact_sha256" text NOT NULL,
 "name" text NOT NULL, "description" text NOT NULL, "created_at" timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT "memlia_procedure_version_scope_fk" FOREIGN KEY(procedure_id,workspace_id,owner_user_id) REFERENCES memlia_desktop_procedure(id,workspace_id,owner_user_id) ON DELETE CASCADE,
 CONSTRAINT "memlia_procedure_version_revision" CHECK(revision BETWEEN 1 AND 9007199254740991),
 CONSTRAINT "memlia_procedure_text_bounds" CHECK(length(name) BETWEEN 1 AND 120 AND length(description)<=2000),
 CONSTRAINT "memlia_procedure_hashes" CHECK(request_digest ~ '^sha256:[a-f0-9]{64}$' AND artifact_sha256 ~ '^sha256:[a-f0-9]{64}$'),
 CONSTRAINT "memlia_procedure_request_id" CHECK(request_id ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$')
);
--> statement-breakpoint
CREATE UNIQUE INDEX "memlia_procedure_version_uq" ON "memlia_desktop_procedure_version"(procedure_id,revision);
CREATE UNIQUE INDEX "memlia_procedure_request_uq" ON "memlia_desktop_procedure_version"(workspace_id,owner_user_id,request_id);
