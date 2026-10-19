CREATE TABLE "memlia_chat_cost_reservation" (
	"attempt_id" text PRIMARY KEY NOT NULL,
	"window_id" text NOT NULL,
	"window_version" integer NOT NULL,
	"actor_user_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"billed_account_user_id" text NOT NULL,
	"organization_id" text,
	"billing_entity_type" "billing_entity_type" NOT NULL,
	"billing_entity_id" text NOT NULL,
	"billing_period_start" timestamp NOT NULL,
	"billing_period_end" timestamp NOT NULL,
	"attribution" jsonb NOT NULL,
	"maximum_cost_usd" numeric(21, 12) NOT NULL,
	"state" text NOT NULL,
	"event_key" text NOT NULL,
	"ledger_id" text,
	"settled_cost_usd" numeric(21, 12),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone,
	CONSTRAINT "memlia_chat_cost_reservation_event_key_unique" UNIQUE("event_key"),
	CONSTRAINT "memlia_chat_cost_reservation_bounds" CHECK (
      length("memlia_chat_cost_reservation"."attempt_id") BETWEEN 1 AND 128 AND "memlia_chat_cost_reservation"."window_version" > 0
      AND "memlia_chat_cost_reservation"."maximum_cost_usd" > 0 AND "memlia_chat_cost_reservation"."maximum_cost_usd" <= 999999999
      AND "memlia_chat_cost_reservation"."billing_period_start" < "memlia_chat_cost_reservation"."billing_period_end"
      AND "memlia_chat_cost_reservation"."state" IN ('reserved', 'unknown', 'settled')),
	CONSTRAINT "memlia_chat_cost_reservation_settlement" CHECK (
      ("memlia_chat_cost_reservation"."state" IN ('reserved', 'unknown') AND "memlia_chat_cost_reservation"."ledger_id" IS NULL
        AND "memlia_chat_cost_reservation"."settled_cost_usd" IS NULL AND "memlia_chat_cost_reservation"."settled_at" IS NULL)
      OR ("memlia_chat_cost_reservation"."state" = 'settled' AND "memlia_chat_cost_reservation"."ledger_id" IS NOT NULL
        AND "memlia_chat_cost_reservation"."settled_cost_usd" IS NOT NULL
        AND "memlia_chat_cost_reservation"."settled_cost_usd" > 0 AND "memlia_chat_cost_reservation"."settled_cost_usd" <= 999999999
        AND "memlia_chat_cost_reservation"."settled_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "memlia_chat_cost_window" (
	"id" text PRIMARY KEY NOT NULL,
	"version" integer NOT NULL,
	"currency" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"limit_usd" numeric(21, 12) NOT NULL,
	"state" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memlia_chat_cost_window_bounds" CHECK (
      length("memlia_chat_cost_window"."id") BETWEEN 1 AND 128 AND "memlia_chat_cost_window"."version" > 0
      AND "memlia_chat_cost_window"."currency" = 'USD' AND "memlia_chat_cost_window"."starts_at" < "memlia_chat_cost_window"."ends_at"
      AND "memlia_chat_cost_window"."limit_usd" >= 0 AND "memlia_chat_cost_window"."limit_usd" <= 999999999
      AND "memlia_chat_cost_window"."state" IN ('open', 'blocked'))
);
--> statement-breakpoint
ALTER TABLE "memlia_chat_cost_reservation" ADD CONSTRAINT "memlia_chat_cost_reservation_window_id_memlia_chat_cost_window_id_fk" FOREIGN KEY ("window_id") REFERENCES "public"."memlia_chat_cost_window"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memlia_chat_cost_reservation_window_state_idx" ON "memlia_chat_cost_reservation" USING btree ("window_id","state");