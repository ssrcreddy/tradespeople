// Outbound email for owner notifications now; quotes and invoices later
// (Days 11–15) reuse the same transport.
import { Resend } from "resend";

export interface MailMessage { to: string; subject: string; text: string; replyTo?: string }
export interface Mailer { send(m: MailMessage): Promise<{ id: string }> }

export function resendMailer(apiKey: string, from: string): Mailer {
  const resend = new Resend(apiKey);
  return {
    async send(m) {
      const { data, error } = await resend.emails.send({
        from, to: m.to, subject: m.subject, text: m.text, ...(m.replyTo ? { replyTo: m.replyTo } : {}),
      });
      if (error || !data) throw new Error(`email send failed: ${error?.message ?? "unknown"}`);
      return { id: data.id };
    },
  };
}

// Development and tests: keeps messages in memory and logs a one-line summary.
export function memoryMailer(log = false): Mailer & { sent: MailMessage[] } {
  const sent: MailMessage[] = [];
  return {
    sent,
    async send(m) {
      sent.push(m);
      if (log) console.log(`[mail] to=${m.to} subject="${m.subject}"`);
      return { id: `mem_${sent.length}` };
    },
  };
}
