import { describe, expect, it } from "vitest";
import { computeDrawdown, evaluateBuyZone } from "../buyZone";
import { barsFromCloses, trendCloses } from "./helpers";

const cfg = {
  targetBuyLow: 100,
  targetBuyHigh: 110,
  reinvestAbovePrice: 130,
  maxRiskPrice: 90,
};

describe("evaluateBuyZone", () => {
  it("returns In Buy Zone inside the range (inclusive)", () => {
    expect(evaluateBuyZone(105, cfg).status).toBe("In Buy Zone");
    expect(evaluateBuyZone(100, cfg).status).toBe("In Buy Zone");
    expect(evaluateBuyZone(110, cfg).status).toBe("In Buy Zone");
    expect(evaluateBuyZone(105, cfg).distanceFromBuyZonePercent).toBe(0);
  });

  it("flags falling-knife risk below the zone", () => {
    const result = evaluateBuyZone(92, cfg);
    expect(result.status).toBe("Below Buy Zone / Falling Knife Risk");
    expect(result.distanceFromBuyZonePercent).toBeLessThan(0);
  });

  it("says Wait when modestly above the zone", () => {
    expect(evaluateBuyZone(118, cfg).status).toBe("Above Buy Zone / Wait");
  });

  it("flags Reinvestment Candidate above reinvest level only with favorable catalysts", () => {
    expect(evaluateBuyZone(135, cfg, { catalystsFavorable: true }).status).toBe(
      "Reinvestment Candidate",
    );
    expect(evaluateBuyZone(135, cfg, { catalystsFavorable: false }).status).toBe(
      "Extended / Risk Elevated",
    );
  });

  it("flags Extended when far above the zone without a reinvest level", () => {
    const noReinvest = { ...cfg, reinvestAbovePrice: null };
    expect(evaluateBuyZone(145, noReinvest).status).toBe("Extended / Risk Elevated");
  });

  it("handles missing config or price gracefully", () => {
    expect(evaluateBuyZone(105, { ...cfg, targetBuyLow: null }).status).toBe("No Buy Zone Set");
    expect(evaluateBuyZone(null, cfg).status).toBe("No Buy Zone Set");
  });
});

describe("computeDrawdown", () => {
  it("computes drawdown from 52w and 30d highs", () => {
    // Rise to ~200 then fall to 150.
    const closes = [...trendCloses(100, 200, 200), ...trendCloses(200, 150, 30)];
    const bars = barsFromCloses(closes);
    const dd = computeDrawdown(bars, 150);
    expect(dd.fiftyTwoWeekHigh).toBeGreaterThan(195);
    expect(dd.drawdownFrom52wHighPercent).toBeLessThan(-20);
    expect(dd.drawdownFrom30dHighPercent).toBeLessThan(0);
  });

  it("computes gain/loss vs average cost", () => {
    const bars = barsFromCloses(trendCloses(100, 150, 60));
    const dd = computeDrawdown(bars, 150, 120);
    expect(dd.drawdownFromAvgCostPercent).toBeCloseTo(25);
  });

  it("reports recovery from the recent low", () => {
    const closes = [...trendCloses(150, 100, 40), ...trendCloses(100, 120, 10)];
    const dd = computeDrawdown(barsFromCloses(closes), 120);
    expect(dd.recoveryFromRecentLowPercent).toBeGreaterThan(15);
  });

  it("classifies the drawdown trend direction", () => {
    const worsening = computeDrawdown(
      barsFromCloses([...trendCloses(100, 150, 60), ...trendCloses(150, 130, 10)]),
      130,
    );
    expect(worsening.trend).toBe("worsening");
    const improving = computeDrawdown(
      barsFromCloses([...trendCloses(150, 110, 60), ...trendCloses(110, 125, 10)]),
      125,
    );
    expect(improving.trend).toBe("improving");
  });

  it("returns nulls (not crashes) with no bars", () => {
    const dd = computeDrawdown([], 100, 90);
    expect(dd.fiftyTwoWeekHigh).toBeNull();
    expect(dd.trend).toBe("unknown");
    expect(dd.drawdownFromAvgCostPercent).toBeCloseTo(11.11, 1);
  });
});
