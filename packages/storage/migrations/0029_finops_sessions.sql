CREATE INDEX "spend_ledger_session_idx" ON "spend_ledger" USING btree ((("attributes"->>'session')),"created_at");--> statement-breakpoint
CREATE TABLE "session_block" (
	"workspace_id" uuid NOT NULL,
	"session" text NOT NULL,
	"reason" text NOT NULL,
	"source" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	CONSTRAINT "session_block_workspace_id_session_pk" PRIMARY KEY("workspace_id","session"),
	CONSTRAINT "session_block_source_check" CHECK ("source" IN ('runaway', 'manual'))
);--> statement-breakpoint
CREATE INDEX "session_block_expires_idx" ON "session_block" USING btree ("expires_at");
