CREATE TABLE "mask_vault" (
	"request_id" text NOT NULL,
	"direction" text NOT NULL,
	"workspace_id" uuid NOT NULL,
	"org_id" uuid,
	"ciphertext" jsonb NOT NULL,
	"token_count" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mask_vault_request_id_direction_pk" PRIMARY KEY("request_id","direction")
);
--> statement-breakpoint
CREATE INDEX "mask_vault_workspace_idx" ON "mask_vault" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "mask_vault_expires_idx" ON "mask_vault" USING btree ("expires_at");