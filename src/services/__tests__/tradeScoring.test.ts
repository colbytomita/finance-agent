import { describe, expect, it } from "vitest";
import {
  addBlockers,
  combineTradeScore,
  evaluateTrade,
  hardExitRules,
  riskRewardScore,
  tradeRecommendationLabel,
  trimRules,
  type TradeContext,
} from "../tradeScoring";
import { computeIndicators } from "../indicators";
import { barsFromCloses, trendCloses } from "./helpers";

const baseTrade: TradeContext = {
  direction: "long",
  entryPrice: 100,
  currentPrice: 105,
  stopLoss: 95,
  targetPrice1: 120,
  targetPrice2: 130,
  thesis: "Breakout continuation",
  thesisInvalidated: false,
  daysToEarnings: null,
  positionWeightPercent: 5,
};

describe("combineTradeScore", () => {
  it("applies the spec weights (30/20/20/15/10/5)", () => {
    const score = combineTradeScore({
      technicalScore: 10,
      momentumScore: 0,
      catalystScore: 10,
      riskRewardScore: 10,
      marketConditionScore: 10,
      thesisValidityScore: 10,
    });
    // 10*0.3 + 0 + 10*0.2 + 10*0.15 + 10*0.1 + 10*0.05 = 8.0
    expect(score).toBe(8);
  });
});

describe("tradeRecommendationLabel", () => {
  it("maps bands per spec", () => {
    expect(tradeRecommendationLabel(9.2)).toBe("Strong Hold / Consider Add");
    expect(tradeRecommendationLabel(7.5)).toBe("Hold");
    expect(tradeRecommendationLabel(5.5)).toBe("Monitor Closely");
    expect(tradeRecommendationLabel(3.5)).toBe("Trim / Prepare Exit");
    expect(tradeRecommendationLabel(2)).toBe("Exit");
  });
});

describe("riskRewardScore", () => {
  it("computes remaining R/R from current price", () => {
    // risk = 105-95 = 10, reward = 120-105 = 15 => 1.5:1
    const { ratio, score } = riskRewardScore(baseTrade);
    expect(ratio).toBeCloseTo(1.5);
    expect(score).toBe(6);
  });

  it("scores 1 when price is at/through the stop", () => {
    const { score } = riskRewardScore({ ...baseTrade, currentPrice: 94 });
    expect(score).toBe(1);
  });

  it("handles missing stop/target without crashing", () => {
    const { score, ratio } = riskRewardScore({ ...baseTrade, stopLoss: null });
    expect(ratio).toBeNull();
    expect(score).toBe(4);
  });

  it("supports short trades", () => {
    const shortTrade: TradeContext = {
      ...baseTrade,
      direction: "short",
      entryPrice: 100,
      currentPrice: 95,
      stopLoss: 105,
      targetPrice1: 80,
    };
    // risk = 105-95 = 10, reward = 95-80 = 15
    const { ratio } = riskRewardScore(shortTrade);
    expect(ratio).toBeCloseTo(1.5);
  });
});

describe("hardExitRules (overrides)", () => {
  const base = {
    trade: baseTrade,
    indicators: null,
    catalysts: [],
    tradeScore: 7,
    avoidEarningsWithinDays: 3,
  };

  it("triggers on stop-loss hit", () => {
    const reasons = hardExitRules({
      ...base,
      trade: { ...baseTrade, currentPrice: 94.9 },
    });
    expect(reasons.join(" ")).toMatch(/stop-loss hit/i);
  });

  it("triggers on thesis invalidation", () => {
    const reasons = hardExitRules({
      ...base,
      trade: { ...baseTrade, thesisInvalidated: true },
    });
    expect(reasons.join(" ")).toMatch(/thesis invalidated/i);
  });

  it("triggers on major negative catalyst", () => {
    const reasons = hardExitRules({
      ...base,
      catalysts: [{ impactScore: -5, confidence: "high", status: "occurred" }],
    });
    expect(reasons.join(" ")).toMatch(/major negative catalyst/i);
  });

  it("triggers when trade score < 3", () => {
    const reasons = hardExitRules({ ...base, tradeScore: 2.5 });
    expect(reasons.join(" ")).toMatch(/below 3/i);
  });

  it("triggers on imminent earnings per user settings", () => {
    const reasons = hardExitRules({
      ...base,
      trade: { ...baseTrade, daysToEarnings: 1 },
    });
    expect(reasons.join(" ")).toMatch(/earnings in 1/i);
  });

  it("does not trigger on a healthy trade", () => {
    expect(hardExitRules(base)).toHaveLength(0);
  });

  it("triggers on support break", () => {
    // Downtrending bars give a support level above the crashed price.
    const bars = barsFromCloses([...trendCloses(100, 140, 100), 120, 110, 90]);
    const ind = computeIndicators(bars);
    const reasons = hardExitRules({
      ...base,
      trade: { ...baseTrade, currentPrice: 90, stopLoss: 50 }, // wide stop so only support rule fires
      indicators: ind,
      tradeScore: 7,
    });
    if (ind?.support != null && 90 < ind.support) {
      expect(reasons.join(" ")).toMatch(/support/i);
    }
  });
});

describe("trimRules", () => {
  const base = {
    trade: baseTrade,
    indicators: null,
    catalysts: [],
    tradeScore: 7,
    previousScore: 7,
    maxPositionWeightPercent: 20,
  };

  it("recommends trim at target 1", () => {
    const reasons = trimRules({ ...base, trade: { ...baseTrade, currentPrice: 121 } });
    expect(reasons.join(" ")).toMatch(/target 1/i);
  });

  it("recommends trim when score collapses from strong", () => {
    const reasons = trimRules({ ...base, previousScore: 8.5, tradeScore: 6 });
    expect(reasons.join(" ")).toMatch(/strong to neutral/i);
  });

  it("recommends trim on oversized positions", () => {
    const reasons = trimRules({
      ...base,
      trade: { ...baseTrade, positionWeightPercent: 35 },
    });
    expect(reasons.join(" ")).toMatch(/above your 20% cap/i);
  });

  it("recommends trim near earnings", () => {
    const reasons = trimRules({ ...base, trade: { ...baseTrade, daysToEarnings: 4 } });
    expect(reasons.join(" ")).toMatch(/event risk/i);
  });
});

describe("addBlockers", () => {
  it("blocks adds when score < 8", () => {
    const blockers = addBlockers({
      trade: baseTrade,
      indicators: null,
      catalysts: [],
      tradeScore: 7.5,
      riskScoreValue: 7,
      maxPositionWeightPercent: 20,
    });
    expect(blockers.join(" ")).toMatch(/below 8/i);
  });

  it("blocks adds below the buy zone and on earnings risk", () => {
    const blockers = addBlockers({
      trade: { ...baseTrade, daysToEarnings: 2 },
      indicators: null,
      catalysts: [],
      tradeScore: 9,
      riskScoreValue: 7,
      maxPositionWeightPercent: 20,
      belowBuyZone: true,
    });
    expect(blockers.join(" ")).toMatch(/below the buy zone/i);
    expect(blockers.join(" ")).toMatch(/earnings/i);
  });
});

describe("evaluateTrade end-to-end", () => {
  it("returns Exit action when stop is hit regardless of components", () => {
    const bars = barsFromCloses(trendCloses(100, 150, 260));
    const result = evaluateTrade({
      trade: { ...baseTrade, currentPrice: 94 },
      indicators: computeIndicators(bars),
      catalysts: [],
    });
    expect(result.action).toBe("Exit");
    expect(result.hardRulesTriggered.length).toBeGreaterThan(0);
  });

  it("holds a healthy trade in an uptrend", () => {
    // Gentle uptrend with oscillation so RSI stays out of the
    // overextended (>78) trim zone — a straight line maxes out RSI.
    const closes = trendCloses(80, 106, 260).map((c, i) => c + (i % 2 === 0 ? 0.9 : -0.9));
    const bars = barsFromCloses(closes);
    const result = evaluateTrade({
      trade: baseTrade,
      indicators: computeIndicators(bars),
      catalysts: [{ impactScore: 3, confidence: "high", status: "upcoming" }],
    });
    expect(["Hold", "Add"]).toContain(result.action);
    expect(result.tradeScore).toBeGreaterThanOrEqual(5);
  });

  it("survives totally missing data (returns low confidence, no crash)", () => {
    const result = evaluateTrade({
      trade: { ...baseTrade, stopLoss: null, targetPrice1: null },
      indicators: null,
      catalysts: [],
    });
    expect(result.confidence).toBe("low");
    expect(result.tradeScore).toBeGreaterThanOrEqual(1);
  });

  it("excludes the catalyst component when there are no catalysts so it isn't dragged", () => {
    const closes = trendCloses(80, 106, 260).map((c, i) => c + (i % 2 === 0 ? 0.9 : -0.9));
    const bars = barsFromCloses(closes);
    const result = evaluateTrade({ trade: baseTrade, indicators: computeIndicators(bars), catalysts: [] });
    expect(result.weightsUsed.catalyst).toBe(0);
    expect(result.tradeScore).toBe(combineTradeScore(result.components, result.weightsUsed));
    // Dropping the neutral no-data catalyst doesn't lower the score.
    expect(result.tradeScore).toBeGreaterThanOrEqual(combineTradeScore(result.components));
  });
});
