import "server-only";

// Airline names, for the ambiguous-quote rule (decision 0015): a quote that
// names more than one airline cannot say which one a price belongs to. Names
// that are also common words ("United", "Delta", "Spirit") match only with a
// capital letter and, for "United" and "American", not as part of a country
// or company name.

interface AirlineDef {
  id: string;
  /** Matched without regard to case. */
  names: string[];
  /** Matched exactly as written. */
  exact?: RegExp[];
}

const AIRLINES: AirlineDef[] = [
  { id: "BA", names: ["British Airways"] },
  { id: "VS", names: ["Virgin Atlantic"] },
  { id: "AA", names: ["American Airlines"], exact: [/\bAmerican\b(?! (?:Express|Samoa|Airlines))/] },
  { id: "DL", names: ["Delta Air Lines", "Delta Airlines"], exact: [/\bDelta\b/] },
  { id: "UA", names: ["United Airlines"], exact: [/\bUnited\b(?! (?:States|Kingdom|Arab|Nations|Airlines))/] },
  { id: "B6", names: ["JetBlue", "Jet Blue"] },
  { id: "AS", names: ["Alaska Airlines"] },
  { id: "WN", names: ["Southwest Airlines"], exact: [/\bSouthwest\b(?! Airlines)/] },
  { id: "NK", names: ["Spirit Airlines"], exact: [/\bSpirit\b(?! Airlines)/] },
  { id: "F9", names: ["Frontier Airlines"], exact: [/\bFrontier\b(?! Airlines)/] },
  { id: "HA", names: ["Hawaiian Airlines"] },
  { id: "AC", names: ["Air Canada"] },
  { id: "WS", names: ["WestJet"] },
  { id: "AF", names: ["Air France"] },
  { id: "KL", names: ["KLM", "KLM Royal Dutch Airlines"] },
  { id: "LH", names: ["Lufthansa"] },
  { id: "IB", names: ["Iberia"] },
  { id: "TP", names: ["TAP Air Portugal", "TAP Portugal"] },
  { id: "EI", names: ["Aer Lingus"] },
  { id: "LX", names: ["Swiss International Air Lines", "SWISS"] },
  { id: "OS", names: ["Austrian Airlines"] },
  { id: "SN", names: ["Brussels Airlines"] },
  { id: "AZ", names: ["ITA Airways"] },
  { id: "SK", names: ["Scandinavian Airlines", "SAS"] },
  { id: "AY", names: ["Finnair"] },
  { id: "FI", names: ["Icelandair"] },
  { id: "LO", names: ["LOT Polish Airlines", "LOT"] },
  { id: "A3", names: ["Aegean Airlines"] },
  { id: "UX", names: ["Air Europa"] },
  { id: "VY", names: ["Vueling"] },
  { id: "FR", names: ["Ryanair"] },
  { id: "U2", names: ["easyJet"] },
  { id: "W6", names: ["Wizz Air"] },
  { id: "EW", names: ["Eurowings"] },
  { id: "DE", names: ["Condor"] },
  { id: "N0", names: ["Norse Atlantic", "Norse Atlantic Airways"], exact: [/\bNorse\b(?! Atlantic)/] },
  // Low-cost and transatlantic carriers that share route pages with the big airlines.
  // Names that are also common words match only as written.
  { id: "LEVEL", names: ["Level Airlines"], exact: [/\bLevel\b(?! Airlines)/] },
  { id: "OG", names: ["PLAY", "Fly Play", "PLAY Airlines"] },
  { id: "B0", names: [], exact: [/\bLa Compagnie\b/] },
  { id: "MX", names: ["Breeze Airways"], exact: [/\bBreeze\b(?! Airways)/] },
  { id: "SY", names: ["Sun Country Airlines", "Sun Country"] },
  { id: "G4", names: ["Allegiant Air"], exact: [/\bAllegiant\b(?! Air)/] },
  { id: "XP", names: ["Avelo Airlines", "Avelo"] },
  { id: "PD", names: ["Porter Airlines"], exact: [/\bPorter\b(?! Airlines)/] },
  { id: "F8", names: ["Flair Airlines"], exact: [/\bFlair\b(?! Airlines)/] },
  { id: "TS", names: ["Air Transat"] },
  { id: "TR", names: [], exact: [/\bScoot\b/] },
  { id: "AK", names: ["AirAsia", "Air Asia"] },
  { id: "LS", names: ["Jet2", "Jet2.com"] },
  { id: "HV", names: ["Transavia"] },
  { id: "V7", names: ["Volotea"] },
  { id: "BT", names: ["airBaltic", "Air Baltic"] },
  { id: "ZG", names: ["ZIPAIR", "Zipair Tokyo"] },
  { id: "LM", names: ["Loganair"] },
  { id: "TK", names: ["Turkish Airlines"] },
  { id: "PC", names: ["Pegasus Airlines"] },
  { id: "EK", names: ["Emirates"] },
  { id: "QR", names: ["Qatar Airways"] },
  { id: "EY", names: ["Etihad", "Etihad Airways"] },
  { id: "FZ", names: ["flydubai"] },
  { id: "G9", names: ["Air Arabia"] },
  { id: "SV", names: ["Saudia", "Saudi Arabian Airlines"] },
  { id: "GF", names: ["Gulf Air"] },
  { id: "WY", names: ["Oman Air"] },
  { id: "RJ", names: ["Royal Jordanian"] },
  { id: "MS", names: ["EgyptAir"] },
  { id: "ET", names: ["Ethiopian Airlines"] },
  { id: "KQ", names: ["Kenya Airways"] },
  { id: "SA", names: ["South African Airways"] },
  { id: "LY", names: ["El Al"] },
  { id: "AI", names: ["Air India"] },
  { id: "6E", names: ["IndiGo"] },
  { id: "UL", names: ["SriLankan Airlines"] },
  { id: "SQ", names: ["Singapore Airlines"] },
  { id: "CX", names: ["Cathay Pacific"] },
  { id: "JL", names: ["Japan Airlines", "JAL"] },
  { id: "NH", names: ["All Nippon Airways", "ANA"] },
  { id: "KE", names: ["Korean Air"] },
  { id: "OZ", names: ["Asiana Airlines", "Asiana"] },
  { id: "BR", names: ["EVA Air"] },
  { id: "CI", names: ["China Airlines"] },
  { id: "MU", names: ["China Eastern"] },
  { id: "CZ", names: ["China Southern"] },
  { id: "CA", names: ["Air China"] },
  { id: "HU", names: ["Hainan Airlines"] },
  { id: "TG", names: ["Thai Airways"] },
  { id: "MH", names: ["Malaysia Airlines"] },
  { id: "GA", names: ["Garuda Indonesia"] },
  { id: "PR", names: ["Philippine Airlines"] },
  { id: "VN", names: ["Vietnam Airlines"] },
  { id: "QF", names: ["Qantas"] },
  { id: "JQ", names: ["Jetstar"] },
  { id: "VA", names: ["Virgin Australia"] },
  { id: "NZ", names: ["Air New Zealand"] },
  { id: "LA", names: ["LATAM", "LATAM Airlines"] },
  { id: "AV", names: ["Avianca"] },
  { id: "AM", names: ["Aeromexico", "Aeroméxico"] },
  { id: "CM", names: ["Copa Airlines"] },
  { id: "AD", names: ["Azul"] },
  { id: "G3", names: ["GOL Linhas Aereas"] },
  { id: "Y4", names: ["Volaris"] },
  { id: "BF", names: ["French bee"] },
];

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface Matcher {
  id: string;
  pattern: RegExp;
}

const MATCHERS: Matcher[] = AIRLINES.flatMap((airline) => [
  ...airline.names.map((name) => {
    // Short all-capital names (SAS, ANA, JAL, LOT, KLM, SWISS) match only in capitals.
    const exactCase = name.length <= 5 && name === name.toUpperCase();
    const flags = exactCase ? "gu" : "giu";
    // Letters only around the name: pages glue prices to names ("$636TAP AIR PORTUGAL").
    return { id: airline.id, pattern: new RegExp(`(?<!\\p{L})${escape(name)}(?!\\p{L})`, flags) };
  }),
  ...(airline.exact ?? []).map((pattern) => ({ id: airline.id, pattern: new RegExp(pattern.source, "gu") })),
]);

/** The distinct airlines a text names, by airline code. */
export function airlinesIn(text: string): Set<string> {
  const found = new Set<string>();
  for (const matcher of MATCHERS) {
    matcher.pattern.lastIndex = 0;
    if (matcher.pattern.test(text)) found.add(matcher.id);
    matcher.pattern.lastIndex = 0;
  }
  return found;
}

export interface AirlineMention {
  id: string;
  start: number;
  end: number;
}

/** Every airline name in a text, with its position. */
export function airlineMentions(text: string): AirlineMention[] {
  const mentions: AirlineMention[] = [];
  for (const matcher of MATCHERS) {
    // matchAll starts from the pattern's lastIndex.
    matcher.pattern.lastIndex = 0;
    for (const match of text.matchAll(matcher.pattern)) {
      mentions.push({ id: matcher.id, start: match.index, end: match.index + match[0].length });
    }
  }
  return mentions;
}

/**
 * The text with every airline name replaced by spaces of the same length, so
 * a place inside an airline name ("Singapore Airlines") is not read as a place.
 */
export function maskAirlines(text: string): string {
  let masked = text;
  for (const mention of airlineMentions(text)) {
    masked = masked.slice(0, mention.start) + " ".repeat(mention.end - mention.start) + masked.slice(mention.end);
  }
  return masked;
}
