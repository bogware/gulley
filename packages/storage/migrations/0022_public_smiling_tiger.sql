CREATE TABLE "prompt_template" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prompt_version" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"template_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"body" text NOT NULL,
	"variables" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"hash" text NOT NULL,
	"prev_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"message" text
);
--> statement-breakpoint
ALTER TABLE "prompt_template" ADD CONSTRAINT "prompt_template_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prompt_version" ADD CONSTRAINT "prompt_version_template_id_prompt_template_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."prompt_template"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "prompt_template_ws_name_idx" ON "prompt_template" USING btree ("workspace_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "prompt_version_template_version_idx" ON "prompt_version" USING btree ("template_id","version");