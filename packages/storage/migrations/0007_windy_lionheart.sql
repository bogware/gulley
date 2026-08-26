ALTER TABLE "request_log" ADD COLUMN "attributes" jsonb;--> statement-breakpoint
CREATE INDEX "request_log_ws_created_idx" ON "request_log" USING btree ("workspace_id","created_at");