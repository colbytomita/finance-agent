import { describe, expect, it } from "vitest";
import { useTestDb } from "./dbHarness";
import { getDb, schema } from "@/db";
import { staleBrokerHoldings, syncPortfolio } from "../marketData";

useTestDb();

const holding = (ticker: string, source: "alpaca" | "manual", shares = 1) => ({
  ticker,
  shares,
  averageCost: 100,
  currentPrice: 100,
  marketValue: 100 * shares,
  source,
  updatedAt: "2026-08-17T00:00:00Z",
});

const position = (ticker: string, qty: number) => ({
  ticker,
  qty,
  avgEntryPrice: 100,
  currentPrice: 110,
  marketValue: 110 * qty,
  unrealizedPl: 10 * qty,
  unrealizedPlPercent: 10,
});

describe("staleBrokerHoldings", () => {
  it("removes broker-sourced holdings the broker no longer reports", () => {
    // The bug this exists for: syncPortfolio only ever upserted, so a position
    // closed at the broker kept its row forever and kept being repriced.
    const stale = staleBrokerHoldings(
      [holding("AAPL", "alpaca"), holding("QBTS", "alpaca"), holding("GE", "alpaca")],
      new Set(["AAPL"]),
    );
    expect(stale.sort()).toEqual(["GE", "QBTS"]);
  });

  it("never removes a manually-added holding", () => {
    // Manual rows are user-entered positions the broker was never asked about.
    // Deleting them because Alpaca does not report them would destroy real data.
    const stale = staleBrokerHoldings(
      [holding("CASHY", "manual"), holding("QBTS", "alpaca")],
      new Set<string>(),
    );
    expect(stale).toEqual(["QBTS"]);
  });

  it("removes every broker holding when the account is flat", () => {
    // A genuinely flat account returns []. That is a real answer, not an error,
    // and it must clear the book — this is the exact case that left 15 phantom
    // rows worth ~$25k on the portfolio page.
    const stale = staleBrokerHoldings(
      [holding("AAPL", "alpaca"), holding("BAC", "alpaca")],
      new Set<string>(),
    );
    expect(stale.sort()).toEqual(["AAPL", "BAC"]);
  });

  it("keeps holdings the broker still reports", () => {
    expect(staleBrokerHoldings([holding("AAPL", "alpaca")], new Set(["AAPL"]))).toEqual([]);
  });
});

describe("syncPortfolio removal", () => {
  it("deletes holdings that vanished from the broker", async () => {
    getDb()
      .insert(schema.portfolioHoldings)
      .values([holding("AAPL", "alpaca", 2), holding("QBTS", "alpaca", 97)])
      .run();

    const result = await syncPortfolio({ getPositions: async () => [position("AAPL", 2)] });

    expect(result).toMatchObject({ synced: 1, removed: 1 });
    expect(
      getDb().select().from(schema.portfolioHoldings).all().map((h) => h.ticker),
    ).toEqual(["AAPL"]);
  });

  it("removes NOTHING when the broker read fails", async () => {
    // Same rule as the stop-coverage check: a network blip must never be read
    // as "the account is flat" and wipe the user's portfolio.
    getDb()
      .insert(schema.portfolioHoldings)
      .values([holding("AAPL", "alpaca"), holding("QBTS", "alpaca")])
      .run();

    const result = await syncPortfolio({
      getPositions: async () => {
        throw new Error("connect ETIMEDOUT");
      },
    });

    expect(result).toHaveProperty("error");
    expect(getDb().select().from(schema.portfolioHoldings).all()).toHaveLength(2);
  });

  it("leaves a manual holding in place after a flat sync", async () => {
    getDb()
      .insert(schema.portfolioHoldings)
      .values([holding("AAPL", "alpaca"), holding("CASHY", "manual")])
      .run();

    await syncPortfolio({ getPositions: async () => [] });

    expect(
      getDb().select().from(schema.portfolioHoldings).all().map((h) => h.ticker),
    ).toEqual(["CASHY"]);
  });
});
