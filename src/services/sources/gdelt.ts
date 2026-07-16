import type { RawEventItem } from "./types";

// GDELT Doc 2.0 API — free, keyless global news index. We use it to find news
// COVERAGE of public-figure statements about companies ("person says X about
// company Y"). We deliberately do NOT scrape Truth Social / X / other social
// platforms directly: no clean official API, fragile HTML, and ToS friction —
// ingesting mainstream news coverage of those statements is the robust path.

const GDELT_BASE = "https://api.gdeltproject.org/api/v2/doc/doc";

interface GdeltArticle {
  url?: string;
  title?: string;
  seendate?: string; // "YYYYMMDDTHHMMSSZ"
  domain?: string;
}

/** "20251201T120000Z" -> "2025-12-01" (null if unparseable). */
function seendateToIso(s: string | undefined): string | null {
  if (!s || s.length < 8) return null;
  const y = s.slice(0, 4);
  const mo = s.slice(4, 6);
  const d = s.slice(6, 8);
  const iso = `${y}-${mo}-${d}`;
  return Number.isNaN(new Date(iso).getTime()) ? null : iso;
}

/** Map a GDELT ArtList JSON payload to RawEventItems (pure; no network). */
export function parseGdelt(json: unknown, query?: string): RawEventItem[] {
  const articles = (json as { articles?: GdeltArticle[] })?.articles ?? [];
  return articles
    .filter((a) => a.url && a.title)
    .map((a) => ({
      source: query ? `gdelt:${query}` : "gdelt",
      title: a.title as string,
      text: a.title as string,
      url: a.url as string,
      publishedAt: seendateToIso(a.seendate),
    }));
}

// ----------------------------------------------------------------------------
// Auto query building — derive GDELT searches from the companies you track so
// the source produces relevant coverage without hand-written queries.
// ----------------------------------------------------------------------------

// Trailing legal-entity suffixes that news prose rarely uses ("Apple Inc." is
// "Apple" in a headline). Stripped so the phrase search matches real coverage.
const TRAILING_SUFFIX =
  /[\s,]+(?:incorporated|inc|corporation|corp|company|co|llc|l\.?l\.?c|plc|ltd|limited|lp|l\.?p|holdings?|group|s\.?a|n\.?v|a\.?g|s\.?e|a\.?b)\.?$/i;

// SEC company titles carry a trailing state-of-incorporation marker like
// " /DE/" or "/TX" — pure noise for both display and search.
const STATE_MARKER = /\s*\/[^/]*\/?\s*$/;

/** Reduce a legal company name to the form news actually uses for searching. */
export function cleanCompanyName(name: string): string {
  let s = name.trim().replace(/^the\s+/i, "");
  // Peel stacked trailing artifacts — state markers and legal suffixes —
  // e.g. "Acme Co., Ltd /DE/" -> "Acme".
  for (let i = 0; i < 4; i++) {
    const next = s.replace(STATE_MARKER, "").trim().replace(TRAILING_SUFFIX, "").trim();
    if (next === s) break;
    s = next;
  }
  // Drop a stray trailing connector/punctuation left behind ("Merck & Co" -> "Merck").
  return s.replace(/[\s&.,-]+$/g, "").replace(/\s+/g, " ").trim();
}

/**
 * A GDELT phrase query for one company. Prefers a cleaned company-name phrase;
 * falls back to a distinctive (4+ char) ticker when no usable name exists.
 * Returns null when nothing safe enough to search remains (short/ambiguous
 * tickers like "F" or "CAT" would only add noise).
 */
export function companyGdeltQuery(companyName: string | null | undefined, ticker: string): string | null {
  const clean = companyName ? cleanCompanyName(companyName) : "";
  if (clean.length >= 3) return `"${clean}"`;
  const t = (ticker ?? "").trim().toUpperCase();
  if (t.length >= 4) return `"${t}"`;
  return null;
}

export interface GdeltQueryItem {
  ticker: string;
  companyName?: string | null;
}

/**
 * Build GDELT queries from tracked companies, de-duplicated by ticker and by
 * phrase. Companies are batched into OR-queries (default 6 per query) so a real
 * watchlist fits inside GDELT's tight per-run request budget — the downstream
 * extractor attributes each article by its own title, so batching doesn't blur
 * which ticker an event belongs to. Pure (no IO). Order is preserved.
 */
export function buildGdeltQueriesFor(
  items: GdeltQueryItem[],
  opts: { batchSize?: number; maxCompanies?: number } = {},
): string[] {
  const batchSize = Math.max(1, opts.batchSize ?? 6);
  const maxCompanies = Math.max(1, opts.maxCompanies ?? 48);
  const phrases: string[] = [];
  const seenTicker = new Set<string>();
  const seenPhrase = new Set<string>();
  for (const it of items) {
    const t = (it.ticker ?? "").trim().toUpperCase();
    if (!t || seenTicker.has(t)) continue;
    seenTicker.add(t);
    const q = companyGdeltQuery(it.companyName, t);
    if (!q) continue;
    const key = q.toLowerCase();
    if (seenPhrase.has(key)) continue;
    seenPhrase.add(key);
    phrases.push(q);
    if (phrases.length >= maxCompanies) break;
  }
  const queries: string[] = [];
  for (let i = 0; i < phrases.length; i += batchSize) {
    const batch = phrases.slice(i, i + batchSize);
    queries.push(batch.length === 1 ? batch[0] : `(${batch.join(" OR ")})`);
  }
  return queries;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Per-run request-failure tally (roadmap #56) — every path that used to be silent. */
export interface GdeltFailures {
  /** 429 responses seen (fast enough to arrive before the timeout). */
  throttled: number;
  /** Requests aborted by the per-request timeout — a slow 429 lands here. */
  timedOut: number;
  /** HTTP 200 whose body wasn't the expected JSON (GDELT error text). */
  badPayload: number;
  /** Non-ok, non-429 statuses and non-timeout network errors. */
  httpError: number;
  /** Head of the first non-JSON body, for diagnosis. */
  badPayloadSample?: string;
}

export interface GdeltFetchResult {
  items: RawEventItem[];
  failures: GdeltFailures;
}

/** "1 throttled (429), 6 timed out" — only the nonzero classes. Pure. */
export function describeGdeltFailures(f: GdeltFailures): string {
  const parts: string[] = [];
  if (f.throttled > 0) parts.push(`${f.throttled} throttled (429)`);
  if (f.timedOut > 0) parts.push(`${f.timedOut} timed out`);
  if (f.badPayload > 0)
    parts.push(
      `${f.badPayload} bad payload` + (f.badPayloadSample ? ` (e.g. "${f.badPayloadSample}")` : ""),
    );
  if (f.httpError > 0) parts.push(`${f.httpError} http error`);
  return parts.join(", ");
}

/**
 * Rotate a query list by a seed (e.g. day number) so a different batch leads
 * each run — when a run dies early to throttling, coverage still cycles
 * through every company over successive days instead of starving the tail. Pure.
 */
export function rotateQueries<T>(queries: T[], seed: number): T[] {
  if (queries.length === 0) return [];
  const k = ((seed % queries.length) + queries.length) % queries.length;
  return [...queries.slice(k), ...queries.slice(0, k)];
}

/**
 * Fetch news for each query, reporting every failure class (roadmap #56).
 * GDELT is free but rate-limits hard: its stated floor is ONE request per 5
 * seconds, and observed penalties last minutes — during which even the 429
 * response can take >10s to arrive. The old defaults (1.5s spacing, 10s
 * timeout) therefore self-inflicted throttling and then hid it: the abort
 * fired before the slow 429 landed, the catch swallowed it, and a week of
 * runs recorded zero items with zero errors. Now: spacing above the stated
 * floor, a timeout generous enough to actually SEE a slow 429, one polite
 * Retry-After retry, and a failures tally the caller can surface.
 */
export async function fetchGdeltNews(
  queries: string[],
  opts: {
    maxPerQuery?: number;
    timespan?: string;
    fetchFn?: typeof fetch;
    maxQueries?: number;
    perRequestTimeoutMs?: number;
    spacingMs?: number;
  } = {},
): Promise<GdeltFetchResult> {
  const fetchFn = opts.fetchFn ?? fetch;
  const maxPerQuery = Math.min(75, Math.max(5, opts.maxPerQuery ?? 25));
  const timespan = opts.timespan ?? "3d";
  const maxQueries = Math.max(1, opts.maxQueries ?? 8);
  const timeoutMs = Math.max(1000, opts.perRequestTimeoutMs ?? 20000);
  const spacingMs = Math.max(0, opts.spacingMs ?? 5500);
  const items: RawEventItem[] = [];
  const failures: GdeltFailures = { throttled: 0, timedOut: 0, badPayload: 0, httpError: 0 };
  let retriedAfter429 = false;

  const selected = queries.slice(0, maxQueries);
  for (let i = 0; i < selected.length; i++) {
    const q = selected[i];
    const url =
      `${GDELT_BASE}?query=${encodeURIComponent(q)}` +
      `&mode=ArtList&maxrecords=${maxPerQuery}&format=json&sort=DateDesc&timespan=${encodeURIComponent(timespan)}`;
    try {
      const res = await fetchFn(url, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status === 429) {
        failures.throttled++;
        // One polite retry when GDELT tells us exactly how long to wait.
        const retryAfter = Number.parseInt(res.headers.get("retry-after") ?? "", 10);
        if (!retriedAfter429 && Number.isFinite(retryAfter) && retryAfter >= 0 && retryAfter <= 15) {
          retriedAfter429 = true;
          await sleep(retryAfter * 1000);
          i--; // re-run this query
          continue;
        }
        // Otherwise stop; remaining queries retry next run — continuing would
        // just extend the penalty window.
        console.warn(
          `[gdelt] rate limited (429) after ${items.length} item(s); stopping this run — try again in a few minutes`,
        );
        break;
      }
      if (!res.ok) {
        failures.httpError++;
        continue;
      }
      const text = await res.text();
      try {
        items.push(...parseGdelt(JSON.parse(text), q));
      } catch {
        // 200 with GDELT's plain-text error body — the old silent-zero path.
        failures.badPayload++;
        if (!failures.badPayloadSample) failures.badPayloadSample = text.slice(0, 80).trim();
      }
    } catch (e) {
      const name = (e as Error)?.name ?? "";
      if (name === "TimeoutError" || name === "AbortError") failures.timedOut++;
      else failures.httpError++;
    }
    if (spacingMs > 0 && i < selected.length - 1) await sleep(spacingMs);
  }
  return { items, failures };
}
