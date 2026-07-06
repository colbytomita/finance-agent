import { describe, expect, it } from "vitest";
import { barsFromChart, summaryFieldsFromQuoteSummary } from "../yahooHttp";

// Pure mappers over Yahoo's JSON endpoints (quoteSummary / v8 chart).

const quoteSummaryFixture = {
  quoteSummary: {
    result: [
      {
        price: {
          longName: "NVIDIA Corporation",
          shortName: "NVIDIA Corp",
          regularMarketPrice: { raw: 187.62, fmt: "187.62" },
          regularMarketChangePercent: { raw: 0.0123, fmt: "1.23%" },
          preMarketPrice: { raw: 188.1 },
          preMarketChangePercent: { raw: 0.0026 },
          marketState: "PRE",
        },
        summaryDetail: {
          fiftyTwoWeekHigh: { raw: 212.19 },
          fiftyTwoWeekLow: { raw: 86.62 },
        },
      },
    ],
    error: null,
  },
};

describe("summaryFieldsFromQuoteSummary", () => {
  it("maps price + summaryDetail into YahooSummaryFields", () => {
    const f = summaryFieldsFromQuoteSummary(quoteSummaryFixture, "nvda", new Date("2026-07-06T04:00:00Z"));
    expect(f).toMatchObject({
      ticker: "NVDA",
      companyName: "NVIDIA Corporation",
      regularPrice: 187.62,
      preMarketPrice: 188.1,
      afterHoursPrice: null,
      marketState: "PRE",
      fiftyTwoWeekHigh: 212.19,
      fiftyTwoWeekLow: 86.62,
      source: "yahoo",
      extractionErrors: [],
    });
    // Fractional change percents are scaled to percent points.
    expect(f?.regularChangePercent).toBeCloseTo(1.23);
  });

  it("returns null without a usable price", () => {
    expect(summaryFieldsFromQuoteSummary({}, "NVDA")).toBeNull();
    expect(
      summaryFieldsFromQuoteSummary(
        { quoteSummary: { result: [{ price: { marketState: "REGULAR" } }] } },
        "NVDA",
      ),
    ).toBeNull();
  });
});

describe("barsFromChart", () => {
  const chartFixture = {
    chart: {
      result: [
        {
          timestamp: [1751490000, 1751576400, 1751662800],
          indicators: {
            quote: [
              {
                open: [100, 102, null],
                high: [103, 104, null],
                low: [99, 101, null],
                close: [102, 103.5, null],
                volume: [1_000_000, 900_000, null],
              },
            ],
          },
        },
      ],
    },
  };

  it("maps timestamps/OHLCV into ascending bars, skipping null closes", () => {
    const bars = barsFromChart(chartFixture);
    expect(bars).toHaveLength(2);
    expect(bars[0]).toMatchObject({ open: 100, high: 103, low: 99, close: 102, volume: 1_000_000 });
    expect(bars[0].date).toMatch(/^2025-07-02T/);
    expect(bars[1].close).toBe(103.5);
  });

  it("returns [] on malformed payloads", () => {
    expect(barsFromChart({})).toEqual([]);
    expect(barsFromChart({ chart: { result: [{}] } })).toEqual([]);
    expect(barsFromChart(null)).toEqual([]);
  });
});
