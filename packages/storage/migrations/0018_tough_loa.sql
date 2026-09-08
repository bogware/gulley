ALTER TABLE "admin_session" ALTER COLUMN "token_hash" SET DEFAULT '';--> statement-breakpoint
ALTER TABLE "admin_session" ADD COLUMN "source" text DEFAULT 'exchange' NOT NULL;--> statement-breakpoint
ALTER TABLE "admin_session" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;