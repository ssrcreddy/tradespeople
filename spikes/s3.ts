// Spike 5 — local S3 (SeaweedFS replaces MinIO, whose images are no longer published).
// Usage: pnpm dev:infra (repo root), then pnpm s3
// Proves: the AWS SDK talks to the local store with path-style addressing, and
// a put → head → get round-trip preserves bytes (what sent-PDF storage needs).
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";

const endpoint = process.env.S3_ENDPOINT ?? "http://localhost:8333";
const bucket = process.env.S3_BUCKET ?? "quotes-dev";
const s3 = new S3Client({
  endpoint, region: "us-east-1", forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID ?? "dev-access-key",
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? "dev-secret-key",
  },
});

const body = await readFile("out/quote-spike.pdf").catch(() => Buffer.from("no pdf yet — run pnpm pdf first"));
const sha = createHash("sha256").update(body).digest("hex");
const key = `biz_spike/sent/Q-0042-v1.pdf`;

await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: "application/pdf", Metadata: { sha256: sha } }));
const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
const got = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
const back = Buffer.from(await got.Body!.transformToByteArray());
const backSha = createHash("sha256").update(back).digest("hex");

console.log(`endpoint ${endpoint} bucket ${bucket}`);
console.log(`put ${body.length} B → head size ${head.ContentLength}, metadata sha256 ${head.Metadata?.sha256 === sha ? "kept" : "LOST"}`);
console.log(`round-trip bytes identical: ${backSha === sha ? "YES" : "NO"}`);
process.exit(backSha === sha ? 0 : 1);
