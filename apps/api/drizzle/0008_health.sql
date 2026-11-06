-- /health needs one number across all tenants: when the last webhook arrived.
CREATE OR REPLACE FUNCTION app_last_inbound_at() RETURNS timestamptz
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
  AS $$ SELECT max(received_at) FROM inbound_messages $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_last_inbound_at() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_last_inbound_at() TO app;
