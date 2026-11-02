import type pg from "pg";
import type { Db } from "../db/client.ts";
import type { Boss } from "../queue.ts";
import type { ObjectStore } from "../storage.ts";
import type { InboundProvider } from "../inbound.ts";
import type { LlmProvider, Pricing } from "../llm/gateway.ts";
import type { Mailer } from "../mail.ts";

export interface WorkerDeps {
  db: Db;
  pool: pg.Pool;
  boss: Boss;
  store: ObjectStore;
  inbound: InboundProvider;
  llm: LlmProvider;
  pricing: Pricing;
  mailer: Mailer;
  webOrigin: string;
  llmMonthlyCapUsd: number;
}
