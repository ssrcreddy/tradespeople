// Inbound email provider (design §7, §15). Resend's webhook carries metadata
// only; body and attachments are fetched afterwards in the worker. The
// interface keeps a Postmark swap to one file if the Day-1 spike says so.
import { Resend } from "resend";

export interface InboundEvent {
  providerMessageId: string;
  from: string;
  to: string[];
  subject: string;
}

export interface InboundEmail {
  from: string;
  subject: string;
  text: string;
  html: string;
  attachments: { filename: string; contentType: string; bytes: Buffer }[];
  raw: unknown;          // full provider response, stored for audit
}

export interface DeliveryEvent {
  providerEmailId: string;
  type: "delivered" | "bounced" | "complained" | "opened";
  recipient: string | null;
}

export interface InboundProvider {
  // Throws when the signature is invalid. Returns null for events we ignore.
  verify(rawBody: string, headers: Record<string, string | string[] | undefined>): InboundEvent | null;
  verifyDelivery(rawBody: string, headers: Record<string, string | string[] | undefined>): DeliveryEvent | null;
  fetch(providerMessageId: string): Promise<InboundEmail>;
}

const DELIVERY: Record<string, DeliveryEvent["type"]> = {
  "email.delivered": "delivered", "email.bounced": "bounced", "email.complained": "complained", "email.opened": "opened",
};

const h = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

export function resendInbound(apiKey: string, webhookSecret: string, eventsSecret: string | undefined): InboundProvider {
  const resend = new Resend(apiKey);
  return {
    verify(rawBody, headers) {
      const event = resend.webhooks.verify({
        payload: rawBody,
        headers: { id: h(headers["svix-id"]), timestamp: h(headers["svix-timestamp"]), signature: h(headers["svix-signature"]) },
        webhookSecret,
      });
      if (event.type !== "email.received") return null;
      const d = event.data as { email_id: string; from: string; to: string[]; received_for?: string[]; subject: string };
      return { providerMessageId: d.email_id, from: d.from, to: [...d.to, ...(d.received_for ?? [])], subject: d.subject ?? "" };
    },
    verifyDelivery(rawBody, headers) {
      if (!eventsSecret) throw new Error("RESEND_EVENTS_SECRET is not set");
      const event = resend.webhooks.verify({
        payload: rawBody,
        headers: { id: h(headers["svix-id"]), timestamp: h(headers["svix-timestamp"]), signature: h(headers["svix-signature"]) },
        webhookSecret: eventsSecret,
      });
      const type = DELIVERY[event.type];
      if (!type) return null;
      const d = event.data as { email_id: string; to?: string[] };
      return { providerEmailId: d.email_id, type, recipient: d.to?.[0] ?? null };
    },
    async fetch(id) {
      const { data: email, error } = await resend.emails.receiving.get(id);
      if (error || !email) throw new Error(`fetch received email failed: ${error?.message ?? "unknown"}`);
      const { data: atts, error: attErr } = await resend.emails.receiving.attachments.list({ emailId: id });
      if (attErr || !atts) throw new Error(`list attachments failed: ${attErr?.message ?? "unknown"}`);
      const attachments = [];
      for (const a of atts.data) {
        const res = await fetch(a.download_url);    // short-lived URL: fetch now, never store the link
        if (!res.ok) throw new Error(`attachment download ${res.status}`);
        attachments.push({ filename: a.filename ?? "attachment", contentType: a.content_type, bytes: Buffer.from(await res.arrayBuffer()) });
      }
      return { from: email.from, subject: email.subject ?? "", text: email.text ?? "", html: email.html ?? "", attachments, raw: email };
    },
  };
}

// Tests and local development without a provider account.
export function fakeInbound(emails: Map<string, InboundEmail> = new Map()): InboundProvider & { emails: Map<string, InboundEmail> } {
  return {
    emails,
    verify(rawBody, headers) {
      if (h(headers["x-fake-signature"]) !== "valid") throw new Error("invalid signature");
      const e = JSON.parse(rawBody) as { type: string; data: { email_id: string; from: string; to: string[]; subject?: string } };
      if (e.type !== "email.received") return null;
      return { providerMessageId: e.data.email_id, from: e.data.from, to: e.data.to, subject: e.data.subject ?? "" };
    },
    verifyDelivery(rawBody, headers) {
      if (h(headers["x-fake-signature"]) !== "valid") throw new Error("invalid signature");
      const e = JSON.parse(rawBody) as { type: string; data: { email_id: string; to?: string[] } };
      const type = DELIVERY[e.type];
      return type ? { providerEmailId: e.data.email_id, type, recipient: e.data.to?.[0] ?? null } : null;
    },
    async fetch(id) {
      const e = emails.get(id);
      if (!e) throw new Error(`fake inbound: no email ${id}`);
      return e;
    },
  };
}

// quote+<token>@intake.example.com → token
export function intakeTokenOf(addresses: string[]): string | null {
  for (const a of addresses) {
    const bare = a.replace(/^.*</, "").replace(/>.*$/, "").trim().toLowerCase();
    const m = /^[^@+]+\+([a-z0-9]+)@/.exec(bare);
    if (m) return m[1]!;
  }
  return null;
}

export const bareAddress = (a: string) => a.replace(/^.*</, "").replace(/>.*$/, "").trim().toLowerCase();
