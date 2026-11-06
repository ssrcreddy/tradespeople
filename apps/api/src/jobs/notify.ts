// notify (design §1): send one owner notification by email. Push arrives with
// the PWA (Days 16–21).
import { and, eq } from "drizzle-orm";
import { withTenant } from "../db/client.ts";
import { businesses, notifications, pushSubscriptions, user } from "../db/schema.ts";
import type { PushMessage } from "../push.ts";
import type { NotifyKind } from "../services/notify.ts";
import type { WorkerDeps } from "./deps.ts";

const SUBJECTS: Record<NotifyKind, (biz: string) => string> = {
  draft_ready: () => "New draft quote ready to review",
  needs_info: () => "A new enquiry needs more information",
  extraction_failed: () => "We couldn't read an enquiry — start it by hand",
  quarantined: () => "Email held from an unknown sender",
  rate_limited: () => "Too many emails to your intake address this hour",
  spend_cap: () => "Monthly AI limit reached",
  send_failed: () => "A document could not be sent",
  bounced: () => "An email to a customer bounced",
  quote_expired: () => "A quote has expired",
  export_ready: () => "Your data export is ready",
};

function body(kind: NotifyKind, link: string) {
  switch (kind) {
    case "draft_ready": return `A draft quote is ready for your review:\n${link}\n\nNothing is sent to the customer until you approve it.`;
    case "needs_info": return `An enquiry came in, but it doesn't say enough to quote. The questions are here:\n${link}`;
    case "extraction_failed": return `We couldn't turn an enquiry into a draft. The original message is here, with a blank quote ready to fill in:\n${link}`;
    case "quarantined": return `An email reached your intake address from a sender you haven't approved. Review it here:\n${link}`;
    case "rate_limited": return `Your intake address received more emails than usual in the last hour. Extra messages are held here:\n${link}`;
    case "spend_cap": return `This month's AI limit is reached, so new enquiries are waiting. Manage it here:\n${link}`;
    case "send_failed": return `We couldn't send this document after several tries. Nothing was delivered. Try again or share the PDF yourself:\n${link}`;
    case "bounced": return `A document you sent was not delivered: the customer's mail server rejected it, and that address is now blocked. Check it here:\n${link}`;
    case "quote_expired": return `A quote passed its expiry date without an answer:\n${link}`;
    case "export_ready": return `Your data export is ready to download:\n${link}`;
  }
}

function linkFor(kind: NotifyKind, entityId: string, web: string) {
  if (kind === "quarantined" || kind === "rate_limited") return `${web}/inbox`;
  if (kind === "spend_cap" || kind === "export_ready") return `${web}/settings`;
  // Document events use "<quote|invoice>:<id>[:suffix]" so a retry can notify again.
  const [doc, id] = entityId.split(":");
  if (doc === "quote") return `${web}/quotes/${id}/review`;
  if (doc === "invoice") return `${web}/invoices/${id}`;
  return `${web}/jobs/${entityId}`;
}

// Push is a nicety on top of email: a dead endpoint is forgotten, an outage
// never fails the notification.
async function pushToDevices(d: WorkerDeps, businessId: string, userId: string, msg: PushMessage) {
  if (!d.push.publicKey) return;
  const subs = await withTenant(d.db, businessId, (tx) => tx.select().from(pushSubscriptions)
    .where(and(eq(pushSubscriptions.businessId, businessId), eq(pushSubscriptions.userId, userId))));
  for (const s of subs) {
    const alive = await d.push.send({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, msg).catch(() => true);
    if (!alive) await withTenant(d.db, businessId, (tx) => tx.delete(pushSubscriptions).where(eq(pushSubscriptions.id, s.id)));
  }
}

export async function notify(d: WorkerDeps, data: { businessId: string; notificationId: string }) {
  const n = await withTenant(d.db, data.businessId, async (tx) => {
    const [row] = await tx.select({
      id: notifications.id, kind: notifications.kind, entityId: notifications.entityId, sentAt: notifications.sentAt, userId: notifications.userId,
      email: user.email, business: businesses.name, replyTo: businesses.replyToEmail,
    }).from(notifications)
      .innerJoin(user, eq(user.id, notifications.userId))
      .innerJoin(businesses, eq(businesses.id, notifications.businessId))
      .where(and(eq(notifications.businessId, data.businessId), eq(notifications.id, data.notificationId)));
    return row;
  });
  if (!n || n.sentAt) return { skipped: true };
  const kind = n.kind as NotifyKind;
  const link = linkFor(kind, n.entityId, d.webOrigin);
  await d.mailer.send({ to: n.email, subject: SUBJECTS[kind](n.business), text: body(kind, link) });
  await pushToDevices(d, data.businessId, n.userId, { title: SUBJECTS[kind](n.business), body: n.business, url: link });
  await withTenant(d.db, data.businessId, (tx) =>
    tx.update(notifications).set({ sentAt: new Date() }).where(eq(notifications.id, n.id)));
  return { sent: true };
}
