import "server-only";
import { isKnownCode, knownCityNames, normalizePlaceText } from "./airports";

// Flight intent (decision 0015 and its amendments): a message that asks for
// fares. For such a message the toggle search is skipped, so unverified
// excerpts never reach the answer, and the service tries to read the trip
// from the user's words (request.ts) to run the flight check itself. It needs
// a search: a flight word, a search or price cue, and a place or a date.
// Questions about a flight already booked (status, refunds, check-in) and
// comparisons with other kinds of travel are not searches. Travel extras
// (bags, lounges, visas) make a question about the trip, unless the message
// also asks plainly for fares ("find the cheapest flights ... with baggage").
// "fares" and "tickets" alone also mean trains, buses and concerts, so they
// need a known place and no other kind of trip.

/** Words that are about flying on their own. */
const FLIGHT_WORDS =
  /\b(?:flights?|airfares?|air fares?|plane tickets?|air tickets?|airline tickets?|flight tickets?|fly|flying)\b/i;
/** "a fly", "the fly", "fly fishing": the insect or the sport. */
const NOT_FLYING = /\b(?:a|the|this|that|fruit|house|horse)\s+fly\b|\bfly[- ]fishing\b|\bfly on the wall\b|\bflying (?:high|colou?rs|start|visit|saucer)\b/gi;
/** The user wants fares or options, not help with a trip. */
const SEARCH_CUES =
  /\b(?:find|search|look(?:ing)? (?:up|for)|show me|cheap|cheaper|cheapest|prices?|priced|pricing|costs?|how much|book|booking|fares?|airfares?|deals?|offers?|tickets?|compare|lowest|budget|options|(?:want|need|would like|wanna|planning|plan|hoping) to fly)\b/i;
/** "flights to Paris", "a flight from London to New York": flights as the thing asked for. */
const FLIGHT_NOUN =
  /\b(?:flights|(?:a|any|cheap|direct|nonstop|non-stop|one[- ]way|return|round[- ]trip) flights?)\s+(?:from|to|between|out of|into|for|on)\b/i;
/** About a flight already booked, or about flying but not a fare search. */
const NOT_A_SEARCH =
  /\b(?:my|our|his|her|their|your) (?:flights?|plane|booking)\b|\b(?:cancel\w*|delay\w*|refund\w*|check(?:ed|ing)?[- ]?in|attendants?|crew|pilots?|pack|packing|status|on time|landed|boarding|gate|lost|missed|compensation|jet ?lag|turbulence|recorder|simulator|remind\w*)\b/i;
/** Travel extras: a question about the trip, unless the message plainly asks for fares too. */
const TRAVEL_EXTRAS = /\b(?:baggage|luggage|suitcases?|carry[- ]on|hand luggage|visas?|passports?|insurance|lounges?)\b/i;
/** Plain requests for fares. "how much", "costs" and "options" are left out: they also ask about bags and visas. */
const STRONG_FARE_CUES =
  /\b(?:find|search|show me|look(?:ing)? for|cheap|cheaper|cheapest|lowest|fares|airfares?|prices|book|deals?)\b/i;
/** Other ways to travel: "train or flight" is a comparison, not a fare search. */
const OTHER_MODES = /\b(?:train|trains|rail|railway|eurostar|bus|buses|coach|ferry|ferries|drive|driving|car|metro|subway|tube|tram|taxi|uber)\b/i;
/** Words that need a place: they also mean trains, buses or events. */
const WEAK_WORDS = /\b(?:fares?|tickets?)\b/i;
const OTHER_TRIPS =
  /\b(?:train|rail|railway|bus|coach|ferry|metro|subway|tube|tram|taxi|uber|concert|gig|movie|cinema|film|theatre|theater|show(?!\s+me\b)|match|game|museum|festival|parking|toll|lottery|raffle|speeding)\b/i;

const MONTHS = "(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*";
const DATE_PATTERNS = [
  new RegExp(`\\b[0-9]{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTHS}\\b`, "i"),
  new RegExp(`\\b${MONTHS}\\.?\\s+[0-9]{1,2}(?:st|nd|rd|th)?\\b`, "i"),
  /\b[0-9]{4}-[0-9]{2}-[0-9]{2}\b/,
  /\b[0-9]{1,2}\/[0-9]{1,2}(?:\/[0-9]{2,4})?\b/,
  /\b(?:tomorrow|tonight|next (?:week|weekend|month|year|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|this (?:weekend|week|month|friday|saturday|sunday)|on (?:monday|tuesday|wednesday|thursday|friday|saturday|sunday))\b/i,
  new RegExp(`\\b(?:in|on|for|during|early|late|mid)[- ]${MONTHS}\\b`, "i"),
];

/** Known city names of at least four characters, as one pattern. */
let placePattern: RegExp | null = null;
function cityNames(): RegExp {
  placePattern ??= new RegExp(
    `(?:^| )(?:${knownCityNames(4)
      .sort((a, b) => b.length - a.length)
      .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("|")})(?= |$)`,
  );
  return placePattern;
}

/** A city the table knows, or a capital IATA code it knows ("LHR to JFK"). */
function hasKnownPlace(text: string): boolean {
  if (cityNames().test(normalizePlaceText(text))) return true;
  for (const match of text.matchAll(/\b[A-Z]{3}\b/g)) if (isKnownCode(match[0])) return true;
  return false;
}

/** A known place, or a capitalised word after from or to ("to Lisbon", "from Porto"). */
function hasPlace(text: string): boolean {
  return hasKnownPlace(text) || /\b(?:from|to|into)\s+[A-Z][a-z]{2,}/.test(text);
}

function hasDate(text: string): boolean {
  return DATE_PATTERNS.some((pattern) => pattern.test(text));
}

/** True when the message asks for flight fares or options with a place or a date. */
export function detectFlightIntent(text: string): boolean {
  const message = text.slice(0, 2_000);
  if (NOT_A_SEARCH.test(message)) return false;
  if (TRAVEL_EXTRAS.test(message) && !STRONG_FARE_CUES.test(message)) return false;
  const flying = FLIGHT_WORDS.test(message.replace(NOT_FLYING, " "));
  if (flying) {
    if (OTHER_MODES.test(message)) return false;
    if (!SEARCH_CUES.test(message) && !FLIGHT_NOUN.test(message)) return false;
    return hasPlace(message) || hasDate(message);
  }
  if (WEAK_WORDS.test(message) && !OTHER_TRIPS.test(message)) return hasKnownPlace(message);
  return false;
}
