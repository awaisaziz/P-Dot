import "server-only";

// Alias table for the most-flown airports and their cities (decision 0015,
// "Route and direction"). It resolves the user's place words to IATA codes and
// gives every name a page may use for the place, so the verifier can check that
// a quote is about the right route in the right direction.
//
// A multi-airport city (London, New York, Paris, Tokyo...) resolves to the
// city with every airport's names. Open: decision 0015's amendment says to
// ask which airport instead; the owner has not settled this yet. A name used by two different places
// (Portland, Birmingham, San Jose, Santiago, Melbourne) is ambiguous, and the
// workflow asks the user which one they mean.

interface AirportDef {
  iata: string;
  /** The first name is the display name inside a multi-airport city. */
  names: string[];
}

interface CityDef {
  /** IATA city (metropolitan) code; the airport code for a one-airport city. */
  code: string;
  name: string;
  alt?: string[];
  /** Country, state and region words a user may add ("Paris, France"). Lower case. */
  region: string[];
  /** Shown when the name is ambiguous, for example "Oregon, USA". */
  where?: string;
  airports: AirportDef[];
}

const A = (iata: string, ...names: string[]): AirportDef => ({ iata, names });

const US = ["usa", "us", "united states", "united states of america", "america"];
const UK = ["uk", "united kingdom", "england", "gb", "great britain", "britain"];
const CHINA = ["china", "prc"];
const INDIA = ["india"];
const SPAIN = ["spain", "espana"];
const GERMANY = ["germany", "deutschland"];
const ITALY = ["italy", "italia"];
const JAPAN = ["japan"];
const BRAZIL = ["brazil", "brasil"];
const CANADA = ["canada"];
const AUSTRALIA = ["australia"];
const UAE = ["uae", "united arab emirates"];
const SAUDI = ["saudi arabia", "ksa"];
const state = (...names: string[]) => [...US, ...names];

const CITIES: CityDef[] = [
  // North America
  { code: "ATL", name: "Atlanta", region: state("georgia", "ga"), airports: [A("ATL", "Hartsfield-Jackson Atlanta International", "Hartsfield-Jackson", "Hartsfield Jackson")] },
  { code: "DFW", name: "Dallas", region: state("texas", "tx"), airports: [A("DFW", "Dallas/Fort Worth International", "Dallas Fort Worth", "Dallas-Fort Worth", "DFW Airport", "Fort Worth"), A("DAL", "Dallas Love Field", "Love Field")] },
  { code: "DEN", name: "Denver", region: state("colorado", "co"), airports: [A("DEN", "Denver International")] },
  { code: "LAX", name: "Los Angeles", alt: ["LA", "L.A."], region: state("california", "ca"), airports: [A("LAX", "Los Angeles International", "LAX Airport")] },
  { code: "CHI", name: "Chicago", region: state("illinois", "il"), airports: [A("ORD", "Chicago O'Hare", "O'Hare", "Ohare", "O'Hare International"), A("MDW", "Chicago Midway", "Midway")] },
  {
    code: "NYC",
    name: "New York",
    alt: ["New York City", "NYC", "NY", "Manhattan"],
    region: state("ny", "new york", "new york state"),
    airports: [A("JFK", "New York JFK", "John F. Kennedy International", "John F Kennedy", "JFK Airport", "Kennedy"), A("LGA", "LaGuardia", "La Guardia", "New York LaGuardia"), A("EWR", "Newark", "Newark Liberty", "Newark Liberty International")],
  },
  { code: "LAS", name: "Las Vegas", alt: ["Vegas"], region: state("nevada", "nv"), airports: [A("LAS", "Harry Reid International", "Harry Reid", "McCarran")] },
  { code: "MCO", name: "Orlando", region: state("florida", "fl"), airports: [A("MCO", "Orlando International")] },
  { code: "CLT", name: "Charlotte", region: state("north carolina", "nc"), airports: [A("CLT", "Charlotte Douglas International", "Charlotte Douglas")] },
  { code: "SEA", name: "Seattle", region: state("washington", "wa"), airports: [A("SEA", "Seattle-Tacoma International", "Seattle Tacoma", "Sea-Tac", "SeaTac")] },
  { code: "MIA", name: "Miami", region: state("florida", "fl"), airports: [A("MIA", "Miami International")] },
  { code: "FLL", name: "Fort Lauderdale", alt: ["Ft Lauderdale", "Ft. Lauderdale"], region: state("florida", "fl"), airports: [A("FLL", "Fort Lauderdale-Hollywood International", "Fort Lauderdale Hollywood")] },
  { code: "SFO", name: "San Francisco", alt: ["SF", "San Fran"], region: state("california", "ca"), airports: [A("SFO", "San Francisco International")] },
  { code: "OAK", name: "Oakland", region: state("california", "ca"), airports: [A("OAK", "Oakland International")] },
  { code: "SJC", name: "San Jose", where: "California, USA", region: state("california", "ca"), airports: [A("SJC", "San Jose Mineta International", "Mineta San Jose", "Norman Y. Mineta San Jose International")] },
  { code: "SJO", name: "San Jose", alt: ["San José"], where: "Costa Rica", region: ["costa rica", "cr"], airports: [A("SJO", "Juan Santamaria International", "Juan Santamaría")] },
  { code: "PHX", name: "Phoenix", region: state("arizona", "az"), airports: [A("PHX", "Phoenix Sky Harbor International", "Sky Harbor")] },
  { code: "HOU", name: "Houston", region: state("texas", "tx"), airports: [A("IAH", "Houston Intercontinental", "George Bush Intercontinental", "Bush Intercontinental"), A("HOU", "Houston Hobby", "William P. Hobby", "Hobby")] },
  { code: "BOS", name: "Boston", region: state("massachusetts", "ma"), airports: [A("BOS", "Boston Logan International", "Boston Logan", "Logan International", "Logan")] },
  { code: "MSP", name: "Minneapolis", alt: ["Minneapolis St Paul", "Minneapolis-Saint Paul", "Saint Paul", "St Paul", "Twin Cities"], region: state("minnesota", "mn"), airports: [A("MSP", "Minneapolis-Saint Paul International", "Minneapolis-St. Paul International")] },
  { code: "DTW", name: "Detroit", region: state("michigan", "mi"), airports: [A("DTW", "Detroit Metropolitan Wayne County", "Detroit Metro")] },
  { code: "PHL", name: "Philadelphia", alt: ["Philly"], region: state("pennsylvania", "pa"), airports: [A("PHL", "Philadelphia International")] },
  {
    code: "WAS",
    name: "Washington",
    alt: ["Washington DC", "Washington D.C.", "DC", "D.C."],
    region: state("dc", "district of columbia"),
    airports: [A("IAD", "Washington Dulles", "Dulles", "Dulles International"), A("DCA", "Washington Reagan National", "Reagan National", "Ronald Reagan Washington National", "Washington National"), A("BWI", "Baltimore/Washington International", "Baltimore Washington", "BWI Marshall", "Baltimore")],
  },
  { code: "SLC", name: "Salt Lake City", alt: ["Salt Lake"], region: state("utah", "ut"), airports: [A("SLC", "Salt Lake City International")] },
  { code: "SAN", name: "San Diego", region: state("california", "ca"), airports: [A("SAN", "San Diego International", "Lindbergh Field")] },
  { code: "TPA", name: "Tampa", region: state("florida", "fl"), airports: [A("TPA", "Tampa International")] },
  { code: "AUS", name: "Austin", region: state("texas", "tx"), airports: [A("AUS", "Austin-Bergstrom International", "Austin Bergstrom")] },
  { code: "BNA", name: "Nashville", region: state("tennessee", "tn"), airports: [A("BNA", "Nashville International")] },
  { code: "HNL", name: "Honolulu", region: state("hawaii", "hi"), airports: [A("HNL", "Daniel K. Inouye International", "Honolulu International")] },
  { code: "PDX", name: "Portland", where: "Oregon, USA", region: state("oregon", "or"), airports: [A("PDX", "Portland International")] },
  { code: "PWM", name: "Portland", where: "Maine, USA", region: state("maine", "me"), airports: [A("PWM", "Portland International Jetport")] },
  { code: "BHM", name: "Birmingham", where: "Alabama, USA", region: state("alabama", "al"), airports: [A("BHM", "Birmingham-Shuttlesworth International", "Shuttlesworth")] },
  { code: "MLB", name: "Melbourne", where: "Florida, USA", region: state("florida", "fl"), airports: [A("MLB", "Melbourne Orlando International")] },
  { code: "YTO", name: "Toronto", region: [...CANADA, "ontario", "on"], airports: [A("YYZ", "Toronto Pearson", "Pearson", "Toronto Pearson International"), A("YTZ", "Toronto Billy Bishop", "Billy Bishop", "Toronto Island")] },
  { code: "YVR", name: "Vancouver", region: [...CANADA, "british columbia", "bc"], airports: [A("YVR", "Vancouver International")] },
  { code: "YMQ", name: "Montreal", alt: ["Montréal"], region: [...CANADA, "quebec", "qc"], airports: [A("YUL", "Montreal-Trudeau International", "Montréal-Trudeau", "Pierre Elliott Trudeau", "Trudeau")] },
  { code: "YYC", name: "Calgary", region: [...CANADA, "alberta", "ab"], airports: [A("YYC", "Calgary International")] },
  { code: "MEX", name: "Mexico City", alt: ["Ciudad de Mexico", "CDMX"], region: ["mexico"], airports: [A("MEX", "Mexico City International", "Benito Juarez International", "Benito Juárez")] },
  { code: "CUN", name: "Cancun", alt: ["Cancún"], region: ["mexico"], airports: [A("CUN", "Cancun International")] },
  // South America
  { code: "SAO", name: "Sao Paulo", alt: ["São Paulo"], region: BRAZIL, airports: [A("GRU", "Sao Paulo Guarulhos", "Guarulhos", "Sao Paulo-Guarulhos International"), A("CGH", "Sao Paulo Congonhas", "Congonhas"), A("VCP", "Campinas Viracopos", "Viracopos", "Campinas")] },
  { code: "RIO", name: "Rio de Janeiro", alt: ["Rio"], region: BRAZIL, airports: [A("GIG", "Rio Galeao", "Galeao", "Galeão", "Rio de Janeiro-Galeao International", "Tom Jobim"), A("SDU", "Rio Santos Dumont", "Santos Dumont")] },
  { code: "BOG", name: "Bogota", alt: ["Bogotá"], region: ["colombia"], airports: [A("BOG", "El Dorado International", "El Dorado")] },
  { code: "LIM", name: "Lima", region: ["peru"], airports: [A("LIM", "Jorge Chavez International", "Jorge Chávez")] },
  { code: "SCL", name: "Santiago", where: "Chile", region: ["chile"], airports: [A("SCL", "Arturo Merino Benitez International", "Santiago International")] },
  { code: "SCQ", name: "Santiago de Compostela", alt: ["Santiago"], where: "Spain", region: SPAIN, airports: [A("SCQ", "Santiago-Rosalia de Castro", "Rosalia de Castro")] },
  { code: "BUE", name: "Buenos Aires", region: ["argentina"], airports: [A("EZE", "Buenos Aires Ezeiza", "Ezeiza", "Ministro Pistarini"), A("AEP", "Buenos Aires Aeroparque", "Aeroparque", "Jorge Newbery")] },
  // Europe
  {
    code: "LON",
    name: "London",
    alt: ["Londres", "Londra"],
    region: UK,
    airports: [
      A("LHR", "London Heathrow", "Heathrow", "Heathrow Airport"),
      A("LGW", "London Gatwick", "Gatwick"),
      A("STN", "London Stansted", "Stansted"),
      A("LTN", "London Luton", "Luton"),
      A("LCY", "London City Airport", "London City"),
      A("SEN", "London Southend", "Southend"),
    ],
  },
  { code: "PAR", name: "Paris", region: ["france"], airports: [A("CDG", "Paris Charles de Gaulle", "Charles de Gaulle", "Roissy", "Roissy-Charles de Gaulle"), A("ORY", "Paris Orly", "Orly"), A("BVA", "Paris Beauvais", "Beauvais")] },
  { code: "AMS", name: "Amsterdam", region: ["netherlands", "the netherlands", "holland"], airports: [A("AMS", "Amsterdam Schiphol", "Schiphol")] },
  { code: "FRA", name: "Frankfurt", region: GERMANY, airports: [A("FRA", "Frankfurt am Main", "Frankfurt International")] },
  { code: "MAD", name: "Madrid", region: SPAIN, airports: [A("MAD", "Madrid-Barajas", "Barajas", "Adolfo Suarez Madrid-Barajas")] },
  { code: "BCN", name: "Barcelona", region: SPAIN, airports: [A("BCN", "Barcelona-El Prat", "El Prat", "Josep Tarradellas")] },
  { code: "IST", name: "Istanbul", region: ["turkey", "turkiye", "türkiye"], airports: [A("IST", "Istanbul Airport", "Istanbul New Airport"), A("SAW", "Istanbul Sabiha Gokcen", "Sabiha Gokcen", "Sabiha Gökçen")] },
  { code: "MUC", name: "Munich", alt: ["Munchen", "München"], region: GERMANY, airports: [A("MUC", "Munich International", "Franz Josef Strauss")] },
  { code: "ROM", name: "Rome", alt: ["Roma"], region: ITALY, airports: [A("FCO", "Rome Fiumicino", "Fiumicino", "Leonardo da Vinci"), A("CIA", "Rome Ciampino", "Ciampino")] },
  { code: "MIL", name: "Milan", alt: ["Milano"], region: ITALY, airports: [A("MXP", "Milan Malpensa", "Malpensa"), A("LIN", "Milan Linate", "Linate"), A("BGY", "Milan Bergamo", "Bergamo", "Orio al Serio")] },
  { code: "LIS", name: "Lisbon", alt: ["Lisboa"], region: ["portugal"], airports: [A("LIS", "Lisbon Humberto Delgado", "Humberto Delgado", "Lisbon Portela", "Portela")] },
  { code: "DUB", name: "Dublin", region: ["ireland"], airports: [A("DUB", "Dublin Airport")] },
  { code: "ZRH", name: "Zurich", alt: ["Zürich"], region: ["switzerland"], airports: [A("ZRH", "Zurich Airport", "Kloten")] },
  { code: "VIE", name: "Vienna", alt: ["Wien"], region: ["austria"], airports: [A("VIE", "Vienna International", "Schwechat")] },
  { code: "CPH", name: "Copenhagen", alt: ["Kobenhavn", "København"], region: ["denmark"], airports: [A("CPH", "Copenhagen Kastrup", "Kastrup")] },
  { code: "OSL", name: "Oslo", region: ["norway"], airports: [A("OSL", "Oslo Gardermoen", "Gardermoen")] },
  { code: "STO", name: "Stockholm", region: ["sweden"], airports: [A("ARN", "Stockholm Arlanda", "Arlanda"), A("BMA", "Stockholm Bromma", "Bromma")] },
  { code: "HEL", name: "Helsinki", region: ["finland"], airports: [A("HEL", "Helsinki-Vantaa", "Vantaa")] },
  { code: "ATH", name: "Athens", region: ["greece"], airports: [A("ATH", "Athens International", "Eleftherios Venizelos")] },
  { code: "BRU", name: "Brussels", alt: ["Bruxelles", "Brussel"], region: ["belgium"], airports: [A("BRU", "Brussels Airport", "Zaventem")] },
  { code: "MAN", name: "Manchester", region: UK, airports: [A("MAN", "Manchester Airport", "Ringway")] },
  { code: "BHX", name: "Birmingham", where: "England, UK", region: UK, airports: [A("BHX", "Birmingham Airport")] },
  { code: "EDI", name: "Edinburgh", region: [...UK, "scotland"], airports: [A("EDI", "Edinburgh Airport")] },
  { code: "PMI", name: "Palma de Mallorca", alt: ["Palma", "Mallorca", "Majorca"], region: SPAIN, airports: [A("PMI", "Palma de Mallorca Airport", "Son Sant Joan")] },
  { code: "AGP", name: "Malaga", alt: ["Málaga"], region: SPAIN, airports: [A("AGP", "Malaga-Costa del Sol", "Costa del Sol")] },
  { code: "MOW", name: "Moscow", alt: ["Moskva"], region: ["russia"], airports: [A("SVO", "Moscow Sheremetyevo", "Sheremetyevo"), A("DME", "Moscow Domodedovo", "Domodedovo"), A("VKO", "Moscow Vnukovo", "Vnukovo")] },
  { code: "WAW", name: "Warsaw", alt: ["Warszawa"], region: ["poland"], airports: [A("WAW", "Warsaw Chopin", "Chopin")] },
  { code: "PRG", name: "Prague", alt: ["Praha"], region: ["czechia", "czech republic"], airports: [A("PRG", "Vaclav Havel Airport Prague", "Vaclav Havel", "Václav Havel")] },
  { code: "BER", name: "Berlin", region: GERMANY, airports: [A("BER", "Berlin Brandenburg", "Willy Brandt")] },
  { code: "DUS", name: "Dusseldorf", alt: ["Düsseldorf", "Duesseldorf"], region: GERMANY, airports: [A("DUS", "Dusseldorf Airport")] },
  // Middle East and Africa
  { code: "DXB", name: "Dubai", region: UAE, airports: [A("DXB", "Dubai International"), A("DWC", "Dubai World Central", "Al Maktoum International", "Al Maktoum")] },
  { code: "DOH", name: "Doha", region: ["qatar"], airports: [A("DOH", "Hamad International", "Hamad")] },
  { code: "AUH", name: "Abu Dhabi", region: UAE, airports: [A("AUH", "Zayed International", "Abu Dhabi International")] },
  { code: "JED", name: "Jeddah", alt: ["Jidda", "Jiddah"], region: SAUDI, airports: [A("JED", "King Abdulaziz International")] },
  { code: "RUH", name: "Riyadh", region: SAUDI, airports: [A("RUH", "King Khalid International")] },
  { code: "CAI", name: "Cairo", region: ["egypt"], airports: [A("CAI", "Cairo International")] },
  { code: "JNB", name: "Johannesburg", alt: ["Joburg", "Jo'burg"], region: ["south africa", "za"], airports: [A("JNB", "O. R. Tambo International", "OR Tambo", "O.R. Tambo")] },
  { code: "CPT", name: "Cape Town", region: ["south africa", "za"], airports: [A("CPT", "Cape Town International")] },
  { code: "ADD", name: "Addis Ababa", region: ["ethiopia"], airports: [A("ADD", "Addis Ababa Bole International", "Bole International")] },
  { code: "NBO", name: "Nairobi", region: ["kenya"], airports: [A("NBO", "Jomo Kenyatta International")] },
  { code: "TLV", name: "Tel Aviv", region: ["israel"], airports: [A("TLV", "Ben Gurion International", "Ben Gurion")] },
  // Asia
  { code: "TYO", name: "Tokyo", region: JAPAN, airports: [A("HND", "Tokyo Haneda", "Haneda", "Tokyo International"), A("NRT", "Tokyo Narita", "Narita", "Narita International")] },
  { code: "OSA", name: "Osaka", region: JAPAN, airports: [A("KIX", "Osaka Kansai", "Kansai International", "Kansai"), A("ITM", "Osaka Itami", "Itami", "Osaka International")] },
  { code: "SEL", name: "Seoul", region: ["south korea", "korea", "republic of korea"], airports: [A("ICN", "Seoul Incheon", "Incheon", "Incheon International"), A("GMP", "Seoul Gimpo", "Gimpo", "Gimpo International")] },
  { code: "BJS", name: "Beijing", alt: ["Peking"], region: CHINA, airports: [A("PEK", "Beijing Capital", "Beijing Capital International"), A("PKX", "Beijing Daxing", "Daxing", "Beijing Daxing International")] },
  { code: "SHA", name: "Shanghai", region: CHINA, airports: [A("PVG", "Shanghai Pudong", "Pudong"), A("SHA", "Shanghai Hongqiao", "Hongqiao")] },
  { code: "CAN", name: "Guangzhou", alt: ["Canton"], region: CHINA, airports: [A("CAN", "Guangzhou Baiyun International", "Baiyun")] },
  { code: "SZX", name: "Shenzhen", region: CHINA, airports: [A("SZX", "Shenzhen Bao'an International", "Bao'an", "Baoan")] },
  { code: "CTU", name: "Chengdu", region: CHINA, airports: [A("CTU", "Chengdu Shuangliu", "Shuangliu"), A("TFU", "Chengdu Tianfu", "Tianfu")] },
  { code: "CKG", name: "Chongqing", region: CHINA, airports: [A("CKG", "Chongqing Jiangbei International", "Jiangbei")] },
  { code: "KMG", name: "Kunming", region: CHINA, airports: [A("KMG", "Kunming Changshui International", "Changshui")] },
  { code: "XIY", name: "Xi'an", alt: ["Xian"], region: CHINA, airports: [A("XIY", "Xi'an Xianyang International", "Xianyang")] },
  { code: "HGH", name: "Hangzhou", region: CHINA, airports: [A("HGH", "Hangzhou Xiaoshan International", "Xiaoshan")] },
  { code: "HKG", name: "Hong Kong", region: [...CHINA, "hong kong sar", "hk"], airports: [A("HKG", "Hong Kong International", "Chek Lap Kok")] },
  { code: "TPE", name: "Taipei", region: ["taiwan"], airports: [A("TPE", "Taipei Taoyuan", "Taoyuan", "Taiwan Taoyuan International"), A("TSA", "Taipei Songshan", "Songshan")] },
  { code: "SIN", name: "Singapore", region: ["singapore"], airports: [A("SIN", "Singapore Changi", "Changi")] },
  { code: "BKK", name: "Bangkok", region: ["thailand"], airports: [A("BKK", "Bangkok Suvarnabhumi", "Suvarnabhumi"), A("DMK", "Bangkok Don Mueang", "Don Mueang", "Don Muang")] },
  { code: "KUL", name: "Kuala Lumpur", alt: ["KL"], region: ["malaysia"], airports: [A("KUL", "Kuala Lumpur International", "KLIA")] },
  { code: "JKT", name: "Jakarta", region: ["indonesia"], airports: [A("CGK", "Jakarta Soekarno-Hatta", "Soekarno-Hatta", "Soekarno Hatta"), A("HLP", "Jakarta Halim Perdanakusuma", "Halim Perdanakusuma", "Halim")] },
  { code: "MNL", name: "Manila", region: ["philippines"], airports: [A("MNL", "Ninoy Aquino International", "NAIA")] },
  { code: "SGN", name: "Ho Chi Minh City", alt: ["Saigon", "Ho Chi Minh"], region: ["vietnam", "viet nam"], airports: [A("SGN", "Tan Son Nhat", "Tân Sơn Nhất")] },
  { code: "HAN", name: "Hanoi", region: ["vietnam", "viet nam"], airports: [A("HAN", "Noi Bai", "Nội Bài")] },
  { code: "DEL", name: "Delhi", alt: ["New Delhi"], region: INDIA, airports: [A("DEL", "Indira Gandhi International", "Delhi International")] },
  { code: "BOM", name: "Mumbai", alt: ["Bombay"], region: INDIA, airports: [A("BOM", "Chhatrapati Shivaji Maharaj International", "Chhatrapati Shivaji")] },
  { code: "BLR", name: "Bengaluru", alt: ["Bangalore"], region: INDIA, airports: [A("BLR", "Kempegowda International", "Kempegowda")] },
  { code: "HYD", name: "Hyderabad", region: INDIA, airports: [A("HYD", "Rajiv Gandhi International")] },
  { code: "MAA", name: "Chennai", alt: ["Madras"], region: INDIA, airports: [A("MAA", "Chennai International")] },
  { code: "CCU", name: "Kolkata", alt: ["Calcutta"], region: INDIA, airports: [A("CCU", "Netaji Subhas Chandra Bose International")] },
  { code: "CMB", name: "Colombo", region: ["sri lanka"], airports: [A("CMB", "Bandaranaike International")] },
  { code: "KTM", name: "Kathmandu", region: ["nepal"], airports: [A("KTM", "Tribhuvan International")] },
  { code: "DPS", name: "Denpasar", alt: ["Bali"], region: ["indonesia"], airports: [A("DPS", "Ngurah Rai International", "Ngurah Rai")] },
  // Oceania
  { code: "SYD", name: "Sydney", region: [...AUSTRALIA, "nsw", "new south wales"], airports: [A("SYD", "Sydney Kingsford Smith", "Kingsford Smith")] },
  { code: "MEL", name: "Melbourne", where: "Australia", region: [...AUSTRALIA, "victoria", "vic"], airports: [A("MEL", "Melbourne Tullamarine", "Tullamarine")] },
  { code: "BNE", name: "Brisbane", region: AUSTRALIA, airports: [A("BNE", "Brisbane Airport")] },
  { code: "PER", name: "Perth", region: AUSTRALIA, airports: [A("PER", "Perth Airport")] },
  { code: "AKL", name: "Auckland", region: ["new zealand", "nz"], airports: [A("AKL", "Auckland Airport")] },
];

/** A place the workflow can search for and check quotes against. */
export interface ResolvedPlace {
  /** The airport code, or the city's code when the place is all of a city's airports. */
  iata: string;
  /** For people: "London (all airports)", "London Heathrow (LHR)", "Atlanta (ATL)". */
  label: string;
  /** For search queries: "London", "London Heathrow". */
  name: string;
  /** Every name a page may use for the place: names, alternate spellings and IATA codes. */
  aliases: string[];
  /** The airport codes the place covers. */
  airports: string[];
}

export interface AmbiguousPlace {
  ambiguous: { iata: string; label: string }[];
}

type PlaceRef = { city: CityDef; airport: AirportDef | null };

/** Lower case, no accents, letters and digits only, single spaces. */
export function normalizePlaceText(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

const NAME_INDEX = new Map<string, PlaceRef[]>();
const CODE_INDEX = new Map<string, PlaceRef>();

function addName(name: string, ref: PlaceRef): void {
  const key = normalizePlaceText(name);
  if (!key) return;
  const list = NAME_INDEX.get(key) ?? [];
  if (!list.some((r) => r.city === ref.city && r.airport === ref.airport)) list.push(ref);
  NAME_INDEX.set(key, list);
}

for (const city of CITIES) {
  const single = city.airports.length === 1;
  const cityRef: PlaceRef = { city, airport: single ? city.airports[0]! : null };
  for (const name of [city.name, ...(city.alt ?? [])]) addName(name, cityRef);
  for (const airport of city.airports) {
    const ref: PlaceRef = single ? cityRef : { city, airport };
    for (const name of airport.names) addName(name, ref);
    CODE_INDEX.set(airport.iata, ref);
  }
  if (!CODE_INDEX.has(city.code)) CODE_INDEX.set(city.code, cityRef);
}

/** How many airports the table knows (for tests). */
export const KNOWN_AIRPORT_COUNT = CITIES.reduce((sum, city) => sum + city.airports.length, 0);

function placeKey(ref: PlaceRef): string {
  return `${ref.city.code}/${ref.airport?.iata ?? "*"}`;
}

function toPlace(ref: PlaceRef): ResolvedPlace {
  const { city, airport } = ref;
  if (airport && city.airports.length === 1) {
    return {
      iata: airport.iata,
      label: `${city.name} (${airport.iata})`,
      name: city.name,
      aliases: unique([city.name, ...(city.alt ?? []), ...airport.names, airport.iata, city.code]),
      airports: [airport.iata],
    };
  }
  if (airport) {
    // One airport of a multi-airport city: only that airport's own names, so a
    // page about another of the city's airports does not count.
    const display = airport.names[0]!;
    return {
      iata: airport.iata,
      label: `${display} (${airport.iata})`,
      name: display,
      aliases: unique([...airport.names, airport.iata]),
      airports: [airport.iata],
    };
  }
  return {
    iata: city.code,
    label: `${city.name} (all airports)`,
    name: city.name,
    aliases: unique([
      city.name,
      ...(city.alt ?? []),
      city.code,
      ...city.airports.flatMap((a) => [...a.names, a.iata]),
    ]),
    airports: city.airports.map((a) => a.iata),
  };
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function ambiguousLabel(ref: PlaceRef): { iata: string; label: string } {
  const place = toPlace(ref);
  const where = ref.city.where ?? ref.city.region[0] ?? "";
  return { iata: place.iata, label: `${ref.city.name}${where ? `, ${where}` : ""} (${place.iata})` };
}

function settle(refs: PlaceRef[]): ResolvedPlace | AmbiguousPlace | null {
  const distinct = [...new Map(refs.map((ref) => [placeKey(ref), ref])).values()];
  if (distinct.length === 0) return null;
  if (distinct.length === 1) return toPlace(distinct[0]!);
  return { ambiguous: distinct.map(ambiguousLabel) };
}

/** Words that add nothing to a place name. */
const FILLER = new Set(["airport", "airports", "international", "intl", "int", "the", "all", "any", "area", "metro", "aeropuerto", "aeroport", "flughafen"]);

/**
 * Resolves the user's words for a place: an IATA code ("LHR", "lon"), a city
 * ("London", "Paris, France"), an airport ("Heathrow", "JFK Airport") or a
 * city with an airport code ("New York JFK"). Returns null for a place the
 * table does not know, or for a qualifier that does not fit ("Paris, Texas"),
 * and the candidates for a name that several places use ("Portland").
 */
export function resolvePlace(text: string): ResolvedPlace | AmbiguousPlace | null {
  const trimmed = text.trim();
  if (/^[A-Za-z]{3}$/.test(trimmed)) {
    const ref = CODE_INDEX.get(trimmed.toUpperCase());
    if (ref) return toPlace(ref);
  }
  const normalized = normalizePlaceText(trimmed);
  if (!normalized) return null;

  const exact = NAME_INDEX.get(normalized);
  if (exact) return settle(exact);

  const tokens = normalized.split(" ").filter((token) => !FILLER.has(token));
  if (tokens.length === 0) return null;
  const stripped = tokens.join(" ");
  const strippedMatch = NAME_INDEX.get(stripped);
  if (strippedMatch) return settle(strippedMatch);

  // "New York JFK", "London LHR": a city with one of its airport codes.
  for (const token of tokens) {
    if (token.length !== 3) continue;
    const ref = CODE_INDEX.get(token.toUpperCase());
    if (!ref?.airport) continue;
    const rest = tokens.filter((t) => t !== token).join(" ");
    const restRefs = rest ? (NAME_INDEX.get(rest) ?? []) : [];
    if (!rest || restRefs.some((r) => r.city === ref.city)) return toPlace(ref);
  }

  // "Paris France", "Portland Oregon": a name followed by its region.
  for (let split = tokens.length - 1; split >= 1; split -= 1) {
    const head = tokens.slice(0, split).join(" ");
    const tail = tokens.slice(split).join(" ");
    const refs = NAME_INDEX.get(head);
    if (!refs) continue;
    const fitting = refs.filter((ref) => ref.city.region.includes(tail));
    if (fitting.length > 0) return settle(fitting);
    return null;
  }
  return null;
}

export function isAmbiguous(place: ResolvedPlace | AmbiguousPlace): place is AmbiguousPlace {
  return "ambiguous" in place;
}

/** Every known airport and city code (for intent detection). */
export function isKnownCode(code: string): boolean {
  return CODE_INDEX.has(code);
}

/** A name a page may use for a known place, and the airports it covers. */
export interface PlaceAlias {
  alias: string;
  airports: string[];
  /** An airport name (not a city name or a code): some are everyday words ("Midway", "Hobby"). */
  airportName: boolean;
}

let aliasList: PlaceAlias[] | null = null;

/**
 * Every city name, airport name and code in the table, once each (by its
 * normalized form), with the airports it may mean. A name two places use
 * ("Portland") covers the airports of both. For spotting a place in a quote
 * that is not on the trip.
 */
export function knownPlaceAliases(): PlaceAlias[] {
  if (aliasList) return aliasList;
  const byKey = new Map<string, { alias: string; airports: Set<string>; airportName: boolean }>();
  const add = (alias: string, airports: string[], airportName: boolean) => {
    const key = /^[A-Z]{3}$/.test(alias) ? alias : normalizePlaceText(alias);
    if (!key) return;
    const entry = byKey.get(key) ?? { alias, airports: new Set<string>(), airportName };
    for (const code of airports) entry.airports.add(code);
    entry.airportName &&= airportName;
    byKey.set(key, entry);
  };
  for (const city of CITIES) {
    const codes = city.airports.map((a) => a.iata);
    for (const name of [city.name, ...(city.alt ?? [])]) add(name, codes, false);
    add(city.code, codes, false);
    for (const airport of city.airports) {
      for (const name of airport.names) add(name, [airport.iata], true);
      add(airport.iata, [airport.iata], false);
    }
  }
  aliasList = [...byKey.values()].map((entry) => ({ alias: entry.alias, airports: [...entry.airports], airportName: entry.airportName }));
  return aliasList;
}

/**
 * City names and their other spellings, normalized, at least `minLength`
 * characters (for intent detection). Airport names are left out: some are
 * everyday words ("Hobby", "Midway", "National").
 */
export function knownCityNames(minLength: number): string[] {
  const names = CITIES.flatMap((city) => [city.name, ...(city.alt ?? [])]).map(normalizePlaceText);
  return [...new Set(names)].filter((name) => name.length >= minLength);
}
