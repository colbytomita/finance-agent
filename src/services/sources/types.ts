// Normalized shape every source connector emits. The LLM extractor consumes
// `{ text, url, source }`; the extra fields help with dating, dedupe, and
// (for single-company feeds) ticker resolution.
export interface RawEventItem {
  source: string; // "sec-edgar" | "gdelt" | `ir-rss:${ticker}`
  title: string;
  text: string; // text used for extraction (title + any summary)
  url: string;
  publishedAt: string | null; // ISO date when known, else null
  tickerHint?: string | null; // authoritative ticker when known (IR feed, or SEC CIK lookup)
  cik?: string | null; // SEC Central Index Key (filings only), used to resolve the ticker
}
