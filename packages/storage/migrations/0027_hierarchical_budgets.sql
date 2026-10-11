ALTER TABLE "budget" ALTER COLUMN "workspace_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "budget" ADD COLUMN "scope_kind" text DEFAULT 'workspace' NOT NULL;--> statement-breakpoint
ALTER TABLE "budget" ADD COLUMN "scope_id" text;--> statement-breakpoint
ALTER TABLE "budget" ADD COLUMN "windows" jsonb;--> statement-breakpoint
UPDATE "budget" SET "scope_id" = "workspace_id"::text WHERE "scope_id" IS NULL;--> statement-breakpoint
ALTER TABLE "budget" ALTER COLUMN "scope_id" SET NOT NULL;--> statement-breakpoint
DROP INDEX IF EXISTS "budget_workspace_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "budget_scope_idx" ON "budget" USING btree ("workspace_id","scope_kind","scope_id") WHERE "budget"."workspace_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "budget_org_scope_idx" ON "budget" USING btree ("scope_kind","scope_id") WHERE "budget"."workspace_id" is null;
