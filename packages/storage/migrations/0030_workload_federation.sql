ALTER TABLE "oauth_grant" ADD COLUMN "kind" text DEFAULT 'user' NOT NULL;--> statement-breakpoint
ALTER TABLE "oauth_grant" ADD COLUMN "federation" text;--> statement-breakpoint
ALTER TABLE "oauth_grant" ADD COLUMN "subject" text;--> statement-breakpoint
ALTER TABLE "oauth_grant" ADD COLUMN "scope" jsonb;--> statement-breakpoint
ALTER TABLE "oauth_grant" ADD COLUMN "on_behalf_of" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "oauth_grant_principal_idx" ON "oauth_grant" USING btree ("principal_id");--> statement-breakpoint
CREATE INDEX "oauth_grant_absolute_expires_idx" ON "oauth_grant" USING btree ("absolute_expires_at");
