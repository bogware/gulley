CREATE TABLE "subject_key" (
	"subject" text PRIMARY KEY NOT NULL,
	"wrapped_key" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"shredded_at" timestamp with time zone
);
