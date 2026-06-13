import type { MarketState, Quote } from "@/lib/types";

// Yahoo Finance extraction via a real browser (Playwright/Chromium).
// Design: parseYahooQuoteHtml() is a pure function tested against fixture
// HTML; YahooFinanceBrowserService owns the browser lifecycle. Partial data
// is always returned instead of throwing — missing fields stay null.

export interface YahooSummaryFields {
  ticker: string;
  companyName: string | null;
  regularPrice: number | null;
  regularChangePercent: number | null;
  preMarketPrice: number | null;
  preMarketChangePercent: number | null;
  afterHoursPrice: number | null;
  afterHoursChangePercent: number | null;
  marketState: MarketState;
  fiftyTwoWeekHigh: number | null;
  fiftyTwoWeekLow: number | null;
  sourceUrl: string;
  capturedAt: string;
  extractionErrors: string[];
}

const num = (v: string | undefined | null): number | null => {
  if (v == null) return null;
  const n = parseFloat(v.replace(/,/g, ""));
  return isFinite(n) ? n : null;
};

/**
 * Extract the value of a fin-streamer element by data-field, resilient to
 * attribute ordering. Prefers data-value (machine-readable) over inner text.
 */
function finStreamerValue(html: string, field: string, ticker?: string): number | null {
  // Match every fin-streamer carrying this data-field; take the first with a
  // usable value. Yahoo renders both `data-value="..."` and inner text.
  const tagRe = new RegExp(
    `<fin-streamer\\b[^>]*data-field="${field}"[^>]*>([^<]*)<`,
    "gi",
  );
  let match: RegExpExecArray | null;
  while ((match = tagRe.exec(html)) !== null) {
    const tag = match[0];
    if (ticker) {
      const symMatch = tag.match(/data-symbol="([^"]+)"/i);
      if (symMatch && symMatch[1].toUpperCase() !== ticker.toUpperCase()) continue;
    }
    const dataValue = tag.match(/data-value="([^"]+)"/i);
    const value = num(dataValue?.[1]) ?? num(match[1]);
    if (value != null) return value;
  }
  return null;
}

function detectMarketState(html: string): MarketState {
  // Yahoo embeds marketState in JSON blobs: "marketState":"PRE" etc.
  const m = html.match(/"marketState"\s*:\s*"(PRE|PREPRE|REGULAR|POST|POSTPOST|CLOSED)"/i);
  if (m) {
    const s = m[1].toUpperCase();
    if (s.startsWith("PRE")) return "PRE";
    if (s === "REGULAR") return "REGULAR";
    if (s.startsWith("POST")) return "POST";
    return "CLOSED";
  }
  if (/data-field="preMarketPrice"/i.test(html)) return "PRE";
  if (/data-field="postMarketPrice"/i.test(html)) return "POST";
  return "UNKNOWN";
}

function extractCompanyName(html: string, ticker: string): string | null {
  // <title>Apple Inc. (AAPL) Stock Price ...</title>
  const title = html.match(/<title>([^<]+)<\/title>/i)?.[1];
  if (title) {
    const m = title.match(new RegExp(`^(.*?)\\s*\\(${ticker}\\)`, "i"));
    if (m && m[1].trim()) return m[1].trim();
  }
  const h1 = html.match(/<h1[^>]*>([^<]+)<\/h1>/i)?.[1];
  if (h1) {
    return h1.replace(new RegExp(`\\s*\\(${ticker}\\)\\s*$`, "i"), "").trim() || null;
  }
  return null;
}

function extractRangeValue(html: string, jsonKey: string): number | null {
  // Fall back to embedded JSON: "fiftyTwoWeekHigh":{"raw":237.23,...} or "fiftyTwoWeekHigh":237.23
  const rawRe = new RegExp(`"${jsonKey}"\\s*:\\s*\\{[^}]*?"raw"\\s*:\\s*([0-9.eE+-]+)`);
  const plainRe = new RegExp(`"${jsonKey}"\\s*:\\s*([0-9.eE+-]+)`);
  const m = html.match(rawRe) ?? html.match(plainRe);
  return m ? num(m[1]) : null;
}

export function parseYahooQuoteHtml(
  html: string,
  ticker: string,
  sourceUrl: string,
  now: Date = new Date(),
): YahooSummaryFields {
  const errors: string[] = [];
  const safe = <T>(label: string, fn: () => T, fallback: T): T => {
    try {
      return fn();
    } catch (e) {
      errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
      return fallback;
    }
  };

  const regularPrice = safe(
    "regularPrice",
    () => finStreamerValue(html, "regularMarketPrice", ticker) ?? extractRangeValue(html, "regularMarketPrice"),
    null,
  );
  const fields: YahooSummaryFields = {
    ticker: ticker.toUpperCase(),
    companyName: safe("companyName", () => extractCompanyName(html, ticker), null),
    regularPrice,
    regularChangePercent: safe(
      "regularChangePercent",
      () => finStreamerValue(html, "regularMarketChangePercent", ticker),
      null,
    ),
    preMarketPrice: safe(
      "preMarketPrice",
      () => finStreamerValue(html, "preMarketPrice", ticker) ?? extractRangeValue(html, "preMarketPrice"),
      null,
    ),
    preMarketChangePercent: safe(
      "preMarketChangePercent",
      () => finStreamerValue(html, "preMarketChangePercent", ticker),
      null,
    ),
    afterHoursPrice: safe(
      "afterHoursPrice",
      () => finStreamerValue(html, "postMarketPrice", ticker) ?? extractRangeValue(html, "postMarketPrice"),
      null,
    ),
    afterHoursChangePercent: safe(
      "afterHoursChangePercent",
      () => finStreamerValue(html, "postMarketChangePercent", ticker),
      null,
    ),
    marketState: safe("marketState", () => detectMarketState(html), "UNKNOWN" as MarketState),
    fiftyTwoWeekHigh: safe("fiftyTwoWeekHigh", () => extractRangeValue(html, "fiftyTwoWeekHigh"), null),
    fiftyTwoWeekLow: safe("fiftyTwoWeekLow", () => extractRangeValue(html, "fiftyTwoWeekLow"), null),
    sourceUrl,
    capturedAt: now.toISOString(),
    extractionErrors: errors,
  };
  if (fields.regularPrice == null) {
    errors.push("regularMarketPrice not found — page layout may have changed.");
  }
  return fields;
}

// ---------------------------------------------------------------------------

type PlaywrightBrowser = import("playwright").Browser;

export class YahooFinanceBrowserService {
  private browser: PlaywrightBrowser | null = null;
  private launching: Promise<PlaywrightBrowser | null> | null = null;

  constructor(private enabled = process.env.YAHOO_BROWSER_ENABLED !== "false") {}

  private async getBrowser(): Promise<PlaywrightBrowser | null> {
    if (!this.enabled) return null;
    if (this.browser?.isConnected()) return this.browser;
    if (this.launching) return this.launching;
    this.launching = (async () => {
      try {
        const { chromium } = await import("playwright");
        this.browser = await chromium.launch({ headless: true });
        return this.browser;
      } catch (e) {
        console.error(
          "[yahoo-browser] Failed to launch Chromium. Run `npx playwright install chromium`.",
          e instanceof Error ? e.message : e,
        );
        return null;
      } finally {
        this.launching = null;
      }
    })();
    return this.launching;
  }

  async getQuotePage(ticker: string): Promise<{ html: string; url: string } | null> {
    const browser = await this.getBrowser();
    if (!browser) return null;
    const url = `https://finance.yahoo.com/quote/${encodeURIComponent(ticker)}/`;
    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
      viewport: { width: 1366, height: 900 },
    });
    try {
      const page = await context.newPage();
      // Block heavy resources for speed; HTML is all we parse.
      await page.route("**/*.{png,jpg,jpeg,gif,webp,woff,woff2,mp4}", (r) => r.abort());
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
      await page
        .waitForSelector('fin-streamer[data-field="regularMarketPrice"]', { timeout: 10000 })
        .catch(() => {
          /* parse whatever is there */
        });
      const html = await page.content();
      return { html, url };
    } catch (e) {
      console.error(`[yahoo-browser] ${ticker} extraction failed:`, e instanceof Error ? e.message : e);
      return null;
    } finally {
      await context.close().catch(() => {});
    }
  }

  async getSummaryFields(ticker: string): Promise<YahooSummaryFields | null> {
    const page = await this.getQuotePage(ticker);
    if (!page) return null;
    const fields = parseYahooQuoteHtml(page.html, ticker, page.url);
    for (const err of fields.extractionErrors) {
      console.warn(`[yahoo-browser] ${ticker}: ${err}`);
    }
    return fields;
  }

  async getRegularPrice(ticker: string): Promise<number | null> {
    return (await this.getSummaryFields(ticker))?.regularPrice ?? null;
  }
  async getPreMarketPrice(ticker: string): Promise<number | null> {
    return (await this.getSummaryFields(ticker))?.preMarketPrice ?? null;
  }
  async getAfterHoursPrice(ticker: string): Promise<number | null> {
    return (await this.getSummaryFields(ticker))?.afterHoursPrice ?? null;
  }
  async getDayChange(ticker: string): Promise<number | null> {
    return (await this.getSummaryFields(ticker))?.regularChangePercent ?? null;
  }
  async getMarketState(ticker: string): Promise<MarketState> {
    return (await this.getSummaryFields(ticker))?.marketState ?? "UNKNOWN";
  }

  toQuote(fields: YahooSummaryFields): Quote {
    return {
      ticker: fields.ticker,
      regularPrice: fields.regularPrice,
      preMarketPrice: fields.preMarketPrice,
      afterHoursPrice: fields.afterHoursPrice,
      dayChangePercent: fields.regularChangePercent,
      marketState: fields.marketState,
      source: "yahoo-browser",
      sourceUrl: fields.sourceUrl,
      capturedAt: fields.capturedAt,
    };
  }

  async close(): Promise<void> {
    await this.browser?.close().catch(() => {});
    this.browser = null;
  }
}

let _singleton: YahooFinanceBrowserService | null = null;
export function getYahooService(): YahooFinanceBrowserService {
  if (!_singleton) _singleton = new YahooFinanceBrowserService();
  return _singleton;
}
