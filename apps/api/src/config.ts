import { z } from "zod";

const Env = z.object({
  DATABASE_URL: z.string().url(),
  BETTER_AUTH_SECRET: z.string().min(32, "BETTER_AUTH_SECRET must be at least 32 characters"),
  BETTER_AUTH_URL: z.string().url().default("http://localhost:8080"),
  WEB_ORIGIN: z.string().url().default("http://localhost:3000"),
  INTAKE_DOMAIN: z.string().default("intake.localhost"),
  PORT: z.coerce.number().int().default(8080),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
});

export type Config = {
  databaseUrl: string;
  authSecret: string;
  authUrl: string;
  trustedOrigins: string[];
  intakeDomain: string;
  port: number;
  production: boolean;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const e = Env.parse(env);
  return {
    databaseUrl: e.DATABASE_URL,
    authSecret: e.BETTER_AUTH_SECRET,
    authUrl: e.BETTER_AUTH_URL,
    trustedOrigins: [e.WEB_ORIGIN, e.BETTER_AUTH_URL],
    intakeDomain: e.INTAKE_DOMAIN,
    port: e.PORT,
    production: e.NODE_ENV === "production",
  };
}
