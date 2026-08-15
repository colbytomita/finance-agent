import { describe, expect, it } from "vitest";
import type { Bar } from "@/lib/types";
import { detectSetups } from "../setupDetection";
import { trendCloses } from "./helpers";

// The setup detectors had no unit coverage — only the outcome resolver
// (setupPerformance) was tested. That gap let `detectBreakout` ship a condition
// that can never describe an actual breakout: `supportResistance` defines
// resistance as the nearest swing high STRICTLY ABOVE price, so the moment price
// clears a level the next level up becomes "resistance". The detector therefore
// only ever fired while price was still under the ceiling.

/** Bars from closes, with an explicit per-bar volume so relativeVolume is controllable. */
function bars(closes: number[], volumes?: number[]): Bar[] {
  return closes.map((c, i) => ({
    date: new Date(Date.UTC(2025, 0, 1) + i * 86400000).toISOString().slice(0, 10),
    open: c * 0.995,
    high: c * 1.005,
    low: c * 0.995,
    close: c,
    volume: volumes?.[i] ?? 1_000_000,
  }));
}

const hasType = (b: Bar[], type: string) => detectSetups(b).some((s) => s.setupType === type);

/**
 * Rally to a peak, pull back, then rally again. `finalClose` decides whether the
 * second rally stops just under the prior peak or closes decisively above it.
 */
function approachThenResolve(finalClose: number, breakoutVolume = 1_000_000): Bar[] {
  const closes = [
    ...trendCloses(100, 120, 22), // rally to the swing high at 120
    ...trendCloses(119, 108, 12), // pull back, confirming 120 as resistance
    ...trendCloses(109, 118, 10), // rally back toward it
    finalClose, // the bar under test
  ];
  const volumes = closes.map(() => 1_000_000);
  volumes[volumes.length - 1] = breakoutVolume;
  return bars(closes, volumes);
}

describe("detectBreakout", () => {
  it("fires when price closes decisively above the prior swing high on volume", () => {
    // 124 is clearly above the 120 peak (and its 120.6 high), on 2x volume.
    expect(hasType(approachThenResolve(124, 2_000_000), "breakout")).toBe(true);
  });

  it("does NOT fire when price is merely approaching resistance from below", () => {
    // 119.9 is a stone's throw under the 120 peak — an approach, not a break.
    // Most approaches to resistance get rejected; that is what makes it resistance.
    expect(hasType(approachThenResolve(119.9), "breakout")).toBe(false);
  });

  it("does NOT fire on a breakout without volume confirmation", () => {
    // Same decisive close, but on average volume — an unconfirmed break.
    expect(hasType(approachThenResolve(124, 900_000), "breakout")).toBe(false);
  });

  it("does NOT fire once the move is extended far beyond the broken level", () => {
    // 140 is ~17% past the 120 level: the break is old news, entry is chasing.
    expect(hasType(approachThenResolve(140, 2_000_000), "breakout")).toBe(false);
  });

  it("places the stop below the level that was broken", () => {
    const setup = detectSetups(approachThenResolve(124, 2_000_000)).find((s) => s.setupType === "breakout");
    expect(setup).toBeDefined();
    // A breakout that fails is one that falls back through the level it cleared.
    expect(setup!.stopLoss).toBeLessThan(120);
    expect(setup!.entryRangeLow).toBeGreaterThan(setup!.stopLoss);
  });
});

describe("detectMaReclaim", () => {
  it("fires when a stock in an uptrend dips below its rising 50-SMA and reclaims it", () => {
    const closes = [
      ...trendCloses(100, 150, 60), // established uptrend, so the 50-SMA is rising
      ...trendCloses(148, 120, 6), // dip clearly through the ~132 average
      134, // reclaim
    ];
    expect(hasType(bars(closes), "ma_reclaim")).toBe(true);
  });

  // Reclaims of a falling 50-SMA still fire on purpose. Filtering them out (the
  // "bull trap" theory) was measured across 288 tickers of history and halved the
  // signal count for an unchanged 35.5% win rate, so the filter was not shipped.
  it("still fires when price reclaims a falling 50-SMA — filtering these showed no edge", () => {
    const closes = [
      ...trendCloses(200, 120, 60), // sustained downtrend — the 50-SMA is falling
      ...trendCloses(122, 150, 6), // sharp bounce that genuinely clears the ~147 average
    ];
    expect(hasType(bars(closes), "ma_reclaim")).toBe(true);
  });
});
