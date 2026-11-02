-- Tenant isolation, second layer (design §5, §12). The app connects as the
-- non-owner role "app" (created by src/db/migrate.ts, no BYPASSRLS). Every
-- tenant row is visible only when app.business_id matches; an unset or empty
-- setting raises an error instead of matching nothing silently.

CREATE OR REPLACE FUNCTION app_current_business() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT current_setting('app.business_id')::uuid $$;
--> statement-breakpoint

-- businesses: the row IS the tenant
ALTER TABLE "businesses" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "businesses" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "businesses"
  USING (id = app_current_business()) WITH CHECK (id = app_current_business());
--> statement-breakpoint

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'memberships', 'customers', 'price_book_items', 'assembly_components', 'inbound_messages', 'jobs',
    'quotes', 'quote_lines', 'invoices', 'payments', 'audit_events', 'llm_calls', 'notifications',
    'usage_counters', 'email_events'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (business_id = app_current_business()) WITH CHECK (business_id = app_current_business())', t);
  END LOOP;
END $$;
--> statement-breakpoint

-- Privileges for the app role. audit_events is append-only for it.
GRANT USAGE ON SCHEMA public TO app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app;
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON "audit_events" FROM app;
--> statement-breakpoint
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_current_business() TO app;
--> statement-breakpoint

-- Lookups that must run before a tenant is known. SECURITY DEFINER (owned by
-- the migration role) and narrow: they return IDs only.
CREATE OR REPLACE FUNCTION app_memberships_for_user(p_user_id text)
  RETURNS TABLE (business_id uuid, role member_role)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
  AS $$ SELECT m.business_id, m.role FROM memberships m WHERE m.user_id = p_user_id ORDER BY m.created_at $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_memberships_for_user(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_memberships_for_user(text) TO app;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app_business_by_intake_token(p_token text)
  RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
  AS $$ SELECT b.id FROM businesses b WHERE b.intake_token = p_token $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_business_by_intake_token(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_business_by_intake_token(text) TO app;
--> statement-breakpoint

-- Fuzzy price-book matching (§17). array_to_string is only STABLE, so wrap it
-- in an IMMUTABLE function to use it in an index expression.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION price_book_search_text(p_name text, p_aliases text[]) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS $$ SELECT lower(p_name || ' ' || array_to_string(p_aliases, ' ')) $$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION price_book_search_text(text, text[]) TO app;
--> statement-breakpoint
CREATE INDEX price_book_trgm ON "price_book_items" USING gin (price_book_search_text(name, aliases) gin_trgm_ops);
