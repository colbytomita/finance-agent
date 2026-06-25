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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Fetch news for each query. GDELT is free but slow and rate-limits aggressively
 * (~1 request / 5s; bursts return HTTP 429). To stay responsive and avoid
 * grinding through dozens of throttled requests, we: cap the number of queries
 * per run, time-box each request, space requests out a little, and STOP as soon
 * as we hit a 429 (further calls would just be throttled too — they retry next run).
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
): Promise<RawEventItem[]> {
  const fetchFn = opts.fetchFn ?? fetch;
  const maxPerQuery = Math.min(75, Math.max(5, opts.maxPerQuery ?? 25));
  const timespan = opts.timespan ?? "3d";
  const maxQueries = Math.max(1, opts.maxQueries ?? 8);
  const timeoutMs = Math.max(1000, opts.perRequestTimeoutMs ?? 10000);
  const spacingMs = Math.max(0, opts.spacingMs ?? 1500);
  const out: RawEventItem[] = [];

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
        // Rate limited — stop; remaining queries retry next run. GDELT throttles
        // to ~1 request / 5s, so continuing would just collect more 429s.
        console.warn(
          `[gdelt] rate limited (429) after ${out.length} item(s); stopping this run — try again in a few minutes`,
        );
        break;
      }
      if (!res.ok) continue;
      const json = await res.json().catch(() => ({}));
      out.push(...parseGdelt(json, q));
    } catch {
      // Timeout or network error — skip this query; others still contribute.
    }
    if (spacingMs > 0 && i < selected.length - 1) await sleep(spacingMs);
  }
  return out;
}
