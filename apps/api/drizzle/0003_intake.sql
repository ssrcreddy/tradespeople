ALTER TABLE "quotes" ALTER COLUMN "customer_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "subject" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "contact_hint" jsonb;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "extraction" jsonb;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "extraction_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "last_error" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "quote_lines" ADD COLUMN "suggestions" jsonb;--> statement-breakpoint
ALTER TABLE "quote_lines" ADD COLUMN "qty_to_confirm" boolean DEFAULT false NOT NULL;