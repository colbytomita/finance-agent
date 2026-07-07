import { describe, expect, it } from "vitest";
import { describeRegime, isRegimeCautious } from "../marketRegime";
import { computeIndicators } from "../indicators";
import { barsFromCloses, trendCloses } from "./helpers";

// describeRegime reuses marketConditionScore (SPY vs 50-day average + RSI).

describe("describeRegime", () => {
  it("is favorable when SPY is above its 50-day average", () => {
    const ind = computeIndicators(barsFromCloses(trendCloses(100, 200, 260)));
    const r = describeRegime(ind);
    expect(r.label).toBe("favorable");
    expect(r.headline).toMatch(/above its 50-day average/);
    expect(r.score).toBeGreaterThan(6.5);
    expect(isRegimeCautious(r)).toBe(false);
  });

  it("is cautious when SPY is below its 50-day average", () => {
    const ind = computeIndicators(barsFromCloses(trendCloses(260, 120, 100)));
    const r = describeRegime(ind);
    expect(r.label).toBe("cautious");
    expect(r.headline).toMatch(/below its 50-day average/);
    expect(r.score).toBeLessThanOrEqual(4.5);
    expect(isRegimeCautious(r)).toBe(true);
  });

  it("is unknown with no SPY data", () => {
    const r = describeRegime(null);
    expect(r.label).toBe("unknown");
    expect(r.headline).toMatch(/unknown/i);
    expect(r.spyPrice).toBeNull();
  });
});
