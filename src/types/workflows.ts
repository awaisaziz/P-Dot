// Shapes shared by the browser and the server for workflow steps and verified
// results (decisions 0015 and 0016). No secrets and no server-only types here.
// Every string in a result came from a page or an account the user's request
// read; render it as text, never as HTML, and pass every URL through
// toSafeHttpUrl before linking it.

/** One line of what P-Dot did, for example "Read 4 pages" or "Verified 3 of 5 fares". */
export type StepStatus = "running" | "done" | "partial" | "failed";

export interface WorkflowStep {
  /** Stable within one reply, so a later event can update the same line. */
  id: string;
  /** One line: verb, object and a count. */
  label: string;
  status: StepStatus;
  /** Optional second line shown when the step is expanded, for example drop reasons. */
  detail?: string;
}

/** Why a candidate fact was not shown. Counted per reason. */
export type DropReason =
  | "quote_not_found"
  | "cross_chunk"
  | "price_not_in_quote"
  | "airline_not_in_quote"
  | "wrong_direction"
  | "route_not_stated"
  | "ambiguous_quote"
  | "addresses_assistant"
  | "invalid";

/** A page the workflow read, numbered like the [n] citations in the reply. */
export interface QuotedSource {
  n: number;
  title: string;
  url: string;
  /** Hostname without "www.", for "Quoted from <domain>". */
  domain: string;
  /** When P-Dot fetched the page (ISO 8601). */
  retrievedAt: string;
  /** The page's own freshness phrase when it has one, for example "Seen 55 minutes ago". */
  freshness?: string;
}

/** How a quoted price is meant, read from the quote's own words. */
export type PriceBasis = "per_person" | "round_trip" | "one_way" | "from" | "range";

export interface FlightOption {
  /** The airline as written on the page. */
  airline: string;
  /** The price exactly as written, for example "$412" or "£441–1,585". */
  priceText: string;
  /** Parsed amount; for a range, the low end. Null when it could not be parsed. */
  amount: number | null;
  /** ISO 4217 code only when the quote states it or uses an unambiguous symbol. */
  currency: string | null;
  basis: PriceBasis[];
  departs?: string;
  arrives?: string;
  stops?: string;
  /** The verbatim quote that supports every field above (at most 240 characters). */
  quote: string;
  /** The number of the source page. */
  source: number;
}

export interface FlightTrip {
  originLabel: string;
  destinationLabel: string;
  /** YYYY-MM-DD. */
  departDate: string;
  returnDate?: string;
  passengers: number;
  /** Code-built line, for example "London (LHR) to New York (JFK) · one way · Wed 12 Nov 2026 · 1 adult". */
  line: string;
}

export interface FlightResult {
  kind: "flights";
  trip: FlightTrip;
  /** Fares whose quote names the departure date. */
  options: FlightOption[];
  /** Verified prices that do not name the date: "Typical prices on this route". */
  typical: FlightOption[];
  dropped: Partial<Record<DropReason, number>>;
  /** Hand-off links to live fares, built by code from the trip. */
  links: { label: string; url: string }[];
  sources: QuotedSource[];
  /** Code-built one-line summary, also the first line of the saved reply. */
  summary: string;
  /** Prices or times in the model's reply that are not in the verified set. */
  unverifiedMentions: string[];
  retrievedAt: string;
}

export interface ResearchClaim {
  /** The model's short label for the fact. */
  claim: string;
  /** The verbatim quote; this is what the card shows as the fact. */
  quote: string;
  source: number;
  /** True when the claim is not close to its quote. */
  paraphrased: boolean;
}

export interface ResearchResult {
  kind: "research";
  question: string;
  claims: ResearchClaim[];
  dropped: Partial<Record<DropReason, number>>;
  sources: QuotedSource[];
  summary: string;
  /** Amounts or times in the model's reply that no verified quote contains. Missing on older rows. */
  unverifiedMentions?: string[];
  retrievedAt: string;
}

export interface CalendarEventItem {
  title: string;
  /** ISO 8601 date-time, or YYYY-MM-DD for an all-day event. */
  start: string;
  end: string;
  allDay: boolean;
  /** The calendar's name. */
  calendar: string;
  location?: string;
  /** The event's Google Calendar link. */
  link?: string;
  /** True when someone else organises it (an invitation). */
  fromOthers: boolean;
}

export interface CalendarResult {
  kind: "calendar";
  events: CalendarEventItem[];
  window: { start: string; end: string };
}

export type DriveFileKind = "doc" | "slides" | "sheet" | "pdf" | "text" | "other";

export interface DriveFileItem {
  id: string;
  name: string;
  kind: DriveFileKind;
  modified?: string;
  link?: string;
}

export interface DriveResult {
  kind: "drive";
  files: DriveFileItem[];
  /**
   * Set when a file's text was read. `capped` is true when the download
   * stopped at the byte cap, so `totalChars` counts only the characters read
   * and the file is longer. Missing on older rows.
   */
  read?: { id: string; name: string; chars: number; totalChars: number; truncated: boolean; capped?: boolean };
}

export type MessageResult = FlightResult | ResearchResult | CalendarResult | DriveResult;

/** What is stored for one assistant reply (table message_results) and returned with the conversation. */
export interface MessageResultsPayload {
  results: MessageResult[];
  steps: WorkflowStep[];
  /** True when the server cut the payload to fit its size limit, so lists and counts may be partial. */
  trimmed?: boolean;
}
