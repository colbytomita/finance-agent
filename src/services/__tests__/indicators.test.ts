import { describe, expect, it } from "vitest";
import { atr, computeIndicators, ema, relativeVolume, rsi, sma } from "../indicators";
import { detectSetups } from "../setupDetection";
import { barsFromCloses, trendCloses, uptrendWithPullback } from "./helpers";
import { freshness } from "@/lib/format";

describe("basic indicators", () => {
  it("sma averages the last N closes", () => {
    expect(sma([1, 2, 3, 4, 5], 3)).toBeCloseTo(4);
  });
  it("returns null for insufficient data", () => {
    expect(sma([1, 2], 5)).toBeNull();
    expect(ema([1, 2], 5)).toBeNull();
    expect(rsi([1, 2, 3], 14)).toBeNull();
    expect(atr(barsFromCloses([1, 2]), 14)).toBeNull();
  });
  it("rsi is high in straight uptrends and low in downtrends", () => {
    expect(rsi(trendCloses(100, 150, 60))!).toBeGreaterThan(70);
    expect(rsi(trendCloses(150, 100, 60))!).toBeLessThan(30);
  });
  it("relative volume compares today's volume to the average", () => {
    const bars = barsFromCloses(trendCloses(100, 110, 30));
    bars[bars.length - 1].volume = 3_000_000; // 3x the 1M default
    expect(relativeVolume(bars)).toBeCloseTo(3);
  });
});

describe("computeIndicators", () => {
  it("returns a full snapshot for a long series", () => {
    const ind = computeIndicators(barsFromCloses(trendCloses(100, 200, 300)))!;
    expect(ind.sma200).not.toBeNull();
    expect(ind.fiftyTwoWeekHigh).not.toBeNull();
    expect(ind.rsi14).not.toBeNull();
    expect(ind.macd).not.toBeNull();
  });
  it("returns null members for short series, never throws", () => {
    const ind = computeIndicators(barsFromCloses([100, 101, 102]))!;
    expect(ind.sma200).toBeNull();
    expect(ind.price).toBe(102);
  });
  it("returns null for empty input", () => {
    expect(computeIndicators([])).toBeNull();
  });
});

describe("detectSetups", () => {
  it("requires at least 30 bars", () => {
    expect(detectSetups(barsFromCloses(trendCloses(100, 110, 20)))).toEqual([]);
  });

  it("every detected setup carries entry/stop/target and R/R >= 1.5", () => {
    const setups = detectSetups(barsFromCloses(uptrendWithPullback()));
    for (const s of setups) {
      expect(s.entryRangeLow).toBeLessThanOrEqual(s.entryRangeHigh);
      expect(s.stopLoss).toBeLessThan(s.entryRangeLow);
      expect(s.targetPrice1).toBeGreaterThan(s.entryRangeHigh);
      expect(s.riskRewardRatio).toBeGreaterThanOrEqual(1.5);
      expect(s.invalidationCondition).toBeTruthy();
      expect(s.setupQualityScore).toBeGreaterThanOrEqual(1);
      expect(s.setupQualityScore).toBeLessThanOrEqual(10);
    }
  });

  it("finds momentum/pullback style setups in a healthy uptrend", () => {
    const setups = detectSetups(barsFromCloses(uptrendWithPullback()));
    // Not asserting a specific type (heuristics may evolve) but a healthy
    // uptrend with a pullback should produce at least one candidate.
    expect(setups.length).toBeGreaterThan(0);
  });
});

describe("stale data handling", () => {
  it("labels fresh data correctly", () => {
    const f = freshness(new Date(Date.now() - 2 * 60000).toISOString(), 30);
    expect(f.isStale).toBe(false);
    expect(f.label).toMatch(/2m ago/);
  });
  it("flags stale data past the threshold", () => {
    const f = freshness(new Date(Date.now() - 3 * 3600000).toISOString(), 30);
    expect(f.isStale).toBe(true);
    expect(f.label).toMatch(/stale/);
  });
  it("handles missing timestamps", () => {
    const f = freshness(null);
    expect(f.isStale).toBe(true);
    expect(f.label).toBe("no data");
  });
});
