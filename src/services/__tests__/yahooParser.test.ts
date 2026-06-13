import { describe, expect, it } from "vitest";
import { parseYahooQuoteHtml } from "../yahooFinanceBrowser";

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
