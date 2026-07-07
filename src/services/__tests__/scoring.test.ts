import { describe, expect, it } from "vitest";
import {
  catalystScore,
  combineStockScore,
  DEFAULT_STOCK_WEIGHTS,
  momentumScore,
  riskScore,
  scoreStock,
  sentimentScore,
  stockRecommendationLabel,
  valuationScore,
} from "../scoring";
import { computeIndicators } from "../indicators";
import { computeDrawdown } from "../buyZone";
import { barsFromCloses, trendCloses } from "./helpers";

describe("combineStockScore", () => {
  it("applies the spec weights (20/20/25/25/10)", () => {
    const score = combineStockScore({
      valuationScore: 10,
      momentumScore: 0, // out-of-range input is fine for the math check
      catalystScore: 10,
      riskScore: 10,
      sentimentScore: 10,
    });
    // 10*0.2 + 0*0.2 + 10*0.25 + 10*0.25 + 10*0.1 = 8.0
    expect(score).toBe(8);
  });

  it("returns a perfect 10 only when all components are 10", () => {
    const all10 = {
      valuationScore: 10,
      momentumScore: 10,
      catalystScore: 10,
      riskScore: 10,
      sentimentScore: 10,
    };
    expect(combineStockScore(all10)).toBe(10);
  });

  it("clamps to the 1-10 range", () => {
    const all0 = {
      valuationScore: 0,
      momentumScore: 0,
      catalystScore: 0,
      riskScore: 0,
      sentimentScore: 0,
    };
    expect(combineStockScore(all0)).toBe(1);
  });
});

describe("stockRecommendationLabel", () => {
  it("maps score bands per spec", () => {
    expect(stockRecommendationLabel(9.5)).toBe("Strong Buy Candidate");
    expect(stockRecommendationLabel(9)).toBe("Strong Buy Candidate");
    expect(stockRecommendationLabel(7.2)).toBe("Buy Candidate");
    expect(stockRecommendationLabel(5)).toBe("Watch / Hold");
    expect(stockRecommendationLabel(3.4)).toBe("Avoid / Risk Elevated");
    expect(stockRecommendationLabel(1.5)).toBe("Strong Avoid");
  });
});

describe("momentumScore", () => {
  it("scores an uptrend above neutral", () => {
    const ind = computeIndicators(barsFromCloses(trendCloses(100, 200, 260)));
    const { score } = momentumScore(ind);
    expect(score).toBeGreaterThan(6);
  });

  it("scores a downtrend below neutral", () => {
    const ind = computeIndicators(barsFromCloses(trendCloses(200, 100, 260)));
    const { score } = momentumScore(ind);
    expect(score).toBeLessThan(5);
  });

  it("is neutral with no data and says so", () => {
    const result = momentumScore(null);
    expect(result.score).toBe(5.5);
    expect(result.reasons[0]).toMatch(/no price history/i);
  });
});

describe("catalystScore", () => {
  it("is neutral with no catalysts", () => {
    expect(catalystScore([]).score).toBe(5);
  });

  it("rewards positive catalysts and weights confidence", () => {
    const high = catalystScore([{ impactScore: 4, confidence: "high", status: "upcoming" }]);
    const low = catalystScore([{ impactScore: 4, confidence: "low", status: "upcoming" }]);
    expect(high.score).toBeGreaterThan(7);
    expect(high.score).toBe(low.score); // single catalyst: weight cancels in the average
  });

  it("blends mixed catalysts by confidence", () => {
    const mixed = catalystScore([
      { impactScore: 4, confidence: "high", status: "upcoming" },
      { impactScore: -4, confidence: "low", status: "upcoming" },
    ]);
    expect(mixed.score).toBeGreaterThan(5.5); // high-confidence positive dominates
  });

  it("ignores expired catalysts", () => {
    const result = catalystScore([{ impactScore: -5, confidence: "high", status: "expired" }]);
    expect(result.score).toBe(5);
  });
});

describe("riskScore (10 = low risk)", () => {
  it("penalizes high volatility", () => {
    // Wild swings = high ATR relative to price.
    const closes = Array.from({ length: 100 }, (_, i) => 100 + (i % 2 === 0 ? 12 : -12));
    const bars = barsFromCloses(closes);
    const calm = computeIndicators(barsFromCloses(trendCloses(100, 104, 100)));
    const wild = computeIndicators(bars);
    const calmScore = riskScore(calm, null).score;
    const wildScore = riskScore(wild, null).score;
    expect(wildScore).toBeLessThan(calmScore);
  });

  it("penalizes strong negative pending catalysts", () => {
    const base = riskScore(null, null, []).score;
    const withNeg = riskScore(null, null, [
      { impactScore: -4, confidence: "high", status: "upcoming" },
    ]).score;
    expect(withNeg).toBeLessThan(base);
  });
});

describe("scoreStock end-to-end", () => {
  it("produces a full result with reasoning and confidence reflecting data completeness", () => {
    const bars = barsFromCloses(trendCloses(100, 150, 260));
    const ind = computeIndicators(bars);
    const dd = computeDrawdown(bars, 150);
    const result = scoreStock({
      indicators: ind,
      drawdown: dd,
      catalysts: [{ impactScore: 3, confidence: "high", status: "upcoming" }],
    });
    expect(result.overallScore).toBeGreaterThanOrEqual(1);
    expect(result.overallScore).toBeLessThanOrEqual(10);
    expect(result.confidence).toBe("high");
    expect(Object.keys(result.reasoning)).toEqual(
      expect.arrayContaining(["momentum", "valuation", "catalyst", "risk", "sentiment"]),
    );
  });

  it("degrades to low confidence with missing data instead of crashing", () => {
    const result = scoreStock({ indicators: null, drawdown: null, catalysts: [] });
    expect(result.confidence).toBe("low");
    expect(result.overallScore).toBeGreaterThanOrEqual(1);
  });
});

describe("scoreStock — missing catalysts don't drag the score", () => {
  // Strong uptrend, modest discount: good momentum/valuation/risk, no catalysts.
  const bars = barsFromCloses(trendCloses(100, 150, 260));
  const ind = computeIndicators(bars);
  const dd = computeDrawdown(bars, 130); // ~14% off the high

  it("excludes catalyst & sentiment from the blend when there are none", () => {
    const r = scoreStock({ indicators: ind, drawdown: dd, catalysts: [] });
    expect(r.weightsUsed.catalyst).toBe(0);
    expect(r.weightsUsed.sentiment).toBe(0);
    // The overall score is the blend over the weights actually used.
    expect(r.overallScore).toBe(combineStockScore(r.components, r.weightsUsed));
    expect(r.reasoning.catalyst[0]).toMatch(/excluded/i);
  });

  it("scores higher than the old behavior that averaged in the neutral catalyst/sentiment", () => {
    const r = scoreStock({ indicators: ind, drawdown: dd, catalysts: [] });
    const draggedBlend = combineStockScore(r.components); // full weights incl. neutral 5 / 5.5
    expect(r.overallScore).toBeGreaterThan(draggedBlend);
  });

  it("keeps full catalyst & sentiment weight when catalysts are present", () => {
    const r = scoreStock({
      indicators: ind,
      drawdown: dd,
      catalysts: [{ impactScore: 3, confidence: "high", status: "upcoming" }],
    });
    expect(r.weightsUsed.catalyst).toBe(DEFAULT_STOCK_WEIGHTS.catalyst);
    expect(r.weightsUsed.sentiment).toBe(DEFAULT_STOCK_WEIGHTS.sentiment);
    expect(r.overallScore).toBe(combineStockScore(r.components, DEFAULT_STOCK_WEIGHTS));
  });
});

describe("scoreStock — earnings surprise nudge (monotonic, bounded)", () => {
  const bars = barsFromCloses(trendCloses(100, 150, 260));
  const ind = computeIndicators(bars);
  const dd = computeDrawdown(bars, 130);
  const at = (impact: number | null) =>
    scoreStock({
      indicators: ind,
      drawdown: dd,
      catalysts: [],
      earnings: impact == null ? null : { impact, reason: "Q earnings" },
    }).overallScore;
  const base = at(null);

  it("a beat only ever helps and a miss only ever hurts", () => {
    expect(at(3)).toBeGreaterThan(base);
    expect(at(-3)).toBeLessThan(base);
    expect(at(0)).toBe(base); // in-line / no signal leaves the score unchanged
  });

  it("is monotonic with surprise size and capped", () => {
    expect(at(5)).toBeGreaterThanOrEqual(at(1));
    expect(at(5) - base).toBeLessThanOrEqual(1.2 + 1e-9); // nudge is bounded
    expect(base - at(-5)).toBeLessThanOrEqual(1.2 + 1e-9);
  });

  it("explains the nudge in the reasoning", () => {
    const r = scoreStock({
      indicators: ind,
      drawdown: dd,
      catalysts: [],
      earnings: { impact: 4, reason: "Q2 2026 earnings beat estimates (+20%)" },
    });
    expect(r.reasoning.earnings?.[0]).toMatch(/beat estimates/);
  });
});

describe("scoreStock — fundamentals lead the score when supplied", () => {
  // A strong, healthy uptrend chart.
  const bars = barsFromCloses(trendCloses(100, 200, 260));
  const ind = computeIndicators(bars);
  const dd = computeDrawdown(bars, 198);
  const score = (fund: number | null) =>
    scoreStock({
      indicators: ind,
      drawdown: dd,
      catalysts: [],
      fundamentals: fund == null ? null : { score: fund, reasons: [`Fundamentals ${fund}.`] },
    }).overallScore;

  it("weak fundamentals veto a strong chart; strong fundamentals make it a buy", () => {
    const weak = score(2.5);
    const strong = score(9);
    expect(strong).toBeGreaterThanOrEqual(7); // strong fundamentals → buy candidate
    expect(weak).toBeLessThan(7); // same chart, weak fundamentals → not a buy
    expect(weak).toBeLessThan(strong);
    expect(weak).toBeLessThan(score(null)); // and below the technical-only read
  });

  it("strong fundamentals lift the score above the technical-only read", () => {
    expect(score(9)).toBeGreaterThan(score(null));
    expect(score(9)).toBeGreaterThan(score(5));
  });

  it("surfaces fundamentals in the reasoning and confidence", () => {
    const r = scoreStock({
      indicators: ind,
      drawdown: dd,
      catalysts: [],
      fundamentals: { score: 8, reasons: ["Revenue +16% YoY."] },
    });
    expect(r.reasoning.fundamentals?.join(" ")).toMatch(/leads the score/i);
    expect(r.reasoning.fundamentals?.join(" ")).toMatch(/Revenue \+16%/);
  });
});

describe("valuationScore + sentimentScore", () => {
  it("treats moderate drawdowns as better value than near-highs", () => {
    const bars = barsFromCloses(trendCloses(100, 200, 260));
    const nearHigh = valuationScore(computeDrawdown(bars, 199));
    const dipped = valuationScore(computeDrawdown(bars, 160)); // ~20% off high
    expect(dipped.score).toBeGreaterThan(nearHigh.score);
  });

  it("sentiment follows catalyst tone", () => {
    const pos = sentimentScore([{ impactScore: 4, confidence: "high", status: "occurred" }]);
    const neg = sentimentScore([{ impactScore: -4, confidence: "high", status: "occurred" }]);
    expect(pos.score).toBeGreaterThan(neg.score);
  });
});
