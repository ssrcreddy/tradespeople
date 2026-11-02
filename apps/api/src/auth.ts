// Better Auth (design §7, §9): email + password now; magic link and email
// verification are switched on with onboarding (Days 16–21), when outbound
// email exists. Users/sessions live in Better Auth's tables; which business a
// user belongs to lives in our memberships table.
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import type { Db } from "./db/client.ts";
import { user, session, account, verification } from "./db/schema.ts";
import type { Config } from "./config.ts";

export function createAuth(db: Db, cfg: Config) {
  return betterAuth({
    database: drizzleAdapter(db, { provider: "pg", schema: { user, session, account, verification } }),
    secret: cfg.authSecret,
    baseURL: cfg.authUrl,
    basePath: "/api/auth",
    trustedOrigins: cfg.trustedOrigins,
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: false, // TODO(onboarding): true once outbound email is wired
      minPasswordLength: 10,
    },
    session: { expiresIn: 60 * 60 * 24 * 30, updateAge: 60 * 60 * 24 },
    rateLimit: { enabled: cfg.production },
    advanced: { defaultCookieAttributes: { sameSite: "lax", httpOnly: true, secure: cfg.production } },
  });
}

export type Auth = ReturnType<typeof createAuth>;
