// Maps each line's source quote back onto the original message (design §22):
// highlighted spans show where a line came from; sentences no line used are
// shaded "not used" — the cheapest defence against a missed line (§10).

export interface Piece { text: string; keys: string[] }
export interface Sentence { pieces: Piece[]; used: boolean }

const flat = (s: string) => s.toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, " ");

function findRange(text: string, quote: string): [number, number] | null {
  const q = flat(quote).trim();
  if (q.length < 3) return null;
  // Compare on a whitespace-collapsed copy, keeping a map back to real offsets.
  const map: number[] = [];
  let collapsed = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (/\s/.test(ch)) { if (collapsed.endsWith(" ")) continue; collapsed += " "; }
    else collapsed += ch.toLowerCase().replace("’", "'");
    map.push(i);
  }
  let at = collapsed.indexOf(q);
  let len = q.length;
  if (at < 0) {                        // model paraphrased slightly: anchor on the opening words
    const head = q.split(" ").slice(0, 5).join(" ");
    at = head.length >= 8 ? collapsed.indexOf(head) : -1;
    len = head.length;
  }
  if (at < 0) return null;
  return [map[at]!, map[Math.min(at + len, map.length) - 1]! + 1];
}

// Text that could never be a line: forwarded headers, greetings, sign-offs,
// names and phone numbers. Flagging these as "not used" would bury the real
// misses ("also the bathroom fan…") in noise.
const HEADER = /^\s*(-{2,}.*-{2,}|Begin forwarded message:|On .+ wrote:|(From|Sent|Date|To|Cc|Subject|Reply-To)\s*:)/i;
const GREETING = /^\s*(hi|hello|hey|dear|bonjour|thanks|thank you|merci|cheers|regards|best|sincerely)\b/i;
function isNeutral(s: string) {
  const t = s.trim();
  return !t || HEADER.test(t) || t.split(/\s+/).length < 4 || (GREETING.test(t) && t.split(/\s+/).length < 6);
}

export function highlight(text: string, quotes: { key: string; quote: string | null }[]): Sentence[] {
  const ranges = quotes.flatMap(({ key, quote }) => {
    const r = quote ? findRange(text, quote) : null;
    return r ? [{ key, start: r[0], end: r[1] }] : [];
  });
  const sentences: Sentence[] = [];
  // A terminator only ends a sentence when whitespace or the end follows, so
  // "priya.shah@example.com" and "4.5 h" stay whole.
  for (const m of text.matchAll(/(?:[^.!?\r\n]|[.!?](?![\s]|$))+[.!?]*[ \t]*|[\r\n]+/g)) {
    const s = m.index!, e = s + m[0].length;
    if (/^[\r\n]+$/.test(m[0])) { sentences.push({ pieces: [{ text: m[0], keys: [] }], used: true }); continue; }
    const cuts = new Set([s, e]);
    for (const r of ranges) {
      if (r.end > s && r.start < e) { cuts.add(Math.max(r.start, s)); cuts.add(Math.min(r.end, e)); }
    }
    const pts = [...cuts].sort((a, b) => a - b);
    const pieces: Piece[] = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i]!, b = pts[i + 1]!;
      pieces.push({ text: text.slice(a, b), keys: ranges.filter((r) => r.start <= a && r.end >= b).map((r) => r.key) });
    }
    const used = pieces.some((p) => p.keys.length) || isNeutral(m[0]);
    sentences.push({ pieces, used });
  }
  return sentences;
}
