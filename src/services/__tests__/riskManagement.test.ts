import { describe, expect, it } from "vitest";
import {
  concentrationWarnings,
  riskRewardRatio,
  suggestPositionSize,
  validateProposedTrade,
} from "../riskManagement";

describe("suggestPositionSize", () => {
  it("sizes by 1% risk default math", () => {
    // $10k account, 1% risk = $100 budget; $2 risk/share => 50 shares.
    const r = suggestPositionSize({
      accountValue: 10000,
      riskPerTradePercent: 1,
      entryPrice: 50,
      stopLoss: 48,
      maxPositionWeightPercent: 30, // high enough not to cap this case
    });
    expect(r.shares).toBe(50);
    expect(r.maxLossIfStopped).toBe(100);
    expect(r.positionValue).toBe(2500);
    expect(r.cappedByConcentration).toBe(false);
  });

  it("applies the default 20% concentration cap", () => {
    // Same trade with the default cap: 20% of $10k = $2k => 40 shares.
    const r = suggestPositionSize({
      accountValue: 10000,
      riskPerTradePercent: 1,
      entryPrice: 50,
      stopLoss: 48,
    });
    expect(r.shares).toBe(40);
    expect(r.cappedByConcentration).toBe(true);
  });

  it("caps by concentration limit", () => {
    // Uncapped would be 100 shares = $10k; cap at 20% = $2k => 20 shares.
    const r = suggestPositionSize({
      accountValue: 10000,
      riskPerTradePercent: 1,
      entryPrice: 100,
      stopLoss: 99,
      maxPositionWeightPercent: 20,
    });
    expect(r.shares).toBe(20);
    expect(r.cappedByConcentration).toBe(true);
  });

  it("refuses to size when stop equals entry", () => {
    const r = suggestPositionSize({
      accountValue: 10000,
      riskPerTradePercent: 1,
      entryPrice: 50,
      stopLoss: 50,
    });
    expect(r.shares).toBe(0);
    expect(r.warnings[0]).toMatch(/cannot size/i);
  });

  it("warns on very wide stops", () => {
    const r = suggestPositionSize({
      accountValue: 100000,
      riskPerTradePercent: 1,
      entryPrice: 100,
      stopLoss: 80,
    });
    expect(r.warnings.join(" ")).toMatch(/wide stop/i);
  });
});

describe("riskRewardRatio", () => {
  it("computes long R/R", () => {
    expect(riskRewardRatio(100, 95, 110)).toBeCloseTo(2);
  });
  it("computes short R/R", () => {
    expect(riskRewardRatio(100, 105, 90, "short")).toBeCloseTo(2);
  });
  it("returns null for a stop on the wrong side", () => {
    expect(riskRewardRatio(100, 105, 110)).toBeNull();
  });
  it("returns 0 when target is behind price", () => {
    expect(riskRewardRatio(100, 95, 99)).toBe(0);
  });
});

describe("validateProposedTrade", () => {
  it("blocks trades without stop or target", () => {
    const problems = validateProposedTrade({
      entry: 100,
      stop: null,
      target: null,
      minRiskReward: 2,
      avoidEarningsWithinDays: 3,
    });
    expect(problems.join(" ")).toMatch(/no clear stop-loss/i);
    expect(problems.join(" ")).toMatch(/no target/i);
  });

  it("blocks trades below minimum R/R", () => {
    const problems = validateProposedTrade({
      entry: 100,
      stop: 95,
      target: 105, // 1:1
      minRiskReward: 2,
      avoidEarningsWithinDays: 3,
    });
    expect(problems.join(" ")).toMatch(/below your 2:1 minimum/i);
  });

  it("blocks trades inside the earnings window", () => {
    const problems = validateProposedTrade({
      entry: 100,
      stop: 95,
      target: 115,
      minRiskReward: 2,
      daysToEarnings: 2,
      avoidEarningsWithinDays: 3,
    });
    expect(problems.join(" ")).toMatch(/earnings in 2/i);
  });

  it("passes a clean trade", () => {
    const problems = validateProposedTrade({
      entry: 100,
      stop: 95,
      target: 112,
      minRiskReward: 2,
      daysToEarnings: 20,
      avoidEarningsWithinDays: 3,
    });
    expect(problems).toHaveLength(0);
  });
});

describe("concentrationWarnings", () => {
  it("flags oversized positions and sectors", () => {
    const warnings = concentrationWarnings({
      positions: [
        { ticker: "NVDA", value: 30000, sector: "Tech" },
        { ticker: "MSFT", value: 15000, sector: "Tech" },
        { ticker: "XOM", value: 5000, sector: "Energy" },
      ],
      accountValue: 100000,
      maxPositionWeightPercent: 20,
      maxSectorWeightPercent: 35,
    });
    expect(warnings.join(" ")).toMatch(/NVDA is 30%/);
    expect(warnings.join(" ")).toMatch(/Tech sector is 45%/);
  });
});
