import "server-only";
import { z } from "zod";
import type {
  DropReason,
  FlightOption,
  FlightResult,
  PriceBasis,
  ResearchClaim,
  ResearchResult,
} from "@/types/workflows";
import { airlineMentions, airlinesIn, maskAirlines } from "./airlines";
import { knownPlaceAliases, type ResolvedPlace } from "./airports";
import { monthName, weekdayName, type CalendarDate } from "./dates";
import { encodeLine } from "./encode";

// Pure checks that decide what a workflow may show as a fact (decision 0015,
// "Code owns the facts"). The extraction model only points at text: every
// span must be on the numbered page, inside one chunk, and code reads the
// price, currency, basis, route, direction and date from that text. Anything
// that fails is dropped with a reason and counted, never shown.

// ---------------------------------------------------------------------------
// Text normalisation
// ---------------------------------------------------------------------------

/**
 * The form both sides of every comparison use: NFKC (fullwidth to ASCII),
 * straight quotes, one kind of dash, no zero-width characters, single spaces.
 */
export function normalizeForMatch(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/[​-‍⁠﻿]/g, "")
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[‐-―−﹘﹣－]/g, "-")
    .replace(/[\s  -   　]+/g, " ")
    .trim();
}

/** Lower case and no accents, one character at a time, so positions stay the same. */
function foldAligned(text: string): string {
  let out = "";
  for (const char of text) {
    const bare = char.normalize("NFKD").replace(/\p{M}/gu, "");
    const folded = bare.length === char.length ? bare.toLowerCase() : char.toLowerCase();
    out += folded.length === char.length ? folded : char;
  }
  return out;
}

/** Where `needle` starts in `haystack`, exact first, then ignoring case and accents. Both normalized. */
function locate(haystack: string, needle: string, from = 0): number {
  const exact = haystack.indexOf(needle, from);
  if (exact !== -1) return exact;
  return foldAligned(haystack).indexOf(foldAligned(needle), from);
}

/** Every start of `needle` in `haystack` (normalized), ignoring case and accents. */
function locateAll(haystack: string, needle: string): number[] {
  const folded = foldAligned(haystack);
  const target = foldAligned(needle);
  const starts: number[] = [];
  if (!target) return starts;
  for (let at = folded.indexOf(target); at !== -1; at = folded.indexOf(target, at + 1)) starts.push(at);
  return starts;
}

// ---------------------------------------------------------------------------
// Quotes
// ---------------------------------------------------------------------------

/** A page as the extraction model saw it: numbered, with its (encoded) chunks. */
export interface CheckPage {
  n: number;
  title: string;
  chunks: string[];
}

export type QuoteMatch =
  | { ok: true; chunkIndex: number; chunk: string; start: number; text: string }
  | { ok: false; reason: "quote_not_found" | "cross_chunk" };

const MIN_QUOTE_CHARS = 5;

/**
 * Finds a quote verbatim (after normalisation, ignoring case and accents) in
 * ONE chunk of the page. A quote found only across two chunks, or one that
 * contains Tavily's "[...]" separator, is `cross_chunk`. `text` is the page's
 * own words for the quote.
 */
export function findQuote(quote: string, page: CheckPage): QuoteMatch {
  const q = normalizeForMatch(quote);
  if (q.length < MIN_QUOTE_CHARS) return { ok: false, reason: "quote_not_found" };
  if (q.includes("[...]")) return { ok: false, reason: "cross_chunk" };
  const chunks = page.chunks.map(normalizeForMatch);
  for (const [chunkIndex, chunk] of chunks.entries()) {
    const start = locate(chunk, q);
    if (start !== -1) return { ok: true, chunkIndex, chunk, start, text: chunk.slice(start, start + q.length) };
  }
  for (const glue of [" ", ""]) {
    if (locate(chunks.join(glue), q) !== -1) return { ok: false, reason: "cross_chunk" };
  }
  return { ok: false, reason: "quote_not_found" };
}

/** Text that talks to the assistant instead of describing the world. */
const ADDRESSING = [
  /\b(?:ignore|disregard|forget|override)\b.{0,40}\b(?:instructions?|prompts?|rules|messages?|above|previous|prior)\b/i,
  /\byou (?:must|should|are required to|have to)\b/i,
  /\bsystem prompt\b/i,
  /\bp\s?-?\s?dot\b/i,
  /\bas an ai\b/i,
  /\b(?:ai|assistant|chatbot|language model|llm)s?\b.{0,24}\b(?:must|should|will|need to)\b/i,
  /\bnew instructions?\b/i,
  /\bdeveloper mode\b/i,
  /\bjailbreak/i,
];

export function addressesAssistant(text: string): boolean {
  const t = normalizeForMatch(text);
  return ADDRESSING.some((pattern) => pattern.test(t));
}

// ---------------------------------------------------------------------------
// Numbers, prices and times
// ---------------------------------------------------------------------------

export interface NumberToken {
  start: number;
  end: number;
  value: number;
}

/**
 * Numbers on token boundaries, with thousands and decimal separators read:
 * "1,412" and "1.412" are 1412, "412.50" and "412,50" are 412.5. A space or an
 * apostrophe between digit groups is a thousands separator too, as French,
 * Nordic and Swiss pages write them: "1 412" and "1'412" are 1412 (text is
 * normalized first, so a no-break space is a space). "412" is not found inside
 * "1,412" or "1 412". A number after a time or a flight number ("8:15 412",
 * "BA117 412") is not joined to it.
 */
export function numberTokens(text: string): NumberToken[] {
  const pattern =
    /(?<![0-9])(?<![0-9][.,])(?:[0-9]{1,3}(?:([.,])[0-9]{3})(?:\1[0-9]{3})*(?:[.,][0-9]{1,2})?|(?<![:.,'A-Za-z])[1-9][0-9]{0,2}(?:([ '])[0-9]{3})(?:\2[0-9]{3})*(?:[.,][0-9]{1,2})?(?![0-9])(?![.,][0-9])|[0-9]+(?:[.,][0-9]{1,2})?)(?![0-9])(?![.,][0-9])/g;
  const tokens: NumberToken[] = [];
  for (const match of text.matchAll(pattern)) {
    const raw = match[0];
    const value = tokenValue(raw, match[1] ?? match[2]);
    if (Number.isFinite(value)) tokens.push({ start: match.index, end: match.index + raw.length, value });
  }
  return tokens;
}

function tokenValue(raw: string, group: string | undefined): number {
  if (group) {
    // Groups of three after the first, then an optional decimal part of one or two digits.
    const grouped = /^([0-9]{1,3}(?:[.,' ][0-9]{3})+)(?:[.,]([0-9]{1,2}))?$/.exec(raw);
    if (grouped) return Number(`${grouped[1]!.split(group).join("")}${grouped[2] ? `.${grouped[2]}` : ""}`);
  }
  const plain = /^([0-9]+)(?:[.,]([0-9]{1,2}))?$/.exec(raw);
  return plain ? Number(`${plain[1]}${plain[2] ? `.${plain[2]}` : ""}`) : Number.NaN;
}

const SYMBOLS: [string, string | null][] = [
  ["US$", "USD"],
  ["CA$", "CAD"],
  ["C$", "CAD"],
  ["AU$", "AUD"],
  ["A$", "AUD"],
  ["NZ$", "NZD"],
  ["HK$", "HKD"],
  ["S$", "SGD"],
  ["R$", "BRL"],
  ["MX$", "MXN"],
  ["CN¥", "CNY"],
  ["JP¥", "JPY"],
  ["£", "GBP"],
  ["€", "EUR"],
  ["₹", "INR"],
  ["₩", "KRW"],
  ["₺", "TRY"],
  ["₱", "PHP"],
  ["฿", "THB"],
  ["₫", "VND"],
  ["¥", null],
  ["$", null],
];

const ISO_CODES = [
  "USD", "GBP", "EUR", "JPY", "CAD", "AUD", "NZD", "CHF", "INR", "AED", "SGD", "HKD", "CNY", "RMB", "KRW", "SEK", "NOK",
  "DKK", "PLN", "CZK", "MXN", "BRL", "ZAR", "TRY", "THB", "MYR", "IDR", "PHP", "VND", "QAR", "SAR", "ILS", "EGP", "ARS",
  "CLP", "COP", "PEN", "HUF", "TWD",
];

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const SYMBOL_ALT = SYMBOLS.map(([symbol]) => escapeRegex(symbol)).join("|");
const ISO_ALT = ISO_CODES.join("|");
const MARKER_BEFORE = new RegExp(`(?:(${SYMBOL_ALT})|(?<![A-Za-z])(${ISO_ALT}))\\s?$`);
const MARKER_AFTER = new RegExp(`^\\s?(?:(${SYMBOL_ALT})|(${ISO_ALT})(?![A-Za-z]))`);
const RANGE_GLUE = /^\s?(?:[-–—]|to)\s?$/i;

export interface PriceToken {
  start: number;
  end: number;
  /** The low end for a range. */
  amount: number;
  values: number[];
  symbols: string[];
  isoCodes: string[];
  range: boolean;
}

/**
 * Prices in a text: numbers with a currency symbol or ISO code next to them
 * ("$412", "£441-1,585", "EUR 412", "412 €"). A second number joined by a
 * dash or "to" to a price is part of the same price (a range).
 */
export function priceTokens(text: string): PriceToken[] {
  const numbers = numberTokens(text);
  const markers = numbers.map((token) => ({
    before: MARKER_BEFORE.exec(text.slice(Math.max(0, token.start - 6), token.start)),
    after: MARKER_AFTER.exec(text.slice(token.end, token.end + 6)),
  }));
  // Two numbers joined by a dash or "to" (a currency symbol may come before the second), low to high.
  const joined = (a: NumberToken, b: NumberToken, aAfter: RegExpExecArray | null) => {
    const between = text.slice(a.end + (aAfter ? aAfter[0].length : 0), b.start).replace(new RegExp(`(?:${SYMBOL_ALT})$`), "");
    return RANGE_GLUE.test(between) && b.value > a.value;
  };
  const prices: PriceToken[] = [];
  for (let i = 0; i < numbers.length; i += 1) {
    const token = numbers[i]!;
    const { before, after } = markers[i]!;
    const next = numbers[i + 1];
    const nextMarkers = markers[i + 1];
    // "441-1,585 USD": the first number has no marker of its own.
    const rangeStartsHere = next !== undefined && nextMarkers !== undefined && joined(token, next, after);
    if (!before && !after && !(rangeStartsHere && (nextMarkers.before || nextMarkers.after))) continue;
    const price: PriceToken = {
      start: token.start - (before ? before[0].length : 0),
      end: token.end + (after ? after[0].length : 0),
      amount: token.value,
      values: [token.value],
      symbols: [before?.[1], after?.[1]].filter((s): s is string => Boolean(s)),
      isoCodes: [before?.[2], after?.[2]].filter((s): s is string => Boolean(s)),
      range: false,
    };
    if (rangeStartsHere) {
      price.values.push(next.value);
      price.range = true;
      price.end = next.end + (nextMarkers.after ? nextMarkers.after[0].length : 0);
      for (const marker of [nextMarkers.before, nextMarkers.after]) {
        if (marker?.[1]) price.symbols.push(marker[1]);
        if (marker?.[2]) price.isoCodes.push(marker[2]);
      }
      i += 1;
    }
    prices.push(price);
  }
  return prices;
}

export interface ClockTime {
  start: number;
  end: number;
  /** Minutes after midnight. */
  minutes: number;
}

/**
 * Clock times in a reply or a quote, for the reply check: what clockTimes
 * reads, plus an hour with am or pm and no minutes ("6pm", "6 p.m."). A time
 * like "18.40" is not read, because it looks like an amount.
 */
export function replyClockTimes(text: string): ClockTime[] {
  const times = clockTimes(text);
  const hourOnly = /(?<![0-9:.,])(1[0-2]|0?[1-9])\s?([ap])(?:m|\.m\.?)(?![a-z])/gi;
  for (const match of text.matchAll(hourOnly)) {
    if (times.some((time) => time.start <= match.index && match.index < time.end)) continue;
    const hours = (Number(match[1]) % 12) + (match[2]!.toLowerCase() === "p" ? 12 : 0);
    times.push({ start: match.index, end: match.index + match[0].length, minutes: hours * 60 });
  }
  return times.sort((a, b) => a.start - b.start);
}

/** Clock times: "8:05 pm", "20:05", "8:05am". */
export function clockTimes(text: string): ClockTime[] {
  const pattern = /(?<![0-9:])([01]?[0-9]|2[0-3]):([0-5][0-9])(?![0-9:])(?:\s?([ap])\.?m\.?(?![a-z]))?/gi;
  const times: ClockTime[] = [];
  for (const match of text.matchAll(pattern)) {
    let hours = Number(match[1]);
    const minutes = Number(match[2]);
    const half = match[3]?.toLowerCase();
    if (half && hours > 12) continue;
    if (half === "p" && hours < 12) hours += 12;
    if (half === "a" && hours === 12) hours = 0;
    times.push({ start: match.index, end: match.index + match[0].length, minutes: hours * 60 + minutes });
  }
  return times;
}

/** ISO 4217 code for a price, only from a code or an unambiguous symbol (decision 0015). */
export function currencyOf(price: PriceToken, quote: string): string | null {
  const iso = price.isoCodes[0];
  if (iso) return iso === "RMB" ? "CNY" : iso;
  const codesInQuote = [...new Set([...quote.matchAll(new RegExp(`(?<![A-Za-z])(${ISO_ALT})(?![A-Za-z])`, "g"))].map((m) => m[1]!))];
  for (const symbol of price.symbols) {
    const known = SYMBOLS.find(([s]) => s === symbol)?.[1];
    if (known) return known;
    if (symbol === "¥") {
      if (/\b(?:yen|JPY|Japan|Japanese)\b/i.test(quote)) return "JPY";
      if (/\b(?:yuan|RMB|CNY|renminbi)\b/i.test(quote)) return "CNY";
    }
  }
  // A bare "$" or "¥": a currency only when the quote names exactly one ISO code.
  if (codesInQuote.length === 1) return codesInQuote[0] === "RMB" ? "CNY" : codesInQuote[0]!;
  return null;
}

/** How a price is meant, from the quote's own words. */
export function priceBasis(quote: string, price: PriceToken): PriceBasis[] {
  const basis: PriceBasis[] = [];
  const before = quote.slice(Math.max(0, price.start - 24), price.start);
  if (/\b(?:from|starting at|starting from|as low as|low as)\s*$/i.test(before)) basis.push("from");
  if (/\b(?:per person|per passenger|per adult|per traveller|per traveler|pp|p\.p\.)(?![a-z])/i.test(quote)) basis.push("per_person");
  if (/\b(?:round[- ]?trip|return (?:flights?|fares?|tickets?|trips?)|rtn)\b/i.test(quote) || hasDateRange(quote)) {
    basis.push("round_trip");
  }
  if (/\bone[- ]way\b/i.test(quote)) basis.push("one_way");
  if (price.range) basis.push("range");
  return basis;
}

// ---------------------------------------------------------------------------
// Route, direction and date
// ---------------------------------------------------------------------------

const INITIALS = /^(?:\p{L}\.){2,}$/u;

function aliasPattern(alias: string): RegExp | null {
  const trimmed = alias.trim();
  if (!trimmed) return null;
  // Codes and short names ("LHR", "NY", "LA") match only as written, so "la" or "sea" in a sentence do not
  // count. A capital code may follow a lower-case letter, as pages glue them ("8:10 amJFK").
  if (/^[A-Z]{2,3}$/.test(trimmed)) return new RegExp(`(?<![A-Z0-9])${trimmed}(?![A-Z0-9a-z])`, "gu");
  if (trimmed.length <= 3 || INITIALS.test(trimmed)) {
    // Short names and initials with dots ("L.A.", "D.C.") match only as written.
    return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegex(trimmed)}(?![\\p{L}\\p{N}])`, "gu");
  }
  const runs = foldAligned(normalizeForMatch(trimmed)).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (runs.length === 0) return null;
  return new RegExp(`(?<![\\p{L}\\p{N}])${runs.map(escapeRegex).join("[^\\p{L}\\p{N}]{0,3}")}(?![\\p{L}\\p{N}])`, "gu");
}

/** Whether an alias matches only as written (codes, short names, initials). */
function matchesAsWritten(alias: string): boolean {
  const trimmed = alias.trim();
  return trimmed.length <= 3 || INITIALS.test(trimmed);
}

/**
 * Text that every match of aliasPattern(alias) contains, in the form it is
 * matched against (as written, or folded): the alias itself, or its longest
 * word. A text without it cannot match, so its pattern is never run. The
 * alias table has over a thousand patterns, and running each one is slow the
 * first times (V8 compiles a pattern when it first runs, and again when it
 * runs a second time).
 */
function aliasNeedle(alias: string): string {
  const trimmed = alias.trim();
  if (matchesAsWritten(trimmed)) return trimmed;
  const runs = foldAligned(normalizeForMatch(trimmed)).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  return runs.reduce((longest, run) => (run.length > longest.length ? run : longest), "");
}

interface Range {
  start: number;
  end: number;
}

/** Where any alias of the place is in the text (normalized). `folded` is foldAligned(text). */
function placeRanges(text: string, folded: string, place: ResolvedPlace): Range[] {
  const ranges: Range[] = [];
  for (const alias of place.aliases) {
    const searched = matchesAsWritten(alias) ? text : folded;
    if (!searched.includes(aliasNeedle(alias))) continue;
    const pattern = aliasPattern(alias);
    if (!pattern) continue;
    for (const match of searched.matchAll(pattern)) {
      ranges.push({ start: match.index, end: match.index + match[0].length });
    }
  }
  return ranges;
}

/** Start positions of any alias of the place in the text (normalized). */
export function placePositions(text: string, place: ResolvedPlace): number[] {
  const starts = placeRanges(text, foldAligned(text), place).map((range) => range.start);
  return [...new Set(starts)].sort((a, b) => a - b);
}

const FROM_BEFORE = /\b(?:from|departing|leaving)\s*$/i;
const TO_BEFORE = /\b(?:to|into|arriving(?: in)?|for)\s*$/i;

function markedBy(text: string, positions: number[], words: RegExp): boolean {
  return positions.some((p) => words.test(text.slice(Math.max(0, p - 10), p)));
}

export type RouteVerdict = "ok" | "reversed" | "incomplete";

/**
 * Whether a text states the route origin to destination. Markers decide
 * first ("from X", "to Y"); otherwise the origin must come first ("X-Y",
 * "X to Y"). Missing either place is "incomplete".
 */
export function routeVerdict(text: string, origin: ResolvedPlace, destination: ResolvedPlace): RouteVerdict {
  const o = placePositions(text, origin);
  const d = placePositions(text, destination);
  if (o.length === 0 || d.length === 0) return "incomplete";
  const forward = markedBy(text, o, FROM_BEFORE) || markedBy(text, d, TO_BEFORE);
  const backward = markedBy(text, d, FROM_BEFORE) || markedBy(text, o, TO_BEFORE);
  if (forward && !backward) return "ok";
  if (backward && !forward) return "reversed";
  return o[0]! < d[0]! ? "ok" : "reversed";
}

/** True when the text marks the origin as where a flight goes, or the destination as where it leaves from. */
function markedReversed(text: string, origin: ResolvedPlace, destination: ResolvedPlace): boolean {
  return markedBy(text, placePositions(text, origin), TO_BEFORE) || markedBy(text, placePositions(text, destination), FROM_BEFORE);
}

interface CompiledAlias {
  alias: string;
  /** Built on first use: most aliases never appear in a text, so their patterns are never built. */
  pattern: RegExp | null;
  /** Text every match contains (see aliasNeedle); the pattern runs only on a text that has it. */
  needle: string;
  asWritten: boolean;
  /** A one-word airport name ("Midway", "Hobby"): counts only with a capital letter. */
  capitalOnly: boolean;
  /** A code or short name in capitals ("PER", "LA"): not counted inside text written in capitals. */
  capitals: boolean;
  airports: string[];
}

let compiledAliases: CompiledAlias[] | null = null;

function knownAliases(): CompiledAlias[] {
  compiledAliases ??= knownPlaceAliases().flatMap((entry) => {
    const trimmed = entry.alias.trim();
    // No needle: aliasPattern has no pattern for it either.
    const needle = aliasNeedle(trimmed);
    if (!needle) return [];
    return [
      {
        alias: trimmed,
        pattern: null,
        needle,
        asWritten: matchesAsWritten(trimmed),
        capitalOnly: entry.airportName && !/[^\p{L}]/u.test(trimmed),
        capitals: /^[A-Z]{2,3}$/.test(trimmed),
        airports: entry.airports,
      },
    ];
  });
  return compiledAliases;
}

/** The matches of a known alias in a text (normalized) and its folded form. None when the text lacks its needle. */
function aliasMatches(alias: CompiledAlias, text: string, folded: string): RegExpExecArray[] {
  const searched = alias.asWritten ? text : folded;
  if (!searched.includes(alias.needle)) return [];
  alias.pattern ??= aliasPattern(alias.alias);
  return alias.pattern ? [...searched.matchAll(alias.pattern)] : [];
}

/** A stop on the way ("1 stop Lisbon", "via Reykjavik", "connecting in Dubai"), not another route. */
const STOP_BEFORE = /(?:\bvia|\bstops?|\bstopover|\blayover|\bconnect(?:s|ing|ion)?|\bchanges?(?: of planes?)?)(?:\s+(?:in|at|through|on))?\s*[:,(]?\s*$/i;

/** A code next to a long word in capitals ("PER PERSON", "YOU CAN BOOK") is a word, not a place. */
function inCapitalsText(text: string, range: Range): boolean {
  const before = /(\S+)\s+$/.exec(text.slice(Math.max(0, range.start - 30), range.start))?.[1] ?? "";
  const after = /^\s+(\S+)/.exec(text.slice(range.end, range.end + 30))?.[1] ?? "";
  return [before, after].some((word) => {
    const letters = word.replace(/[^\p{L}]/gu, "");
    return letters.length >= 4 && letters === letters.toUpperCase();
  });
}

/** "to X", "from X": a capitalised name after a route marker. */
const MARKED_NAME = /\b(?:[Tt]o|TO|[Ff]rom|FROM|[Ii]nto|INTO)\s+(\p{Lu}[\p{L}'.-]*)(?![\p{L}'.-]|[$¥0-9])/gu;
/** Capitalised words after "to" or "from" that are not places. */
const NOT_PLACES = new Set([
  "january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december",
  "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec",
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
  "mon", "tue", "tues", "wed", "thu", "thur", "thurs", "fri", "sat", "sun",
  "economy", "premium", "business", "first", "basic", "only", "just", "book", "top", "save",
]);

/** Where the alias table's names and codes are in a text (normalized), with the airports each may mean. */
function knownPlaceRanges(text: string): (Range & { airports: string[] })[] {
  const folded = foldAligned(text);
  const ranges: (Range & { airports: string[] })[] = [];
  for (const alias of knownAliases()) {
    for (const match of aliasMatches(alias, text, folded)) {
      const range = { start: match.index, end: match.index + match[0].length };
      if (alias.capitalOnly && !/\p{Lu}/u.test(text[range.start] ?? "")) continue;
      if (alias.capitals && inCapitalsText(text, range)) continue;
      ranges.push({ ...range, airports: alias.airports });
    }
  }
  return ranges;
}

/**
 * The airport codes of every place the alias table finds in a text: city and
 * airport names in any case, codes and short names as written. For checking
 * that a place came from the user's own words.
 */
export function airportsNamedIn(text: string): Set<string> {
  const found = new Set<string>();
  for (const range of knownPlaceRanges(normalizeForMatch(text))) for (const code of range.airports) found.add(code);
  return found;
}

/**
 * True when the text (normalized, airline names masked) names a place that is
 * not on the trip: a city, airport or code from the alias table whose airports
 * are not the origin's or the destination's, or an unknown capitalised name
 * after "to" or "from". A stop on the way does not count.
 */
export function namesOtherPlace(text: string, origin: ResolvedPlace, destination: ResolvedPlace): boolean {
  const folded = foldAligned(text);
  const trip = new Set([...origin.airports, ...destination.airports]);
  const covered = [...placeRanges(text, folded, origin), ...placeRanges(text, folded, destination)];
  const others: Range[] = [];
  for (const alias of knownAliases()) {
    const onTrip = alias.airports.some((code) => trip.has(code));
    for (const match of aliasMatches(alias, text, folded)) {
      const range = { start: match.index, end: match.index + match[0].length };
      if (onTrip) {
        covered.push(range);
        continue;
      }
      if (alias.capitalOnly && !/\p{Lu}/u.test(text[range.start] ?? "")) continue;
      if (alias.capitals && inCapitalsText(text, range)) continue;
      others.push(range);
    }
  }
  const inside = (range: Range) => covered.some((c) => c.start <= range.start && range.end <= c.end);
  const isStop = (range: Range) => STOP_BEFORE.test(text.slice(Math.max(0, range.start - 24), range.start));
  if (others.some((range) => !inside(range) && !isStop(range))) return true;

  for (const match of text.matchAll(MARKED_NAME)) {
    const name = match[1]!;
    const start = match.index + match[0].length - name.length;
    if (covered.some((c) => c.start === start)) continue;
    const word = name.replace(/[.'-]+$/, "");
    if (NOT_PLACES.has(word.toLowerCase()) || ISO_CODES.includes(word)) continue;
    if (isStop({ start, end: start + name.length })) continue;
    return true;
  }
  return false;
}

/**
 * The nearest Markdown heading above `position` in a chunk, or null. `chunk`
 * is the raw chunk (with its line breaks); `position` is an offset in its
 * normalized form, as findQuote returns it. Normalizing line by line and
 * joining with one space gives the same text as normalizing the whole chunk.
 */
export function headingBefore(chunk: string, position: number): string | null {
  let normalized = "";
  let heading: string | null = null;
  for (const line of chunk.split("\n")) {
    const text = normalizeForMatch(line);
    if (!text) continue;
    if (normalized) normalized += " ";
    if (normalized.length >= position) break;
    const match = /^#{1,6}\s+(.{1,200})$/.exec(text);
    if (match) heading = match[1]!.trim();
    normalized += text;
  }
  return heading;
}

const MONTH_ALIASES: Record<number, string[]> = {
  1: ["january", "jan"],
  2: ["february", "feb"],
  3: ["march", "mar"],
  4: ["april", "apr"],
  5: ["may"],
  6: ["june", "jun"],
  7: ["july", "jul"],
  8: ["august", "aug"],
  9: ["september", "sept", "sep"],
  10: ["october", "oct"],
  11: ["november", "nov"],
  12: ["december", "dec"],
};
const WEEKDAY_WORDS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/** A page's own "seen", "updated" or "checked" date comes after these words; it is not a departure date. */
const FRESHNESS_BEFORE =
  /\b(?:seen|found|updated|checked|refreshed|last updated|last checked|prices? (?:found|seen|checked)|as of)\b:?\s*(?:on\s+)?$/i;

/**
 * True when the text names the date: "12 Nov", "Nov 12", "12th November",
 * "Thu 12 Nov 2026", "2026-11-12". A different year or weekday next to it
 * does not count, and neither does a page's freshness date ("updated Nov 12",
 * "last checked 2026-11-12").
 */
export function mentionsDate(text: string, date: CalendarDate): boolean {
  const t = normalizeForMatch(text);
  const iso = `${date.year}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}`;
  for (const match of t.matchAll(new RegExp(`(?<![0-9])${iso}(?![0-9])`, "g"))) {
    const before = t.slice(Math.max(0, match.index - 30), match.index);
    const dayWord = /\b(sun|mon|tue|wed|thu|fri|sat)[a-z]*\.?,?\s*$/i.exec(before);
    if (FRESHNESS_BEFORE.test(dayWord ? before.slice(0, dayWord.index) : before)) continue;
    return true;
  }
  const months = MONTH_ALIASES[date.month]!.join("|");
  const day = `0?${date.day}(?:st|nd|rd|th)?`;
  const weekday = weekdayName(date).slice(0, 3).toLowerCase();
  const patterns = [
    new RegExp(`(?<![0-9])${day}(?:\\s+of)?\\s+(?:${months})\\.?(?![a-z])(?:,?\\s+([0-9]{4}))?`, "gi"),
    new RegExp(`(?<![a-z])(?:${months})\\.?\\s+${day}(?![0-9])(?:,?\\s+([0-9]{4}))?`, "gi"),
  ];
  for (const pattern of patterns) {
    for (const match of t.matchAll(pattern)) {
      if (match[1] && Number(match[1]) !== date.year) continue;
      const before = t.slice(Math.max(0, match.index - 24), match.index).toLowerCase();
      const dayWord = /\b(sun|mon|tue|wed|thu|fri|sat)[a-z]*\.?,?\s*$/.exec(before);
      if (dayWord && WEEKDAY_WORDS.includes(dayWord[1]!) && dayWord[1] !== weekday) continue;
      // The second date of "Nov 5 - Nov 12" is a return date, not a departure.
      const rest = dayWord ? before.slice(0, dayWord.index) : before;
      if (/(?:-|\bto|\buntil|\bthrough)\s*$/.test(rest) && /[0-9]/.test(rest)) continue;
      // "back 12 Nov", "returning on 12 Nov": a return date.
      if (/\b(?:back|return|returning|inbound|homebound)\b[^0-9]{0,12}$/.test(rest)) continue;
      // "updated Nov 12", "prices last checked on 12 Nov": when the page was checked, not when the flight leaves.
      if (FRESHNESS_BEFORE.test(rest)) continue;
      return true;
    }
  }
  return false;
}

/** The page's own freshness phrase ("Seen 55 minutes ago", "cheapest in the last 72 hours"), or null. */
export function freshnessPhrase(text: string): string | null {
  const t = normalizeForMatch(text);
  const patterns = [
    /\b(?:seen|found|updated|checked|last updated|last checked|prices? (?:found|seen)|as of)\b:?\s+(?:\d{1,3}\s+(?:minutes?|mins?|hours?|hrs?|days?|weeks?)\s+ago|yesterday|today|[A-Z][a-z]{2,8}\.?\s+\d{1,2}(?:,\s+\d{4})?)/i,
    /\b(?:cheapest|lowest)\b[^.\n]{0,30}\b(?:in|over) the (?:last|past) \d{1,3} (?:hours|days)\b/i,
    /\bin the (?:last|past) \d{1,3} (?:hours|days)\b/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(t);
    if (match) return encodeLine(match[0], 80);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Flight spans
// ---------------------------------------------------------------------------

const optionalSpan = z
  .string()
  .max(60)
  .nullish()
  .transform((value) => (value && value.trim() ? value.trim() : undefined));

/** One item of the submit_flight_spans tool. Extra keys are ignored. */
export const flightSpanSchema = z.object({
  airline_text: z.string().trim().min(2).max(80),
  price_text: z.string().trim().min(1).max(60),
  departs_text: optionalSpan,
  arrives_text: optionalSpan,
  stops_text: optionalSpan,
  quote: z.string().trim().min(1).max(240),
  source: z.number().int(),
});

export type FlightSpan = z.infer<typeof flightSpanSchema>;

export interface FlightCheckContext {
  pages: CheckPage[];
  origin: ResolvedPlace;
  destination: ResolvedPlace;
  departDate: CalendarDate;
  roundTrip: boolean;
}

export type FlightCheck = { ok: true; option: FlightOption; forDate: boolean } | { ok: false; reason: DropReason };

/**
 * Where a span starts in the quote on token boundaries, or -1: a span that
 * starts or ends with a digit is not part of a longer number ("412" is not in
 * "1,412" or "1 412"), and one that starts or ends with a letter is not part
 * of a longer word. A digit next to a letter is a boundary ("$636TAP AIR PORTUGAL").
 */
function spanStart(quote: string, span: string): number {
  const s = normalizeForMatch(span);
  if (!s) return -1;
  const numbers = /[0-9]/.test(s) ? numberTokens(quote) : [];
  for (const start of locateAll(quote, s)) {
    const end = start + s.length;
    const before = quote.slice(Math.max(0, start - 2), start);
    const after = quote.slice(end, end + 2);
    if (/^[0-9]/.test(s) && (/[0-9]$/.test(before) || /[0-9][.,]$/.test(before))) continue;
    if (/[0-9]$/.test(s) && (/^[0-9]/.test(after) || /^[.,][0-9]/.test(after))) continue;
    // A span that starts or ends inside a grouped number of the quote ("412 €" in "1 412 €").
    if (/^[0-9]/.test(s) && numbers.some((n) => n.start < start && start < n.end)) continue;
    if (/[0-9]$/.test(s) && numbers.some((n) => n.start < end && end < n.end)) continue;
    // Letter to letter is a boundary only from lower to upper case, as pages glue words ("5:30 pmLHR").
    const joins = (left: string, right: string) => /\p{L}/u.test(left) && /\p{L}/u.test(right) && !(/\p{Ll}/u.test(left) && /\p{Lu}/u.test(right));
    if (/^\p{L}/u.test(s) && joins(before.slice(-1), s[0]!)) continue;
    if (/\p{L}$/u.test(s) && joins(s.slice(-1), after.slice(0, 1))) continue;
    return start;
  }
  return -1;
}

/** "Nov 29 - Dec 6", "29 Nov - 6 Dec": an outbound and a return date, so a round trip. */
function hasDateRange(quote: string): boolean {
  const month = "(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?";
  const weekday = "(?:(?:sun|mon|tue|wed|thu|fri|sat)[a-z]*\\.?,?\\s+)?";
  const date = `${weekday}(?:${month}\\s+[0-9]{1,2}|[0-9]{1,2}\\s+${month})`;
  return new RegExp(`${date}\\s?(?:-|to)\\s?${date}`, "i").test(quote);
}

function pageText(quote: string, start: number, length: number, max: number): string {
  return encodeLine(quote.slice(start, start + length), max);
}

const DEPART_WORDS = /\b(?:departs?|departing|departure|dep|leaves?|leaving|takes? off|outbound)\.?:?\s*(?:at\s*)?$/i;
const ARRIVE_WORDS = /\b(?:arrives?|arriving|arrival|arr|lands?|landing)\.?:?\s*(?:at\s*)?$/i;

type TimeRole = "departs" | "arrives";

/**
 * What each clock time in a quote is. A word before it decides ("departs
 * 08:05", "arr. 11:15"). With no such word, one time is the departure and two
 * are departure then arrival ("10:00 pm - 5:30 pm"); with more, none is known.
 */
function timeRoles(quote: string): { time: ClockTime; role: TimeRole | null }[] {
  const times = clockTimes(quote);
  const marked = times.map((time): TimeRole | null => {
    const before = quote.slice(Math.max(0, time.start - 16), time.start);
    if (DEPART_WORDS.test(before)) return "departs";
    if (ARRIVE_WORDS.test(before)) return "arrives";
    return null;
  });
  if (times.length === 2 && marked.filter(Boolean).length === 1) {
    // "08:20 - arrives 11:15": the other time has the other role.
    const known = (marked[0] ?? marked[1])!;
    const other: TimeRole = known === "departs" ? "arrives" : "departs";
    return times.map((time, i) => ({ time, role: marked[i] ?? other }));
  }
  if (marked.some(Boolean)) return times.map((time, i) => ({ time, role: marked[i] ?? null }));
  if (times.length === 1) return [{ time: times[0]!, role: "departs" }];
  if (times.length === 2) return [{ time: times[0]!, role: "departs" }, { time: times[1]!, role: "arrives" }];
  return times.map((time) => ({ time, role: null }));
}

/** A price for several travellers: "total", "for 2 adults", "two people", "for a family". */
const GROUP_TOTAL =
  /\b(?:in total|total|altogether)\b|\b(?:[2-9]|[1-9][0-9]|two|three|four|five|six|seven|eight|nine|ten)\s+(?:adults|passengers|people|persons|travell?ers|guests)\b|\bfor (?:a |the |your )?(?:family|group|couple)\b|\bfamily of\b|\bfor (?:two|both)\b/i;

/** Capitalised words that are not airline names, next to "Airlines" or after "or" and "and". */
const NOT_CARRIERS = new Set([
  ...NOT_PLACES,
  "all", "other", "others", "major", "partner", "partners", "top", "best", "cheap", "cheapest", "budget", "low", "low-cost",
  "many", "several", "some", "most", "popular", "our", "these", "those", "which", "compare", "search", "the", "and", "or",
  "fares", "fare", "tickets", "ticket", "travel", "miles", "deals", "deal", "flights", "flight", "class", "cabin", "lounge",
  "seat", "seats", "nonstop", "direct", "return", "round", "one", "way", "from", "to", "with", "fly", "now", "today",
  "tomorrow", "free", "more", "save", "plus", "new", "extra", "baggage", "bags", "bag", "hotel", "hotels", "car", "cars",
  "taxes", "fees", "tax", "fee", "per", "person", "adult", "adults", "lines", "line", "ways", "us", "usa", "uk",
]);
const AFTER_MENTION = /^\s*(?:\b(?:or|and)\b|[/&+])\s*(\p{Lu}[\p{L}'-]*)/u;
const BEFORE_MENTION = /(\p{Lu}[\p{L}'-]*)\s*(?:\b(?:or|and)\b|[/&+])\s*$/u;
/** "Loganair Airways", "Sun Country Airlines": a carrier name the table may not know. */
const CARRIER_PHRASE = /((?:\p{Lu}[\p{L}'.-]*\s+){1,3})(?:Airlines|Airways|Airline|Air Lines)\b/gu;
/** "Air Serbia", "Air Transat". */
const AIR_NAME = /\bAir\s+(\p{Lu}[\p{L}'-]+)/gu;

/**
 * True when the quote names a carrier besides the span's airline that the
 * airline table cannot count (decision 0015, "one airline per quote"): a
 * carrier after "operated by", a capitalised name joined to an airline by
 * "or", "and", "/" or "&" ("Level or Air France"), or a name with "Airlines",
 * "Airways" or "Air" the table does not know. Places and common words do not count.
 */
export function namesOtherCarrier(quote: string, airlineId: string): boolean {
  const mentions = airlineMentions(quote);
  const places = knownPlaceRanges(quote);
  const isWord = (name: string, start: number) => {
    const word = name.replace(/[.'-]+$/, "");
    if (NOT_CARRIERS.has(word.toLowerCase()) || ISO_CODES.includes(word)) return true;
    // Part of a place name ("New York and British Airways") or of a listed airline.
    const end = start + name.length;
    return [...places, ...mentions].some((range) => range.start <= start && end <= range.end);
  };

  for (const match of quote.matchAll(/\boperated by\s+/gi)) {
    const at = match.index + match[0].length;
    if (!mentions.some((mention) => mention.start === at && mention.id === airlineId)) return true;
  }
  for (const mention of mentions) {
    const after = AFTER_MENTION.exec(quote.slice(mention.end, mention.end + 40));
    if (after) {
      const start = mention.end + after.index + after[0].length - after[1]!.length;
      if (!isWord(after[1]!, start)) return true;
    }
    const window = quote.slice(Math.max(0, mention.start - 40), mention.start);
    const before = BEFORE_MENTION.exec(window);
    if (before) {
      const start = mention.start - window.length + before.index;
      if (!isWord(before[1]!, start)) return true;
    }
  }

  const masked = maskAirlines(quote);
  for (const match of masked.matchAll(CARRIER_PHRASE)) {
    const words = match[1]!.trim().split(/\s+/);
    if (!words.every((word) => NOT_CARRIERS.has(word.replace(/[.'-]+$/, "").toLowerCase()))) return true;
  }
  for (const match of masked.matchAll(AIR_NAME)) {
    if (!NOT_CARRIERS.has(match[1]!.toLowerCase())) return true;
  }
  return false;
}

/** Checks one extracted flight item against the pages. Never throws. */
export function checkFlightSpan(item: unknown, ctx: FlightCheckContext): FlightCheck {
  const parsed = flightSpanSchema.safeParse(item);
  if (!parsed.success) return { ok: false, reason: "invalid" };
  const span = parsed.data;
  const page = ctx.pages.find((p) => p.n === span.source);
  if (!page) return { ok: false, reason: "invalid" };
  if ([span.quote, span.airline_text, span.price_text].some(addressesAssistant)) {
    return { ok: false, reason: "addresses_assistant" };
  }

  const found = findQuote(span.quote, page);
  if (!found.ok) return { ok: false, reason: found.reason };
  const quote = found.text;

  // The price: a span on number boundaries, with a currency next to it.
  const priceAt = spanStart(quote, span.price_text);
  const priceLength = normalizeForMatch(span.price_text).length;
  if (priceAt === -1 || numberTokens(normalizeForMatch(span.price_text)).length === 0) {
    return { ok: false, reason: "price_not_in_quote" };
  }
  const prices = priceTokens(quote);
  const overlaps = (p: PriceToken) => p.start < priceAt + priceLength && p.end > priceAt;
  const own = prices.filter(overlaps);
  if (own.length === 0) return { ok: false, reason: "price_not_in_quote" };

  const airlineAt = spanStart(quote, span.airline_text);
  if (airlineAt === -1) return { ok: false, reason: "airline_not_in_quote" };
  // The span must name exactly one airline from the table, the one the quote names.
  const namedAirlines = airlinesIn(quote);
  const airlineText = normalizeForMatch(span.airline_text);
  const spanMentions = airlineMentions(airlineText);
  const spanAirlines = new Set(spanMentions.map((mention) => mention.id));
  const [spanAirline] = [...spanAirlines];
  if (/[0-9]/.test(airlineText) || spanAirlines.size !== 1 || !spanAirline || !namedAirlines.has(spanAirline)) {
    return { ok: false, reason: "airline_not_in_quote" };
  }
  // Shown: the airline's name as the page writes it, not the rest of the span.
  const airlineName = spanMentions.reduce((longest, m) => (m.end - m.start > longest.end - longest.start ? m : longest));

  const optional: { key: "departs" | "arrives" | "stops"; text: string | undefined }[] = [
    { key: "departs", text: span.departs_text },
    { key: "arrives", text: span.arrives_text },
    { key: "stops", text: span.stops_text },
  ];
  const roles = timeRoles(quote);
  const fields: Partial<Record<"departs" | "arrives" | "stops", string>> = {};
  for (const field of optional) {
    if (!field.text) continue;
    const at = spanStart(quote, field.text);
    if (at === -1) return { ok: false, reason: "invalid" };
    const length = normalizeForMatch(field.text).length;
    if (field.key === "stops") {
      fields.stops = pageText(quote, at, length, 40);
      continue;
    }
    // A time is shown only when the quote says it is the departure (or arrival); otherwise it is left out.
    const times = roles.filter(({ time }) => time.start < at + length && time.end > at);
    if (times.length !== 1 || times[0]!.role !== field.key) continue;
    const start = Math.min(at, times[0]!.time.start);
    const end = Math.max(at + length, times[0]!.time.end);
    fields[field.key] = pageText(quote, start, end - start, 40);
  }

  // One price and one airline per quote, or nobody can tell which goes with which.
  if (own.length > 1 || prices.some((p) => !overlaps(p))) return { ok: false, reason: "ambiguous_quote" };
  if (namedAirlines.size > 1) return { ok: false, reason: "ambiguous_quote" };
  // A second carrier the table does not know ("Level or Air France", "operated by Loganair").
  if (namesOtherCarrier(quote, spanAirline)) return { ok: false, reason: "ambiguous_quote" };
  // A total for several travellers is not a fare per traveller; prices are never divided or multiplied.
  if (GROUP_TOTAL.test(quote)) return { ok: false, reason: "ambiguous_quote" };

  // Route and direction. A quote that names a place off the trip is about another route. The
  // chunk's heading may only fill in a place the quote leaves out; the page title never does.
  const quotePlaces = maskAirlines(quote);
  if (namesOtherPlace(quotePlaces, ctx.origin, ctx.destination)) return { ok: false, reason: "route_not_stated" };
  let verdict = routeVerdict(quotePlaces, ctx.origin, ctx.destination);
  if (verdict === "incomplete") {
    if (markedReversed(quotePlaces, ctx.origin, ctx.destination)) return { ok: false, reason: "wrong_direction" };
    const heading = headingBefore(page.chunks[found.chunkIndex] ?? "", found.start);
    if (!heading) return { ok: false, reason: "route_not_stated" };
    const headingPlaces = maskAirlines(heading);
    if (namesOtherPlace(headingPlaces, ctx.origin, ctx.destination)) return { ok: false, reason: "route_not_stated" };
    verdict = routeVerdict(`${headingPlaces}\n${quotePlaces}`, ctx.origin, ctx.destination);
  }
  if (verdict === "reversed") return { ok: false, reason: "wrong_direction" };
  if (verdict === "incomplete") return { ok: false, reason: "route_not_stated" };

  const price = own[0]!;
  const priceStart = Math.min(price.start, priceAt);
  const priceEnd = Math.max(price.end, priceAt + priceLength);
  const basis = priceBasis(quote, price);
  const option: FlightOption = {
    airline: pageText(quote, airlineAt + airlineName.start, airlineName.end - airlineName.start, 80),
    priceText: pageText(quote, priceStart, priceEnd - priceStart, 60),
    amount: price.amount,
    currency: currencyOf(price, quote),
    basis,
    ...fields,
    quote: encodeLine(quote, 240),
    source: page.n,
  };
  const basisFits = ctx.roundTrip ? !basis.includes("one_way") : !basis.includes("round_trip");
  const forDate = mentionsDate(quote, ctx.departDate) && !price.range && basisFits;
  return { ok: true, option, forDate };
}

export interface FlightVerification {
  options: FlightOption[];
  typical: FlightOption[];
  dropped: Partial<Record<DropReason, number>>;
  /** Items the model returned (repeats included). */
  candidates: number;
}

export const MAX_FLIGHT_ITEMS = 8;

/** Checks every extracted item; keeps the verified ones, once each, and counts every drop by reason. */
export function verifyFlightSpans(items: unknown[], ctx: FlightCheckContext): FlightVerification {
  const result: FlightVerification = { options: [], typical: [], dropped: {}, candidates: items.length };
  const seen = new Set<string>();
  for (const [index, item] of items.entries()) {
    const check = index < MAX_FLIGHT_ITEMS ? checkFlightSpan(item, ctx) : ({ ok: false, reason: "invalid" } as const);
    if (!check.ok) {
      result.dropped[check.reason] = (result.dropped[check.reason] ?? 0) + 1;
      continue;
    }
    const key = `${check.option.source}|${check.option.quote}|${check.option.priceText}`;
    if (seen.has(key)) continue;
    seen.add(key);
    (check.forDate ? result.options : result.typical).push(check.option);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Research claims
// ---------------------------------------------------------------------------

/** One item of the submit_claims tool. */
export const claimSchema = z.object({
  claim: z.string().trim().min(1).max(300),
  quote: z.string().trim().min(1).max(300),
  source: z.number().int(),
});

export type ClaimCheck = { ok: true; claim: ResearchClaim } | { ok: false; reason: DropReason };

const STOPWORDS = new Set(
  "the and for are was were that this with from has have had its it's not but can will per than then they them their there what when which who into over also only more most such each some any all our your about after before between".split(
    " ",
  ),
);

function contentWords(text: string): string[] {
  return foldAligned(normalizeForMatch(text))
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => (w.length >= 3 || /^[0-9]+$/.test(w)) && !STOPWORDS.has(w))
    .map((w) => (w.length > 6 ? w.slice(0, 6) : w));
}

/** "not", "no", "never", "without", "can't": words that turn a statement around. */
const NEGATOR = /\b(?:not|no|never|none|nor|neither|without|cannot)\b|n't\b/g;

function negations(text: string): number {
  return foldAligned(normalizeForMatch(text)).match(NEGATOR)?.length ?? 0;
}

/**
 * True when the claim is not close to its quote: it has a different number of
 * negations ("do not need a visa" for "need a visa"), it states a number the
 * quote does not, or fewer than 60% of its words are in the quote.
 */
export function isParaphrased(claim: string, quote: string): boolean {
  if (negations(claim) !== negations(quote)) return true;
  const quoteNumbers = new Set(numberTokens(normalizeForMatch(quote)).map((n) => n.value));
  if (numberTokens(normalizeForMatch(claim)).some((n) => !quoteNumbers.has(n.value))) return true;
  const words = contentWords(claim);
  if (words.length === 0) return false;
  const quoteWords = new Set(contentWords(quote));
  const covered = words.filter((w) => quoteWords.has(w)).length;
  return covered / words.length < 0.6;
}

export function checkClaim(item: unknown, pages: CheckPage[]): ClaimCheck {
  const parsed = claimSchema.safeParse(item);
  if (!parsed.success) return { ok: false, reason: "invalid" };
  const page = pages.find((p) => p.n === parsed.data.source);
  if (!page) return { ok: false, reason: "invalid" };
  if (addressesAssistant(parsed.data.quote) || addressesAssistant(parsed.data.claim)) {
    return { ok: false, reason: "addresses_assistant" };
  }
  const found = findQuote(parsed.data.quote, page);
  if (!found.ok) return { ok: false, reason: found.reason };
  return {
    ok: true,
    claim: {
      claim: encodeLine(parsed.data.claim, 200),
      quote: encodeLine(found.text, 300),
      source: page.n,
      paraphrased: isParaphrased(parsed.data.claim, found.text),
    },
  };
}

export const MAX_CLAIM_ITEMS = 8;

export interface ClaimVerification {
  claims: ResearchClaim[];
  dropped: Partial<Record<DropReason, number>>;
  candidates: number;
}

export function verifyClaims(items: unknown[], pages: CheckPage[]): ClaimVerification {
  const result: ClaimVerification = { claims: [], dropped: {}, candidates: items.length };
  const seen = new Set<string>();
  for (const [index, item] of items.entries()) {
    const check = index < MAX_CLAIM_ITEMS ? checkClaim(item, pages) : ({ ok: false, reason: "invalid" } as const);
    if (!check.ok) {
      result.dropped[check.reason] = (result.dropped[check.reason] ?? 0) + 1;
      continue;
    }
    const key = `${check.claim.source}|${check.claim.quote}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.claims.push(check.claim);
  }
  return result;
}

// ---------------------------------------------------------------------------
// The model's reply
// ---------------------------------------------------------------------------

const MAX_MENTIONS = 20;

/**
 * Currency amounts and clock times in the model's reply that are not in the
 * verified result (decision 0015, "The reply is checked too"). Returned as
 * written, for `unverifiedMentions`.
 */
export function checkReplyClaims(reply: string, result: FlightResult | ResearchResult): string[] {
  const text = normalizeForMatch(reply);
  const verified: { value: number; money: MoneyMention }[] = [];
  const times = new Set<number>();
  const addMoney = (source: string, quoteCurrency: string | null = null) => {
    const normalized = normalizeForMatch(source);
    for (const money of moneyMentions(normalized, normalized)) {
      // A flight option's currency was read from its whole quote ("$412 ... prices in USD").
      const currency = quoteCurrency ?? money.currency;
      const entry = { ...money, currency, marks: currency ? [...money.marks, currency] : money.marks };
      for (const value of entry.values) verified.push({ value, money: entry });
    }
  };
  const addTimes = (source: string) => {
    for (const time of replyClockTimes(normalizeForMatch(source))) times.add(time.minutes);
  };
  if (result.kind === "flights") {
    for (const option of [...result.options, ...result.typical]) {
      addMoney(option.priceText, option.currency);
      addTimes(option.quote);
    }
  } else {
    for (const claim of result.claims) {
      addMoney(claim.quote);
      addTimes(claim.quote);
    }
  }

  const mentions: string[] = [];
  for (const money of moneyMentions(text)) {
    const ok = money.values.every((value) => verified.some((v) => v.value === value && sameCurrency(v.money, money)));
    if (!ok) mentions.push(text.slice(money.start, money.end).trim());
  }
  for (const time of replyClockTimes(text)) {
    if (!times.has(time.minutes)) mentions.push(text.slice(time.start, time.end).trim());
  }
  return [...new Set(mentions)].slice(0, MAX_MENTIONS).map((mention) => encodeLine(mention, 40));
}

/** True when a text (normalized) states an amount of money: "£412", "USD 412", "412 dollars". */
export function hasMoneyMention(text: string): boolean {
  return moneyMentions(text).length > 0;
}

/** An amount of money in a text, with its ISO currency when known and its markers as written. */
interface MoneyMention {
  start: number;
  end: number;
  values: number[];
  currency: string | null;
  /** Symbols and codes as written ("$", "£", "USD"), plus the ISO code. */
  marks: string[];
}

const CURRENCY_WORDS: { pattern: RegExp; currency: string | null; mark: string }[] = [
  { pattern: /^(?:us|u\.s\.|american) dollars?$/i, currency: "USD", mark: "USD" },
  { pattern: /^canadian dollars?$/i, currency: "CAD", mark: "CAD" },
  { pattern: /^australian dollars?$/i, currency: "AUD", mark: "AUD" },
  { pattern: /^(?:dollars?|bucks)$/i, currency: null, mark: "$" },
  { pattern: /^(?:pounds?(?: sterling)?|quid|sterling)$/i, currency: "GBP", mark: "GBP" },
  { pattern: /^euros?$/i, currency: "EUR", mark: "EUR" },
  { pattern: /^yen$/i, currency: "JPY", mark: "JPY" },
  { pattern: /^(?:yuan|renminbi)$/i, currency: "CNY", mark: "CNY" },
  { pattern: /^rupees?$/i, currency: "INR", mark: "INR" },
  { pattern: /^dirhams?$/i, currency: "AED", mark: "AED" },
];
const CURRENCY_WORD_AFTER =
  /^\s?((?:(?:us|u\.s\.|american|canadian|australian)\s)?(?:dollars?|bucks)|pounds?(?: sterling)?|quid|sterling|euros?|yen|yuan|renminbi|rupees?|dirhams?)(?![\p{L}])/iu;

/**
 * Prices with a symbol or code ("£412", "USD 412") and amounts followed by a
 * currency word ("412 dollars"). `context` is the text a bare "$" or "¥" may
 * take its currency from; by default only the price itself.
 */
function moneyMentions(text: string, context?: string): MoneyMention[] {
  const mentions: MoneyMention[] = priceTokens(text).map((price) => {
    const currency = currencyOf(price, context ?? text.slice(price.start, price.end));
    const marks = [...price.symbols, ...price.isoCodes.map((code) => (code === "RMB" ? "CNY" : code)), ...(currency ? [currency] : [])];
    return { start: price.start, end: price.end, values: price.values, currency, marks };
  });
  for (const token of numberTokens(text)) {
    if (mentions.some((m) => m.start < token.end && m.end > token.start)) continue;
    const word = CURRENCY_WORD_AFTER.exec(text.slice(token.end, token.end + 30));
    if (!word) continue;
    const name = word[1]!.replace(/\s+/g, " ");
    const known = CURRENCY_WORDS.find((entry) => entry.pattern.test(name));
    if (!known) continue;
    mentions.push({
      start: token.start,
      end: token.end + word[0].length,
      values: [token.value],
      currency: known.currency,
      marks: [known.mark, ...(known.currency && known.currency !== known.mark ? [known.currency] : [])],
    });
  }
  return mentions.sort((a, b) => a.start - b.start);
}

/** Two amounts are in the same currency when both ISO codes are known and equal, or when they share a marker. */
function sameCurrency(a: MoneyMention, b: MoneyMention): boolean {
  if (a.currency && b.currency) return a.currency === b.currency;
  return a.marks.some((mark) => b.marks.includes(mark));
}

const DROP_LABELS: Record<DropReason, string> = {
  quote_not_found: "quote not on the page",
  cross_chunk: "quote joined two passages",
  price_not_in_quote: "price not in the quote",
  airline_not_in_quote: "airline not in the quote",
  wrong_direction: "wrong direction",
  route_not_stated: "route not stated",
  ambiguous_quote: "more than one price or airline",
  addresses_assistant: "text addressed to the assistant",
  invalid: "malformed",
};

/** "2 dropped: wrong direction 1, route not stated 1". */
export function dropDetail(dropped: Partial<Record<DropReason, number>>): string | null {
  const entries = Object.entries(dropped).filter(([, count]) => (count ?? 0) > 0) as [DropReason, number][];
  if (entries.length === 0) return null;
  const total = entries.reduce((sum, [, count]) => sum + count, 0);
  return `${total} dropped: ${entries.map(([reason, count]) => `${DROP_LABELS[reason]} ${count}`).join(", ")}`;
}

/** "12 November 2026", for search queries. */
export function queryDate(date: CalendarDate): string {
  return `${date.day} ${monthName(date.month)} ${date.year}`;
}
