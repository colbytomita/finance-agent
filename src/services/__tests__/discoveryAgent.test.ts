import { describe, expect, it } from "vitest";
import { buildCandidate, passesTest, suggestBuyZone } from "../discoveryAgent";
import { barsFromCloses, trendCloses, uptrendWithPullback } from "./helpers";

describe("discoveryAgent.buildCandidate", () => {
  it("scores a strong uptrend higher than a downtrend", () => {
    const up = buildCandidate({
      ticker: "UP",
      bars: barsFromCloses(trendCloses(50, 150, 260)),
      price: 150,
    });
    const down = buildCandidate({
      ticker: "DN",
      bars: barsFromCloses(trendCloses(150, 70, 260)),
      price: 70,
    });
    expect(up).not.toBeNull();
    expect(down).not.toBeNull();
    expect(up!.score.overallScore).toBeGreaterThan(down!.score.overallScore);
  });

  it("returns null when there is neither price nor bars", () => {
    expect(buildCandidate({ ticker: "X", bars: [], price: null })).toBeNull();
  });

  it("still scores from price alone when bars are missing (neutral, low confidence)", () => {
    const c = buildCandidate({ ticker: "X", bars: [], price: 42 });
    expect(c).not.toBeNull();
    expect(c!.price).toBe(42);
    expect(c!.score.confidence).toBe("low");
  });
});

describe("discoveryAgent.passesTest", () => {
  it("applies the configurable score threshold", () => {
    const c = buildCandidate({
      ticker: "UP",
      bars: barsFromCloses(uptrendWithPullback()),
      price: 142,
    })!;
    const score = c.score.overallScore;
    expect(passesTest(c, score - 0.1)).toBe(true);
    expect(passesTest(c, score + 0.1)).toBe(false);
  });
});

describe("discoveryAgent.suggestBuyZone", () => {
  it("suggests a low at/below price and a high no lower than the low", () => {
    const c = buildCandidate({
      ticker: "UP",
      bars: barsFromCloses(uptrendWithPullback()),
      price: 142,
    })!;
    const { low, high } = suggestBuyZone(c);
    expect(low).not.toBeNull();
    expect(high).not.toBeNull();
    expect(low!).toBeLessThanOrEqual(high!);
    expect(high!).toBeLessThanOrEqual(142 + 1e-9);
  });

  it("falls back to ~7% below price when no support is available", () => {
    const c = buildCandidate({ ticker: "X", bars: [], price: 100 })!;
    const { low, high } = suggestBuyZone(c);
    expect(low).toBeCloseTo(93, 0);
    expect(high).toBe(100);
  });
});
