import { describe, expect, it } from "vitest";
import {
  canUpdateLiveScoreRow,
  catalystScore,
  combineStockScore,
  DEFAULT_STOCK_WEIGHTS,
  directionalCatalysts,
  MATERIAL_SCORE_DELTA,
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
  it("applies the spec weights (20/20/35/25/0)", () => {
    const score = combineStockScore({
      valuationScore: 10,
      momentumScore: 0, // out-of-range input is fine for the math check
      catalystScore: 10,
      riskScore: 10,
      sentimentScore: 10,
    });
    // sentiment carries 0 weight since roadmap #67 folded it into catalyst:
    // 10*0.2 + 0*0.2 + 10*0.35 + 10*0.25 + 10*0 = 8.0
    expect(score).toBe(8);
  });

  it("gives sentiment no weight — it is displayed, not blended", () => {
    // sentimentScore is derived from the SAME catalyst inputs as catalystScore,
    // so it was ~collinear with it while contributing 0.19 points at weight 0.10.
    // #67 folded its weight into catalyst; it is still computed for display.
    const base = { valuationScore: 6, momentumScore: 6, catalystScore: 6, riskScore: 6 };
    expect(combineStockScore({ ...base, sentimentScore: 1 })).toBe(
      combineStockScore({ ...base, sentimentScore: 10 }),
    );
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

  // riskScore used to start at 7 and only ever subtract, so a genuinely calm,
  // structurally sound stock could never score above 7.5. Combined with
  // valuationScore's hard 7 ceiling that made the 9-10 "Strong Buy Candidate"
  // band arithmetically unreachable — it never fired once in two months.
  it("rewards a genuinely low-risk stock, not just penalizing risky ones", () => {
    const bars = barsFromCloses(trendCloses(100, 104, 100));
    const calm = computeIndicators(bars);
    const dd = computeDrawdown(bars, 104); // sitting at its high
    expect(riskScore(calm, { ...dd!, trend: "improving" }).score).toBeGreaterThan(7.5);
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

describe("scoreStock — the top recommendation band is reachable", () => {
  // Regression guard for a structural bug: with riskScore capped at 7.5 and
  // valuationScore capped at 7.0, the weighted blend could not exceed ~7.8, so
  // "Strong Buy Candidate" (>= 9) was arithmetically impossible. Across 1,967
  // real scored events the band never fired once. An excellent stock on every
  // measured axis must be able to reach it.
  // The band is reachable iff the blend of each component's ATTAINABLE maximum
  // clears 9. Before the fix riskScore capped at 7.5 and valuationScore at 7.0,
  // so this sum could not exceed ~7.8 no matter what the market did.
  it("blending each component's attainable maximum clears the 9.0 threshold", () => {
    const attainableMax = {
      valuationScore: 8.5, // discounted and recovering
      momentumScore: 9.5, // every trend signal aligned (seen in real data)
      catalystScore: 10, // strongly positive, high-confidence catalysts
      riskScore: 9.5, // very low ATR%, intact structure, improving
      sentimentScore: 8.5, // uniformly positive tone
    };
    expect(combineStockScore(attainableMax)).toBeGreaterThanOrEqual(9);
    expect(stockRecommendationLabel(combineStockScore(attainableMax))).toBe("Strong Buy Candidate");
  });

  it("an excellent stock on every axis scores near the top of the range", () => {
    // Tight daily ranges => genuinely low ATR%, the way a mega-cap actually trades.
    const closes = trendCloses(100, 160, 260);
    const bars = closes.map((c, i) => ({
      date: new Date(Date.UTC(2025, 0, 1) + i * 86400000).toISOString().slice(0, 10),
      open: c * 0.999,
      high: c * 1.004,
      low: c * 0.997,
      close: c,
      volume: 1_000_000,
    }));
    const ind = computeIndicators(bars);
    const dd = computeDrawdown(bars, 120); // ~25% off the high — the value sweet spot
    const result = scoreStock({
      indicators: ind,
      drawdown: { ...dd!, trend: "improving" },
      catalysts: [
        { impactScore: 5, confidence: "high", status: "upcoming" },
        { impactScore: 4, confidence: "high", status: "occurred" },
      ],
    });
    // Was 8.0 before the two-sided rebalance, and could never have exceeded ~8.1.
    expect(result.overallScore).toBeGreaterThan(8.5);
    expect(result.components.riskScore).toBeGreaterThan(7.5); // old hard ceiling
    expect(result.components.valuationScore).toBeGreaterThan(7); // old hard ceiling
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

describe("directionalCatalysts (roadmap #67)", () => {
  const c = (impactScore: number, status = "occurred") => ({
    impactScore,
    confidence: "low" as const,
    status,
  });

  it("drops impact-0 items — they carry no direction", () => {
    // 74% of stored catalysts are neutral yahoo-news. Averaging a few real
    // signals across hundreds of them crushed the component: NVDA's mean over
    // everything was 0.31 vs 1.09 over directional items only.
    expect(directionalCatalysts([c(0), c(2), c(0), c(-3)])).toHaveLength(2);
  });

  it("keeps only the most recent N so a stale backlog can't dominate", () => {
    const many = Array.from({ length: 50 }, () => c(1));
    expect(directionalCatalysts(many, 30)).toHaveLength(30);
  });

  it("keeps the LATEST items, not the earliest", () => {
    const cs = [c(-4), ...Array.from({ length: 30 }, () => c(1))];
    // The stale -4 at the front must fall out of a 30-item window.
    expect(directionalCatalysts(cs, 30).every((x) => x.impactScore === 1)).toBe(true);
  });

  it("returns nothing when every catalyst is neutral", () => {
    // Consequence that matters: such a ticker is then treated as having NO
    // catalysts, so catalyst weight is redistributed rather than dragging the
    // score to a false neutral.
    expect(directionalCatalysts([c(0), c(0), c(0)])).toEqual([]);
  });
});

describe("valuationScore + sentimentScore", () => {
  it("treats moderate drawdowns as better value than near-highs", () => {
    const bars = barsFromCloses(trendCloses(100, 200, 260));
    const nearHigh = valuationScore(computeDrawdown(bars, 199));
    const dipped = valuationScore(computeDrawdown(bars, 160)); // ~20% off high
    expect(dipped.score).toBeGreaterThan(nearHigh.score);
  });

  it("rates a discounted-but-recovering stock above its old 7.0 ceiling", () => {
    const bars = barsFromCloses(trendCloses(100, 200, 260));
    const dipped = computeDrawdown(bars, 150); // ~25% off the high
    // A recovering discount is the value sweet spot; the old lookup capped at 7.
    expect(valuationScore({ ...dipped, trend: "improving" }).score).toBeGreaterThan(7);
  });

  it("sentiment follows catalyst tone", () => {
    const pos = sentimentScore([{ impactScore: 4, confidence: "high", status: "occurred" }]);
    const neg = sentimentScore([{ impactScore: -4, confidence: "high", status: "occurred" }]);
    expect(pos.score).toBeGreaterThan(neg.score);
  });
});

describe("canUpdateLiveScoreRow (roadmap #61)", () => {
  const prev = (overallScore: number, calculatedAt: string) => ({ overallScore, calculatedAt });

  it("reuses the row when the same day's score has not moved materially", () => {
    expect(
      canUpdateLiveScoreRow(prev(6.4, "2026-08-06T14:02:00.000Z"), 6.4, "2026-08-06T14:04:00.000Z"),
    ).toBe(true);
  });

  it("reuses the row for a sub-threshold drift", () => {
    const drifted = 6.4 + MATERIAL_SCORE_DELTA / 2;
    expect(
      canUpdateLiveScoreRow(prev(6.4, "2026-08-06T14:02:00.000Z"), drifted, "2026-08-06T14:04:00.000Z"),
    ).toBe(true);
  });

  it("appends a new row once the move reaches the material threshold", () => {
    const moved = 6.4 + MATERIAL_SCORE_DELTA;
    expect(
      canUpdateLiveScoreRow(prev(6.4, "2026-08-06T14:02:00.000Z"), moved, "2026-08-06T14:04:00.000Z"),
    ).toBe(false);
    // ...in either direction.
    expect(
      canUpdateLiveScoreRow(prev(6.4, "2026-08-06T14:02:00.000Z"), 6.4 - MATERIAL_SCORE_DELTA, "2026-08-06T14:04:00.000Z"),
    ).toBe(false);
  });

  it("appends a new row when the UTC day rolls over, however small the move", () => {
    expect(
      canUpdateLiveScoreRow(prev(6.4, "2026-08-05T23:58:00.000Z"), 6.4, "2026-08-06T00:00:00.000Z"),
    ).toBe(false);
  });
});
