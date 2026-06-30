// SEC CIK -> ticker resolution via the official company_tickers.json map.
// EDGAR filings always carry the filer's CIK (Central Index Key); SEC publishes
// an authoritative CIK->ticker file, so we can resolve ANY public filer to its
// symbol instead of only the curated name universe. Fetched once and cached
// (the file changes rarely); failures degrade to "no resolution", never throw.

const CIK_TICKERS_URL = "https://www.sec.gov/files/company_tickers.json";
const TTL_MS = 24 * 60 * 60 * 1000; // refresh at most once a day

/** Zero-pad a CIK (number or string) to the canonical 10-digit form. */
export function normalizeCik(cik: string | number): string {
  return String(cik).replace(/\D/g, "").padStart(10, "0");
}

/**
 * Parse SEC's company_tickers.json into a CIK(10-digit) -> TICKER map. Pure.
 * The file is an object keyed by row index: { "0": { cik_str, ticker, title } }.
 */
export function parseCikTickers(json: unknown): Map<string, string> {
  const map = new Map<string, string>();
  if (!json || typeof json !== "object") return map;
  for (const row of Object.values(json as Record<string, unknown>)) {
    if (!row || typeof row !== "object") continue;
    const r = row as { cik_str?: unknown; ticker?: unknown };
    const ticker = typeof r.ticker === "string" ? r.ticker.trim().toUpperCase() : "";
    if (!ticker || r.cik_str == null) continue;
    const cik = normalizeCik(r.cik_str as string | number);
    // Keep the first ticker seen for a CIK (the primary/common share class).
    if (!map.has(cik)) map.set(cik, ticker);
  }
  return map;
}

/**
 * Parse SEC's company_tickers.json into a TICKER -> company-name map. Pure.
 * Same source as parseCikTickers, but keyed by symbol and carrying the `title`
 * (company name) — used to backfill missing names on tracked tickers.
 */
export function parseTickerNames(json: unknown): Map<string, string> {
  const map = new Map<string, string>();
  if (!json || typeof json !== "object") return map;
  for (const row of Object.values(json as Record<string, unknown>)) {
    if (!row || typeof row !== "object") continue;
    const r = row as { ticker?: unknown; title?: unknown };
    const ticker = typeof r.ticker === "string" ? r.ticker.trim().toUpperCase() : "";
    // Strip SEC's trailing state-of-incorporation marker (" /DE/", "/TX") and
    // collapse whitespace so the stored display name is clean.
    const title =
      typeof r.title === "string" ? r.title.replace(/\s*\/[^/]*\/?\s*$/, "").replace(/\s+/g, " ").trim() : "";
    if (!ticker || !title) continue;
    // Keep the first title seen for a ticker (the primary/common share class).
    if (!map.has(ticker)) map.set(ticker, title);
  }
  return map;
}

let rawCache: { json: unknown; at: number } | null = null;

/**
 * Fetch (and cache) SEC's raw company_tickers.json. Cached for a day; on failure
 * returns the last good payload (or null). Both the CIK->ticker and TICKER->name
 * maps derive from this, so the ~1 MB file is fetched at most once a day.
 */
async function fetchCompanyTickers(
  opts: { fetchFn?: typeof fetch; userAgent?: string } = {},
): Promise<unknown> {
  if (rawCache && Date.now() - rawCache.at < TTL_MS) return rawCache.json;
  const fetchFn = opts.fetchFn ?? fetch;
  try {
    const res = await fetchFn(CIK_TICKERS_URL, {
      headers: {
        "User-Agent": opts.userAgent || "finance-agent research (contact: set SEC_USER_AGENT)",
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`SEC company_tickers ${res.status}`);
    const json = await res.json();
    if (json && typeof json === "object" && Object.keys(json).length > 0) {
      rawCache = { json, at: Date.now() };
    }
    return json;
  } catch {
    return rawCache?.json ?? null;
  }
}

/** Fetch (and cache) the CIK->ticker map. Returns an empty map on failure. */
export async function getCikTickerMap(
  opts: { fetchFn?: typeof fetch; userAgent?: string } = {},
): Promise<Map<string, string>> {
  return parseCikTickers(await fetchCompanyTickers(opts));
}

/** Fetch (and cache) the TICKER->company-name map. Returns an empty map on failure. */
export async function getTickerNameMap(
  opts: { fetchFn?: typeof fetch; userAgent?: string } = {},
): Promise<Map<string, string>> {
  return parseTickerNames(await fetchCompanyTickers(opts));
}
