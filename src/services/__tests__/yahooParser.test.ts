import { describe, expect, it } from "vitest";
import { parseYahooQuoteHtml, parseYahooEarnings } from "../yahooFinanceBrowser";

const URL = "https://finance.yahoo.com/quote/AAPL/";

const FULL_HTML = `
<html><head><title>Apple Inc. (AAPL) Stock Price, News &amp; Quote</title></head>
<body>
<h1>Apple Inc. (AAPL)</h1>
<fin-streamer data-symbol="AAPL" data-field="regularMarketPrice" data-value="201.45">201.45</fin-streamer>
<fin-streamer data-symbol="AAPL" data-field="regularMarketChangePercent" data-value="-1.23">-1.23%</fin-streamer>
<fin-streamer data-symbol="AAPL" data-field="postMarketPrice" data-value="202.10">202.10</fin-streamer>
<fin-streamer data-symbol="AAPL" data-field="postMarketChangePercent" data-value="0.32">+0.32%</fin-streamer>
<script>{"marketState":"POST","fiftyTwoWeekHigh":{"raw":237.23,"fmt":"237.23"},"fiftyTwoWeekLow":{"raw":164.08,"fmt":"164.08"}}</script>
</body></html>`;

const PRE_MARKET_HTML = `
<html><head><title>NVIDIA Corporation (NVDA) Stock Price</title></head><body>
<fin-streamer data-field="regularMarketPrice" data-symbol="NVDA" data-value="120.00">120.00</fin-streamer>
<fin-streamer data-field="preMarketPrice" data-symbol="NVDA" data-value="118.55">118.55</fin-streamer>
<script>{"marketState":"PRE"}</script>
</body></html>`;

describe("parseYahooQuoteHtml", () => {
  it("extracts regular + after-hours prices and market state", () => {
    const f = parseYahooQuoteHtml(FULL_HTML, "AAPL", URL);
    expect(f.regularPrice).toBe(201.45);
    expect(f.regularChangePercent).toBe(-1.23);
    expect(f.afterHoursPrice).toBe(202.1);
    expect(f.afterHoursChangePercent).toBe(0.32);
    expect(f.marketState).toBe("POST");
    expect(f.preMarketPrice).toBeNull();
  });

  it("extracts pre-market price regardless of attribute order", () => {
    const f = parseYahooQuoteHtml(PRE_MARKET_HTML, "NVDA", URL);
    expect(f.regularPrice).toBe(120);
    expect(f.preMarketPrice).toBe(118.55);
    expect(f.marketState).toBe("PRE");
  });

  it("extracts company name and 52-week range from embedded JSON", () => {
    const f = parseYahooQuoteHtml(FULL_HTML, "AAPL", URL);
    expect(f.companyName).toBe("Apple Inc.");
    expect(f.fiftyTwoWeekHigh).toBe(237.23);
    expect(f.fiftyTwoWeekLow).toBe(164.08);
  });

  it("ignores fin-streamers for other symbols", () => {
    const html = `
      <fin-streamer data-symbol="SPY" data-field="regularMarketPrice" data-value="500">500</fin-streamer>
      <fin-streamer data-symbol="AAPL" data-field="regularMarketPrice" data-value="201">201</fin-streamer>`;
    const f = parseYahooQuoteHtml(html, "AAPL", URL);
    expect(f.regularPrice).toBe(201);
  });

  it("returns partial data with errors instead of crashing on junk HTML", () => {
    const f = parseYahooQuoteHtml("<html><body>captcha wall</body></html>", "AAPL", URL);
    expect(f.regularPrice).toBeNull();
    expect(f.preMarketPrice).toBeNull();
    expect(f.marketState).toBe("UNKNOWN");
    expect(f.extractionErrors.length).toBeGreaterThan(0);
    expect(f.sourceUrl).toBe(URL);
    expect(f.capturedAt).toBeTruthy();
  });

  it("falls back to inner text when data-value is missing", () => {
    const html = `<fin-streamer data-symbol="AAPL" data-field="regularMarketPrice">1,234.56</fin-streamer>`;
    const f = parseYahooQuoteHtml(html, "AAPL", URL);
    expect(f.regularPrice).toBe(1234.56);
  });

  it("records source URL and timestamp on every result", () => {
    const now = new Date("2026-06-12T08:00:00Z");
    const f = parseYahooQuoteHtml(FULL_HTML, "AAPL", URL, now);
    expect(f.capturedAt).toBe("2026-06-12T08:00:00.000Z");
  });
});

// Real shape captured from Yahoo's quoteSummary?modules=earningsHistory endpoint.
const EARNINGS_JSON = {
  quoteSummary: {
    result: [
      {
        earningsHistory: {
          history: [
            {
              epsActual: { raw: 2.84 },
              epsEstimate: { raw: 2.6708 },
              surprisePercent: { raw: 0.0634 },
              quarter: { raw: 1767139200, fmt: "2025-12-31" },
              period: "-2q",
            },
            {
              epsActual: { raw: 2.01 },
              epsEstimate: { raw: 1.94275 },
              surprisePercent: { raw: 0.0346 },
              quarter: { raw: 1774915200, fmt: "2026-03-31" },
              period: "-1q",
            },
          ],
        },
      },
    ],
    error: null,
  },
};

describe("parseYahooEarnings", () => {
  it("maps quoteSummary earningsHistory to per-quarter estimate/actual", () => {
    const rows = parseYahooEarnings(EARNINGS_JSON);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({
      quarterEnd: "2026-03-31",
      fiscalPeriod: "Q1 2026",
      epsEstimate: 1.94275,
      epsActual: 2.01,
    });
    // Report date is the quarter end nudged ~1 month forward (typical reporting lag).
    expect(rows[1].reportDate > rows[1].quarterEnd).toBe(true);
    expect(rows[0].fiscalPeriod).toBe("Q4 2025");
  });

  it("returns [] for malformed / empty payloads", () => {
    expect(parseYahooEarnings(null)).toEqual([]);
    expect(parseYahooEarnings({})).toEqual([]);
    expect(parseYahooEarnings({ quoteSummary: { result: [] } })).toEqual([]);
  });
});

describe("parseYahooQuoteHtml — sidebar widget / wrong-symbol guard", () => {
  // Real Yahoo pages render a "trending tickers" widget (other symbols) before
  // the main quote, so the price must be taken from THIS ticker's element only.
  const WIDGET_HTML = `<html><head><title>Apple Inc. (AAPL)</title></head><body>
    <fin-streamer data-symbol="ON" data-field="regularMarketPrice" value="91.02" active="true"></fin-streamer>
    <fin-streamer data-symbol="MRNA" data-field="regularMarketPrice" value="65.79" active="true"></fin-streamer>
    <fin-streamer key="price" class="last-price" data-symbol="AAPL" data-field="regularMarketPrice" data-value="281.44" active="">281.44</fin-streamer>
  </body></html>`;

  it("uses the page's own symbol, not a sidebar widget's price", () => {
    expect(parseYahooQuoteHtml(WIDGET_HTML, "AAPL", URL).regularPrice).toBe(281.44);
  });

  it("returns null (not a wrong symbol's price) when this ticker's element is absent", () => {
    const noAapl = `<html><body><fin-streamer data-symbol="ON" data-field="regularMarketPrice" value="91.02"></fin-streamer></body></html>`;
    expect(parseYahooQuoteHtml(noAapl, "AAPL", URL).regularPrice).toBeNull();
  });
});
