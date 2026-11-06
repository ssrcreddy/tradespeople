// Calendar dates in the business's timezone (design §12, §14, §20). "Today",
// due dates and reminder times are local to the business, not to the server.

export function todayIn(tz: string, now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

export function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + days)).toISOString().slice(0, 10);
}

// How far `tz` is ahead of UTC at this instant, in milliseconds.
function offsetMs(instant: number, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric",
    hour: "numeric", minute: "numeric", second: "numeric",
  }).formatToParts(instant);
  const n = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  return Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second")) - Math.floor(instant / 1000) * 1000;
}

// The instant when the wall clock in `tz` reads `hour`:00 on `iso`.
export function localHourToInstant(iso: string, hour: number, tz: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  const wall = Date.UTC(y!, m! - 1, d!, hour);
  const first = wall - offsetMs(wall, tz);
  return new Date(wall - offsetMs(first, tz));   // second pass settles DST-boundary days
}
