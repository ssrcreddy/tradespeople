// Outbound email: owner notifications, quotes, invoices and reminders.
import { Resend } from "resend";

export interface MailAttachment { filename: string; content: Buffer }
export interface MailMessage {
  to: string; subject: string; text: string;
  replyTo?: string | undefined;
  fromName?: string | undefined;          // the business's name, on our sending address
  attachments?: MailAttachment[] | undefined;
  idempotencyKey?: string | undefined;    // a retry with the same key must not send twice
}
export interface Mailer { send(m: MailMessage): Promise<{ id: string }> }

export function resendMailer(apiKey: string, from: string): Mailer {
  const resend = new Resend(apiKey);
  return {
    async send(m) {
      const { data, error } = await resend.emails.send({
        from: m.fromName ? `${m.fromName.replace(/["<>]/g, "")} <${from}>` : from,
        to: m.to, subject: m.subject, text: m.text,
        ...(m.replyTo ? { replyTo: m.replyTo } : {}),
        ...(m.attachments ? { attachments: m.attachments.map((a) => ({ filename: a.filename, content: a.content })) } : {}),
      }, m.idempotencyKey ? { idempotencyKey: m.idempotencyKey } : undefined);
      if (error || !data) throw new Error(`email send failed: ${error?.message ?? "unknown"}`);
      return { id: data.id };
    },
  };
}

// Development and tests. Honours idempotency keys the way the provider does, so
// `sent` holds what a customer would actually receive; `attempts` counts calls.
export function memoryMailer(log = false) {
  const sent: MailMessage[] = [];
  const byKey = new Map<string, string>();
  const state = { attempts: 0, failNext: 0 };
  const mailer: Mailer & { sent: MailMessage[]; state: typeof state } = {
    sent, state,
    async send(m) {
      state.attempts++;
      if (state.failNext > 0) { state.failNext--; throw new Error("provider unavailable"); }
      const known = m.idempotencyKey ? byKey.get(m.idempotencyKey) : undefined;
      if (known) return { id: known };
      sent.push(m);
      const id = `mem_${sent.length}_${Date.now()}`;
      if (m.idempotencyKey) byKey.set(m.idempotencyKey, id);
      // Development has no inbox, so print the message: sign-in links are in the text.
      if (log) console.log(`[mail] to=${m.to} subject="${m.subject}" attachments=${m.attachments?.length ?? 0}\n${m.text}`);
      return { id };
    },
  };
  return mailer;
}
