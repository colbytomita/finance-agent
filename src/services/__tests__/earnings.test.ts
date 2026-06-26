import { describe, expect, it } from "vitest";
import {
  computeSurprisePercent,
  classifySurprise,
  surpriseToImpact,
  earningsCatalystInput,
  describeEarnings,
} from "../earnings";

describe("computeSurprisePercent", () => {
  it("is positive for a beat, negative for a miss", () => {
    expect(computeSurprisePercent(1.0, 1.2)).toBeCloseTo(20);
    expect(computeSurprisePercent(1.0, 0.9)).toBeCloseTo(-10);
  });

  it("handles a narrowing loss vs estimate as a beat (negative estimate)", () => {
    // Lost less than expected: −0.10 vs −0.20 estimate => +50% surprise.
    expect(computeSurprisePercent(-0.2, -0.1)).toBeCloseTo(50);
  });

  it("returns null when not computable (zero/nullish estimate)", () => {
    expect(computeSurprisePercent(0, 1)).toBeNull();
    expect(computeSurprisePercent(null, 1)).toBeNull();
    expect(computeSurprisePercent(1, null)).toBeNull();
  });
});

describe("classifySurprise", () => {
  it("treats ±2% as in line", () => {
    expect(classifySurprise(1.5)).toBe("inline");
    expect(classifySurprise(-2)).toBe("inline");
    expect(classifySurprise(3)).toBe("beat");
    expect(classifySurprise(-5)).toBe("miss");
    expect(classifySurprise(null)).toBe("inline");
  });
});

describe("surpriseToImpact (calibration)", () => {
  it("is zero inside the ±2% deadzone", () => {
    expect(surpriseToImpact(0)).toBe(0);
    expect(surpriseToImpact(2)).toBe(0);
    expect(surpriseToImpact(-1.5)).toBe(0);
  });

  it("is signed and saturating with diminishing returns", () => {
    expect(surpriseToImpact(10)).toBeCloseTo(2.22, 1);
    expect(surpriseToImpact(-10)).toBeCloseTo(-2.22, 1);
    // bigger beat => bigger impact, but each extra % adds less
    expect(surpriseToImpact(20)).toBeGreaterThan(surpriseToImpact(10));
    expect(surpriseToImpact(20) - surpriseToImpact(10)).toBeLessThan(
      surpriseToImpact(10) - surpriseToImpact(5),
    );
    // never exceeds the ±5 catalyst range
    expect(surpriseToImpact(500)).toBeLessThan(5);
    expect(surpriseToImpact(500)).toBeGreaterThan(4.5);
  });
});

describe("earningsCatalystInput (recency + signal)", () => {
  const now = Date.parse("2026-06-26T00:00:00Z");
  const daysAgo = (n: number) => new Date(now - n * 86400000).toISOString().slice(0, 10);
  const make = (surprisePercent: number | null, ageDays: number) =>
    earningsCatalystInput(
      { reportDate: daysAgo(ageDays), surprisePercent, fiscalPeriod: "Q2 2026", epsEstimate: 1, epsActual: 1.2 },
      { now, freshnessDays: 90 },
    );

  it("a fresh beat is a positive, high-confidence signal", () => {
    const c = make(15, 5);
    expect(c).not.toBeNull();
    expect(c!.impactScore).toBeGreaterThan(2);
    expect(c!.confidence).toBe("high");
    expect(c!.status).toBe("occurred");
  });

  it("a fresh big miss is a strong negative signal (triggers the risk penalty)", () => {
    const c = make(-30, 5);
    expect(c!.impactScore).toBeLessThanOrEqual(-3); // riskScore penalizes <= -3
    expect(c!.confidence).toBe("high");
  });

  it("an in-line print produces no signal", () => {
    expect(make(1, 5)).toBeNull();
    expect(make(-2, 5)).toBeNull();
  });

  it("decays with age — an older beat counts for less", () => {
    const fresh = make(15, 5)!.impactScore;
    const old = make(15, 85)!.impactScore;
    expect(old).toBeGreaterThan(0);
    expect(old).toBeLessThan(fresh);
  });

  it("ignores reports beyond the freshness window or in the future", () => {
    expect(make(15, 200)).toBeNull(); // too old
    expect(make(15, -10)).toBeNull(); // future-dated
  });

  it("returns null when the surprise is unknown", () => {
    expect(make(null, 5)).toBeNull();
  });
});

describe("describeEarnings", () => {
  it("reads naturally for beat / miss / in line", () => {
    expect(describeEarnings({ fiscalPeriod: "Q2 2026", surprisePercent: 12, epsEstimate: 1, epsActual: 1.12 })).toMatch(
      /Q2 2026 earnings beat estimates \(\+12.0%\)/,
    );
    expect(describeEarnings({ fiscalPeriod: "Q1 2026", surprisePercent: -8, epsEstimate: 1, epsActual: 0.92 })).toMatch(
      /missed estimates \(-8.0%\)/,
    );
    expect(describeEarnings({ fiscalPeriod: "Q3 2026", surprisePercent: 0.5, epsEstimate: 1, epsActual: 1.005 })).toMatch(
      /met estimates/,
    );
  });
});
