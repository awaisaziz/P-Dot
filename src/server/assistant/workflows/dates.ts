import "server-only";

// Dates in the user's own time zone (decision 0015): the prompt states the
// local date and weekday, and a flight date is checked against local today.

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

/** An IANA zone name: letters, digits and _ + - / only. */
const ZONE_PATTERN = /^[A-Za-z][A-Za-z0-9_+\-/]{0,63}$/;

/**
 * The canonical IANA name for `timeZone`, or "UTC" when it is missing or not
 * a zone this runtime knows. The result is safe to put in a prompt: it is the
 * runtime's own name, never the caller's text.
 */
export function safeTimeZone(timeZone: string | undefined | null): string {
  if (!timeZone || !ZONE_PATTERN.test(timeZone)) return "UTC";
  try {
    const resolved = new Intl.DateTimeFormat("en-US", { timeZone }).resolvedOptions().timeZone;
    return ZONE_PATTERN.test(resolved) ? resolved : "UTC";
  } catch {
    return "UTC";
  }
}

export interface CalendarDate {
  year: number;
  /** 1 to 12. */
  month: number;
  day: number;
}

/** The calendar date at `now` in the zone (UTC when the zone is unknown). */
export function localDate(now: Date, timeZone?: string | null): CalendarDate {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: safeTimeZone(timeZone),
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(now);
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? NaN);
  return { year: get("year"), month: get("month"), day: get("day") };
}

/** YYYY-MM-DD. */
export function isoDate(date: CalendarDate): string {
  return `${String(date.year).padStart(4, "0")}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}`;
}

/** Parses YYYY-MM-DD into a real calendar date, or null (2026-02-30 is null). */
export function parseIsoDate(value: string): CalendarDate | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const date = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
  const check = new Date(Date.UTC(date.year, date.month - 1, date.day));
  if (check.getUTCFullYear() !== date.year || check.getUTCMonth() !== date.month - 1 || check.getUTCDate() !== date.day) {
    return null;
  }
  return date;
}

/** Whole days from `a` to `b` (positive when b is later). */
export function daysBetween(a: CalendarDate, b: CalendarDate): number {
  return Math.round((Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / 86_400_000);
}

export function addDays(date: CalendarDate, days: number): CalendarDate {
  const d = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/** 0 (Sunday) to 6 (Saturday). */
export function weekdayIndex(date: CalendarDate): number {
  return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
}

export function weekdayName(date: CalendarDate): string {
  return WEEKDAYS[weekdayIndex(date)]!;
}

export function monthName(month: number): string {
  return MONTHS[month - 1] ?? "";
}

/** "Wednesday 21 October 2026". */
export function longDate(date: CalendarDate): string {
  return `${weekdayName(date)} ${date.day} ${monthName(date.month)} ${date.year}`;
}

/** "Wed 21 Oct 2026". */
export function shortDate(date: CalendarDate): string {
  return `${weekdayName(date).slice(0, 3)} ${date.day} ${monthName(date.month).slice(0, 3)} ${date.year}`;
}

/** The zone's offset at `now`, as "UTC+1", "UTC+5:30", "UTC-3" or "UTC+0". */
export function utcOffsetLabel(now: Date, timeZone: string): string {
  const name =
    new Intl.DateTimeFormat("en-US", { timeZone: safeTimeZone(timeZone), timeZoneName: "longOffset" })
      .formatToParts(now)
      .find((part) => part.type === "timeZoneName")?.value ?? "GMT";
  const match = /^GMT([+-])(\d{2}):(\d{2})$/.exec(name);
  if (!match) return "UTC+0";
  const hours = Number(match[2]);
  const minutes = match[3] === "00" ? "" : `:${match[3]}`;
  return `UTC${match[1]}${hours}${minutes}`;
}

/** "Today is Wednesday 21 October 2026 in Europe/London (UTC+1)." */
export function todaySentence(now: Date, timeZone?: string | null): string {
  const zone = safeTimeZone(timeZone);
  const today = localDate(now, zone);
  return `Today is ${longDate(today)} in ${zone} (${utcOffsetLabel(now, zone)}). The ISO date is ${isoDate(today)}.`;
}
