// Spike 1 — Resend inbound email (design §15, §25 Day 1). The riskiest spike.
// Usage: pnpm inbound   (needs RESEND_API_KEY + RESEND_INBOUND_SECRET in ../.env)
// Then expose the port publicly (e.g. `cloudflared tunnel --url http://localhost:8787`),
// point a Resend "email.received" webhook at <tunnel>/webhooks/resend/inbound,
// and forward a real email with an iPhone photo to quote+spike123@<your receiving domain>.
//
// Proves, against the real provider:
//   1. webhook signature verification on the raw body
//   2. plus-addressing survives (we can read the "spike123" token from to/received_for)
//   3. body + forwarded headers can be fetched (webhook carries metadata only)
//   4. attachments can be downloaded and pushed through the photo pipeline
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import Fastify from "fastify";
import { Resend } from "resend";
import { processImage, sniff } from "./photo-pipeline.ts";

const { RESEND_API_KEY, RESEND_INBOUND_SECRET } = process.env;
const PORT = Number(process.env.SPIKE_INBOUND_PORT ?? 8787);
if (!RESEND_API_KEY || !RESEND_INBOUND_SECRET) {
  console.log("SKIP: set RESEND_API_KEY and RESEND_INBOUND_SECRET in .env to run the inbound spike.");
  process.exit(0);
}

const resend = new Resend(RESEND_API_KEY);
const OUT = "out/inbound";
await mkdir(OUT, { recursive: true });

// quote+<token>@intake.example.com → token
const tokenOf = (addr: string) => /^[^@+]+\+([^@]+)@/.exec(addr.replace(/^.*<|>.*$/g, ""))?.[1] ?? null;

const app = Fastify({ logger: false, bodyLimit: 1024 * 1024 });
// Keep the raw body: the signature covers the exact bytes, not re-serialised JSON.
app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => done(null, body));

app.post("/webhooks/resend/inbound", async (req, reply) => {
  const raw = req.body as string;
  let event;
  try {
    event = resend.webhooks.verify({
      payload: raw,
      headers: {
        id: String(req.headers["svix-id"] ?? ""),
        timestamp: String(req.headers["svix-timestamp"] ?? ""),
        signature: String(req.headers["svix-signature"] ?? ""),
      },
      webhookSecret: RESEND_INBOUND_SECRET,
    });
  } catch {
    console.log("✗ signature verification FAILED — dropped");
    return reply.code(401).send({ error: "invalid signature" });
  }

  const stamp = Date.now();
  await writeFile(join(OUT, `${stamp}-webhook.json`), raw);
  if (event.type !== "email.received") {
    console.log(`· ignored event ${event.type}`);
    return reply.send({ ok: true });
  }

  // Respond fast (the real app enqueues work); the spike does the fetch inline
  // after replying so a slow fetch can't make the provider retry.
  reply.send({ ok: true });
  const data = event.data as { email_id: string; to: string[]; received_for?: string[]; from: string; subject: string };
  console.log(`\n✓ verified email.received ${data.email_id} from ${data.from} — "${data.subject}"`);
  const tokens = [...data.to, ...(data.received_for ?? [])].map(tokenOf).filter(Boolean);
  console.log(`  to=${JSON.stringify(data.to)} received_for=${JSON.stringify(data.received_for ?? [])}`);
  console.log(`  plus-address token: ${tokens.length ? tokens.join(", ") : "NOT FOUND ✗"}`);

  const { data: email, error } = await resend.emails.receiving.get(data.email_id);
  if (error || !email) { console.log(`  ✗ fetch body failed: ${JSON.stringify(error)}`); return; }
  await writeFile(join(OUT, `${stamp}-email.json`), JSON.stringify(email, null, 2));
  const text = email.text ?? "";
  const fwdFrom = [...text.matchAll(/^\s*From:\s*(.+)$/gim)].map((m) => m[1]);
  console.log(`  body: text=${text.length} chars, html=${(email.html ?? "").length} chars`);
  console.log(`  forwarded "From:" lines in text: ${fwdFrom.length ? fwdFrom.join(" | ") : "none (check html / raw)"}`);
  // Documented in the API reference (spf/dkim/dmarc) but missing from the SDK 6.37 types.
  console.log(`  authentication: ${JSON.stringify((email as { authentication?: unknown }).authentication ?? null)}`);

  const { data: atts, error: attErr } = await resend.emails.receiving.attachments.list({ emailId: data.email_id });
  if (attErr || !atts) { console.log(`  ✗ list attachments failed: ${JSON.stringify(attErr)}`); return; }
  console.log(`  attachments: ${atts.data.length}`);
  for (const a of atts.data) {
    const res = await fetch(a.download_url);
    const buf = Buffer.from(await res.arrayBuffer());
    const kind = sniff(buf);
    await writeFile(join(OUT, `${stamp}-${a.filename}`), buf);
    if (kind === "unknown") {
      console.log(`  - ${a.filename} (${a.content_type}, ${buf.length} B): not an image — stored only`);
      continue;
    }
    const r = await processImage(buf);
    await writeFile(join(OUT, `${stamp}-${a.filename}.model.jpg`), r.model);
    console.log(`  - ${a.filename} (${a.content_type} → sniffed ${kind}, ${(buf.length / 1024).toFixed(0)} KB) → ${r.width}x${r.height} in ${r.ms} ms ✓`);
  }
  console.log(`  saved everything under ${OUT}/${stamp}-*`);
});

await app.listen({ port: PORT, host: "127.0.0.1" });
console.log(`listening on http://127.0.0.1:${PORT}/webhooks/resend/inbound — expose it with a tunnel and send a test email`);
