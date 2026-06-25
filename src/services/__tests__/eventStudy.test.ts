import { describe, expect, it } from "vitest";
import {
  eventStudy,
  aggregateEventStudies,
  EVENT_WINDOWS,
  type EventStudyResult,
  type EventWindowKey,
  type WindowReturn,
} from "../eventStudy";
import { barsFromCloses } from "./helpers";

// Build a 60-bar series with the event at index 30 so every window
// (pre [-5,0] … post [0,+20]) is covered.
const EVENT_IDX = 30;
const LEN = 60;

function flat(value: number): number[] {
  return Array.from({ length: LEN }, () => value);
}

/** Flat `before`, then `after` from the bar *after* the event index onward. */
function stepAtEvent(before: number, after: number): number[] {
  return Array.from({ length: LEN }, (_, i) => (i <= EVENT_IDX ? before : after));
}

describe("eventStudy", () => {
  it("reports a positive abnormal post-return when the stock jumps and SPY is flat", () => {
    const bars = barsFromCloses(stepAtEvent(100, 110)); // +10% right after event
    const spy = barsFromCloses(flat(400)); // market flat
    const eventDate = bars[EVENT_IDX].date;

    const r = eventStudy(bars, spy, eventDate);
    expect(r).not.toBeNull();
    expect(r!.eventIndex).toBe(EVENT_IDX);

    const post1 = r!.windows.post1;
    expect(post1.stockReturnPct).toBeCloseTo(10, 5);
    expect(post1.marketReturnPct).toBeCloseTo(0, 5);
    expect(post1.abnormalReturnPct).toBeCloseTo(10, 5);
    expect(post1.abnormalReturnPct!).toBeGreaterThan(0);

    // Pre-window saw no move.
    expect(r!.windows.pre5.stockReturnPct).toBeCloseTo(0, 5);
  });

  it("reports a negative abnormal return when the stock is flat but SPY rises (market subtraction works)", () => {
    const bars = barsFromCloses(flat(100)); // stock flat
    const spy = barsFromCloses(stepAtEvent(400, 440)); // market +10% after event
    const eventDate = bars[EVENT_IDX].date;

    const r = eventStudy(bars, spy, eventDate);
    expect(r).not.toBeNull();
    const post1 = r!.windows.post1;
    expect(post1.stockReturnPct).toBeCloseTo(0, 5);
    expect(post1.marketReturnPct).toBeCloseTo(10, 5);
    expect(post1.abnormalReturnPct).toBeCloseTo(-10, 5);
    expect(post1.abnormalReturnPct!).toBeLessThan(0);
  });

  it("returns null when the event date is after the last available bar", () => {
    const bars = barsFromCloses(flat(100).slice(0, 5));
    const spy = barsFromCloses(flat(400).slice(0, 5));
    expect(eventStudy(bars, spy, "2099-01-01")).toBeNull();
  });

  it("returns null on empty bars and never throws", () => {
    expect(eventStudy([], [], "2025-02-01")).toBeNull();
  });

  it("returns null when the event predates the price history (no misattribution to a distant bar)", () => {
    // Bars start 2025-01-01; an event years earlier must NOT snap to bar[0].
    const bars = barsFromCloses(flat(100));
    const spy = barsFromCloses(flat(400));
    expect(eventStudy(bars, spy, "2016-12-06")).toBeNull();
    // A few days before the first bar is still acceptable (small gap).
    expect(eventStudy(bars, spy, "2024-12-30")).not.toBeNull();
  });

  it("marks windows unavailable (not null result) when bars don't reach far enough", () => {
    // 8 bars, event at index 5: pre5 covered, post1 covered, post5/post20 not.
    const closes = flat(100).slice(0, 8);
    const bars = barsFromCloses(closes);
    const spy = barsFromCloses(flat(400).slice(0, 8));
    const r = eventStudy(bars, spy, bars[5].date);
    expect(r).not.toBeNull();
    expect(r!.windows.post1.available).toBe(true);
    expect(r!.windows.post5.available).toBe(false);
    expect(r!.windows.post5.abnormalReturnPct).toBeNull();
    expect(r!.windows.post20.available).toBe(false);
  });
});

// Build a minimal EventStudyResult with a chosen abnormal return for one window.
function resultWithAbnormal(key: EventWindowKey, abnormal: number): EventStudyResult {
  const windows = {} as Record<EventWindowKey, WindowReturn>;
  for (const w of EVENT_WINDOWS) {
    windows[w.key] =
      w.key === key
        ? {
            stockReturnPct: abnormal,
            marketReturnPct: 0,
            abnormalReturnPct: abnormal,
            available: true,
          }
        : {
            stockReturnPct: null,
            marketReturnPct: null,
            abnormalReturnPct: null,
            available: false,
          };
  }
  return { eventDate: "2025-01-01", resolvedEventDate: "2025-01-01", eventIndex: 0, windows };
}

describe("aggregateEventStudies", () => {
  it("computes n, mean, and hit rate over pooled events", () => {
    const results = [
      resultWithAbnormal("post5", 2),
      resultWithAbnormal("post5", 4),
      resultWithAbnormal("post5", -1),
    ];
    const summary = aggregateEventStudies(results);
    expect(summary.totalEvents).toBe(3);

    const post5 = summary.windows.find((w) => w.key === "post5")!;
    expect(post5.n).toBe(3);
    expect(post5.meanAbnormalReturnPct).toBeCloseTo((2 + 4 - 1) / 3, 6);
    expect(post5.hitRate).toBeCloseTo((2 / 3) * 100, 6);
    expect(post5.stdDev).not.toBeNull();
    expect(post5.tStat).not.toBeNull();

    // A window with no data stays null rather than 0.
    const post1 = summary.windows.find((w) => w.key === "post1")!;
    expect(post1.n).toBe(0);
    expect(post1.meanAbnormalReturnPct).toBeNull();
    expect(post1.hitRate).toBeNull();
    expect(post1.tStat).toBeNull();
  });

  it("guards the significance proxy when n < 2", () => {
    const summary = aggregateEventStudies([resultWithAbnormal("post5", 3)]);
    const post5 = summary.windows.find((w) => w.key === "post5")!;
    expect(post5.n).toBe(1);
    expect(post5.meanAbnormalReturnPct).toBeCloseTo(3, 6);
    expect(post5.stdDev).toBeNull();
    expect(post5.tStat).toBeNull();
  });
});
