// Offline check for the inbound spike's signature handling: signs a payload the
// way Svix/Resend do (HMAC-SHA256 over "id.timestamp.body" with the base64
// secret after "whsec_") and posts it to a running `pnpm inbound`.
// Usage: start inbound with RESEND_INBOUND_SECRET set, then: node sign-test.ts
import { createHmac, randomBytes } from "node:crypto";

const secret = process.env.RESEND_INBOUND_SECRET!;
const url = `http://127.0.0.1:${process.env.SPIKE_INBOUND_PORT ?? 8787}/webhooks/resend/inbound`;
const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");

async function post(body: string, tamper = false) {
  const id = "msg_" + randomBytes(6).toString("hex");
  const ts = Math.floor(Date.now() / 1000).toString();
  const sig = createHmac("sha256", key).update(`${id}.${ts}.${body}`).digest("base64");
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "svix-id": id, "svix-timestamp": ts, "svix-signature": `v1,${sig}` },
    body: tamper ? body.replace("sent", "SENT") : body,
  });
  return res.status;
}

const body = JSON.stringify({ type: "email.sent", created_at: new Date().toISOString(), data: { email_id: "test" } });
const ok = await post(body);
const bad = await post(body, true);
console.log(`valid signature → ${ok} (expect 200); tampered body → ${bad} (expect 401)`);
process.exit(ok === 200 && bad === 401 ? 0 : 1);
