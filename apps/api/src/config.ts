import { z } from "zod";

const optional = z.string().optional().transform((v) => (v ? v : undefined));

const Env = z.object({
  DATABASE_URL: z.string().url(),
  BETTER_AUTH_SECRET: z.string().min(32, "BETTER_AUTH_SECRET must be at least 32 characters"),
  BETTER_AUTH_URL: z.string().url().default("http://localhost:8080"),
  WEB_ORIGIN: z.string().url().default("http://localhost:3000"),
  INTAKE_DOMAIN: z.string().default("intake.localhost"),
  INTAKE_RATE_LIMIT_PER_HOUR: z.coerce.number().int().positive().default(30),
  PORT: z.coerce.number().int().default(8080),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

  S3_ENDPOINT: optional,
  S3_BUCKET: z.string().default("quotes-dev"),
  S3_ACCESS_KEY_ID: z.string().default("dev-access-key"),
  S3_SECRET_ACCESS_KEY: z.string().default("dev-secret-key"),

  RESEND_API_KEY: optional,
  RESEND_INBOUND_SECRET: optional,
  RESEND_EVENTS_SECRET: optional,
  SENDER_ADDRESS: optional,

  OPENAI_API_KEY: optional,
  STRONG_MODEL: optional,
  LLM_TEMPERATURE: z.coerce.number().min(0).max(2).optional(),
  LLM_INPUT_USD_PER_MTOK: z.coerce.number().nonnegative().default(2.5),
  LLM_OUTPUT_USD_PER_MTOK: z.coerce.number().nonnegative().default(10),
  LLM_MONTHLY_CAP_USD: z.coerce.number().positive().default(20),
  FAKE_LLM_FILE: optional,
});

export type Config = {
  databaseUrl: string;
  authSecret: string;
  authUrl: string;
  webOrigin: string;
  trustedOrigins: string[];
  intakeDomain: string;
  intakeRateLimitPerHour: number;
  port: number;
  production: boolean;
  s3: { endpoint: string | undefined; bucket: string; accessKeyId: string; secretAccessKey: string };
  resend: { apiKey: string; inboundSecret: string | undefined; eventsSecret: string | undefined; sender: string } | undefined;
  openai: { apiKey: string; model: string; temperature: number | undefined } | undefined;
  pricing: { inputUsdPerMTok: number; outputUsdPerMTok: number };
  llmMonthlyCapUsd: number;
  fakeLlmFile: string | undefined;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const e = Env.parse(env);
  return {
    databaseUrl: e.DATABASE_URL,
    authSecret: e.BETTER_AUTH_SECRET,
    authUrl: e.BETTER_AUTH_URL,
    webOrigin: e.WEB_ORIGIN,
    trustedOrigins: [e.WEB_ORIGIN, e.BETTER_AUTH_URL],
    intakeDomain: e.INTAKE_DOMAIN,
    intakeRateLimitPerHour: e.INTAKE_RATE_LIMIT_PER_HOUR,
    port: e.PORT,
    production: e.NODE_ENV === "production",
    s3: { endpoint: e.S3_ENDPOINT, bucket: e.S3_BUCKET, accessKeyId: e.S3_ACCESS_KEY_ID, secretAccessKey: e.S3_SECRET_ACCESS_KEY },
    resend: e.RESEND_API_KEY
      ? { apiKey: e.RESEND_API_KEY, inboundSecret: e.RESEND_INBOUND_SECRET, eventsSecret: e.RESEND_EVENTS_SECRET, sender: e.SENDER_ADDRESS ?? "quotes@localhost" }
      : undefined,
    openai: e.OPENAI_API_KEY && e.STRONG_MODEL
      ? { apiKey: e.OPENAI_API_KEY, model: e.STRONG_MODEL, temperature: e.LLM_TEMPERATURE }
      : undefined,
    pricing: { inputUsdPerMTok: e.LLM_INPUT_USD_PER_MTOK, outputUsdPerMTok: e.LLM_OUTPUT_USD_PER_MTOK },
    llmMonthlyCapUsd: e.LLM_MONTHLY_CAP_USD,
    fakeLlmFile: e.FAKE_LLM_FILE,
  };
}
