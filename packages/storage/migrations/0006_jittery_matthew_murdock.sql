CREATE TABLE "config_version" (
	"version" integer PRIMARY KEY NOT NULL,
	"content_hash" text NOT NULL,
	"yaml" text NOT NULL,
	"actor" text NOT NULL,
	"summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"audit_seq" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "config_version_hash_idx" ON "config_version" USING btree ("content_hash");--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='gulley_app') THEN CREATE ROLE gulley_app NOLOGIN; END IF; END $$;--> statement-breakpoint
REVOKE UPDATE, DELETE ON "config_version" FROM gulley_app;--> statement-breakpoint
CREATE OR REPLACE FUNCTION config_version_no_mutate() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'config_version is append-only'; END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS config_version_immutable ON "config_version";--> statement-breakpoint
CREATE TRIGGER config_version_immutable BEFORE UPDATE OR DELETE ON "config_version" FOR EACH ROW EXECUTE FUNCTION config_version_no_mutate();
