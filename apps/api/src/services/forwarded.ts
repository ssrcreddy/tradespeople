// Forwarded-message parsing (design §16 step 1). When a tradesperson forwards
// an enquiry, the customer's address usually appears only in the forwarded
// header block — so it is read deterministically here, before any cleaning.

export interface ParsedForward {
  contactHint: { name: string | null; email: string | null };
  cleanedText: string;
}

const FORWARD_MARKERS = [
  /^-{2,}\s*Forwarded message\s*-{2,}\s*$/im,      // Gmail
  /^Begin forwarded message:\s*$/im,                // Apple Mail
  /^-{2,}\s*Original Message\s*-{2,}\s*$/im,        // Outlook (older)
  /^_{5,}\s*$/m,                                    // Outlook (newer) underscore rule
];

const HEADER = /^\s*(From|Sent|Date|To|Cc|Subject|Reply-To)\s*:\s*(.*)$/i;
const MAX_CHARS = 12_000;

function parseAddress(v: string): { name: string | null; email: string | null } {
  const angle = /^\s*"?([^"<]*?)"?\s*<([^>]+@[^>]+)>\s*$/.exec(v);
  if (angle) return { name: angle[1]!.trim() || null, email: angle[2]!.trim().toLowerCase() };
  const bare = /([^\s<>"]+@[^\s<>"]+\.[^\s<>"]+)/.exec(v);
  return { name: null, email: bare ? bare[1]!.toLowerCase() : null };
}

export function parseForwarded(text: string): ParsedForward {
  const normalised = text.replace(/\r\n/g, "\n");
  let contactHint: ParsedForward["contactHint"] = { name: null, email: null };
  let body = normalised;

  // Use the innermost forwarded block: that is the original customer message.
  let lastMarker = -1;
  let markerLen = 0;
  for (const re of FORWARD_MARKERS) {
    const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
    for (const m of normalised.matchAll(g)) {
      if (m.index! > lastMarker) { lastMarker = m.index!; markerLen = m[0].length; }
    }
  }

  const start = lastMarker >= 0 ? lastMarker + markerLen : 0;
  const lines = normalised.slice(start).split("\n");
  let i = 0;
  while (i < lines.length && lines[i]!.trim() === "") i++;
  const headerStart = i;
  while (i < lines.length && HEADER.test(lines[i]!)) {
    const [, key, value] = HEADER.exec(lines[i]!)!;
    if (key!.toLowerCase() === "from") contactHint = parseAddress(value!);
    i++;
  }
  if (i > headerStart) body = lines.slice(i).join("\n");
  else if (lastMarker >= 0) body = normalised.slice(start);

  // Drop quoted reply lines and trailing whitespace; keep everything else verbatim
  // so source quotes still match the stored original.
  body = body.split("\n").filter((l) => !/^\s*>/.test(l)).join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return { contactHint, cleanedText: body.slice(0, MAX_CHARS) };
}

// Minimal HTML → text for emails with no text part.
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|li|tr|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}
