import { describe, expect, it } from "vitest";
import {
  summarizeClosedTrades,
  type ClosedTradeInput,
  type JournalInput,
} from "../tradePerformance";

const A: ClosedTradeInput = {
  id: 1, direction: "long", entryPrice: 100, exitPrice: 110, stopLoss: 95,
  entryDate: "2026-01-01", closedAt: "2026-01-06", unrealizedGainLoss: 100, unrealizedGainLossPercent: 10,
};
const B: ClosedTradeInput = {
  id: 2, direction: "long", entryPrice: 50, exitPrice: 45, stopLoss: 48,
  entryDate: "2026-01-01", closedAt: "2026-01-04", unrealizedGainLoss: -50, unrealizedGainLossPercent: -10,
};
const C: ClosedTradeInput = {
  id: 3, direction: "short", entryPrice: 200, exitPrice: 180, stopLoss: 210,
  entryDate: "2026-01-01", closedAt: "2026-01-11", unrealizedGainLoss: 100, unrealizedGainLossPercent: 10,
};

// thesisPlayedOut is a real boolean (Drizzle boolean mode), not 1/0.
const journal: JournalInput[] = [
  { tradeId: 1, profitLossPercent: 10, holdingPeriodDays: 5, thesisPlayedOut: true },
  { tradeId: 2, profitLossPercent: -10, holdingPeriodDays: 3, thesisPlayedOut: false },
  { tradeId: 3, profitLossPercent: 10, holdingPeriodDays: 10, thesisPlayedOut: true },
];

describe("tradePerformance.summarizeClosedTrades", () => {
  it("returns an all-null/zero summary when there are no closed trades", () => {
    const s = summarizeClosedTrades([], []);
    expect(s.closed).toBe(0);
    expect(s.winRate).toBeNull();
    expect(s.avgRMultiple).toBeNull();
    expect(s.totalPnl).toBeNull();
  });

  it("computes win/loss, returns, R-multiple, profit factor, holding, and thesis rate", () => {
    const s = summarizeClosedTrades([A, B, C], journal);
    expect(s.closed).toBe(3);
    expect(s.wins).toBe(2);
    expect(s.losses).toBe(1);
    expect(s.breakeven).toBe(0);
    expect(s.winRate).toBeCloseTo(66.67, 1);
    expect(s.avgReturnPct).toBeCloseTo(3.33, 1);
    expect(s.avgWinPct).toBeCloseTo(10);
    expect(s.avgLossPct).toBeCloseTo(-10);
    // R: A=(110-100)/5=2, B=(45-50)/2=-2.5, C short=(180-200)*-1/10=2 → mean 0.5
    expect(s.avgRMultiple).toBeCloseTo(0.5, 5);
    // profit factor = (100+100) / 50
    expect(s.profitFactor).toBeCloseTo(4);
    expect(s.avgHoldingDays).toBeCloseTo(6);
    expect(s.thesisPlayedOutRate).toBeCloseTo(66.67, 1);
    expect(s.totalPnl).toBeCloseTo(150);
    expect(s.bestPct).toBeCloseTo(10);
    expect(s.worstPct).toBeCloseTo(-10);
  });

  it("excludes trades without a stop from the R-multiple, and derives holding days when journal lacks them", () => {
    const noStop: ClosedTradeInput = { ...A, id: 9, stopLoss: null };
    const s = summarizeClosedTrades([noStop], []);
    expect(s.avgRMultiple).toBeNull(); // no valid stop → no R sample
    // holding derived from entryDate→closedAt (2026-01-01 → 2026-01-06 = 5d)
    expect(s.avgHoldingDays).toBeCloseTo(5);
    expect(s.thesisPlayedOutRate).toBeNull(); // no journal outcome recorded
  });

  it("classifies a zero-P/L trade as breakeven, not a win or loss", () => {
    const flat: ClosedTradeInput = { ...A, id: 7, exitPrice: 100, unrealizedGainLoss: 0, unrealizedGainLossPercent: 0 };
    const s = summarizeClosedTrades([flat], []);
    expect(s.wins).toBe(0);
    expect(s.losses).toBe(0);
    expect(s.breakeven).toBe(1);
    expect(s.winRate).toBe(0);
  });
});
