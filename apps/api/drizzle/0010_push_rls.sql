-- Tenant isolation for push subscriptions, same policy as every tenant table.
ALTER TABLE "push_subscriptions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "push_subscriptions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "push_subscriptions"
  USING (business_id = app_current_business()) WITH CHECK (business_id = app_current_business());
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "push_subscriptions" TO app;
