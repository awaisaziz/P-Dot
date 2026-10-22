import "server-only";
import type { ResolvedPlace } from "./airports";

// Hand-off links to live fares (decision 0015). Built by code from the user's
// own trip, never fetched by P-Dot. Only Google Flights (?q=) and Skyscanner;
// KAYAK and momondo are left out. Every link is built with URL and
// URLSearchParams, IATA codes go into a path only when they are three capital
// letters, and the host must be on the allow list.

export const LINK_HOSTS = ["www.google.com", "www.skyscanner.net"] as const;

const IATA = /^[A-Z]{3}$/;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export interface LinkTrip {
  origin: ResolvedPlace;
  destination: ResolvedPlace;
  /** YYYY-MM-DD. */
  departDate: string;
  returnDate?: string;
  passengers: number;
}

export interface HandOffLink {
  label: string;
  url: string;
}

/** True for an https URL on the allow list. */
export function isAllowedLink(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && (LINK_HOSTS as readonly string[]).includes(parsed.hostname) && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

/** The words for a place in a Google Flights query: the airport code, or the city's name for all its airports. */
function queryWord(place: ResolvedPlace): string {
  return place.airports.length === 1 && IATA.test(place.iata) ? place.iata : place.name;
}

/** https://www.google.com/travel/flights?q=Flights+from+LHR+to+JFK+on+2026-11-12+one+way */
export function googleFlightsLink(trip: LinkTrip): string | null {
  if (!ISO_DATE.test(trip.departDate) || (trip.returnDate !== undefined && !ISO_DATE.test(trip.returnDate))) return null;
  const words = [`Flights from ${queryWord(trip.origin)} to ${queryWord(trip.destination)} on ${trip.departDate}`];
  words.push(trip.returnDate ? `through ${trip.returnDate}` : "one way");
  if (trip.passengers > 1) words.push(`for ${trip.passengers} adults`);
  const url = new URL("https://www.google.com/travel/flights");
  url.search = new URLSearchParams({ q: words.join(" ") }).toString();
  return url.toString();
}

/** "2026-11-12" to "261112", Skyscanner's date path segment. */
function skyscannerDate(iso: string): string | null {
  const match = ISO_DATE.exec(iso);
  return match ? `${match[1]!.slice(2)}${match[2]}${match[3]}` : null;
}

/** https://www.skyscanner.net/transport/flights/lhr/jfk/261112/?adultsv2=1&cabinclass=economy&rtn=0 */
export function skyscannerLink(trip: LinkTrip): string | null {
  if (!IATA.test(trip.origin.iata) || !IATA.test(trip.destination.iata)) return null;
  const out = skyscannerDate(trip.departDate);
  const back = trip.returnDate === undefined ? null : skyscannerDate(trip.returnDate);
  if (!out || (trip.returnDate !== undefined && !back)) return null;
  const segments = [trip.origin.iata.toLowerCase(), trip.destination.iata.toLowerCase(), out, ...(back ? [back] : [])];
  const url = new URL(`/transport/flights/${segments.join("/")}/`, "https://www.skyscanner.net");
  url.search = new URLSearchParams({
    adultsv2: String(Math.min(9, Math.max(1, Math.trunc(trip.passengers)))),
    cabinclass: "economy",
    rtn: back ? "1" : "0",
  }).toString();
  return url.toString();
}

/** The hand-off links for a trip, each checked against the allow list. */
export function buildFlightLinks(trip: LinkTrip): HandOffLink[] {
  const links: HandOffLink[] = [];
  const google = googleFlightsLink(trip);
  if (google && isAllowedLink(google)) links.push({ label: "Check live fares on Google Flights", url: google });
  const skyscanner = skyscannerLink(trip);
  if (skyscanner && isAllowedLink(skyscanner)) links.push({ label: "Check live fares on Skyscanner", url: skyscanner });
  return links;
}
