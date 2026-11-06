-- Days 11–15: tenant isolation for the suppression list, and the narrow
-- cross-tenant lookups the worker and provider webhooks need. SECURITY DEFINER,
-- IDs and addresses only — never document content.
ALTER TABLE "email_suppressions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "email_suppressions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "email_suppressions"
  USING (business_id = app_current_business()) WITH CHECK (business_id = app_current_business());
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "email_suppressions" TO app;
--> statement-breakpoint

-- Outbound delivery events carry the provider's email id; find its document.
CREATE OR REPLACE FUNCTION app_document_by_provider_email(p_email_id text)
  RETURNS TABLE (business_id uuid, kind text, document_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
  AS $$
    SELECT q.business_id, 'quote', q.id FROM quotes q WHERE q.provider_email_id = p_email_id
    UNION ALL
    SELECT i.business_id, 'invoice', i.id FROM invoices i WHERE i.provider_email_id = p_email_id
    LIMIT 1
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_document_by_provider_email(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_document_by_provider_email(text) TO app;
--> statement-breakpoint

-- Documents left in `sending` (stuck-sweep, design §14).
CREATE OR REPLACE FUNCTION app_stuck_documents(p_minutes int)
  RETURNS TABLE (business_id uuid, kind text, document_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
  AS $$
    SELECT q.business_id, 'quote', q.id FROM quotes q
      WHERE q.status = 'sending' AND q.updated_at < now() - make_interval(mins => p_minutes)
    UNION ALL
    SELECT i.business_id, 'invoice', i.id FROM invoices i
      WHERE i.status = 'sending' AND i.updated_at < now() - make_interval(mins => p_minutes)
    LIMIT 200
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_stuck_documents(int) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_stuck_documents(int) TO app;
--> statement-breakpoint

-- Sent quotes past their expiry date in the business's own timezone (§14).
CREATE OR REPLACE FUNCTION app_expired_quotes()
  RETURNS TABLE (business_id uuid, quote_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
  AS $$
    SELECT q.business_id, q.id
    FROM quotes q JOIN businesses b ON b.id = q.business_id
    WHERE q.status = 'sent'
      AND (q.snapshot->>'expiresOn')::date < (now() AT TIME ZONE b.timezone)::date
    LIMIT 500
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_expired_quotes() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_expired_quotes() TO app;
