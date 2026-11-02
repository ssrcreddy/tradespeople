// Thin client for the Fastify API, reached through the /backend rewrite.
export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details?: unknown) {
    super(message);
  }
}

export async function api<T = any>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, headers, ...rest } = init;
  const res = await fetch(path.startsWith("/api/") ? path : `/backend${path}`, {
    credentials: "same-origin",
    ...rest,
    headers: { ...(json !== undefined ? { "content-type": "application/json" } : {}), ...headers },
    ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
  });
  if (res.status === 204) return undefined as T;
  const body = res.headers.get("content-type")?.includes("json") ? await res.json() : await res.text();
  if (!res.ok) {
    const e = (body as { error?: { code: string; message: string; details?: unknown } })?.error;
    throw new ApiError(res.status, e?.code ?? `HTTP_${res.status}`, e?.message ?? String(body), e?.details);
  }
  return body as T;
}

// Integer cents only — the browser never does money arithmetic beyond display.
export const money = (cents: number | null | undefined) =>
  cents == null ? "—" : (cents / 100).toLocaleString("en-CA", { style: "currency", currency: "CAD" });

// "12.3" → 1230, "12" → 1200, "" → null; rejects anything else.
export function parseDollars(s: string): number | null | "invalid" {
  const v = s.trim().replace(/^\$/, "").replace(/,/g, "");
  if (v === "") return null;
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(v);
  if (!m) return "invalid";
  return Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
}

export const dollarsOf = (cents: number | null) => (cents == null ? "" : (cents / 100).toFixed(2));
