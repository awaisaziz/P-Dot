import "server-only";
import { isAmbiguous, isKnownCode, resolvePlace, type ResolvedPlace } from "./airports";
import { addDays, daysBetween, isoDate, localDate, parseIsoDate, weekdayIndex, type CalendarDate } from "./dates";
import { airportsNamedIn } from "./verify";

// The trip in the user's own words (decision 0015, changes after the final
// review). A local model ignored a forced tool call and answered in text, and
// forcing the tool on a vague request made a model invent the missing origin
// and date. So code reads a clear request itself: both places and a
// departure date the user wrote. When one is missing, nothing is read here
// and search_flights refuses unless the user's words name the places and the
// date it was called with.

/** The furthest departure date accepted, in days after local today. */
export const MAX_DAYS_AHEAD = 330;

/** search_flights arguments read from the user's message. */
export interface FlightRequest {
  origin: string;
  destination: string;
  /** YYYY-MM-DD. */
  depart_date: string;
  return_date?: string;
  passengers: number;
}

const MONTH = "(january|february|march|april|may|june|july|august|september|october|november|december|sept|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)";
const MONTH_KEYS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

const ISO_DATE = /(?<![0-9])([0-9]{4})-([0-9]{2})-([0-9]{2})(?![0-9])/g;
const DAY_MONTH = new RegExp(
  `(?<![0-9A-Za-z])([0-9]{1,2})(?:st|nd|rd|th)?(?:\\s+of)?\\s+${MONTH}\\.?(?![A-Za-z])(?:,?\\s+([0-9]{4})(?![0-9]))?`,
  "gi",
);
const MONTH_DAY = new RegExp(
  `(?<![A-Za-z])${MONTH}\\.?\\s+([0-9]{1,2})(?:st|nd|rd|th)?(?![0-9A-Za-z:])(?:,?\\s+([0-9]{4})(?![0-9]))?`,
  "gi",
);
const RELATIVE_DAY = /\b(today|tonight|tomorrow)\b/gi;
/** "today's fares" and "tonight's prices" are about now, not a travel date. */
const POSSESSIVE_AFTER = /^['’]s\b/i;
const RELATIVE_WEEKDAY = /\b(this|next|coming)\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/gi;
const WEEKDAY_BEFORE = /\b(sun|mon|tue|wed|thu|fri|sat)[a-z]*\.?,?\s*$/i;
/**
 * A number and a traveller or length word: "June 2 adults" is two adults in
 * June and "June 3 nights" a three-night stay, never 2 or 3 June.
 */
const COUNT_SPAN = /(?<![0-9])[0-9]{1,3}\s+(?:adults?|people|persons|passengers|pax|travell?ers|of us|nights?|days?|weeks?|months?)\b/gi;

/** "returning 19 Nov", "back on 19 Nov", "until 19 Nov". */
const RETURN_BEFORE = /\b(?:returning|return|back|until|till|inbound)\b(?:\s+on)?(?:\s+the)?\s*$/i;
/** A return or a stay is asked for: without a return date the trip cannot be read. */
const RETURN_WORD = /\b(?:returning|return|back|inbound)\b/i;
const STAY_LENGTH =
  /\b(?:a|an|one|two|three|four|five|six|seven|eight|nine|ten|few|couple of|[0-9]{1,3})\s+(?:nights?|days?|weeks?|months?)\b|\bfortnight\b/i;
/** A bound or an approximate date, not the date itself: "by 12 Nov", "around 12 Nov", "week of 12 Nov". */
const APPROX_BEFORE =
  /\b(?:before|by|after|around|about|approx(?:imately)?|roughly|circa|near|than|earliest|latest|week of|weekend of|within|up to|sometime|some time|any ?time|any day)(?:\s+the)?\s*$/i;
/** After a date: "12 Nov or later", "or 13 Nov", "12 Nov-ish", "12 Nov onwards", "12 Nov at the latest". */
const APPROX_AFTER =
  /^\s*(?:[,(]\s*)?(?:or\b|and\/or\b|give or take|plus or minus|\+\s*\/?\s*-|±|-?\s*ish\b|onwards?\b|at the (?:latest|earliest)\b|(?:latest|earliest)\b)/i;
/** A flexible date anywhere in the message. */
const FLEXIBLE = /\bflexib(?:le|ility)\b|\bgive or take\b|\bplus or minus\b|±|\+\/-/i;
/** Between two dates: the second is the return ("12 Nov - 19 Nov", "12 Nov to 19 Nov"). */
const RANGE_GLUE = /^\s*(?:-|–|—|to|until|till|through|thru)\s*$/i;
/** Between two dates: a choice, so neither is the departure ("12 Nov or 13 Nov"). */
const CHOICE_GLUE = /^\s*(?:or|and|&|,|\/)\s*$/i;
/** A number and a dash or "or" just before a date: "12-19 Nov", "12 or 13 Nov". */
const PARTIAL_BEFORE = /[0-9]\s*(?:-|–|—|\/|or|and|&|to)\s*$/i;
/** A round trip without its return date cannot be read. */
const ROUND_TRIP = /\b(?:round[- ]?trip|return (?:flights?|tickets?|trip|fares?)|and back|there and back)\b/i;

const COUNT_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9 };
/** Any number is read, so "12 people" is a count of 12 (refused), never 1. */
const TRAVELLERS = /\b([0-9]{1,3}|one|two|three|four|five|six|seven|eight|nine)\s+(?:adults?|people|persons|passengers|travell?ers|of us)\b/gi;
/** Children travel on other fares, so a count of adults does not cover them. */
const CHILDREN = /\b(?:child|children|kids?|infants?|baby|babies|toddlers?|minors?)\b/i;
/** A group without a count: the number of travellers is not clear. */
const UNCLEAR_TRAVELLERS = /\b(?:we|our|wife|husband|partner|family|couple|friends?|colleagues?|both of)\b/i;

interface DateMention {
  start: number;
  end: number;
  /** Null when the words name no real date (31 Nov), or a weekday that does not fit it. */
  date: CalendarDate | null;
}

function monthNumber(word: string): number {
  return MONTH_KEYS.indexOf(word.slice(0, 3).toLowerCase()) + 1;
}

/** Day and month without a year: the next such date on or after local today. */
function nextDate(month: number, day: number, today: CalendarDate): CalendarDate | null {
  for (const year of [today.year, today.year + 1]) {
    const date = parseIsoDate(isoDate({ year, month, day }));
    if (date && daysBetween(today, date) >= 0) return date;
  }
  return null;
}

function namedDate(month: number, day: number, year: string | undefined, today: CalendarDate): CalendarDate | null {
  if (month < 1) return null;
  return year ? parseIsoDate(isoDate({ year: Number(year), month, day })) : nextDate(month, day, today);
}

/** The weekday of this week, today included ("this Friday"). */
function thisWeekday(today: CalendarDate, target: number): CalendarDate {
  return addDays(today, (target - weekdayIndex(today) + 7) % 7);
}

/** The weekday of next week, weeks starting on Monday ("next Friday"). */
function nextWeekday(today: CalendarDate, target: number): CalendarDate {
  const sinceMonday = (weekdayIndex(today) + 6) % 7;
  return addDays(today, 7 - sinceMonday + ((target + 6) % 7));
}

/** Every date the text names, in order: ISO dates, "12 Nov", "Nov 12th", "tomorrow", "next Friday". */
function dateMentions(text: string, today: CalendarDate): DateMention[] {
  const found: DateMention[] = [];
  const counts = [...text.matchAll(COUNT_SPAN)].map((match) => ({ start: match.index, end: match.index + match[0].length }));
  const add = (start: number, end: number, date: CalendarDate | null) => {
    // A weekday next to a date must fit it ("Thu 12 Nov"); otherwise the date is unclear.
    const weekday = WEEKDAY_BEFORE.exec(text.slice(Math.max(0, start - 12), start));
    if (date && weekday && WEEKDAYS[weekdayIndex(date)]!.slice(0, 3) !== weekday[1]!.toLowerCase()) date = null;
    found.push({ start, end, date });
  };
  /** A day and a month whose number is a count of travellers or nights ("June 2 adults"): no date. */
  const isCount = (start: number, end: number) => counts.some((count) => start < count.end && count.start < end);
  for (const match of text.matchAll(ISO_DATE)) {
    add(match.index, match.index + match[0].length, parseIsoDate(match[0]));
  }
  for (const match of text.matchAll(DAY_MONTH)) {
    // "may" in lower case is a verb.
    if (match[2] === "may") continue;
    if (isCount(match.index, match.index + match[0].length)) continue;
    add(match.index, match.index + match[0].length, namedDate(monthNumber(match[2]!), Number(match[1]), match[3], today));
  }
  for (const match of text.matchAll(MONTH_DAY)) {
    if (match[1] === "may") continue;
    if (isCount(match.index, match.index + match[0].length)) continue;
    add(match.index, match.index + match[0].length, namedDate(monthNumber(match[1]!), Number(match[2]), match[3], today));
  }
  for (const match of text.matchAll(RELATIVE_DAY)) {
    const word = match[1]!.toLowerCase();
    const end = match.index + match[0].length;
    if (word !== "tomorrow" && POSSESSIVE_AFTER.test(text.slice(end))) continue;
    found.push({ start: match.index, end, date: word === "tomorrow" ? addDays(today, 1) : today });
  }
  for (const match of text.matchAll(RELATIVE_WEEKDAY)) {
    const target = WEEKDAYS.indexOf(match[2]!.toLowerCase());
    const date = match[1]!.toLowerCase() === "next" ? nextWeekday(today, target) : thisWeekday(today, target);
    found.push({ start: match.index, end: match.index + match[0].length, date });
  }
  // One mention per stretch of text: the first that starts there, the longest when two start together.
  found.sort((a, b) => a.start - b.start || b.end - a.end);
  const kept: DateMention[] = [];
  for (const mention of found) {
    if (kept.some((other) => mention.start < other.end && other.start < mention.end)) continue;
    kept.push(mention);
  }
  return kept;
}

/**
 * The ISO dates the text names, read against local today (for checking that a
 * departure date came from the user's words).
 */
export function datesNamedIn(text: string, now: Date, timeZone: string): Set<string> {
  const today = localDate(now, timeZone);
  return new Set(
    dateMentions(text.slice(0, 4_000), today).flatMap((mention) => (mention.date ? [isoDate(mention.date)] : [])),
  );
}

/**
 * Three-letter words that are also codes in the airport table ("was" is
 * Washington, "can" Guangzhou, "per" Perth), or start a place name ("san",
 * "las"). Not in capitals, they are words, not codes.
 */
const CODE_WORDS = new Set([
  "add", "bog", "can", "chi", "del", "den", "doh", "dub", "gig", "las", "mad", "man", "mel", "mia", "mil",
  "mow", "oak", "par", "per", "san", "saw", "sea", "sen", "sin", "tsa", "vie", "was",
]);

/**
 * The airports of every place the text names: names in any case, codes as
 * written, and three-letter codes in other cases too ("lhr"), except codes
 * that are everyday words ("was", "can", "per").
 */
export function airportsInUserWords(text: string): Set<string> {
  const found = airportsNamedIn(text.slice(0, 4_000));
  for (const match of text.slice(0, 4_000).matchAll(/(?<![A-Za-z])[A-Za-z]{3}(?![A-Za-z])/g)) {
    if (CODE_WORDS.has(match[0].toLowerCase()) || !isKnownCode(match[0].toUpperCase())) continue;
    const place = resolvePlace(match[0]);
    if (place && !isAmbiguous(place)) for (const code of place.airports) found.add(code);
  }
  return found;
}

interface Word {
  /** As written, without punctuation at either end. */
  text: string;
  lower: string;
  /** Where the word (without that punctuation) starts and ends in the text. */
  start: number;
  end: number;
}

function wordsOf(text: string): Word[] {
  const words: Word[] = [];
  for (const match of text.matchAll(/\S+/g)) {
    const lead = /^[^\p{L}\p{N}]*/u.exec(match[0])![0].length;
    const word = match[0].slice(lead).replace(/[^\p{L}\p{N}]+$/u, "");
    if (!word) continue;
    words.push({ text: word, lower: word.toLowerCase(), start: match.index + lead, end: match.index + lead + word.length });
  }
  return words;
}

/** Words a place may run into at its end ("Paris all") that add nothing to it. */
const EDGE_FILLER = new Set(["the", "all", "any", "area", "metro"]);

/**
 * Words that may follow the destination: glue, dates and request words.
 * Another capitalised word ("Paris Texas") may be a qualifier the table does
 * not know, so the destination is unclear.
 */
const AFTER_DESTINATION = new Set([
  "on", "in", "for", "from", "at", "by", "via", "with", "and", "or", "but", "departing", "depart", "leaving", "leave",
  "returning", "return", "back", "next", "this", "coming", "today", "tonight", "tomorrow", "i", "we", "my", "please",
  "thanks", "thank", "one", "round", "direct", "nonstop", "flights", "flight", "tickets", "ticket", "fares", "fare",
]);
const DATE_WORD = new RegExp(`^(?:${MONTH}|(?:mon|tues?|wed|thu(?:rs?)?|fri|sat|sun)|${WEEKDAYS.join("|")})$`, "i");

/** True when the word after the destination, in the same clause, is a capitalised word that is not glue or a date. */
function unclearAfterDestination(text: string, last: Word, next: Word | undefined): boolean {
  if (!next || !/^\s*[,(]?\s*$/.test(text.slice(last.end, next.start))) return false;
  if (!/^\p{Lu}/u.test(next.text)) return false;
  return !AFTER_DESTINATION.has(next.lower) && !DATE_WORD.test(next.text);
}

/** A place in the user's words. Codes and short names count only in capitals ("LHR", "NYC", "LA"). */
function placeIn(words: Word[]): ResolvedPlace | "ambiguous" | null {
  if (words.length === 0 || words.some((word) => word.lower === "to" || word.lower === "from")) return null;
  const text = words.map((word) => word.text).join(" ");
  if (words.length === 1 && text.length <= 3 && text !== text.toUpperCase()) return null;
  const place = resolvePlace(text);
  if (!place) return null;
  return isAmbiguous(place) ? "ambiguous" : place;
}

/** The longest run of 1 to `max` words that is a place, from `words[from]` forward or ending at `words[to - 1]`. */
function longestPlace(words: Word[], start: number, end: number, forward: boolean, max = 4) {
  for (let size = Math.min(max, end - start); size >= 1; size -= 1) {
    const slice = forward ? words.slice(start, start + size) : words.slice(end - size, end);
    // "Paris any day": the place is "Paris", not "Paris any".
    if (size > 1 && EDGE_FILLER.has((forward ? slice.at(-1)! : slice[0]!).lower)) continue;
    const place = placeIn(slice);
    if (place) return { place, text: slice.map((word) => word.text).join(" "), size };
  }
  return null;
}

/** "from X to Y" or "X to Y", both places the table knows. Null when there is none or it is unclear. */
function placesIn(text: string): { origin: string; destination: string; places: [ResolvedPlace, ResolvedPlace] } | null {
  const words = wordsOf(text);
  for (let i = 1; i < words.length - 1; i += 1) {
    if (words[i]!.lower !== "to") continue;
    const destination = longestPlace(words, i + 1, words.length, true);
    if (!destination) continue;
    // "Paris Texas": the whole name is not in the table, so "Paris" alone may be another place.
    if (unclearAfterDestination(text, words[i + destination.size]!, words[i + 1 + destination.size])) return null;
    // "from X to Y": X is everything between them. Without "from": the place just before "to".
    let from = -1;
    for (let j = i - 1; j >= Math.max(0, i - 6); j -= 1) {
      if (words[j]!.lower === "from") {
        from = j;
        break;
      }
    }
    const origin =
      from >= 0
        ? (() => {
            const slice = words.slice(from + 1, i);
            const place = slice.length <= 5 ? placeIn(slice) : null;
            return place ? { place, text: slice.map((word) => word.text).join(" ") } : null;
          })()
        : longestPlace(words, Math.max(0, i - 4), i, false);
    if (!origin) {
      if (from >= 0) return null;
      continue;
    }
    if (origin.place === "ambiguous" || destination.place === "ambiguous") return null;
    // A second leg ("London to Paris to Rome") is not one trip.
    const next = i + 1 + destination.size;
    if (words[next]?.lower === "to" && longestPlace(words, next + 1, words.length, true)) return null;
    if (origin.place.airports.some((code) => (destination.place as ResolvedPlace).airports.includes(code))) return null;
    return {
      origin: origin.text.slice(0, 80),
      destination: destination.text.slice(0, 80),
      places: [origin.place, destination.place],
    };
  }
  return null;
}

/** "for 2 adults", "3 people"; 1 when the text gives no count. Null when the count is unclear or children come too. */
function travellersIn(text: string): number | null {
  if (CHILDREN.test(text)) return null;
  const counts = new Set([...text.matchAll(TRAVELLERS)].map((match) => COUNT_WORDS[match[1]!.toLowerCase()] ?? Number(match[1])));
  if (counts.size > 1) return null;
  const [count] = [...counts];
  if (count !== undefined) return count >= 1 && count <= 9 ? count : null;
  return UNCLEAR_TRAVELLERS.test(text) ? null : 1;
}

/**
 * Reads a flight request from the user's message: both places ("from X to Y"
 * or "X to Y", resolved by the airport table, IATA codes in capitals), a
 * departure date the user wrote (ISO, "12 Nov", "12 November", "Nov 12",
 * "November 12th", with or without a year, "today", "tomorrow", "this
 * Friday", "next Friday"), an optional return date ("returning 19 Nov", "back
 * 19 Nov") and travellers ("for 2 adults", "2 people"). Returns null when any
 * part is missing or unclear: then the model may call search_flights itself.
 * Unclear includes a bound or approximate date ("by 12 Nov", "12 Nov or
 * later"), a return or a stay without a return date read ("back on the 19th",
 * "for a week") and a destination followed by a word the table cannot place
 * ("Paris Texas").
 */
export function parseFlightRequest(text: string, now: Date, timeZone: string): FlightRequest | null {
  const message = text.slice(0, 2_000);
  const route = placesIn(message);
  if (!route) return null;

  if (FLEXIBLE.test(message)) return null;
  const today = localDate(now, timeZone);
  const mentions = dateMentions(message, today);
  const departs: CalendarDate[] = [];
  const returns: CalendarDate[] = [];
  for (const [index, mention] of mentions.entries()) {
    if (!mention.date) return null;
    const before = message.slice(Math.max(0, mention.start - 30), mention.start);
    if (PARTIAL_BEFORE.test(before)) return null;
    // A bound or an approximate date is not the date to search.
    if (APPROX_BEFORE.test(before) || APPROX_AFTER.test(message.slice(mention.end, mention.end + 30))) return null;
    const previous = index > 0 ? mentions[index - 1]! : null;
    const between = previous ? message.slice(previous.end, mention.start) : null;
    if (between !== null && CHOICE_GLUE.test(between)) return null;
    if (RETURN_BEFORE.test(before) || (between !== null && RANGE_GLUE.test(between))) returns.push(mention.date);
    else departs.push(mention.date);
  }
  const distinct = (dates: CalendarDate[]) => [...new Set(dates.map(isoDate))];
  const [depart, ...otherDeparts] = distinct(departs);
  const [back, ...otherReturns] = distinct(returns);
  if (!depart || otherDeparts.length > 0 || otherReturns.length > 0) return null;
  // A return or a stay without a return date read ("returning 19/11", "for a week") is not a one-way trip.
  if (!back && (ROUND_TRIP.test(message) || RETURN_WORD.test(message) || STAY_LENGTH.test(message))) return null;

  const departDate = parseIsoDate(depart)!;
  const last = addDays(today, MAX_DAYS_AHEAD);
  if (daysBetween(today, departDate) < 0 || daysBetween(departDate, last) < 0) return null;
  if (back) {
    const returnDate = parseIsoDate(back)!;
    if (daysBetween(departDate, returnDate) < 0 || daysBetween(returnDate, last) < 0) return null;
  }

  const passengers = travellersIn(message);
  if (passengers === null) return null;
  return {
    origin: route.origin,
    destination: route.destination,
    depart_date: depart,
    ...(back ? { return_date: back } : {}),
    passengers,
  };
}
