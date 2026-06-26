import type { RawEventItem } from "./types";
import { parseAtomEntries } from "./parse";
import { resolveTicker } from "./tickerMap";
import { getCikTickerMap, normalizeCik } from "./cikMap";

// SEC EDGAR connector — the "latest filings" Atom feed is free, official, and
// keyless. We pull recent filings of a given form type (8-K by default: material
// corporate events) and hand the titles to the extractor. SEC asks API clients
// to send a descriptive User-Agent with contact info — override via SEC_USER_AGENT.

const EDGAR_BASE =
  "https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&owner=include&output=atom";

function userAgent(): string {
  return process.env.SEC_USER_AGENT || "finance-agent research (contact: set SEC_USER_AGENT)";
}

/** Pull the company name out of an EDGAR "current filings" entry title. */
export function parseEdgarCompany(title: string): string | null {
  // Titles look like: "8-K - Apple Inc. (0000320193) (Filer)". The form type can
  // itself contain hyphens (8-K, 10-K, S-1), so split on the " - " that follows
  // it (space-hyphen-space) rather than the first hyphen.
  const m = /\s-\s+(.+?)\s*\(\d{6,10}\)/.exec(title);
  return m ? m[1].trim() : null;
}

/** Pull the filer CIK out of an EDGAR entry title, e.g. "...(0000320193) (Filer)". */
export function parseEdgarCik(title: string): string | null {
  const m = /\((\d{6,10})\)/.exec(title);
  return m ? normalizeCik(m[1]) : null;
}

/** Map an EDGAR Atom payload to RawEventItems (pure; no network). */
export function edgarItemsFromAtom(xml: string): RawEventItem[] {
  return parseAtomEntries(xml)
    .filter((e) => e.title)
    .map((e) => {
      const company = parseEdgarCompany(e.title);
      return {
        source: "sec-edgar",
        title: e.title,
        text: e.summary ? `${e.title}. ${e.summary}` : e.title,
        url: e.link,
        publishedAt: e.date,
        // Resolve the filer to a known ticker up front when possible — for a
        // company's own filing the entity IS the company. The CIK (resolved in
        // fetchEdgarFilings against SEC's official map) is preferred over the
        // name-based universe lookup.
        tickerHint: company ? resolveTicker(company) : null,
        cik: parseEdgarCik(e.title),
      };
    });
}

export async function fetchEdgarFilings(opts: {
  formType?: string;
  max?: number;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
} = {}): Promise<RawEventItem[]> {
  const fetchFn = opts.fetchFn ?? fetch;
  const formType = opts.formType ?? "8-K";
  const count = Math.min(100, Math.max(10, opts.max ?? 40));
  const url = `${EDGAR_BASE}&type=${encodeURIComponent(formType)}&count=${count}`;
  const res = await fetchFn(url, {
    headers: { "User-Agent": userAgent(), Accept: "application/atom+xml" },
    signal: AbortSignal.timeout(opts.timeoutMs ?? 15000),
  });
  if (!res.ok) throw new Error(`EDGAR ${res.status}`);
  const xml = await res.text();
  const items = edgarItemsFromAtom(xml).slice(0, opts.max ?? 40);

  // Upgrade each item's tickerHint via the filer's CIK using SEC's official
  // CIK->ticker map, so filings from companies outside the curated name universe
  // still resolve to a real symbol. Best effort: if the map is unavailable the
  // name-based tickerHint stands.
  const cikMap = await getCikTickerMap({ fetchFn, userAgent: userAgent() });
  if (cikMap.size > 0) {
    for (const it of items) {
      if (it.cik) {
        const ticker = cikMap.get(normalizeCik(it.cik));
        if (ticker) it.tickerHint = ticker;
      }
    }
  }
  return items;
}
