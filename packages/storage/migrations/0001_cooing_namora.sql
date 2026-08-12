CREATE TABLE "request_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" text NOT NULL,
	"principal_id" text NOT NULL,
	"workspace_id" uuid,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"route" text NOT NULL,
	"status_code" integer NOT NULL,
	"status" text NOT NULL,
	"streamed" boolean DEFAULT false NOT NULL,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"cost_micro_usd" bigint DEFAULT 0 NOT NULL,
	"latency_ms" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "spend_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" text NOT NULL,
	"principal_id" text NOT NULL,
	"org_id" uuid,
	"workspace_id" uuid,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"status" text NOT NULL,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"cost_micro_usd" bigint DEFAULT 0 NOT NULL,
	"priced" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "request_log_workspace_idx" ON "request_log" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "request_log_created_idx" ON "request_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "spend_ledger_workspace_idx" ON "spend_ledger" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "spend_ledger_created_idx" ON "spend_ledger" USING btree ("created_at");