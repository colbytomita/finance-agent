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

let cache: { map: Map<string, string>; at: number } | null = null;

/** Fetch (and cache) the CIK->ticker map. Returns an empty map on failure. */
export async function getCikTickerMap(
  opts: { fetchFn?: typeof fetch; userAgent?: string } = {},
): Promise<Map<string, string>> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.map;
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
    const map = parseCikTickers(await res.json());
    if (map.size > 0) cache = { map, at: Date.now() };
    return map;
  } catch {
    return cache?.map ?? new Map();
  }
}
