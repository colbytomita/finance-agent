import { describe, expect, it } from "vitest";
import {
  resolveSetupOutcome,
  aggregateSetups,
  dedupeSetups,
  type SetupInput,
  type SetupOutcome,
} from "../setupPerformance";
import type { Bar } from "@/lib/types";

// A long setup: entry 100 (mid of 99–101), stop 95 (risk 5), target 110 (reward 10 → 2R).
const setup: SetupInput = {
  setupType: "breakout",
  detectedAt: "2026-01-01",
  entryRangeLow: 99,
  entryRangeHigh: 101,
  stopLoss: 95,
  targetPrice1: 110,
};

// Bar factory; date sequence starts the day after detection.
const bar = (date: string, o: number, h: number, l: number, c: number): Bar => ({
  date,
  open: o,
  high: h,
  low: l,
  close: c,
  volume: 1_000_000,
});

const days = (specs: [string, number, number, number, number][]): Bar[] =>
  specs.map(([d, o, h, l, c]) => bar(d, o, h, l, c));

describe("resolveSetupOutcome", () => {
  it("target touched first is a win at +2R (after the entry zone is reached)", () => {
    const bars = days([
      ["2026-01-02", 101, 105, 99, 104], // range 99–105 overlaps entry 99–101 → fill at ~100
      ["2026-01-03", 104, 111, 103, 110], // high 111 ≥ target 110 → win
    ]);
    const o = resolveSetupOutcome(setup, bars, 2)!; // full 2-bar horizon
    expect(o.result).toBe("win");
    expect(o.rMultiple).toBe(2); // (110-100)/5
    expect(o.barsHeld).toBe(2);
  });

  it("stop touched first is a loss at −1R", () => {
    const bars = days([
      ["2026-01-02", 100, 102, 94, 96], // enters zone AND low 94 ≤ stop 95 → loss same bar
      ["2026-01-03", 96, 112, 96, 110],
    ]);
    const o = resolveSetupOutcome(setup, bars, 2)!;
    expect(o.result).toBe("loss");
    expect(o.rMultiple).toBe(-1);
  });

  it("same-bar stop + target is scored as a stop (conservative)", () => {
    const bars = days([["2026-01-02", 100, 111, 94, 100]]); // enters zone, touches both
    const o = resolveSetupOutcome(setup, bars, 1)!;
    expect(o.result).toBe("loss");
    expect(o.rMultiple).toBe(-1);
  });

  it("a gap-down open below the stop fills at the open (worse than −1R)", () => {
    // Bar enters the zone (high 100 ≥ entryLow 99) but opens at 90 below the stop.
    const bars = days([["2026-01-02", 90, 100, 89, 96]]);
    const o = resolveSetupOutcome(setup, bars, 1)!;
    expect(o.result).toBe("loss");
    expect(o.exitPrice).toBe(90);
    expect(o.rMultiple).toBeLessThan(-1);
  });

  it("counts a setup that never reaches its entry zone as no_fill (not a win)", () => {
    // Price gaps above the entry zone and runs to target — but was never fillable.
    const bars = days([
      ["2026-01-02", 106, 108, 105, 107],
      ["2026-01-03", 107, 112, 106, 111], // hits target price, but entry never reached
    ]);
    const o = resolveSetupOutcome(setup, bars, 2)!; // horizon 2 fully elapsed
    expect(o.result).toBe("no_fill");
    expect(o.rMultiple).toBe(0);
  });

  it("filled but neither touched within the horizon → expired, marked to market", () => {
    const bars = days([
      ["2026-01-02", 100, 103, 98, 102], // fills at entry 100
      ["2026-01-03", 102, 104, 99, 103], // last close 103 → (103-100)/5 = +0.6R
    ]);
    const o = resolveSetupOutcome(setup, bars, 2)!;
    expect(o.result).toBe("expired");
    expect(o.rMultiple).toBe(0.6);
  });

  it("is unmatured (null) until the full horizon of forward bars exists", () => {
    // Only 2 forward bars but a 20-bar horizon → not judged yet (unbiased maturity).
    expect(resolveSetupOutcome(setup, days([["2026-01-02", 100, 103, 98, 102]]), 20)).toBeNull();
    expect(resolveSetupOutcome(setup, days([["2026-01-02", 106, 108, 105, 107]]), 20)).toBeNull();
  });

  it("returns null with no forward bars or bad geometry", () => {
    expect(resolveSetupOutcome(setup, [], 1)).toBeNull();
    expect(resolveSetupOutcome(setup, days([["2026-01-01", 100, 111, 90, 100]]), 1)).toBeNull();
    expect(
      resolveSetupOutcome({ ...setup, stopLoss: 105 }, days([["2026-01-02", 100, 111, 90, 100]]), 1),
    ).toBeNull();
  });
});

describe("dedupeSetups", () => {
  const s = (ticker: string, setupType: string, detectedAt: string) => ({ ticker, setupType, detectedAt });

  it("collapses a persistent re-detected setup to its earliest appearance", () => {
    // Same MU breakout re-inserted on consecutive days → one signal (first day).
    const rows = [
      s("MU", "breakout", "2026-01-01T00:00:00Z"),
      s("MU", "breakout", "2026-01-02T00:00:00Z"),
      s("MU", "breakout", "2026-01-03T00:00:00Z"),
    ];
    const out = dedupeSetups(rows, 10);
    expect(out).toHaveLength(1);
    expect(out[0].detectedAt).toBe("2026-01-01T00:00:00Z");
  });

  it("starts a new episode after a gap longer than gapDays", () => {
    const rows = [
      s("MU", "breakout", "2026-01-01T00:00:00Z"),
      s("MU", "breakout", "2026-01-02T00:00:00Z"),
      s("MU", "breakout", "2026-02-01T00:00:00Z"), // ~30d later → new episode
    ];
    const out = dedupeSetups(rows, 10).sort((a, b) => a.detectedAt.localeCompare(b.detectedAt));
    expect(out.map((r) => r.detectedAt)).toEqual(["2026-01-01T00:00:00Z", "2026-02-01T00:00:00Z"]);
  });

  it("keeps different tickers and setup types separate", () => {
    const rows = [
      s("MU", "breakout", "2026-01-01T00:00:00Z"),
      s("MU", "pullback_to_support", "2026-01-01T00:00:00Z"),
      s("NVDA", "breakout", "2026-01-01T00:00:00Z"),
    ];
    expect(dedupeSetups(rows, 10)).toHaveLength(3);
  });
});

describe("aggregateSetups", () => {
  const oc = (setupType: string, result: SetupOutcome["result"], r: number): { setupType: string; outcome: SetupOutcome } => ({
    setupType,
    outcome: { result, rMultiple: r, exitPrice: 0, exitDate: "2026-01-02", barsHeld: 1 },
  });

  it("pools per type and overall; win rate + expectancy exclude no-fills", () => {
    const { byType, overall } = aggregateSetups([
      oc("breakout", "win", 2),
      oc("breakout", "loss", -1),
      oc("breakout", "expired", 0.5),
      oc("breakout", "no_fill", 0), // excluded from triggered/winRate/avgR
      oc("pullback", "win", 2),
    ]);

    const breakout = byType.find((b) => b.setupType === "breakout")!;
    expect(breakout.matured).toBe(4);
    expect(breakout.triggered).toBe(3); // no_fill excluded
    expect(breakout.noFill).toBe(1);
    expect(breakout.wins).toBe(1);
    expect(breakout.losses).toBe(1);
    expect(breakout.expired).toBe(1);
    expect(breakout.winRate).toBe(50); // 1 win of 2 resolved
    expect(breakout.avgR).toBeCloseTo((2 - 1 + 0.5) / 3, 2); // over triggered only

    // Most-sampled type first.
    expect(byType[0].setupType).toBe("breakout");

    expect(overall.setupType).toBe("All setups");
    expect(overall.matured).toBe(5);
    expect(overall.triggered).toBe(4);
    expect(overall.wins).toBe(2);
    expect(overall.winRate).toBeCloseTo((2 / 3) * 100, 1); // 2 wins of 3 resolved
  });

  it("reports null win rate when nothing resolved, and null avgR when nothing triggered", () => {
    const expiredOnly = aggregateSetups([oc("breakout", "expired", 0.2)]).overall;
    expect(expiredOnly.winRate).toBeNull(); // no wins or losses
    expect(expiredOnly.avgR).toBe(0.2); // expired counts toward expectancy

    const noFillOnly = aggregateSetups([oc("breakout", "no_fill", 0)]).overall;
    expect(noFillOnly.triggered).toBe(0);
    expect(noFillOnly.avgR).toBeNull();
    expect(noFillOnly.winRate).toBeNull();
  });
});
