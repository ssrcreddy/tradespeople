CREATE TYPE "public"."email_event_type" AS ENUM('delivered', 'bounced', 'complained', 'opened');--> statement-breakpoint
CREATE TYPE "public"."inbound_disposition" AS ENUM('job', 'quarantined', 'dropped', 'rate_limited');--> statement-breakpoint
CREATE TYPE "public"."invoice_kind" AS ENUM('deposit', 'final');--> statement-breakpoint
CREATE TYPE "public"."invoice_status" AS ENUM('issued', 'sending', 'sent', 'paid', 'void');--> statement-breakpoint
CREATE TYPE "public"."job_source" AS ENUM('email_forward', 'paste', 'upload', 'share', 'site_notes', 'manual');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('received', 'extracting', 'draft_ready', 'in_review', 'needs_info', 'extraction_failed', 'closed');--> statement-breakpoint
CREATE TYPE "public"."line_unit" AS ENUM('each', 'hour', 'flat', 'metre', 'foot');--> statement-breakpoint
CREATE TYPE "public"."member_role" AS ENUM('owner', 'member');--> statement-breakpoint
CREATE TYPE "public"."notify_channel" AS ENUM('email', 'push');--> statement-breakpoint
CREATE TYPE "public"."price_book_kind" AS ENUM('labour', 'material', 'callout', 'fixed_job', 'assembly');--> statement-breakpoint
CREATE TYPE "public"."quote_status" AS ENUM('draft', 'approved', 'sending', 'sent', 'accepted', 'declined', 'expired', 'superseded');--> statement-breakpoint
CREATE TYPE "public"."sent_via" AS ENUM('email', 'manual_share');--> statement-breakpoint
CREATE TYPE "public"."source_kind" AS ENUM('text', 'photo', 'manual', 'assembly');--> statement-breakpoint
CREATE TYPE "public"."trade" AS ENUM('electrical');--> statement-breakpoint
CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assembly_components" (
	"business_id" uuid NOT NULL,
	"assembly_id" uuid NOT NULL,
	"component_id" uuid NOT NULL,
	"qty_milli" integer NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "assembly_components_assembly_id_component_id_pk" PRIMARY KEY("assembly_id","component_id"),
	CONSTRAINT "assembly_components_qty" CHECK ("assembly_components"."qty_milli" > 0),
	CONSTRAINT "assembly_components_not_self" CHECK ("assembly_components"."assembly_id" <> "assembly_components"."component_id")
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"business_id" uuid NOT NULL,
	"actor" text NOT NULL,
	"entity" text NOT NULL,
	"entity_id" text NOT NULL,
	"action" text NOT NULL,
	"diff" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "businesses" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"trade" "trade" DEFAULT 'electrical' NOT NULL,
	"tax_components" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"currency" char(3) DEFAULT 'CAD' NOT NULL,
	"timezone" text DEFAULT 'America/Toronto' NOT NULL,
	"locale" text DEFAULT 'en-CA' NOT NULL,
	"logo_path" text,
	"reply_to_email" text,
	"sender_allowlist" text[] DEFAULT '{}'::text[] NOT NULL,
	"intake_token" text NOT NULL,
	"terms_days" integer DEFAULT 14 NOT NULL,
	"quote_expiry_days" integer DEFAULT 30 NOT NULL,
	"deposit_pct_default" integer DEFAULT 0 NOT NULL,
	"collapse_assemblies" boolean DEFAULT true NOT NULL,
	"next_quote_no" integer DEFAULT 1 NOT NULL,
	"next_invoice_no" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "businesses_intake_token_unique" UNIQUE("intake_token"),
	CONSTRAINT "businesses_deposit_pct" CHECK ("businesses"."deposit_pct_default" between 0 and 100),
	CONSTRAINT "businesses_terms" CHECK ("businesses"."terms_days" between 0 and 365 and "businesses"."quote_expiry_days" between 1 and 365)
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"name" text NOT NULL,
	"email" text,
	"phone" text,
	"site_address" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customers_contact" CHECK ("customers"."email" is not null or "customers"."phone" is not null)
);
--> statement-breakpoint
CREATE TABLE "email_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"provider_id" text NOT NULL,
	"type" "email_event_type" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inbound_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid,
	"provider_message_id" text NOT NULL,
	"raw_object_key" text NOT NULL,
	"from_addr" text NOT NULL,
	"disposition" "inbound_disposition" NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inbound_messages_provider_message_id_unique" UNIQUE("provider_message_id")
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"quote_id" uuid NOT NULL,
	"kind" "invoice_kind" NOT NULL,
	"number" integer NOT NULL,
	"status" "invoice_status" DEFAULT 'issued' NOT NULL,
	"due_date" date,
	"amount_cents" integer NOT NULL,
	"tax_cents" integer NOT NULL,
	"paid_cents" integer DEFAULT 0 NOT NULL,
	"snapshot" jsonb NOT NULL,
	"pdf_object_key" text,
	"pdf_sha256" text,
	"provider_email_id" text,
	"sent_at" timestamp with time zone,
	"reminders_sent" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoices_quote_kind" UNIQUE("quote_id","kind"),
	CONSTRAINT "invoices_number" UNIQUE("business_id","number"),
	CONSTRAINT "invoices_paid_bound" CHECK ("invoices"."paid_cents" >= 0 and "invoices"."paid_cents" <= "invoices"."amount_cents")
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"customer_id" uuid,
	"inbound_message_id" uuid,
	"source" "job_source" NOT NULL,
	"original_text" text DEFAULT '' NOT NULL,
	"original_files" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"provider_message_id" text,
	"status" "job_status" DEFAULT 'received' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "jobs_provider_message_id_unique" UNIQUE("provider_message_id")
);
--> statement-breakpoint
CREATE TABLE "llm_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"job_id" uuid,
	"purpose" text NOT NULL,
	"model" text NOT NULL,
	"prompt_version" text NOT NULL,
	"input_tokens" integer NOT NULL,
	"output_tokens" integer NOT NULL,
	"image_count" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(10, 6) NOT NULL,
	"latency_ms" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"business_id" uuid NOT NULL,
	"role" "member_role" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memberships_user_business" UNIQUE("user_id","business_id")
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"entity_id" text NOT NULL,
	"channel" "notify_channel" NOT NULL,
	"sent_at" timestamp with time zone,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notifications_dedupe" UNIQUE("business_id","kind","entity_id","channel")
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"amount_cents" integer NOT NULL,
	"method" text NOT NULL,
	"received_on" date NOT NULL,
	"note" text,
	"recorded_by" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_idempotency" UNIQUE("business_id","idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "price_book_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"kind" "price_book_kind" NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"unit" "line_unit" NOT NULL,
	"cost_cents" integer,
	"markup_ppm" integer,
	"rate_cents" integer,
	"aliases" text[] DEFAULT '{}'::text[] NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "price_book_money" CHECK (coalesce("price_book_items"."rate_cents", 0) >= 0 and coalesce("price_book_items"."cost_cents", 0) >= 0 and coalesce("price_book_items"."markup_ppm", 0) >= 0),
	CONSTRAINT "price_book_assembly_no_rate" CHECK ("price_book_items"."kind" <> 'assembly' or "price_book_items"."rate_cents" is null)
);
--> statement-breakpoint
CREATE TABLE "quote_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"quote_id" uuid NOT NULL,
	"sort" integer NOT NULL,
	"description" text NOT NULL,
	"qty_milli" integer NOT NULL,
	"unit" "line_unit" NOT NULL,
	"unit_price_cents" integer,
	"line_total_cents" integer,
	"price_book_item_id" uuid,
	"needs_price" boolean NOT NULL,
	"optional" boolean DEFAULT false NOT NULL,
	"group_key" text,
	"source_kind" "source_kind" DEFAULT 'manual' NOT NULL,
	"source_quote" text,
	"extracted_snapshot" jsonb,
	CONSTRAINT "quote_lines_qty" CHECK ("quote_lines"."qty_milli" > 0),
	CONSTRAINT "quote_lines_price" CHECK ("quote_lines"."unit_price_cents" is null or "quote_lines"."unit_price_cents" >= 0),
	CONSTRAINT "quote_lines_needs_price" CHECK ("quote_lines"."needs_price" = ("quote_lines"."unit_price_cents" is null))
);
--> statement-breakpoint
CREATE TABLE "quotes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"job_id" uuid,
	"customer_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"parent_quote_id" uuid,
	"status" "quote_status" DEFAULT 'draft' NOT NULL,
	"discount_cents" integer DEFAULT 0 NOT NULL,
	"subtotal_cents" integer DEFAULT 0 NOT NULL,
	"tax_cents" integer DEFAULT 0 NOT NULL,
	"total_cents" integer DEFAULT 0 NOT NULL,
	"optional_total_cents" integer DEFAULT 0 NOT NULL,
	"taxes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"totals_complete" boolean DEFAULT false NOT NULL,
	"terms" text DEFAULT '' NOT NULL,
	"deposit_pct" integer DEFAULT 0 NOT NULL,
	"lock_version" integer DEFAULT 0 NOT NULL,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"snapshot" jsonb,
	"pdf_object_key" text,
	"pdf_sha256" text,
	"sent_at" timestamp with time zone,
	"sent_via" "sent_via",
	"provider_email_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quotes_number_version" UNIQUE("business_id","number","version"),
	CONSTRAINT "quotes_discount_bound" CHECK ("quotes"."discount_cents" >= 0 and "quotes"."discount_cents" <= "quotes"."subtotal_cents"),
	CONSTRAINT "quotes_total_identity" CHECK ("quotes"."total_cents" = "quotes"."subtotal_cents" - "quotes"."discount_cents" + "quotes"."tax_cents"),
	CONSTRAINT "quotes_money_nonneg" CHECK ("quotes"."subtotal_cents" >= 0 and "quotes"."tax_cents" >= 0 and "quotes"."optional_total_cents" >= 0),
	CONSTRAINT "quotes_deposit_pct" CHECK ("quotes"."deposit_pct" between 0 and 100)
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "usage_counters" (
	"business_id" uuid NOT NULL,
	"month" date NOT NULL,
	"quotes_approved" integer DEFAULT 0 NOT NULL,
	"llm_cost_usd" numeric(12, 6) DEFAULT '0' NOT NULL,
	CONSTRAINT "usage_counters_business_id_month_pk" PRIMARY KEY("business_id","month")
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assembly_components" ADD CONSTRAINT "assembly_components_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assembly_components" ADD CONSTRAINT "assembly_components_assembly_id_price_book_items_id_fk" FOREIGN KEY ("assembly_id") REFERENCES "public"."price_book_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assembly_components" ADD CONSTRAINT "assembly_components_component_id_price_book_items_id_fk" FOREIGN KEY ("component_id") REFERENCES "public"."price_book_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_events" ADD CONSTRAINT "email_events_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_messages" ADD CONSTRAINT "inbound_messages_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_quote_id_quotes_id_fk" FOREIGN KEY ("quote_id") REFERENCES "public"."quotes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_inbound_message_id_inbound_messages_id_fk" FOREIGN KEY ("inbound_message_id") REFERENCES "public"."inbound_messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_calls" ADD CONSTRAINT "llm_calls_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_calls" ADD CONSTRAINT "llm_calls_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_book_items" ADD CONSTRAINT "price_book_items_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_lines" ADD CONSTRAINT "quote_lines_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_lines" ADD CONSTRAINT "quote_lines_quote_id_quotes_id_fk" FOREIGN KEY ("quote_id") REFERENCES "public"."quotes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_lines" ADD CONSTRAINT "quote_lines_price_book_item_id_price_book_items_id_fk" FOREIGN KEY ("price_book_item_id") REFERENCES "public"."price_book_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_counters" ADD CONSTRAINT "usage_counters_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_entity" ON "audit_events" USING btree ("business_id","entity","entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "customers_business_email" ON "customers" USING btree ("business_id",lower("email")) WHERE "customers"."email" is not null;--> statement-breakpoint
CREATE INDEX "invoices_business_due" ON "invoices" USING btree ("business_id","due_date","status");--> statement-breakpoint
CREATE INDEX "jobs_business_status" ON "jobs" USING btree ("business_id","status","created_at");--> statement-breakpoint
CREATE INDEX "price_book_business_active" ON "price_book_items" USING btree ("business_id","active");--> statement-breakpoint
CREATE INDEX "quote_lines_quote" ON "quote_lines" USING btree ("quote_id","sort");--> statement-breakpoint
CREATE INDEX "quotes_business_status" ON "quotes" USING btree ("business_id","status");