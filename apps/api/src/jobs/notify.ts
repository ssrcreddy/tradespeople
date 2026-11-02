// notify (design §1): send one owner notification by email. Push arrives with
// the PWA (Days 16–21).
import { and, eq } from "drizzle-orm";
import { withTenant } from "../db/client.ts";
import { businesses, notifications, user } from "../db/schema.ts";
import type { NotifyKind } from "../services/notify.ts";
import type { WorkerDeps } from "./deps.ts";

const SUBJECTS: Record<NotifyKind, (biz: string) => string> = {
  draft_ready: () => "New draft quote ready to review",
  needs_info: () => "A new enquiry needs more information",
  extraction_failed: () => "We couldn't read an enquiry — start it by hand",
  quarantined: () => "Email held from an unknown sender",
  rate_limited: () => "Too many emails to your intake address this hour",
  spend_cap: () => "Monthly AI limit reached",
};

function body(kind: NotifyKind, link: string) {
  switch (kind) {
    case "draft_ready": return `A draft quote is ready for your review:\n${link}\n\nNothing is sent to the customer until you approve it.`;
    case "needs_info": return `An enquiry came in, but it doesn't say enough to quote. The questions are here:\n${link}`;
    case "extraction_failed": return `We couldn't turn an enquiry into a draft. The original message is here, with a blank quote ready to fill in:\n${link}`;
    case "quarantined": return `An email reached your intake address from a sender you haven't approved. Review it here:\n${link}`;
    case "rate_limited": return `Your intake address received more emails than usual in the last hour. Extra messages are held here:\n${link}`;
    case "spend_cap": return `This month's AI limit is reached, so new enquiries are waiting. Manage it here:\n${link}`;
  }
}

function linkFor(kind: NotifyKind, entityId: string, web: string) {
  if (kind === "quarantined" || kind === "rate_limited") return `${web}/inbox`;
  if (kind === "spend_cap") return `${web}/settings`;
  return `${web}/jobs/${entityId}`;
}

export async function notify(d: WorkerDeps, data: { businessId: string; notificationId: string }) {
  const n = await withTenant(d.db, data.businessId, async (tx) => {
    const [row] = await tx.select({
      id: notifications.id, kind: notifications.kind, entityId: notifications.entityId, sentAt: notifications.sentAt,
      email: user.email, business: businesses.name, replyTo: businesses.replyToEmail,
    }).from(notifications)
      .innerJoin(user, eq(user.id, notifications.userId))
      .innerJoin(businesses, eq(businesses.id, notifications.businessId))
      .where(and(eq(notifications.businessId, data.businessId), eq(notifications.id, data.notificationId)));
    return row;
  });
  if (!n || n.sentAt) return { skipped: true };
  const kind = n.kind as NotifyKind;
  await d.mailer.send({ to: n.email, subject: SUBJECTS[kind](n.business), text: body(kind, linkFor(kind, n.entityId, d.webOrigin)) });
  await withTenant(d.db, data.businessId, (tx) =>
    tx.update(notifications).set({ sentAt: new Date() }).where(eq(notifications.id, n.id)));
  return { sent: true };
}
