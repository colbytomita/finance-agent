import { describe, expect, it } from "vitest";
import {
  fundamentalsFromQuoteSummary,
  fundamentalsScore,
  fundamentalsSummary,
  type Fundamentals,
} from "../fundamentals";

// Pure mapper + scoring over Yahoo's quoteSummary financial modules.

const strong = {
  quoteSummary: {
    result: [
      {
        financialData: {
          currentPrice: { raw: 200 },
          targetMeanPrice: { raw: 240 },
          recommendationKey: "buy",
          numberOfAnalystOpinions: { raw: 30 },
          returnOnEquity: { raw: 0.31 },
          grossMargins: { raw: 0.56 },
          profitMargins: { raw: 0.24 },
          revenueGrowth: { raw: 0.16 },
          earningsGrowth: { raw: 0.22 },
          debtToEquity: { raw: 40 },
        },
        defaultKeyStatistics: { forwardPE: { raw: 22 }, pegRatio: { raw: 1.4 }, priceToBook: { raw: 12 } },
        summaryDetail: { trailingPE: { raw: 28 }, forwardPE: { raw: 22 } },
        assetProfile: { sector: "Financial Services", industry: "Credit Services" },
      },
    ],
  },
};

describe("fundamentalsFromQuoteSummary", () => {
  it("maps growth, profitability, valuation, analyst, and profile", () => {
    const f = fundamentalsFromQuoteSummary(strong, "ma");
    expect(f).toMatchObject({
      ticker: "MA",
      revenueGrowth: 0.16,
      earningsGrowth: 0.22,
      profitMargins: 0.24,
      returnOnEquity: 0.31,
      forwardPE: 22,
      pegRatio: 1.4,
      recommendationKey: "buy",
      targetMeanPrice: 240,
      currentPrice: 200,
      sector: "Financial Services",
    });
  });

  it("returns null when there's no substantive data", () => {
    expect(fundamentalsFromQuoteSummary({}, "X")).toBeNull();
    expect(
      fundamentalsFromQuoteSummary({ quoteSummary: { result: [{ assetProfile: { sector: "Tech" } }] } }, "X"),
    ).toBeNull();
    expect(fundamentalsFromQuoteSummary(null, "X")).toBeNull();
  });

  it("treats a 'none' recommendationKey as absent", () => {
    const f = fundamentalsFromQuoteSummary(
      { quoteSummary: { result: [{ financialData: { recommendationKey: "none", revenueGrowth: { raw: 0.05 } } }] } },
      "X",
    );
    expect(f?.recommendationKey).toBeNull();
    expect(f?.revenueGrowth).toBe(0.05);
  });
});

describe("fundamentalsScore", () => {
  it("rates a high-quality, reasonably-valued grower well above neutral", () => {
    const f = fundamentalsFromQuoteSummary(strong, "MA")!;
    const s = fundamentalsScore(f);
    expect(s.score).toBeGreaterThanOrEqual(7);
    expect(s.reasons.join(" ")).toMatch(/Revenue|margin|P\/E|consensus/i);
  });

  it("scores a shrinking, unprofitable, expensive name low", () => {
    const weak: Fundamentals = {
      ticker: "BAD",
      revenueGrowth: -0.15,
      earningsGrowth: -0.4,
      grossMargins: 0.2,
      operatingMargins: -0.1,
      profitMargins: -0.08,
      returnOnEquity: -0.2,
      trailingPE: null,
      forwardPE: 80,
      pegRatio: 6,
      priceToBook: 20,
      debtToEquity: 300,
      freeCashflow: null,
      recommendationKey: "underperform",
      numberOfAnalystOpinions: 12,
      targetMeanPrice: 40,
      currentPrice: 50,
      sector: "Tech",
      industry: "Software",
    };
    expect(fundamentalsScore(weak).score).toBeLessThanOrEqual(4);
  });

  it("returns a neutral 5 with an explicit reason when there's no data", () => {
    const s = fundamentalsScore(null);
    expect(s.score).toBe(5);
    expect(s.reasons[0]).toMatch(/no fundamental data/i);
  });
});

describe("fundamentalsSummary", () => {
  it("produces a compact fact line", () => {
    const line = fundamentalsSummary(fundamentalsFromQuoteSummary(strong, "MA"));
    expect(line).toMatch(/revenue 16% YoY/);
    expect(line).toMatch(/net margin 24%/);
    expect(line).toMatch(/analysts buy/);
  });
});
