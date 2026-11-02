// Attachment pipeline (design §15, Day-1 spike): sniff by magic bytes →
// HEIC→JPEG (native libheif when installed, pure-JS fallback) → auto-orient →
// strip all metadata (EXIF incl. GPS) → resize ≤1600 px for the model.
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import heicConvert from "heic-convert";

const run = promisify(execFile);

export type ImageKind = "jpeg" | "png" | "webp" | "heic";
const HEIC_BRANDS = new Set(["heic", "heix", "hevc", "heim", "heis", "hevm", "hevs", "mif1", "msf1"]);

export function sniffImage(buf: Buffer): ImageKind | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpeg";
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "webp";
  if (buf.toString("ascii", 4, 8) === "ftyp" && HEIC_BRANDS.has(buf.toString("ascii", 8, 12))) return "heic";
  return null;
}

let nativeHeif: boolean | undefined;
async function hasNativeHeif() {
  if (nativeHeif === undefined) {
    nativeHeif = await run("heif-convert", ["--help"]).then(() => true, (e) => e?.code !== "ENOENT");
  }
  return nativeHeif;
}

async function heicToJpeg(input: Buffer): Promise<Buffer> {
  if (await hasNativeHeif()) {
    const dir = await mkdtemp(join(tmpdir(), "heic-"));
    try {
      await writeFile(join(dir, "in.heic"), input);
      await run("heif-convert", ["-q", "92", join(dir, "in.heic"), join(dir, "out.jpg")], { timeout: 60_000 });
      return await readFile(join(dir, "out.jpg"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  return Buffer.from(await heicConvert({ buffer: input, format: "JPEG", quality: 0.92 }));
}

export const MAX_EDGE = 1600;

export interface ProcessedImage { kind: ImageKind; sha256: string; model: Buffer; width: number; height: number }

export async function processImage(input: Buffer): Promise<ProcessedImage> {
  const kind = sniffImage(input);
  if (!kind) throw new Error("not a supported image");
  const decodable = kind === "heic" ? await heicToJpeg(input) : input;
  const { data, info } = await sharp(decodable)
    .rotate()
    .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 85, mozjpeg: true })
    .toBuffer({ resolveWithObject: true });
  return { kind, sha256: createHash("sha256").update(input).digest("hex"), model: data, width: info.width, height: info.height };
}
