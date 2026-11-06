// Object storage (design §7, §8): S3 API everywhere — SeaweedFS locally,
// R2/S3 in production. Keys are always prefixed by business id.
import { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command, DeleteObjectsCommand } from "@aws-sdk/client-s3";

export interface ObjectStore {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<{ body: Buffer; contentType: string }>;
  deletePrefix(prefix: string): Promise<number>;
}

export function s3Store(cfg: { endpoint?: string; bucket: string; accessKeyId: string; secretAccessKey: string; region?: string }): ObjectStore {
  const s3 = new S3Client({
    ...(cfg.endpoint ? { endpoint: cfg.endpoint, forcePathStyle: true } : {}),
    region: cfg.region ?? "auto",
    credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
  });
  return {
    async put(key, body, contentType) {
      await s3.send(new PutObjectCommand({ Bucket: cfg.bucket, Key: key, Body: body, ContentType: contentType }));
    },
    async get(key) {
      const r = await s3.send(new GetObjectCommand({ Bucket: cfg.bucket, Key: key }));
      return { body: Buffer.from(await r.Body!.transformToByteArray()), contentType: r.ContentType ?? "application/octet-stream" };
    },
    async deletePrefix(prefix) {
      let removed = 0;
      for (;;) {
        const page = await s3.send(new ListObjectsV2Command({ Bucket: cfg.bucket, Prefix: prefix }));
        const keys = (page.Contents ?? []).flatMap((o) => (o.Key ? [{ Key: o.Key }] : []));
        if (!keys.length) return removed;
        await s3.send(new DeleteObjectsCommand({ Bucket: cfg.bucket, Delete: { Objects: keys } }));
        removed += keys.length;
      }
    },
  };
}

export function memoryStore(): ObjectStore & { keys(): string[] } {
  const m = new Map<string, { body: Buffer; contentType: string }>();
  return {
    async put(key, body, contentType) { m.set(key, { body, contentType }); },
    async get(key) {
      const v = m.get(key);
      if (!v) throw new Error(`no object ${key}`);
      return v;
    },
    async deletePrefix(prefix) {
      const keys = [...m.keys()].filter((k) => k.startsWith(prefix));
      keys.forEach((k) => m.delete(k));
      return keys.length;
    },
    keys: () => [...m.keys()],
  };
}
