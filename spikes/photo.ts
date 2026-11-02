// Spike 2 — iPhone photos (design §15, §25 Day 1).
// Usage: pnpm photo [file-or-dir ...]   (default: samples/photos + samples/private)
// Proves: HEIC decodes, orientation is applied, EXIF/GPS is gone, output ≤1600 px.
import { readdir, readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { join, basename, extname } from "node:path";
import sharp from "sharp";
import exifReader from "exif-reader";
import { processImage, MAX_EDGE } from "./photo-pipeline.ts";

const OUT = "out/photos";

// A JPEG carrying GPS + a rotate-90 orientation flag, made here so the
// EXIF-stripping check does not depend on anyone's real photo.
async function makeJpegWithGps(path: string) {
  const portraitMarker = await sharp({
    create: { width: 3000, height: 2000, channels: 3, background: { r: 200, g: 80, b: 40 } },
  }).jpeg().toBuffer();
  await sharp(portraitMarker)
    .withMetadata({ orientation: 6 })
    .withExif({
      IFD0: { Make: "Apple", Model: "iPhone 15" },
      IFD3: {
        GPSLatitudeRef: "N", GPSLatitude: "43/1 39/1 125/10",
        GPSLongitudeRef: "W", GPSLongitude: "79/1 23/1 12/10",
      },
    })
    .toFile(path);
}

function gpsOf(exif: Buffer | undefined): string {
  if (!exif) return "none";
  try {
    const gps = exifReader(exif).GPSInfo;
    return gps && Object.keys(gps).length ? `present (${Object.keys(gps).join(", ")})` : "none";
  } catch {
    return "unreadable";
  }
}

async function collect(args: string[]): Promise<string[]> {
  const roots = args.length ? args : ["samples/photos", "samples/private"];
  const files: string[] = [];
  for (const r of roots) {
    const s = await stat(r).catch(() => null);
    if (!s) continue;
    if (s.isFile()) files.push(r);
    else for (const f of await readdir(r)) if (!f.startsWith(".")) files.push(join(r, f));
  }
  return files;
}

await mkdir(OUT, { recursive: true });
await mkdir("samples/photos", { recursive: true });
const gpsJpeg = "samples/photos/synthetic-gps-rotated.jpg";
await makeJpegWithGps(gpsJpeg);

let failures = 0;
for (const file of await collect(process.argv.slice(2))) {
  const input = await readFile(file);
  const inMeta = await sharp(input).metadata().catch(() => null); // null for HEIC on prebuilt sharp
  try {
    const r = await processImage(input);
    const outMeta = await sharp(r.model).metadata();
    const outPath = join(OUT, basename(file, extname(file)) + ".model.jpg");
    await writeFile(outPath, r.model);

    const checks = {
      decoded: true,
      withinMaxEdge: Math.max(r.width, r.height) <= MAX_EDGE,
      noExif: outMeta.exif === undefined,
      noXmp: outMeta.xmp === undefined,
      orientationApplied: (outMeta.orientation ?? 1) === 1,
    };
    const ok = Object.values(checks).every(Boolean);
    if (!ok) failures++;
    console.log(`${ok ? "PASS" : "FAIL"} ${file}`);
    console.log(`  kind=${r.kind} in=${(input.length / 1024).toFixed(0)}KB ` +
      `${inMeta ? `${inMeta.width}x${inMeta.height} orient=${inMeta.orientation ?? 1}` : "(sharp can't read input directly)"} ` +
      `gps-in=${gpsOf(inMeta?.exif)}`);
    console.log(`  out=${r.width}x${r.height} ${(r.model.length / 1024).toFixed(0)}KB in ${r.ms}ms → ${outPath}`);
    console.log(`  checks ${JSON.stringify(checks)}`);
  } catch (e) {
    failures++;
    console.log(`FAIL ${file}: ${(e as Error).message}`);
  }
}

console.log(`\nsharp ${sharp.versions.sharp}, libvips ${sharp.versions.vips}, ` +
  `HEIF in sharp build: ${sharp.format.heif.input.buffer ? "yes" : "no"} (HEVC decode still needs heic-convert)`);
process.exit(failures ? 1 : 0);
