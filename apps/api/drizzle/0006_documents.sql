CREATE TABLE "email_suppressions" (
	"business_id" uuid NOT NULL,
	"email" text NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_suppressions_business_id_email_pk" PRIMARY KEY("business_id","email")
);
--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "monthly_quote_limit" integer DEFAULT 20;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "sent_via" "sent_via";--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "last_send_error" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "quotes" ADD COLUMN "accepted_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "quotes" ADD COLUMN "usage_counted" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "quotes" ADD COLUMN "last_send_error" text;--> statement-breakpoint
ALTER TABLE "quotes" ADD COLUMN "outcome_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "email_suppressions" ADD CONSTRAINT "email_suppressions_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;