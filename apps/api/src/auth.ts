// Better Auth (design §7, §9): email + password, magic link, verification and
// password reset. Users/sessions live in Better Auth's tables; which business a
// user belongs to lives in our memberships table.
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { magicLink } from "better-auth/plugins/magic-link";
import type { Db } from "./db/client.ts";
import { user, session, account, verification } from "./db/schema.ts";
import type { Config } from "./config.ts";
import type { Mailer } from "./mail.ts";

export function createAuth(db: Db, cfg: Config, mailer: Mailer) {
  // Never fail a sign-in request because the provider hiccuped: the user can
  // ask for the link again, and the address must not be revealed either way.
  const mail = (to: string, subject: string, text: string) => {
    mailer.send({ to, subject, text }).catch((e) => console.error(JSON.stringify({ msg: "auth email failed", error: (e as Error).message })));
  };
  return betterAuth({
    database: drizzleAdapter(db, { provider: "pg", schema: { user, session, account, verification } }),
    secret: cfg.authSecret,
    baseURL: cfg.authUrl,
    basePath: "/api/auth",
    trustedOrigins: cfg.trustedOrigins,
    emailAndPassword: {
      enabled: true,
      // Needs real email: without a provider nobody could ever finish signing up.
      requireEmailVerification: cfg.requireEmailVerification,
      minPasswordLength: 10,
      sendResetPassword: async ({ user: u, url }) => mail(u.email, "Reset your password", `Use this link to choose a new password:\n${url}\n\nIf you didn't ask for this, ignore this email.`),
    },
    emailVerification: {
      sendOnSignUp: cfg.requireEmailVerification,
      autoSignInAfterVerification: true,
      sendVerificationEmail: async ({ user: u, url }) => mail(u.email, "Confirm your email", `Confirm your email to finish signing up:\n${url}`),
    },
    plugins: [
      magicLink({
        expiresIn: 15 * 60,
        sendMagicLink: async ({ email, url }) => mail(email, "Your sign-in link", `Use this link to sign in. It works once and expires in 15 minutes:\n${url}`),
      }),
    ],
    session: { expiresIn: 60 * 60 * 24 * 30, updateAge: 60 * 60 * 24 },
    rateLimit: { enabled: cfg.production },
    advanced: { defaultCookieAttributes: { sameSite: "lax", httpOnly: true, secure: cfg.production } },
  });
}

export type Auth = ReturnType<typeof createAuth>;
