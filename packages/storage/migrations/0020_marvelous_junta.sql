ALTER TABLE "provider" ADD COLUMN "region" text;--> statement-breakpoint
ALTER TABLE "provider" ADD COLUMN "zdr" boolean DEFAULT false NOT NULL;