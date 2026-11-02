import type { FastifyError, FastifyInstance } from "fastify";
import { ZodError } from "zod";
import { EngineError } from "../services/quoteEngine.ts";

// Errors as { error: { code, message } } with stable codes (design §21).
export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const notFound = (what: string) => new AppError(404, "NOT_FOUND", `${what} not found`);

// Postgres SQLSTATEs we translate instead of leaking a 500.
const PG_UNIQUE = "23505";
const PG_CHECK = "23514";
const PG_FK = "23503";

export function registerErrorHandler(app: FastifyInstance) {
  app.setErrorHandler((err: FastifyError & { cause?: unknown }, req, reply) => {
    if (err instanceof AppError) {
      return reply.code(err.status).send({ error: { code: err.code, message: err.message, details: err.details } });
    }
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: { code: "VALIDATION", message: "invalid request", details: err.issues } });
    }
    if (err instanceof EngineError) {
      return reply.code(422).send({ error: { code: err.code, message: err.message } });
    }
    const pg = (err.cause ?? err) as { code?: string; constraint?: string };
    if (pg.code === PG_UNIQUE) return reply.code(409).send({ error: { code: "CONFLICT", message: pg.constraint ?? "duplicate" } });
    if (pg.code === PG_CHECK) return reply.code(422).send({ error: { code: "CONSTRAINT", message: pg.constraint ?? "check failed" } });
    if (pg.code === PG_FK) return reply.code(422).send({ error: { code: "REFERENCE", message: pg.constraint ?? "reference failed" } });
    if (err.validation || err.statusCode === 400) {
      return reply.code(400).send({ error: { code: "BAD_REQUEST", message: err.message } });
    }
    req.log.error({ err }, "unhandled error");
    return reply.code(500).send({ error: { code: "INTERNAL", message: "internal error" } });
  });
}
