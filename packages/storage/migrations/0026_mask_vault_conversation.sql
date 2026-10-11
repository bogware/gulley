ALTER TABLE "mask_vault" ADD COLUMN "conversation_id" text;--> statement-breakpoint
CREATE INDEX "mask_vault_conversation_idx" ON "mask_vault" USING btree ("conversation_id");