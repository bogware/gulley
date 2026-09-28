-- Prompt registry tamper-evidence (release-readiness audit #15). `prompt_version` is
-- append-only and hash-chained (row hash covers prev_hash + body + author/time/message),
-- but — unlike audit_log/config_version — it had no DB-level immutability, so an in-place
-- UPDATE of a version body with a recomputed forward chain was undetectable.
--
-- Block UPDATE and TRUNCATE only, NOT DELETE: prompt_version has ON DELETE cascade from
-- prompt_template/workspace, and dropping an individual version leaves a detectable gap in
-- the (template_id, version) sequence — whereas an in-place rewrite does not. The trigger
-- fires for every role (the table owner too), so it is the real guard; the REVOKE mirrors
-- the audit_log/config_version pattern for a least-privilege app login role.
REVOKE UPDATE ON "prompt_version" FROM gulley_app;--> statement-breakpoint
CREATE OR REPLACE FUNCTION prompt_version_no_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'prompt_version is append-only (a version is immutable; delete the template to remove its versions)'; END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS prompt_version_immutable ON "prompt_version";--> statement-breakpoint
CREATE TRIGGER prompt_version_immutable BEFORE UPDATE ON "prompt_version" FOR EACH ROW EXECUTE FUNCTION prompt_version_no_update();--> statement-breakpoint
DROP TRIGGER IF EXISTS prompt_version_no_truncate ON "prompt_version";--> statement-breakpoint
CREATE TRIGGER prompt_version_no_truncate BEFORE TRUNCATE ON "prompt_version" FOR EACH STATEMENT EXECUTE FUNCTION prompt_version_no_update();
