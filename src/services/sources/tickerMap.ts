import { DEFAULT_UNIVERSE } from "../discoveryAgent";
import { cleanCompanyName } from "./gdelt";

// Company-name → ticker resolution for the known universe. Turns extracted
// company names (from filings / news coverage) into tickers. Anything outside
// the known set resolves to null so callers SKIP rather than guess — we never
// fabricate a ticker. This is a static reference lookup, not seed/demo data.

const NAME_ENTRIES: [string, string[]][] = [
  ["AAPL", ["Apple"]],
  ["MSFT", ["Microsoft"]],
  ["GOOGL", ["Alphabet", "Google"]],
  ["AMZN", ["Amazon"]],
  ["META", ["Meta Platforms", "Facebook"]],
  ["NVDA", ["Nvidia"]],
  ["AVGO", ["Broadcom"]],
  ["ORCL", ["Oracle"]],
  ["ADBE", ["Adobe"]],
  ["CRM", ["Salesforce"]],
  ["NFLX", ["Netflix"]],
  ["AMD", ["Advanced Micro Devices"]],
  ["INTC", ["Intel"]],
  ["QCOM", ["Qualcomm"]],
  ["TXN", ["Texas Instruments"]],
  ["MU", ["Micron", "Micron Technology"]],
  ["CSCO", ["Cisco", "Cisco Systems"]],
  ["IBM", ["International Business Machines"]],
  ["NOW", ["ServiceNow"]],
  ["INTU", ["Intuit"]],
  ["TSLA", ["Tesla"]],
  ["HD", ["Home Depot"]],
  ["NKE", ["Nike"]],
  ["MCD", ["McDonalds", "McDonald's"]],
  ["SBUX", ["Starbucks"]],
  ["COST", ["Costco", "Costco Wholesale"]],
  ["WMT", ["Walmart"]],
  ["TGT", ["Target"]],
  ["LOW", ["Lowes", "Lowe's"]],
  ["DIS", ["Disney", "Walt Disney"]],
  ["JPM", ["JPMorgan", "JPMorgan Chase", "JP Morgan"]],
  ["BAC", ["Bank of America"]],
  ["GS", ["Goldman Sachs"]],
  ["MS", ["Morgan Stanley"]],
  ["V", ["Visa"]],
  ["MA", ["Mastercard"]],
  ["AXP", ["American Express"]],
  ["SCHW", ["Charles Schwab", "Schwab"]],
  ["BLK", ["BlackRock"]],
  ["C", ["Citigroup", "Citibank"]],
  ["UNH", ["UnitedHealth", "UnitedHealth Group"]],
  ["JNJ", ["Johnson & Johnson"]],
  ["LLY", ["Eli Lilly", "Lilly"]],
  ["ABBV", ["AbbVie"]],
  ["MRK", ["Merck"]],
  ["PFE", ["Pfizer"]],
  ["TMO", ["Thermo Fisher", "Thermo Fisher Scientific"]],
  ["ABT", ["Abbott", "Abbott Laboratories"]],
  ["DHR", ["Danaher"]],
  ["AMGN", ["Amgen"]],
  ["CAT", ["Caterpillar"]],
  ["DE", ["Deere", "John Deere"]],
  ["BA", ["Boeing"]],
  ["GE", ["General Electric", "GE Aerospace"]],
  ["HON", ["Honeywell"]],
  ["UPS", ["United Parcel Service"]],
  ["XOM", ["Exxon", "ExxonMobil", "Exxon Mobil"]],
  ["CVX", ["Chevron"]],
  ["COP", ["ConocoPhillips", "Conoco"]],
  ["FCX", ["Freeport-McMoRan", "Freeport McMoRan", "Freeport"]],
  ["ASML", ["ASML Holding"]],
  ["ARM", ["Arm Holdings"]],
  ["SMCI", ["Super Micro Computer", "Supermicro", "Super Micro"]],
  ["PLTR", ["Palantir", "Palantir Technologies"]],
  ["SHOP", ["Shopify"]],
  ["UBER", ["Uber Technologies", "Uber"]],
  ["ABNB", ["Airbnb"]],
  ["PANW", ["Palo Alto Networks", "Palo Alto"]],
  ["SNOW", ["Snowflake"]],
  ["DDOG", ["Datadog"]],
];

const UNIVERSE_SET = new Set(DEFAULT_UNIVERSE.map((t) => t.toUpperCase()));

const SUFFIX =
  /\b(INC|INCORPORATED|CORP|CORPORATION|CO|COMPANY|LTD|LIMITED|PLC|HOLDINGS|HOLDING|GROUP|THE|COM|SA|NV|AG)\b/g;

/** Normalize a company name for lookup (strip suffixes, punctuation, case). */
function norm(s: string): string {
  return s
    .toUpperCase()
    .replace(/&/g, " AND ")
    .replace(/[.,'’]/g, "")
    .replace(SUFFIX, " ")
    .replace(/\bAND\s*$/, " ") // drop a dangling "AND" left by stripping "& Co"
    .replace(/\s+/g, " ")
    .trim();
}

// norm(name) -> ticker, built once.
const NAME_TO_TICKER = new Map<string, string>();
const TICKER_TO_DISPLAY = new Map<string, string>();
for (const [ticker, names] of NAME_ENTRIES) {
  TICKER_TO_DISPLAY.set(ticker, names[0]);
  NAME_TO_TICKER.set(norm(ticker), ticker);
  for (const n of names) {
    const k = norm(n);
    if (k) NAME_TO_TICKER.set(k, ticker);
  }
}

/** Resolve a ticker symbol or company name to a known-universe ticker, or null. */
export function resolveTicker(input: string | null | undefined): string | null {
  if (!input) return null;
  const raw = input.trim();
  if (!raw) return null;
  const upper = raw.toUpperCase();
  if (UNIVERSE_SET.has(upper)) return upper; // already a known ticker
  return NAME_TO_TICKER.get(norm(raw)) ?? null;
}

/** Best-effort: find the first known company name/ticker mentioned in free text. */
export function findKnownTicker(text: string): string | null {
  if (!text) return null;
  for (const [ticker, names] of NAME_ENTRIES) {
    const aliases = [...names];
    if (ticker.length >= 3) aliases.push(ticker); // avoid matching 1-2 char tickers in prose
    for (const a of aliases) {
      const re = new RegExp(`\\b${a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
      if (re.test(text)) return ticker;
    }
  }
  return null;
}

/** Human-readable display name for a ticker (its primary alias), or the ticker. */
export function companyDisplayName(ticker: string): string {
  return TICKER_TO_DISPLAY.get(ticker.toUpperCase()) ?? ticker.toUpperCase();
}

// ----------------------------------------------------------------------------
// Resolver — the curated universe, optionally augmented with extra (ticker,name)
// pairs (e.g. the companies you track) so extraction can map news/filings about
// smaller names back to a ticker instead of dropping them.
// ----------------------------------------------------------------------------

export interface TickerResolver {
  /** Resolve a ticker symbol or company name to a ticker, or null. */
  resolve(input: string | null | undefined): string | null;
  /** Find the first recognized company/ticker mentioned in free text, or null. */
  findInText(text: string): string | null;
  /** Human-readable display name for a ticker (or the ticker itself). */
  displayName(ticker: string): string;
}

/** Resolver over the built-in curated universe (the long-standing behavior). */
export const defaultResolver: TickerResolver = {
  resolve: resolveTicker,
  findInText: findKnownTicker,
  displayName: companyDisplayName,
};

/**
 * Build a resolver that ALSO recognizes the given (ticker, name) pairs. Names are
 * suffix-cleaned (e.g. "Rocket Lab Corp" -> "Rocket Lab") so they match how they
 * appear in prose, and each ticker joins the resolvable universe. Falls back to
 * the curated universe for everything else. Pure.
 */
export function makeResolver(extra: { ticker: string; name?: string | null }[]): TickerResolver {
  const nameToTicker = new Map(NAME_TO_TICKER);
  const display = new Map(TICKER_TO_DISPLAY);
  const universe = new Set(UNIVERSE_SET);
  const extraAliases: [string, string[]][] = [];
  for (const e of extra) {
    const t = e.ticker?.trim().toUpperCase();
    if (!t) continue;
    universe.add(t);
    const alias = e.name ? cleanCompanyName(e.name) : "";
    const aliases = alias ? [alias] : [];
    for (const a of aliases) {
      const k = norm(a);
      if (k) nameToTicker.set(k, t);
    }
    if (alias && !display.has(t)) display.set(t, alias);
    extraAliases.push([t, aliases]);
  }

  return {
    resolve(input) {
      if (!input) return null;
      const raw = input.trim();
      if (!raw) return null;
      if (universe.has(raw.toUpperCase())) return raw.toUpperCase();
      return nameToTicker.get(norm(raw)) ?? null;
    },
    findInText(text) {
      const base = findKnownTicker(text); // curated names first (unchanged behavior)
      if (base || !text) return base;
      for (const [ticker, names] of extraAliases) {
        const aliases = [...names];
        if (ticker.length >= 3) aliases.push(ticker); // avoid 1-2 char tickers in prose
        for (const a of aliases) {
          const re = new RegExp(`\\b${a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
          if (re.test(text)) return ticker;
        }
      }
      return null;
    },
    displayName(ticker) {
      return display.get(ticker.toUpperCase()) ?? ticker.toUpperCase();
    },
  };
}
