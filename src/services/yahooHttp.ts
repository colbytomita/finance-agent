import type { Bar, MarketState } from "@/lib/types";
import {
  getYahooService,
  parseYahooEarnings,
  type ParsedYahooEarnings,
  type YahooSummaryFields,
} from "./yahooFinanceBrowser";

// Plain-HTTP Yahoo Finance client (roadmap #8). The headless-browser scraper is
// the app's most fragile subsystem — page-layout changes silently break price
// extraction. Yahoo's JSON endpoints are far more stable:
//   - quoteSummary (price, summaryDetail, earningsHistory): needs a cookie+crumb
//     session, bootstrapped with two plain fetches and cached.
//   - chart: daily OHLCV bars, no crumb needed.
// Every public helper tries HTTP first and falls back to the browser service,
// so a consent wall or endpoint change degrades gracefully instead of breaking.

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

const SESSION_TTL_MS = 30 * 60 * 1000;

interface YahooSession {
  cookie: string;
  crumb: string;
  fetchedAt: number;
}

let session: YahooSession | null = null;

/** Bootstrap (or reuse) a cookie+crumb session. Null when Yahoo won't play. */
async function getSession(): Promise<YahooSession | null> {
  if (session && Date.now() - session.fetchedAt < SESSION_TTL_MS) return session;
  try {
    // fc.yahoo.com 404s but sets the auth cookie the crumb endpoint requires.
    const res = await fetch("https://fc.yahoo.com/", {
      headers: { "user-agent": UA },
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
    const cookie = (res.headers.getSetCookie?.() ?? [])
      .map((c) => c.split(";")[0])
      .join("; ");
    if (!cookie) return null;

    const crumbRes = await fetch("https://query1.finance.yahoo.com/v1/test/getcrumb", {
      headers: { "user-agent": UA, cookie },
      signal: AbortSignal.timeout(10_000),
    });
    const crumb = crumbRes.ok ? (await crumbRes.text()).trim() : "";
    // A consent wall returns HTML; a real crumb is a short opaque token.
    if (!crumb || crumb.length > 40 || crumb.includes("<")) return null;

    session = { cookie, crumb, fetchedAt: Date.now() };
    return session;
  } catch {
    return null;
  }
}

/** Drop the cached session (e.g. after a 401) so the next call re-bootstraps. */
function invalidateSession(): void {
  session = null;
}

async function quoteSummary(ticker: string, modules: string): Promise<unknown> {
  const s = await getSession();
  if (!s) return null;
  const url =
    `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(ticker.toUpperCase())}` +
    `?modules=${modules}&crumb=${encodeURIComponent(s.crumb)}`;
  const res = await fetch(url, {
    headers: { "user-agent": UA, cookie: s.cookie },
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 401 || res.status === 403) {
    invalidateSession();
    return null;
  }
  return res.ok ? res.json() : null;
}

// --- Pure mappers (unit-tested) ---------------------------------------------

type RawNum = { raw?: number } | number | null | undefined;

const rawNum = (v: RawNum): number | null => {
  const n = typeof v === "number" ? v : v?.raw;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
};

const asPercent = (v: RawNum): number | null => {
  // quoteSummary percent fields are fractional (0.0123 => 1.23%).
  const n = rawNum(v);
  return n == null ? null : n * 100;
};

function toMarketState(v: unknown): MarketState {
  const s = String(v ?? "").toUpperCase();
  if (s.startsWith("PRE")) return "PRE";
  if (s === "REGULAR") return "REGULAR";
  if (s.startsWith("POST")) return "POST";
  if (s === "CLOSED") return "CLOSED";
  return "UNKNOWN";
}

/** Map a quoteSummary price+summaryDetail payload to YahooSummaryFields. */
export function summaryFieldsFromQuoteSummary(
  json: unknown,
  ticker: string,
  now: Date = new Date(),
): YahooSummaryFields | null {
  const result = (
    json as {
      quoteSummary?: {
        result?: Array<{
          price?: Record<string, unknown>;
          summaryDetail?: Record<string, unknown>;
        }>;
      };
    }
  )?.quoteSummary?.result?.[0];
  const price = result?.price;
  if (!price) return null;

  const detail = result?.summaryDetail ?? {};
  const fields: YahooSummaryFields = {
    ticker: ticker.toUpperCase(),
    companyName:
      (typeof price.longName === "string" && price.longName) ||
      (typeof price.shortName === "string" && price.shortName) ||
      null,
    regularPrice: rawNum(price.regularMarketPrice as RawNum),
    regularChangePercent: asPercent(price.regularMarketChangePercent as RawNum),
    preMarketPrice: rawNum(price.preMarketPrice as RawNum),
    preMarketChangePercent: asPercent(price.preMarketChangePercent as RawNum),
    afterHoursPrice: rawNum(price.postMarketPrice as RawNum),
    afterHoursChangePercent: asPercent(price.postMarketChangePercent as RawNum),
    marketState: toMarketState(price.marketState),
    fiftyTwoWeekHigh: rawNum(detail.fiftyTwoWeekHigh as RawNum),
    fiftyTwoWeekLow: rawNum(detail.fiftyTwoWeekLow as RawNum),
    sourceUrl: `https://finance.yahoo.com/quote/${ticker.toUpperCase()}/`,
    capturedAt: now.toISOString(),
    extractionErrors: [],
  };
  return fields.regularPrice == null ? null : fields;
}

/** Map a v8 chart payload to ascending daily bars. */
export function barsFromChart(json: unknown): Bar[] {
  const result = (
    json as {
      chart?: {
        result?: Array<{
          timestamp?: number[];
          indicators?: {
            quote?: Array<{
              open?: (number | null)[];
              high?: (number | null)[];
              low?: (number | null)[];
              close?: (number | null)[];
              volume?: (number | null)[];
            }>;
          };
        }>;
      };
    }
  )?.chart?.result?.[0];
  const ts = result?.timestamp;
  const q = result?.indicators?.quote?.[0];
  if (!Array.isArray(ts) || !q) return [];

  const out: Bar[] = [];
  for (let i = 0; i < ts.length; i++) {
    const close = q.close?.[i];
    if (close == null || !Number.isFinite(close)) continue; // half-days/holes
    out.push({
      date: new Date(ts[i] * 1000).toISOString(),
      open: q.open?.[i] ?? close,
      high: q.high?.[i] ?? close,
      low: q.low?.[i] ?? close,
      close,
      volume: q.volume?.[i] ?? 0,
    });
  }
  return out;
}

// --- Public helpers: HTTP first, browser fallback ----------------------------

/** Quote/summary fields for a ticker — HTTP first, headless browser fallback. */
export async function getYahooSummaryFields(ticker: string): Promise<YahooSummaryFields | null> {
  try {
    const json = await quoteSummary(ticker, "price,summaryDetail");
    const fields = json ? summaryFieldsFromQuoteSummary(json, ticker) : null;
    if (fields) return fields;
  } catch {
    /* fall through to the browser */
  }
  return getYahooService().getSummaryFields(ticker);
}

/** Quarterly EPS estimate vs actual — HTTP first, browser fallback. */
export async function getYahooEarnings(ticker: string): Promise<ParsedYahooEarnings[]> {
  try {
    const json = await quoteSummary(ticker, "earningsHistory");
    if (json) {
      const rows = parseYahooEarnings(json);
      if (rows.length > 0) return rows;
    }
  } catch {
    /* fall through to the browser */
  }
  return getYahooService().getEarnings(ticker);
}

/**
 * Per-ticker news headlines from Yahoo's public RSS feed (no cookies/crumb).
 * Far more stable than scraping the quote page, and each entry carries a real
 * article link and publish date. Returns [] on any failure.
 */
export async function getYahooHeadlines(
  ticker: string,
): Promise<import("./sources/parse").FeedEntry[]> {
  try {
    const url =
      `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(ticker.toUpperCase())}` +
      `&region=US&lang=en-US`;
    const res = await fetch(url, {
      headers: { "user-agent": UA },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return [];
    const { parseFeed } = await import("./sources/parse");
    return parseFeed(await res.text());
  } catch {
    return [];
  }
}

/**
 * Daily OHLCV bars from the crumb-free chart endpoint (ascending). Used as the
 * bar source when Alpaca isn't configured. Returns [] on any failure.
 */
export async function getYahooDailyBars(ticker: string, days = 400): Promise<Bar[]> {
  try {
    const range = days <= 250 ? "1y" : days <= 500 ? "2y" : "5y";
    const url =
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker.toUpperCase())}` +
      `?range=${range}&interval=1d&events=split`;
    const res = await fetch(url, {
      headers: { "user-agent": UA },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return [];
    const bars = barsFromChart(await res.json());
    return bars.slice(-days);
  } catch {
    return [];
  }
}
