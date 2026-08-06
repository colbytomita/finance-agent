import { describe, expect, it } from "vitest";
import {
  addDays,
  dayOffset,
  filterClosedTrades,
  filterPerformance,
  performanceDateDomain,
  studyFromAbn,
} from "../performanceFilter";
import {
  bucketAndAggregate,
  PICK_SOURCES,
  poolBySource,
  type PerformanceEvents,
  type PerformanceReport,
} from "../signalPerformanceCore";
import { aggregateSetups } from "../setupPerformance";
import type { ClosedTradeInput, JournalInput } from "../tradePerformance";

// Pure date-range filtering for the Signal Performance page. The stored report
// keeps per-event rows so a narrowed range can be re-pooled through the SAME
// aggregators the backtest used — these tests pin the filtering rules and, most
// importantly, that a full-range refilter reproduces the stored aggregates.

const abn = (post5: number) => ({ post1: post5 / 2, post5, post20: post5 * 2 });

function events(over: Partial<PerformanceEvents> = {}): PerformanceEvents {
  return {
    scores: [],
    picks: [],
    setups: [],
    scoreRowsByDay: {},
    ...over,
  };
}

/** A report carrying `ev`, with run-level facts the filter must preserve. */
function reportWith(ev: PerformanceEvents): PerformanceReport {
  return {
    generatedAt: "2026-07-25T00:00:00.000Z",
    score: {
      totalScoreRows: 0,
      sampledEvents: 0,
      analyzed: 0,
      tickers: 0,
      spyAvailable: true,
      primaryWindow: "post5",
      calibration: "n/a",
      buckets: [],
      notes: ["stored note"],
    },
    picks: {
      sampledEvents: 0,
      analyzed: 0,
      spyAvailable: true,
      sources: [],
      byIndustry: [],
      notes: ["stored note"],
    },
    setups: {
      horizonDays: 20,
      totalSetups: 0,
      matured: 0,
      pending: 0,
      byType: [],
      overall: {
        setupType: "All setups",
        matured: 0,
        triggered: 0,
        wins: 0,
        losses: 0,
        expired: 0,
        noFill: 0,
        winRate: null,
        avgR: null,
      },
      notes: ["stored note"],
    },
    events: ev,
  };
}

describe("performanceFilter.filterPerformance — score calibration", () => {
  it("keeps events on both range boundaries and drops those outside", () => {
    const ev = events({
      scores: [
        { ticker: "AAA", day: "2026-06-01", band: "Buy Candidate", abn: abn(1) },
        { ticker: "BBB", day: "2026-06-10", band: "Buy Candidate", abn: abn(3) },
        { ticker: "CCC", day: "2026-06-20", band: "Buy Candidate", abn: abn(5) },
        { ticker: "DDD", day: "2026-06-30", band: "Buy Candidate", abn: abn(99) },
      ],
    });

    const res = filterPerformance(reportWith(ev), { from: "2026-06-10", to: "2026-06-20" });
    const buy = res.score.buckets.find((b) => b.bucket === "Buy Candidate")!;

    expect(buy.totalEvents).toBe(2); // 06-10 and 06-20 inclusive, 06-01 and 06-30 out
    expect(buy.windows.find((w) => w.key === "post5")!.meanAbnormalReturnPct).toBeCloseTo(4);
    expect(res.score.analyzed).toBe(2);
  });

  it("recomputes tickers, scored days and raw rows from the filtered range", () => {
    const ev = events({
      scores: [
        { ticker: "AAA", day: "2026-06-01", band: "Buy Candidate", abn: abn(1) },
        { ticker: "AAA", day: "2026-06-10", band: "Buy Candidate", abn: abn(2) },
        { ticker: "BBB", day: "2026-06-10", band: "Watch / Hold", abn: abn(3) },
      ],
      scoreRowsByDay: { "2026-06-01": 40, "2026-06-10": 55 },
      scoreSampledByDay: { "2026-06-01": 1, "2026-06-10": 2 },
    });

    const res = filterPerformance(reportWith(ev), { from: "2026-06-05", to: "2026-06-30" });

    expect(res.score.sampledEvents).toBe(2);
    expect(res.score.tickers).toBe(2); // AAA and BBB, both seen on 06-10
    expect(res.score.totalScoreRows).toBe(55); // only 06-10's raw rows count
  });

  it("counts scored days from what was sampled, not from what resolved", () => {
    // Score events that never resolved to a forward window are dropped from the
    // stored rows, so "scored days" has to come from the per-day sampled counts —
    // otherwise a filtered view claims every scored day was analyzed.
    const ev = events({
      scores: [{ ticker: "AAA", day: "2026-06-10", band: "Buy Candidate", abn: abn(2) }],
      scoreRowsByDay: { "2026-06-10": 55 },
      scoreSampledByDay: { "2026-06-10": 4 },
    });

    const res = filterPerformance(reportWith(ev), { from: "2026-06-01", to: "2026-06-30" });

    expect(res.score.analyzed).toBe(1);
    expect(res.score.sampledEvents).toBe(4);
  });

  it("falls back to the analyzed count when the report predates the sampled map", () => {
    const ev = events({
      scores: [
        { ticker: "AAA", day: "2026-06-10", band: "Buy Candidate", abn: abn(2) },
        { ticker: "BBB", day: "2026-06-11", band: "Buy Candidate", abn: abn(3) },
      ],
    });
    expect(ev.scoreSampledByDay).toBeUndefined();

    const res = filterPerformance(reportWith(ev), { from: "2026-06-01", to: "2026-06-30" });

    expect(res.score.sampledEvents).toBe(2); // never 0, and never a crash
  });

  it("returns all five bands with zeroed windows when the range holds no events", () => {
    const ev = events({
      scores: [{ ticker: "AAA", day: "2026-06-01", band: "Buy Candidate", abn: abn(1) }],
    });

    const res = filterPerformance(reportWith(ev), { from: "2026-07-01", to: "2026-07-10" });

    expect(res.score.buckets).toHaveLength(5);
    expect(res.score.buckets.every((b) => b.totalEvents === 0)).toBe(true);
    expect(res.score.analyzed).toBe(0);
    expect(res.score.calibration).toBe("n/a");
    expect(res.score.notes.some((n) => n.includes("No score events"))).toBe(true);
  });

  it("preserves run-level facts and drops stale stored notes", () => {
    const ev = events({
      scores: [{ ticker: "AAA", day: "2026-06-01", band: "Buy Candidate", abn: abn(1) }],
    });

    const res = filterPerformance(reportWith(ev), { from: "2026-06-01", to: "2026-06-01" });

    expect(res.score.spyAvailable).toBe(true);
    expect(res.score.primaryWindow).toBe("post5");
    expect(res.score.notes).not.toContain("stored note"); // "spans X → Y" would be wrong now
    expect(res.score.notes.some((n) => n.includes("Small sample"))).toBe(true);
  });
});

describe("performanceFilter.filterPerformance — picks", () => {
  it("pools filtered picks by source, keeping both sources present", () => {
    const ev = events({
      picks: [
        { ticker: "AAA", day: "2026-06-01", source: "Agent Picks", abn: abn(2) },
        { ticker: "BBB", day: "2026-06-15", source: "Agent Picks", abn: abn(4) },
        { ticker: "CCC", day: "2026-06-15", source: "Sector Scout", abn: abn(-1), industries: ["space"] },
      ],
    });

    const res = filterPerformance(reportWith(ev), { from: "2026-06-10", to: "2026-06-20" });

    expect(res.picks.sources.map((s) => s.source)).toEqual(["Agent Picks", "Sector Scout"]);
    expect(res.picks.sources.find((s) => s.source === "Agent Picks")!.totalEvents).toBe(1);
    expect(res.picks.analyzed).toBe(2);
  });

  it("fans multi-industry picks out to each industry after filtering", () => {
    const ev = events({
      picks: [
        {
          ticker: "AAA",
          day: "2026-06-15",
          source: "Sector Scout",
          industries: ["ai", "semiconductors"],
          abn: abn(6),
        },
        { ticker: "BBB", day: "2026-06-01", source: "Sector Scout", industries: ["space"], abn: abn(9) },
      ],
    });

    const res = filterPerformance(reportWith(ev), { from: "2026-06-10", to: "2026-06-20" });

    expect(res.picks.byIndustry.map((r) => r.industry).sort()).toEqual(["ai", "semiconductors"]);
    expect(res.picks.byIndustry.every((r) => r.totalEvents === 1)).toBe(true);
  });
});

describe("performanceFilter.filterPerformance — setups", () => {
  it("recomputes matured, pending and no-fill counts for the range", () => {
    const ev = events({
      setups: [
        { setupType: "breakout", day: "2026-06-05", result: "win", rMultiple: 2 },
        { setupType: "breakout", day: "2026-06-15", result: "loss", rMultiple: -1 },
        { setupType: "breakout", day: "2026-06-16", result: "no_fill", rMultiple: 0 },
        { setupType: "pullback", day: "2026-06-17", result: "pending" },
        { setupType: "pullback", day: "2026-06-25", result: "win", rMultiple: 3 },
      ],
    });

    const res = filterPerformance(reportWith(ev), { from: "2026-06-10", to: "2026-06-20" });
    const setups = res.setups!;

    expect(setups.totalSetups).toBe(3); // 06-15, 06-16, 06-17
    expect(setups.matured).toBe(2); // pending is not matured
    expect(setups.pending).toBe(1);
    expect(setups.overall.triggered).toBe(1); // no_fill excluded
    expect(setups.overall.losses).toBe(1);
    expect(setups.overall.noFill).toBe(1);
    expect(setups.horizonDays).toBe(20); // run-level fact preserved
  });
});

describe("performanceFilter.filterClosedTrades", () => {
  it("filters on the close date, not the entry date", () => {
    const trades: ClosedTradeInput[] = [
      {
        id: 1,
        direction: "long",
        entryPrice: 100,
        exitPrice: 110,
        stopLoss: 95,
        entryDate: "2026-05-01",
        closedAt: "2026-06-15",
        unrealizedGainLoss: 100,
        unrealizedGainLossPercent: 10,
      },
      {
        id: 2,
        direction: "long",
        entryPrice: 100,
        exitPrice: 90,
        stopLoss: 95,
        entryDate: "2026-06-12",
        closedAt: "2026-07-01",
        unrealizedGainLoss: -100,
        unrealizedGainLossPercent: -10,
      },
    ];
    const journal: JournalInput[] = [];

    const res = filterClosedTrades(trades, journal, { from: "2026-06-10", to: "2026-06-20" });

    // Trade 1 closed in range (entered before it); trade 2 entered in range but
    // closed after it, so it must NOT count.
    expect(res.closed).toBe(1);
    expect(res.wins).toBe(1);
    expect(res.avgReturnPct).toBeCloseTo(10);
  });
});

describe("performanceFilter day arithmetic", () => {
  it("counts whole days between two day strings, including across months", () => {
    expect(dayOffset("2026-06-13", "2026-06-13")).toBe(0);
    expect(dayOffset("2026-06-13", "2026-06-14")).toBe(1);
    expect(dayOffset("2026-06-13", "2026-07-24")).toBe(41);
    expect(dayOffset("2026-06-13", "2026-06-01")).toBe(-12); // before the origin
  });

  it("adds days across month, year and leap-day boundaries", () => {
    expect(addDays("2026-06-13", 0)).toBe("2026-06-13");
    expect(addDays("2026-06-13", 41)).toBe("2026-07-24");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29"); // 2028 is a leap year
  });

  it("round-trips regardless of the machine's timezone", () => {
    // Colby runs in Hawaii (UTC-10); parsing day strings as local time would slip
    // every label back a day. Both helpers must work purely in UTC.
    const original = process.env.TZ;
    try {
      process.env.TZ = "Pacific/Honolulu";
      expect(addDays("2026-06-13", dayOffset("2026-06-13", "2026-07-24"))).toBe("2026-07-24");
      expect(addDays("2026-01-01", 0)).toBe("2026-01-01");
    } finally {
      process.env.TZ = original;
    }
  });
});

describe("performanceFilter.performanceDateDomain", () => {
  it("spans the earliest and latest day across every dataset", () => {
    const ev = events({
      scores: [{ ticker: "AAA", day: "2026-06-13", band: "Buy Candidate", abn: abn(1) }],
      picks: [{ ticker: "BBB", day: "2026-06-02", source: "Agent Picks", abn: abn(1) }],
      setups: [{ setupType: "breakout", day: "2026-07-20", result: "win", rMultiple: 1 }],
    });

    expect(performanceDateDomain(ev, ["2026-07-24"])).toEqual({
      from: "2026-06-02",
      to: "2026-07-24",
    });
  });

  it("returns null when there is nothing to plot", () => {
    expect(performanceDateDomain(undefined, [])).toBeNull();
    expect(performanceDateDomain(events(), [])).toBeNull();
  });
});

describe("performanceFilter — consistency with the stored aggregates", () => {
  it("reproduces the stored buckets and sources when refiltered over the full range", () => {
    // Guard against the stored path and the filtered path drifting apart: the
    // report below is what the backtest itself produced from these events.
    const ev = events({
      scores: [
        { ticker: "AAA", day: "2026-06-01", band: "Strong Buy Candidate", abn: abn(4) },
        { ticker: "BBB", day: "2026-06-02", band: "Buy Candidate", abn: abn(2) },
        { ticker: "CCC", day: "2026-06-03", band: "Watch / Hold", abn: abn(-1) },
      ],
      picks: [
        { ticker: "AAA", day: "2026-06-01", source: "Agent Picks", abn: abn(3) },
        { ticker: "DDD", day: "2026-06-02", source: "Sector Scout", industries: ["ai"], abn: abn(1) },
      ],
      setups: [
        { setupType: "breakout", day: "2026-06-01", result: "win", rMultiple: 2 },
        { setupType: "breakout", day: "2026-06-02", result: "loss", rMultiple: -1 },
      ],
    });
    const full = { from: "2026-06-01", to: "2026-06-03" };

    const a = filterPerformance(reportWith(ev), full);
    const b = filterPerformance(reportWith(ev), { from: "2026-05-01", to: "2026-12-31" });

    // Widening beyond the data changes nothing — the full range is the whole set.
    expect(a.score.buckets).toEqual(b.score.buckets);
    expect(a.picks.sources).toEqual(b.picks.sources);
    expect(a.setups!.byType).toEqual(b.setups!.byType);
    expect(a.score.calibration).toBe("improves"); // 4 > 2 > -1, best band first
  });

  it("matches what the backtest's own aggregators produce from the same events", () => {
    // The real guard: run the events through the aggregators the backtest uses
    // (the stored path) and through filterPerformance (the filtered path). If the
    // adapter that rebuilds studies from stored abnormal returns is wrong, or the
    // two paths ever diverge, this fails.
    const ev = events({
      scores: [
        { ticker: "AAA", day: "2026-06-01", band: "Strong Buy Candidate", abn: abn(4) },
        { ticker: "BBB", day: "2026-06-02", band: "Buy Candidate", abn: abn(2) },
        { ticker: "CCC", day: "2026-06-03", band: "Buy Candidate", abn: abn(-3) },
      ],
      picks: [
        { ticker: "AAA", day: "2026-06-01", source: "Agent Picks", abn: abn(3) },
        { ticker: "DDD", day: "2026-06-02", source: "Sector Scout", industries: ["ai"], abn: abn(1) },
      ],
      setups: [
        { setupType: "breakout", day: "2026-06-01", result: "win", rMultiple: 2 },
        { setupType: "breakout", day: "2026-06-02", result: "loss", rMultiple: -1 },
        { setupType: "pullback", day: "2026-06-03", result: "no_fill", rMultiple: 0 },
      ],
    });

    const expectedBuckets = bucketAndAggregate(
      ev.scores.map((s) => ({ bucket: s.band, study: studyFromAbn(s.abn) })),
    );
    const expectedSources = poolBySource(
      ev.picks.map((p) => ({ source: p.source, study: studyFromAbn(p.abn) })),
      PICK_SOURCES,
    );
    const expectedSetups = aggregateSetups(
      ev.setups
        .filter((s) => s.result !== "pending")
        .map((s) => ({
          setupType: s.setupType,
          outcome: {
            result: s.result as Exclude<typeof s.result, "pending">,
            rMultiple: s.rMultiple!,
            exitPrice: 0,
            exitDate: s.day,
            barsHeld: 0,
          },
        })),
    );

    const res = filterPerformance(reportWith(ev), { from: "2026-06-01", to: "2026-06-03" });

    expect(res.score.buckets).toEqual(expectedBuckets);
    expect(res.picks.sources).toEqual(expectedSources);
    expect(res.setups!.byType).toEqual(expectedSetups.byType);
    expect(res.setups!.overall).toEqual(expectedSetups.overall);
  });
});
