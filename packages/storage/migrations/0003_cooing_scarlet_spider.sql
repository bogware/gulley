CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE TABLE "cache_entry" (
	"key" text PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"provider" text DEFAULT '' NOT NULL,
	"model" text NOT NULL,
	"status_code" integer NOT NULL,
	"streamed" boolean DEFAULT false NOT NULL,
	"headers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"body" text NOT NULL,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "semantic_vector" (
	"key" text PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"embedding" vector(256) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "semantic_vector" ADD CONSTRAINT "semantic_vector_key_cache_entry_key_fk" FOREIGN KEY ("key") REFERENCES "public"."cache_entry"("key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cache_entry_scope_idx" ON "cache_entry" USING btree ("scope");--> statement-breakpoint
CREATE INDEX "cache_entry_expires_idx" ON "cache_entry" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "semantic_vector_scope_idx" ON "semantic_vector" USING btree ("scope");--> statement-breakpoint
CREATE INDEX "semantic_vector_embedding_idx" ON "semantic_vector" USING hnsw ("embedding" vector_cosine_ops);