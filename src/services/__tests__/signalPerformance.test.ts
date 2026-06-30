import { describe, expect, it } from "vitest";
import {
  bucketAndAggregate,
  calibrationVerdict,
  poolByIndustry,
  poolBySource,
  SCORE_BANDS,
} from "../signalPerformance";
import {
  EVENT_WINDOWS,
  type EventStudyResult,
  type EventWindowKey,
  type WindowReturn,
} from "../eventStudy";
import type { StockRecommendationLabel } from "@/lib/types";

/** Build a synthetic event study with given abnormal returns per window. */
function studyWith(abn: Partial<Record<EventWindowKey, number>>): EventStudyResult {
  const windows = {} as Record<EventWindowKey, WindowReturn>;
  for (const w of EVENT_WINDOWS) {
    const v = abn[w.key];
    windows[w.key] =
      v == null
        ? { stockReturnPct: null, marketReturnPct: null, abnormalReturnPct: null, available: false }
        : { stockReturnPct: v, marketReturnPct: 0, abnormalReturnPct: v, available: true };
  }
  return { eventDate: "2025-01-01", resolvedEventDate: "2025-01-01", eventIndex: 5, windows };
}

function ev(bucket: StockRecommendationLabel, post5: number) {
  return { bucket, study: studyWith({ post1: post5 / 2, post5, post20: post5 * 2 }) };
}

describe("signalPerformance.poolBySource", () => {
  it("pools studies by source, one row per requested source in order", () => {
    const studies = [
      { source: "Agent Picks", study: studyWith({ post5: 3 }) },
      { source: "Agent Picks", study: studyWith({ post5: 1 }) },
      { source: "Sector Scout", study: studyWith({ post5: -2 }) },
    ];
    const res = poolBySource(studies, ["Agent Picks", "Sector Scout", "Empty"]);
    expect(res.map((r) => r.source)).toEqual(["Agent Picks", "Sector Scout", "Empty"]);
    const ap = res.find((r) => r.source === "Agent Picks")!;
    expect(ap.totalEvents).toBe(2);
    expect(ap.windows.find((w) => w.key === "post5")!.meanAbnormalReturnPct).toBeCloseTo(2);
    expect(ap.windows.find((w) => w.key === "post5")!.hitRate).toBe(100);
    expect(res.find((r) => r.source === "Empty")!.totalEvents).toBe(0);
  });
});

describe("signalPerformance.poolByIndustry", () => {
  it("fans multi-industry picks out to each industry and orders by sample size", () => {
    const rows = poolByIndustry([
      { groups: ["space"], study: studyWith({ post5: 4 }) },
      { groups: ["space"], study: studyWith({ post5: 2 }) },
      { groups: ["ai", "semiconductors"], study: studyWith({ post5: 6 }) }, // counts in both
      { study: studyWith({ post5: 9 }) }, // no groups -> ignored entirely
    ]);
    // space=2 sampled, ai=1, semiconductors=1 -> space first, then alphabetical
    expect(rows.map((r) => r.industry)).toEqual(["space", "ai", "semiconductors"]);

    const space = rows.find((r) => r.industry === "space")!;
    expect(space.totalEvents).toBe(2);
    expect(space.windows.find((w) => w.key === "post5")!.meanAbnormalReturnPct).toBeCloseTo(3);

    const ai = rows.find((r) => r.industry === "ai")!;
    expect(ai.totalEvents).toBe(1);
    expect(ai.windows.find((w) => w.key === "post5")!.meanAbnormalReturnPct).toBeCloseTo(6);
  });

  it("returns an empty list when no studies carry industries", () => {
    expect(poolByIndustry([{ study: studyWith({ post5: 1 }) }])).toEqual([]);
  });
});

describe("signalPerformance.bucketAndAggregate", () => {
  it("returns all five bands even when most are empty", () => {
    const buckets = bucketAndAggregate([ev("Strong Buy Candidate", 2)]);
    expect(buckets.map((b) => b.bucket)).toEqual(SCORE_BANDS.map((s) => s.label));
    expect(buckets.find((b) => b.bucket === "Watch / Hold")!.totalEvents).toBe(0);
  });

  it("pools abnormal returns within a band (mean + hit rate)", () => {
    const buckets = bucketAndAggregate([
      ev("Strong Buy Candidate", 2),
      ev("Strong Buy Candidate", 4),
      ev("Strong Avoid", -3),
    ]);
    const sbc = buckets.find((b) => b.bucket === "Strong Buy Candidate")!;
    expect(sbc.totalEvents).toBe(2);
    const post5 = sbc.windows.find((w) => w.key === "post5")!;
    expect(post5.n).toBe(2);
    expect(post5.meanAbnormalReturnPct).toBeCloseTo(3);
    expect(post5.hitRate).toBe(100);

    const avoid = buckets.find((b) => b.bucket === "Strong Avoid")!;
    expect(avoid.windows.find((w) => w.key === "post5")!.hitRate).toBe(0);
  });

  it("treats unavailable windows as zero-sample (not zero-return)", () => {
    const buckets = bucketAndAggregate([
      { bucket: "Buy Candidate", study: studyWith({ post5: 1 }) }, // post1/post20 null
    ]);
    const bc = buckets.find((b) => b.bucket === "Buy Candidate")!;
    expect(bc.windows.find((w) => w.key === "post5")!.n).toBe(1);
    expect(bc.windows.find((w) => w.key === "post20")!.n).toBe(0);
    expect(bc.windows.find((w) => w.key === "post20")!.meanAbnormalReturnPct).toBeNull();
  });
});

describe("signalPerformance.calibrationVerdict", () => {
  const buckets = (means: [StockRecommendationLabel, number][]) =>
    bucketAndAggregate(means.map(([b, m]) => ev(b, m)));

  it("reports 'improves' when better bands have higher forward returns", () => {
    const b = buckets([
      ["Strong Buy Candidate", 5],
      ["Buy Candidate", 3],
      ["Watch / Hold", 1],
      ["Avoid / Risk Elevated", -1],
      ["Strong Avoid", -3],
    ]);
    expect(calibrationVerdict(b, "post5")).toBe("improves");
  });

  it("reports 'inverts' when the ordering is backwards", () => {
    const b = buckets([
      ["Strong Buy Candidate", -3],
      ["Buy Candidate", -1],
      ["Watch / Hold", 1],
      ["Strong Avoid", 4],
    ]);
    expect(calibrationVerdict(b, "post5")).toBe("inverts");
  });

  it("reports 'mixed' when there is no clean ordering", () => {
    const b = buckets([
      ["Strong Buy Candidate", 1],
      ["Buy Candidate", 4],
      ["Strong Avoid", 2],
    ]);
    expect(calibrationVerdict(b, "post5")).toBe("mixed");
  });

  it("skips empty bands and needs at least two populated to judge", () => {
    expect(calibrationVerdict(bucketAndAggregate([ev("Strong Buy Candidate", 5)]), "post5")).toBe("n/a");
    // Two populated bands (others empty) still yields a verdict.
    const b = buckets([
      ["Strong Buy Candidate", 5],
      ["Strong Avoid", -3],
    ]);
    expect(calibrationVerdict(b, "post5")).toBe("improves");
  });
});
