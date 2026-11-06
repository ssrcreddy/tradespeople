// Web Push for owner notifications (design §22). Off unless VAPID keys are set;
// email stays the channel that always works.
import webpush from "web-push";

export interface PushSubscriptionData { endpoint: string; keys: { p256dh: string; auth: string } }
export interface PushMessage { title: string; body: string; url: string }

export interface PushSender {
  readonly publicKey: string | null;
  // Resolves false when the subscription is gone and should be forgotten.
  send(sub: PushSubscriptionData, msg: PushMessage): Promise<boolean>;
}

export function webPushSender(cfg: { publicKey: string; privateKey: string; contact: string }): PushSender {
  webpush.setVapidDetails(cfg.contact, cfg.publicKey, cfg.privateKey);
  return {
    publicKey: cfg.publicKey,
    async send(sub, msg) {
      try {
        await webpush.sendNotification(sub, JSON.stringify(msg), { TTL: 86_400 });
        return true;
      } catch (e) {
        const status = (e as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) return false;
        throw e;
      }
    },
  };
}

export const noPush: PushSender = { publicKey: null, send: async () => true };

export function memoryPush(publicKey = "test-public-key") {
  const sent: { sub: PushSubscriptionData; msg: PushMessage }[] = [];
  const gone = new Set<string>();
  const sender: PushSender & { sent: typeof sent; gone: typeof gone } = {
    publicKey, sent, gone,
    async send(sub, msg) {
      if (gone.has(sub.endpoint)) return false;
      sent.push({ sub, msg });
      return true;
    },
  };
  return sender;
}
