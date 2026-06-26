import { describe, expect, it } from "vitest";
import { edgeImpact, describeEdge, isFreshEdgeMention } from "../catalystEdge";
import { aggregateEventStudies, EVENT_WINDOWS, type EventStudyResult, type EventWindowKey, type WindowReturn } from "../eventStudy";

// Build an EntityEdgeSummary whose post5 window pools the given abnormal returns.
function summaryWithPost5(abnormals: number[]) {
  const results: EventStudyResult[] = abnormals.map((a) => {
    const windows = {} as Record<EventWindowKey, WindowReturn>;
    for (const w of EVENT_WINDOWS) {
      windows[w.key] =
        w.key === "post5"
          ? { stockReturnPct: a, marketReturnPct: 0, abnormalReturnPct: a, available: true }
          : { stockReturnPct: null, marketReturnPct: null, abnormalReturnPct: null, available: false };
    }
    return { eventDate: "2025-01-01", resolvedEventDate: "2025-01-01", eventIndex: 0, windows };
  });
  return aggregateEventStudies(results);
}

describe("edgeImpact", () => {
  it("maps a positive edge + bullish mention to a positive catalyst impact", () => {
    const s = summaryWithPost5([3, 4, 2, 3]); // mean +3%, n=4
    const e = edgeImpact(s, "bullish");
    expect(e).not.toBeNull();
    expect(e!.impactScore).toBeGreaterThan(0);
    expect(e!.impactScore).toBeCloseTo(3, 1);
    expect(e!.n).toBe(4);
    expect(e!.confidence).toBe("medium"); // n>=4
  });

  it("scales confidence up with sample size", () => {
    const big = summaryWithPost5([2, 2, 2, 2, 2, 2, 2, 2]); // n=8
    expect(edgeImpact(big, "bullish")!.confidence).toBe("high");
    const small = summaryWithPost5([2, 2, 2]); // n=3
    expect(edgeImpact(small, "bullish")!.confidence).toBe("low");
  });

  it("returns null below the minimum sample size", () => {
    const s = summaryWithPost5([5, 5]); // n=2 < default 3
    expect(edgeImpact(s, "bullish")).toBeNull();
    // ...but a lower threshold lets it through
    expect(edgeImpact(s, "bullish", { minSamples: 2 })).not.toBeNull();
  });

  it("returns null when the effect is negligible", () => {
    const s = summaryWithPost5([0.1, -0.1, 0.05]); // mean ~0
    expect(edgeImpact(s, "bullish")).toBeNull();
  });

  it("halves the magnitude when the stated direction contradicts the measured tendency", () => {
    const s = summaryWithPost5([4, 4, 4]); // strong positive tendency
    const aligned = edgeImpact(s, "bullish")!.impactScore;
    const contra = edgeImpact(s, "bearish")!.impactScore;
    expect(contra).toBeCloseTo(aligned / 2, 5);
  });

  it("clamps to the -5..+5 range", () => {
    const s = summaryWithPost5([12, 12, 12]);
    expect(edgeImpact(s, "bullish")!.impactScore).toBe(5);
  });
});

describe("describeEdge", () => {
  it("includes the sample size and a not-a-prediction caveat", () => {
    const s = summaryWithPost5([3, 4, 2, 3]);
    const e = edgeImpact(s, "bullish")!;
    const { title, summary } = describeEdge("Jane Doe", "NVDA", "bullish", e);
    expect(title).toContain("Jane Doe");
    expect(title).toContain("NVDA");
    expect(summary).toContain("n=4");
    expect(summary.toLowerCase()).toContain("not advice");
  });
});

describe("isFreshEdgeMention", () => {
  it("keeps old mentions out of current catalyst scoring surfaces", () => {
    const now = Date.parse("2026-06-26T12:00:00Z");
    expect(isFreshEdgeMention("2026-06-01", 90, now)).toBe(true);
    expect(isFreshEdgeMention("2025-12-01", 90, now)).toBe(false);
  });
});
