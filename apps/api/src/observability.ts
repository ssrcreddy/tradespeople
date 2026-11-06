// Error tracking (design §7, §23). Off unless SENTRY_DSN is set, and the SDK is
// only loaded then (it adds seconds to every boot). Tags carry IDs only: request
// bodies, customer messages and addresses never leave the system.
type SentryModule = typeof import("@sentry/node");

let sentry: SentryModule | null = null;

export async function initSentry(dsn: string | undefined, service: "api" | "worker") {
  if (!dsn) return;
  sentry = await import("@sentry/node");
  sentry.init({
    dsn, serverName: service, tracesSampleRate: 0,
    beforeSend(event) {
      delete event.request;
      delete event.user;
      return event;
    },
  });
}

export function captureError(err: unknown, tags: Record<string, string | undefined> = {}) {
  sentry?.withScope((scope) => {
    for (const [k, v] of Object.entries(tags)) if (v) scope.setTag(k, v);
    sentry?.captureException(err);
  });
}
