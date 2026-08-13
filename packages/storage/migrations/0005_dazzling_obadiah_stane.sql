CREATE TABLE "auth_code" (
	"code" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"redirect_uri" text NOT NULL,
	"code_challenge" text NOT NULL,
	"principal_id" text NOT NULL,
	"display_name" text NOT NULL,
	"org_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "device_code" (
	"device_code" text PRIMARY KEY NOT NULL,
	"user_code" text NOT NULL,
	"client_id" text NOT NULL,
	"status" text NOT NULL,
	"principal_id" text,
	"display_name" text,
	"expires_at" timestamp with time zone NOT NULL,
	"last_polled_at" bigint DEFAULT 0 NOT NULL,
	"interval_ms" integer DEFAULT 5000 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_client" (
	"client_id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"org_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"grant_types" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"redirect_allowlist" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_grant" (
	"handle" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"principal_id" text NOT NULL,
	"display_name" text NOT NULL,
	"org_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"status" text NOT NULL,
	"access_token_hash" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_hash" text,
	"prev_refresh_token_hash" text,
	"refresh_generation" integer DEFAULT 0 NOT NULL,
	"absolute_expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "oauth_client" ADD CONSTRAINT "oauth_client_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_client" ADD CONSTRAINT "oauth_client_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "device_code_user_idx" ON "device_code" USING btree ("user_code");--> statement-breakpoint
CREATE INDEX "oauth_grant_client_idx" ON "oauth_grant" USING btree ("client_id");