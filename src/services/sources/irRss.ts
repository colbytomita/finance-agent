import type { RawEventItem } from "./types";
import { parseFeed } from "./parse";

// Company Investor-Relations RSS/Atom feeds. These are per-company and vary by
// vendor (GlobeNewswire, Business Wire, in-house), so the feed list is config-
// driven (see AppConfig.irFeeds) and empty by default — add `{ ticker, url }`
// entries to ingest a company's official press releases. Because each feed is a
// single company, we attach a `tickerHint` so resolution is unambiguous.

export interface IrFeed {
  ticker: string;
  url: string;
}

/** Map a parsed feed for one company to RawEventItems (pure; no network). */
export function irItemsFromFeed(xml: string, feed: IrFeed): RawEventItem[] {
  const ticker = feed.ticker.toUpperCase();
  return parseFeed(xml)
    .filter((e) => e.title)
    .map((e) => ({
      source: `ir-rss:${ticker}`,
      title: e.title,
      text: e.summary ? `${e.title}. ${e.summary}` : e.title,
      url: e.link,
      publishedAt: e.date,
      tickerHint: ticker,
    }));
}

export async function fetchIrFeeds(
  feeds: IrFeed[],
  opts: { fetchFn?: typeof fetch } = {},
): Promise<RawEventItem[]> {
  const fetchFn = opts.fetchFn ?? fetch;
  const out: RawEventItem[] = [];
  for (const feed of feeds) {
    if (!feed.url) continue;
    try {
      const res = await fetchFn(feed.url, { headers: { Accept: "application/rss+xml, application/atom+xml, application/xml" } });
      if (!res.ok) continue;
      const xml = await res.text();
      out.push(...irItemsFromFeed(xml, feed));
    } catch {
      // Skip a failing feed; others still contribute.
    }
  }
  return out;
}
