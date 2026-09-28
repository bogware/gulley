DROP INDEX "guardrail_workspace_idx";--> statement-breakpoint
DROP INDEX "model_alias_workspace_idx";--> statement-breakpoint
DROP INDEX "rate_limit_workspace_idx";--> statement-breakpoint
DROP INDEX "route_workspace_idx";--> statement-breakpoint
DROP INDEX "route_policy_workspace_idx";--> statement-breakpoint
DROP INDEX "smart_routing_policy_workspace_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "guardrail_workspace_name_idx" ON "guardrail" USING btree ("workspace_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "model_alias_workspace_name_idx" ON "model_alias" USING btree ("workspace_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "rate_limit_workspace_name_idx" ON "rate_limit" USING btree ("workspace_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "route_workspace_name_idx" ON "route" USING btree ("workspace_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "route_policy_workspace_name_idx" ON "route_policy" USING btree ("workspace_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "smart_routing_policy_workspace_name_idx" ON "smart_routing_policy" USING btree ("workspace_id","name");