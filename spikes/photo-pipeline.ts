// Candidate implementation of the §15 attachment pipeline:
// sniff by magic bytes → HEIC→JPEG → auto-orient → resize ≤1600 px → strip all metadata.
import { createHash } from "node:crypto";
import sharp from "sharp";
import heicConvert from "heic-convert";

export type ImageKind = "jpeg" | "png" | "webp" | "heic" | "unknown";

const HEIC_BRANDS = new Set(["heic", "heix", "hevc", "heim", "heis", "hevm", "hevs", "mif1", "msf1"]);

export function sniff(buf: Buffer): ImageKind {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpeg";
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "webp";
  if (buf.toString("ascii", 4, 8) === "ftyp" && HEIC_BRANDS.has(buf.toString("ascii", 8, 12))) return "heic";
  return "unknown";
}

export interface ProcessedImage {
  kind: ImageKind;
  originalSha256: string;
  model: Buffer;          // what goes to the vision model and the review screen
  width: number;
  height: number;
  ms: number;
}

export const MAX_EDGE = 1600;

export async function processImage(input: Buffer): Promise<ProcessedImage> {
  const started = performance.now();
  const kind = sniff(input);
  if (kind === "unknown") throw new Error("not a supported image (by magic bytes)");

  let decodable = input;
  if (kind === "heic") {
    // sharp's prebuilt binaries cannot decode HEVC-coded HEIC; convert first.
    const jpeg = await heicConvert({ buffer: input, format: "JPEG", quality: 0.92 });
    decodable = Buffer.from(jpeg);
  }

  // rotate() with no args applies the EXIF orientation; sharp drops all
  // metadata (EXIF incl. GPS, XMP, ICC) unless withMetadata() is called.
  const { data, info } = await sharp(decodable)
    .rotate()
    .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 85, mozjpeg: true })
    .toBuffer({ resolveWithObject: true });

  return {
    kind,
    originalSha256: createHash("sha256").update(input).digest("hex"),
    model: data,
    width: info.width,
    height: info.height,
    ms: Math.round(performance.now() - started),
  };
}
