CREATE TABLE "memlia_desktop_agent_certificate" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"enrollment_id" text NOT NULL,
	"organization_id" text,
	"workspace_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"installation_id" text NOT NULL,
	"fqdn" text NOT NULL,
	"windows_sid" text NOT NULL,
	"csr_sha256" text NOT NULL,
	"spki_sha256" text NOT NULL,
	"certificate_serial" text NOT NULL,
	"certificate_sha256" text NOT NULL,
	"certificate_pem" text NOT NULL,
	"not_before" timestamp with time zone NOT NULL,
	"not_after" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "memlia_agent_cert_lifetime" CHECK ("memlia_desktop_agent_certificate"."not_before" < "memlia_desktop_agent_certificate"."not_after"),
	CONSTRAINT "memlia_agent_cert_hashes" CHECK ("memlia_desktop_agent_certificate"."csr_sha256" ~ '^[a-f0-9]{64}$' AND "memlia_desktop_agent_certificate"."spki_sha256" ~ '^[a-f0-9]{64}$' AND "memlia_desktop_agent_certificate"."certificate_sha256" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "memlia_agent_cert_input_bounds" CHECK (length("memlia_desktop_agent_certificate"."id") BETWEEN 1 AND 128 AND length("memlia_desktop_agent_certificate"."agent_id") BETWEEN 1 AND 128 AND length("memlia_desktop_agent_certificate"."installation_id") BETWEEN 1 AND 128 AND length("memlia_desktop_agent_certificate"."fqdn") BETWEEN 1 AND 2048 AND "memlia_desktop_agent_certificate"."windows_sid" ~ '^S-1-([0-9]+-){1,14}[0-9]+$' AND "memlia_desktop_agent_certificate"."certificate_serial" ~ '^[a-f0-9]{1,40}$' AND octet_length("memlia_desktop_agent_certificate"."certificate_pem") BETWEEN 1 AND 16384)
);
--> statement-breakpoint
CREATE TABLE "memlia_desktop_agent_enrollment" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text,
	"workspace_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"installation_id" text NOT NULL,
	"fqdn" text NOT NULL,
	"code_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revision" bigint DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"revoked_at" timestamp with time zone,
	"csr_sha256" text,
	"spki_sha256" text,
	"windows_sid" text,
	"challenge" text,
	"challenge_digest" text,
	"issuance_id" text,
	"agent_id" text,
	"certificate_serial" text,
	"certificate_sha256" text,
	"issued_at" timestamp with time zone,
	CONSTRAINT "memlia_agent_enroll_lifetime" CHECK ("memlia_desktop_agent_enrollment"."expires_at" > "memlia_desktop_agent_enrollment"."created_at" AND "memlia_desktop_agent_enrollment"."expires_at" <= "memlia_desktop_agent_enrollment"."created_at" + interval '5 minutes'),
	CONSTRAINT "memlia_agent_enroll_revision" CHECK ("memlia_desktop_agent_enrollment"."revision" BETWEEN 0 AND 9007199254740991),
	CONSTRAINT "memlia_agent_enroll_hashes" CHECK ("memlia_desktop_agent_enrollment"."code_hash" ~ '^[a-f0-9]{64}$' AND ("memlia_desktop_agent_enrollment"."csr_sha256" IS NULL OR "memlia_desktop_agent_enrollment"."csr_sha256" ~ '^[a-f0-9]{64}$') AND ("memlia_desktop_agent_enrollment"."spki_sha256" IS NULL OR "memlia_desktop_agent_enrollment"."spki_sha256" ~ '^[a-f0-9]{64}$') AND ("memlia_desktop_agent_enrollment"."challenge_digest" IS NULL OR "memlia_desktop_agent_enrollment"."challenge_digest" ~ '^[a-f0-9]{64}$') AND ("memlia_desktop_agent_enrollment"."certificate_sha256" IS NULL OR "memlia_desktop_agent_enrollment"."certificate_sha256" ~ '^[a-f0-9]{64}$')),
	CONSTRAINT "memlia_agent_enroll_state" CHECK ("memlia_desktop_agent_enrollment"."status" IN ('pending','challenged','issuing','issued','issuance_unknown','revoked') AND (("memlia_desktop_agent_enrollment"."status" = 'revoked') = ("memlia_desktop_agent_enrollment"."revoked_at" IS NOT NULL))),
	CONSTRAINT "memlia_agent_enroll_bound" CHECK ("memlia_desktop_agent_enrollment"."status" NOT IN ('challenged','issuing','issued','issuance_unknown') OR ("memlia_desktop_agent_enrollment"."csr_sha256" IS NOT NULL AND "memlia_desktop_agent_enrollment"."spki_sha256" IS NOT NULL AND "memlia_desktop_agent_enrollment"."windows_sid" IS NOT NULL AND "memlia_desktop_agent_enrollment"."challenge" IS NOT NULL AND "memlia_desktop_agent_enrollment"."challenge_digest" IS NOT NULL)),
	CONSTRAINT "memlia_agent_enroll_issuance" CHECK ("memlia_desktop_agent_enrollment"."status" NOT IN ('issuing','issued','issuance_unknown') OR ("memlia_desktop_agent_enrollment"."issuance_id" IS NOT NULL AND "memlia_desktop_agent_enrollment"."agent_id" IS NOT NULL)),
	CONSTRAINT "memlia_agent_enroll_issued" CHECK ("memlia_desktop_agent_enrollment"."status" <> 'issued' OR ("memlia_desktop_agent_enrollment"."certificate_serial" IS NOT NULL AND "memlia_desktop_agent_enrollment"."certificate_sha256" IS NOT NULL AND "memlia_desktop_agent_enrollment"."issued_at" IS NOT NULL)),
	CONSTRAINT "memlia_agent_enroll_input_bounds" CHECK (length("memlia_desktop_agent_enrollment"."id") BETWEEN 1 AND 128 AND length("memlia_desktop_agent_enrollment"."installation_id") BETWEEN 1 AND 128 AND length("memlia_desktop_agent_enrollment"."fqdn") BETWEEN 1 AND 2048 AND ("memlia_desktop_agent_enrollment"."challenge" IS NULL OR "memlia_desktop_agent_enrollment"."challenge" ~ '^[A-Za-z0-9_-]{43}$') AND ("memlia_desktop_agent_enrollment"."windows_sid" IS NULL OR "memlia_desktop_agent_enrollment"."windows_sid" ~ '^S-1-([0-9]+-){1,14}[0-9]+$'))
);
--> statement-breakpoint
ALTER TABLE "memlia_desktop_agent_certificate" ADD CONSTRAINT "memlia_agent_cert_enrollment_fk" FOREIGN KEY ("enrollment_id") REFERENCES "public"."memlia_desktop_agent_enrollment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memlia_desktop_agent_certificate" ADD CONSTRAINT "memlia_agent_cert_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memlia_desktop_agent_certificate" ADD CONSTRAINT "memlia_agent_cert_owner_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memlia_desktop_agent_certificate" ADD CONSTRAINT "memlia_agent_cert_organization_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memlia_desktop_agent_enrollment" ADD CONSTRAINT "memlia_agent_enroll_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memlia_desktop_agent_enrollment" ADD CONSTRAINT "memlia_agent_enroll_owner_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memlia_desktop_agent_enrollment" ADD CONSTRAINT "memlia_agent_enroll_organization_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "memlia_agent_cert_enrollment_uq" ON "memlia_desktop_agent_certificate" USING btree ("enrollment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "memlia_agent_cert_serial_uq" ON "memlia_desktop_agent_certificate" USING btree ("certificate_serial");--> statement-breakpoint
CREATE UNIQUE INDEX "memlia_agent_cert_fingerprint_uq" ON "memlia_desktop_agent_certificate" USING btree ("certificate_sha256");--> statement-breakpoint
CREATE INDEX "memlia_agent_cert_agent_idx" ON "memlia_desktop_agent_certificate" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "memlia_agent_cert_owner_idx" ON "memlia_desktop_agent_certificate" USING btree ("workspace_id","owner_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "memlia_agent_enroll_code_uq" ON "memlia_desktop_agent_enrollment" USING btree ("code_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "memlia_agent_enroll_issuance_uq" ON "memlia_desktop_agent_enrollment" USING btree ("issuance_id");--> statement-breakpoint
CREATE INDEX "memlia_agent_enroll_owner_idx" ON "memlia_desktop_agent_enrollment" USING btree ("workspace_id","owner_user_id");--> statement-breakpoint
CREATE INDEX "memlia_agent_enroll_expiry_idx" ON "memlia_desktop_agent_enrollment" USING btree ("status","expires_at");