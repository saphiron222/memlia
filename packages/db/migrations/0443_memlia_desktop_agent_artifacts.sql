-- Additive private storage. Forward migration only; never drop captures as a rollback.
-- The command FK is deferred so its two manifests can precede the intent INSERT
-- within the same transaction. An orphan cannot commit.
CREATE TABLE "memlia_desktop_agent_artifact" (
  "command_id" text NOT NULL,
  "artifact_id" text NOT NULL,
  "sha256" text NOT NULL,
  "origin" text NOT NULL,
  "total_bytes" integer NOT NULL,
  "next_offset" integer DEFAULT 0 NOT NULL,
  "complete" boolean DEFAULT false NOT NULL,
  PRIMARY KEY ("command_id", "artifact_id"),
  CONSTRAINT "memlia_agent_artifact_command_fk" FOREIGN KEY ("command_id") REFERENCES "memlia_desktop_agent_command"("id") ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "memlia_agent_artifact_digest" CHECK ("sha256" ~ '^sha256:[a-f0-9]{64}$'),
  CONSTRAINT "memlia_agent_artifact_origin" CHECK ("origin" IN ('server','agent')),
  CONSTRAINT "memlia_agent_artifact_bounds" CHECK ("total_bytes" BETWEEN 0 AND 34603008 AND "next_offset" BETWEEN 0 AND "total_bytes" AND ("complete" = ("next_offset" = "total_bytes")))
);
--> statement-breakpoint
CREATE TABLE "memlia_desktop_agent_artifact_chunk" (
  "command_id" text NOT NULL,
  "artifact_id" text NOT NULL,
  "offset" integer NOT NULL,
  "byte_count" integer NOT NULL,
  "data_base64" text NOT NULL,
  PRIMARY KEY ("command_id", "artifact_id", "offset"),
  CONSTRAINT "memlia_agent_artifact_chunk_fk" FOREIGN KEY ("command_id", "artifact_id") REFERENCES "memlia_desktop_agent_artifact"("command_id", "artifact_id") ON DELETE CASCADE,
  CONSTRAINT "memlia_agent_artifact_chunk_bounds" CHECK ("offset" BETWEEN 0 AND 34603008 AND "offset" % 262144 = 0 AND "byte_count" BETWEEN 0 AND 262144 AND octet_length("data_base64") <= 349528 AND octet_length(decode("data_base64", 'base64')) = "byte_count")
);
