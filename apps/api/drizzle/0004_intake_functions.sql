-- Intake helpers that must work before (or across) tenants. SECURITY DEFINER,
-- owned by the migration role, narrow in what they accept and return.

-- A verified webhook for an unknown intake token: recorded with a null tenant
-- (the app role cannot insert a null business_id under RLS) for debugging.
CREATE OR REPLACE FUNCTION app_record_unrouted_inbound(p_provider_message_id text, p_raw_key text, p_from text)
  RETURNS void
  LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public
  AS $$
    INSERT INTO inbound_messages (business_id, provider_message_id, raw_object_key, from_addr, disposition)
    VALUES (NULL, p_provider_message_id, p_raw_key, p_from, 'dropped')
    ON CONFLICT (provider_message_id) DO NOTHING
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_record_unrouted_inbound(text, text, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_record_unrouted_inbound(text, text, text) TO app;
--> statement-breakpoint

-- Stuck-job sweep (design §14): the worker scans every tenant, so this returns
-- only what it needs to re-drive a job — never job content.
CREATE OR REPLACE FUNCTION app_stuck_jobs(p_received_minutes int, p_extracting_minutes int)
  RETURNS TABLE (id uuid, business_id uuid, status job_status, needs_fetch boolean)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
  AS $$
    SELECT j.id, j.business_id, j.status,
           (j.source = 'email_forward' AND j.original_text = '' AND j.original_files = '[]'::jsonb)
    FROM jobs j
    WHERE (j.status = 'received'   AND j.updated_at < now() - make_interval(mins => p_received_minutes))
       OR (j.status = 'extracting' AND j.updated_at < now() - make_interval(mins => p_extracting_minutes))
    ORDER BY j.updated_at
    LIMIT 200
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_stuck_jobs(int, int) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_stuck_jobs(int, int) TO app;
--> statement-breakpoint

-- Trigram similarity for the matcher (§17): best of name and each alias.
CREATE OR REPLACE FUNCTION price_book_similarity(p_name text, p_aliases text[], p_query text) RETURNS real
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS $$
    SELECT greatest(
      similarity(lower(p_name), lower(p_query)),
      coalesce((SELECT max(similarity(lower(a), lower(p_query))) FROM unnest(p_aliases) a), 0)
    )
  $$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION price_book_similarity(text, text[], text) TO app;
