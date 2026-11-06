// Fixed-template PDFs (design §19). Drawn from a snapshot only. Dates come from
// the snapshot, never the clock. The bytes rendered here are stored once and
// are the document from then on; nothing relies on re-rendering matching them.
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import PDFDocument from "pdfkit";
import { type InvoiceSnapshot, type QtyMilli, type QuoteSnapshot, type SnapshotLine, formatQtyMilli } from "@qa/shared";

const require = createRequire(import.meta.url);
// The "latin" subset covers English and French. Names outside it (e.g. Polish ł)
// would print as a blank box; switch to a full Noto TTF before a pilot needs them.
const FONT = require.resolve("@fontsource/noto-sans/files/noto-sans-latin-400-normal.woff");
const FONT_BOLD = require.resolve("@fontsource/noto-sans/files/noto-sans-latin-700-normal.woff");

const money = (cents: number, currency: string) =>
  (cents / 100).toLocaleString("en-CA", { style: "currency", currency, currencyDisplay: "narrowSymbol" });

interface Row { description: string; qty: string; unit: string; price: string; total: string }

// Assembly components print as one priced row when the business collapses them.
function rows(lines: SnapshotLine[], collapse: boolean, currency: string): Row[] {
  const out: Row[] = [];
  const seen = new Set<string>();
  for (const l of lines) {
    if (collapse && l.groupKey) {
      if (seen.has(l.groupKey)) continue;
      seen.add(l.groupKey);
      const group = lines.filter((x) => x.groupKey === l.groupKey);
      const total = group.reduce((s, x) => s + x.lineTotalCents, 0);
      out.push({ description: l.groupKey.split(":").slice(1).join(":"), qty: "1", unit: "each", price: money(total, currency), total: money(total, currency) });
    } else {
      out.push({
        description: l.description, qty: formatQtyMilli(l.qtyMilli as QtyMilli), unit: l.unit,
        price: money(l.unitPriceCents, currency), total: money(l.lineTotalCents, currency),
      });
    }
  }
  return out;
}

interface Layout {
  title: string; footerRef: string; date: Date; author: string; currency: string;
  business: string; regNos: string[];
  customer: QuoteSnapshot["customer"];
  meta: string[];
  table: Row[];
  optional: Row[];
  totals: [string, string, boolean?][];
  terms: string;
}

function draw(l: Layout): Promise<Buffer> {
  const doc = new PDFDocument({
    size: "LETTER", margin: 54, bufferPages: true,
    info: { Title: l.title, Author: l.author, CreationDate: l.date, ModDate: l.date },
  });
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((res) => doc.on("end", () => res(Buffer.concat(chunks))));
  doc.registerFont("body", FONT);
  doc.registerFont("bold", FONT_BOLD);

  doc.font("bold").fontSize(18).text(l.business);
  if (l.regNos.length) doc.font("body").fontSize(9).fillColor("#555").text(l.regNos.join(" · "));
  doc.moveDown();
  doc.fillColor("#000").font("bold").fontSize(14).text(l.title);
  doc.font("body").fontSize(10).text(`Prepared for: ${l.customer.name}`);
  if (l.customer.siteAddress) doc.text(l.customer.siteAddress);
  for (const m of l.meta) doc.text(m);
  doc.moveDown();

  // Money columns are fixed-width and right-aligned (Day-1 spike finding).
  const x = { desc: 54, qty: 350, unit: 385, price: 425, total: 493 };
  const moneyCol = { width: 65, align: "right" as const };
  const descWidth = x.qty - x.desc - 10;
  const header = () => {
    doc.font("bold").fontSize(9);
    const y = doc.y;
    doc.text("Description", x.desc, y).text("Qty", x.qty, y).text("Unit", x.unit, y)
      .text("Price", x.price, y, moneyCol).text("Total", x.total, y, moneyCol);
    doc.moveTo(54, doc.y + 2).lineTo(558, doc.y + 2).stroke("#999");
    doc.moveDown(0.5).font("body");
  };
  const table = (data: Row[]) => {
    for (const r of data) {
      doc.font("body").fontSize(9);
      const h = doc.heightOfString(r.description, { width: descWidth });
      if (doc.y + h > doc.page.height - 100) { doc.addPage(); header(); doc.fontSize(9); }
      const y = doc.y;
      doc.text(r.description, x.desc, y, { width: descWidth });
      const after = doc.y;
      doc.text(r.qty, x.qty, y).text(r.unit, x.unit, y)
        .text(r.price, x.price, y, moneyCol).text(r.total, x.total, y, moneyCol);
      doc.y = after + 3;
    }
  };
  header();
  table(l.table);
  if (l.optional.length) {
    doc.moveDown(0.5).font("bold").fontSize(9).text("Optional extras (not included in the total)", x.desc);
    doc.moveDown(0.3);
    table(l.optional);
  }

  doc.moveDown();
  if (doc.y + l.totals.length * 16 > doc.page.height - 90) doc.addPage();
  for (const [label, value, bold] of l.totals) {
    const y = doc.y;
    doc.font(bold ? "bold" : "body").fontSize(10).text(label, 340, y).text(value, 478, y, { width: 80, align: "right" });
  }
  if (l.terms.trim()) {
    doc.moveDown(1.5).font("body").fontSize(8.5).fillColor("#444").text(l.terms, 54, doc.y, { width: 504 });
  }

  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(i);
    doc.font("body").fontSize(8).fillColor("#777")
      .text(`${l.footerRef} — page ${i + 1} of ${range.count}`, 54, doc.page.height - 40, { lineBreak: false });
  }
  doc.end();
  return done;
}

const regNos = (taxes: QuoteSnapshot["taxes"]) => taxes.filter((t) => t.regNo).map((t) => `${t.name} ${t.regNo}`);
const taxRows = (taxes: QuoteSnapshot["taxes"], c: string): [string, string][] =>
  taxes.map((t) => [`${t.name} ${t.ratePpm / 10_000}%`, money(t.amountCents, c)]);

export function renderQuotePdf(s: QuoteSnapshot): Promise<Buffer> {
  const c = s.currency;
  const ref = `${s.number} v${s.version}`;
  const deposit = s.depositPct > 0 ? [`Deposit due on acceptance: ${s.depositPct}%`] : [];
  return draw({
    title: `Quote ${s.number} (v${s.version})`, footerRef: ref, date: new Date(`${s.issuedOn}T00:00:00Z`), author: s.business.name,
    currency: c, business: s.business.name, regNos: regNos(s.taxes), customer: s.customer,
    meta: [`Issued ${s.issuedOn} · Valid until ${s.expiresOn}`, ...deposit],
    table: rows(s.lines.filter((l) => !l.optional), s.collapseAssemblies, c),
    optional: rows(s.lines.filter((l) => l.optional), false, c),
    totals: [
      ["Subtotal", money(s.subtotalCents, c)],
      ...(s.discountCents ? [["Discount", `−${money(s.discountCents, c)}`] as [string, string]] : []),
      ...taxRows(s.taxes, c),
      ["Total", money(s.totalCents, c), true],
    ],
    terms: s.terms,
  });
}

export function renderInvoicePdf(s: InvoiceSnapshot, dueDate: string): Promise<Buffer> {
  const c = s.currency;
  return draw({
    title: `${s.kind === "deposit" ? "Deposit invoice" : "Invoice"} ${s.number}`, footerRef: s.number,
    date: new Date(`${s.issuedOn}T00:00:00Z`), author: s.business.name,
    currency: c, business: s.business.name, regNos: regNos(s.taxes), customer: s.customer,
    meta: [`Issued ${s.issuedOn} · Due ${dueDate}`, `For quote ${s.quoteRef}`],
    table: rows(s.lines, s.collapseAssemblies, c),
    optional: [],
    totals: [
      ["Subtotal", money(s.subtotalCents, c)],
      ...(s.discountCents ? [["Discount", `−${money(s.discountCents, c)}`] as [string, string]] : []),
      ...taxRows(s.taxes, c),
      ["Total", money(s.totalCents, c), !s.lessDepositCents],
      ...(s.lessDepositCents
        ? [[`Less deposit ${s.lessDepositRef ?? ""}`.trim(), `−${money(s.lessDepositCents, c)}`] as [string, string],
           ["Amount due", money(s.amountDueCents, c), true] as [string, string, boolean]]
        : []),
    ],
    terms: s.terms,
  });
}

export const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");
