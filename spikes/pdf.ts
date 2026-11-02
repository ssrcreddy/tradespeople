// Spike 3 — PDF quote page (design §19, §25 Day 1).
// Usage: pnpm pdf
// Proves: PDFKit embeds Noto Sans so accented names render, long tables paginate,
// and shows whether two renders of the same snapshot are byte-identical
// (v1.1 does NOT rely on that — the PDF is rendered once and stored — but it is
// worth knowing).
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import PDFDocument from "pdfkit";

const require = createRequire(import.meta.url);
const FONT = require.resolve("@fontsource/noto-sans/files/noto-sans-latin-400-normal.woff");
const FONT_BOLD = require.resolve("@fontsource/noto-sans/files/noto-sans-latin-700-normal.woff");

// Integer-cent formatting only; the real app takes this from money.ts + locale.
const fmt = (cents: number) =>
  "$" + (cents / 100).toLocaleString("en-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const snapshot = {
  number: "Q-0042", version: 1, issuedOn: "2026-11-01", expiresOn: "2026-12-01",
  business: { name: "Hélène Côté Électrique Inc.", regNos: ["HST 123456789 RT0001"] },
  customer: { name: "François Lévesque-Gagné", address: "12 rue Saint-Jérôme, Montréal QC H2X 1Y4" },
  lines: [
    ...Array.from({ length: 34 }, (_, i) => ({
      description: i % 5 === 0
        ? `Supply & install GFCI receptacle (bathroom ${i + 1}) — includes faceplate, weatherproof cover where required by code, and testing`
        : `Supply & install 15 A tamper-resistant receptacle, room ${i + 1}`,
      qty: "1", unit: "each", unitCents: 8950 + i * 10, totalCents: 8950 + i * 10,
    })),
    { description: "Labour — EV charger install (assembly)", qty: "4", unit: "hour", unitCents: 9500, totalCents: 38000 },
  ],
  taxes: [{ name: "GST 5%", cents: 0 }, { name: "QST 9.975%", cents: 0 }],
};
const subtotal = snapshot.lines.reduce((s, l) => s + l.totalCents, 0);
snapshot.taxes[0]!.cents = Math.round(subtotal * 0.05);       // display only in this spike
snapshot.taxes[1]!.cents = Math.round(subtotal * 0.09975);
const total = subtotal + snapshot.taxes.reduce((s, t) => s + t.cents, 0);

async function render(): Promise<Buffer> {
  const issued = new Date(`${snapshot.issuedOn}T00:00:00Z`);
  const doc = new PDFDocument({
    size: "LETTER", margin: 54, bufferPages: true,
    info: {
      Title: `Quote ${snapshot.number} v${snapshot.version}`,
      Author: snapshot.business.name,
      CreationDate: issued,      // from the snapshot, never the clock
      ModDate: issued,
    },
  });
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((res) => doc.on("end", () => res(Buffer.concat(chunks))));

  doc.registerFont("body", FONT);
  doc.registerFont("bold", FONT_BOLD);

  doc.font("bold").fontSize(18).text(snapshot.business.name);
  doc.font("body").fontSize(9).fillColor("#555").text(snapshot.business.regNos.join(" · "));
  doc.moveDown();
  doc.fillColor("#000").font("bold").fontSize(14).text(`Quote ${snapshot.number} (v${snapshot.version})`);
  doc.font("body").fontSize(10)
    .text(`Prepared for: ${snapshot.customer.name}`)
    .text(snapshot.customer.address)
    .text(`Issued ${snapshot.issuedOn} · Valid until ${snapshot.expiresOn}`);
  doc.moveDown();

  // Money columns are fixed-width and right-aligned; without a width PDFKit
  // wraps at the page margin and "$3,479.10" breaks onto two lines.
  const x = { desc: 54, qty: 350, unit: 385, price: 425, total: 493 };
  const money = { width: 65, align: "right" as const };
  const descWidth = x.qty - x.desc - 10;
  const header = () => {
    doc.font("bold").fontSize(9);
    const y = doc.y;
    doc.text("Description", x.desc, y).text("Qty", x.qty, y).text("Unit", x.unit, y)
      .text("Price", x.price, y, money).text("Total", x.total, y, money);
    doc.moveTo(54, doc.y + 2).lineTo(558, doc.y + 2).stroke("#999");
    doc.moveDown(0.5).font("body");
  };
  header();
  for (const l of snapshot.lines) {
    const h = doc.heightOfString(l.description, { width: descWidth });
    if (doc.y + h > doc.page.height - 120) { doc.addPage(); header(); }   // manual page break
    const y = doc.y;
    doc.fontSize(9).text(l.description, x.desc, y, { width: descWidth });
    const after = doc.y;
    doc.text(l.qty, x.qty, y).text(l.unit, x.unit, y)
      .text(fmt(l.unitCents), x.price, y, money).text(fmt(l.totalCents), x.total, y, money);
    doc.y = after + 3;
  }
  doc.moveDown();
  const row = (label: string, value: string, bold = false) => {
    const y = doc.y;
    doc.font(bold ? "bold" : "body").fontSize(10).text(label, 380, y).text(value, x.total - 15, y, { width: 80, align: "right" });
  };
  row("Subtotal", fmt(subtotal));
  for (const t of snapshot.taxes) row(t.name, fmt(t.cents));
  row("Total", fmt(total), true);

  // Page numbers after layout (bufferPages: true).
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(i);
    doc.font("body").fontSize(8).fillColor("#777")
      .text(`${snapshot.number} v${snapshot.version} — page ${i + 1} of ${range.count}`, 54, doc.page.height - 40, { lineBreak: false });
  }
  doc.end();
  return done;
}

await mkdir("out", { recursive: true });
const a = await render();
const b = await render();
const sha = (buf: Buffer) => createHash("sha256").update(buf).digest("hex");
await writeFile("out/quote-spike.pdf", a);

const pages = (a.toString("latin1").match(/\/Type\s*\/Page[^s]/g) ?? []).length;
const fontEmbedded = /\/FontFile2|\/FontFile3|\/FontFile\b/.test(a.toString("latin1"));
console.log(`wrote out/quote-spike.pdf (${(a.length / 1024).toFixed(0)} KB, ${pages} pages, embedded font: ${fontEmbedded})`);
console.log(`render 1 sha256 ${sha(a)}`);
console.log(`render 2 sha256 ${sha(b)}`);
console.log(`byte-identical re-render: ${sha(a) === sha(b) ? "YES" : "NO"}`);
if (sha(a) !== sha(b)) {
  const sa = a.toString("latin1"), sb = b.toString("latin1");
  let i = 0; while (i < sa.length && sa[i] === sb[i]) i++;
  console.log(`first difference at byte ${i}: …${JSON.stringify(sa.slice(Math.max(0, i - 40), i + 40))}`);
}
