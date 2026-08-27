CREATE TABLE "classifier_centroid" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope" text NOT NULL,
	"label" text NOT NULL,
	"model" text NOT NULL,
	"exemplar_sha" text NOT NULL,
	"embedding" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "classifier_centroid_uniq" ON "classifier_centroid" USING btree ("scope","label","model","exemplar_sha");--> statement-breakpoint
CREATE INDEX "classifier_centroid_scope_idx" ON "classifier_centroid" USING btree ("scope");