CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
ALTER TABLE "classifier_centroid" ADD COLUMN "embedding_vec" vector(256);--> statement-breakpoint
UPDATE "classifier_centroid" SET "embedding_vec" = ("embedding"::text)::vector WHERE "embedding_vec" IS NULL;--> statement-breakpoint
CREATE INDEX "classifier_centroid_scope_model_idx" ON "classifier_centroid" USING btree ("scope","model");--> statement-breakpoint
CREATE INDEX "classifier_centroid_embedding_idx" ON "classifier_centroid" USING hnsw ("embedding_vec" vector_cosine_ops);
