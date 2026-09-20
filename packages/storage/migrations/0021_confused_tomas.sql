CREATE INDEX "admin_session_subject_idx" ON "admin_session" USING btree ("subject");--> statement-breakpoint
CREATE INDEX "admin_session_created_idx" ON "admin_session" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "auth_code_expires_idx" ON "auth_code" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "device_code_expires_idx" ON "device_code" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "oauth_grant_created_idx" ON "oauth_grant" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "request_log_request_id_idx" ON "request_log" USING btree ("request_id","created_at");--> statement-breakpoint
CREATE INDEX "spend_ledger_ws_created_idx" ON "spend_ledger" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "spend_ledger_request_idx" ON "spend_ledger" USING btree ("request_id");--> statement-breakpoint
-- Append-only hardening: the row-level UPDATE/DELETE triggers (0004, 0006) did not
-- cover TRUNCATE, which the table owner could still run. Statement-level triggers
-- close that gap for both hash-chained tables. (A least-privilege login role that
-- is NOT the owner remains the recommended deployment posture; see docs.)
DROP TRIGGER IF EXISTS audit_log_no_truncate ON "audit_log";--> statement-breakpoint
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON "audit_log" FOR EACH STATEMENT EXECUTE FUNCTION audit_log_immutable();--> statement-breakpoint
DROP TRIGGER IF EXISTS config_version_no_truncate ON "config_version";--> statement-breakpoint
CREATE TRIGGER config_version_no_truncate BEFORE TRUNCATE ON "config_version" FOR EACH STATEMENT EXECUTE FUNCTION config_version_no_mutate();
