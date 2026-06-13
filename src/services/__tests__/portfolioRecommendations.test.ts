import { describe, expect, it } from "vitest";
import {
  selectRecommendations,
  type PortfolioRecommendation,
} from "../portfolioRecommendations";

const h = (
  ticker: string,
  marketValue: number | null = null,
  companyName: string | null = null,
): PortfolioRecommendation => ({
  ticker,
  companyName,
  currentPrice: null,
  unrealizedGainLossPercent: null,
  marketValue,
});

describe("selectRecommendations", () => {
  it("excludes holdings already on the watchlist (case-insensitive)", () => {
    const recs = selectRecommendations([h("AAPL"), h("MSFT")], ["aapl"], [], 10);
    expect(recs.map((r) => r.ticker)).toEqual(["MSFT"]);
  });

  it("excludes dismissed holdings (case-insensitive)", () => {
    const recs = selectRecommendations([h("AAPL"), h("MSFT")], [], ["MSFT"], 10);
    expect(recs.map((r) => r.ticker)).toEqual(["AAPL"]);
  });

  it("orders by market value descending, then ticker", () => {
    const recs = selectRecommendations(
      [h("AAPL", 100), h("MSFT", 500), h("NVDA", 500)],
      [],
      [],
      10,
    );
    expect(recs.map((r) => r.ticker)).toEqual(["MSFT", "NVDA", "AAPL"]);
  });

  it("caps the result at the limit", () => {
    const recs = selectRecommendations(
      [h("A", 4), h("B", 3), h("C", 2), h("D", 1)],
      [],
      [],
      3,
    );
    expect(recs.map((r) => r.ticker)).toEqual(["A", "B", "C"]);
  });

  it("returns nothing when the limit is 0", () => {
    expect(selectRecommendations([h("AAPL")], [], [], 0)).toEqual([]);
  });
});
