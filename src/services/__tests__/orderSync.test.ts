import { describe, expect, it } from "vitest";
import type { AlpacaOrder } from "../alpaca";
import { planOrderSync, TERMINAL_ORDER_STATUSES, type SyncableTrade } from "../orderSync";

// Pure decision logic: given a logged trade and its broker order's current
// state, what should happen to the trade row?

function order(overrides: Partial<AlpacaOrder>): AlpacaOrder {
  return {
    id: "ord-1",
    symbol: "MSFT",
    qty: 10,
    side: "buy",
    type: "limit",
    orderClass: null,
    status: "new",
    limitPrice: 400,
    filledAvgPrice: null,
    filledQty: null,
    submittedAt: "2026-07-01T14:00:00Z",
    legs: null,
    ...overrides,
  };
}

function trade(overrides: Partial<SyncableTrade> = {}): SyncableTrade {
  return { entryPrice: 400, shares: 10, brokerOrderStatus: null, ...overrides };
}

describe("planOrderSync", () => {
  it("corrects entry price and shares when the fill differs from the logged values", () => {
    const action = planOrderSync(
      trade(),
      order({ status: "filled", filledAvgPrice: 399.5, filledQty: 10 }),
    );
    expect(action).toEqual({ kind: "fill", orderStatus: "filled", entryPrice: 399.5, shares: 10 });
  });

  it("records the terminal status without touching values when the fill matches", () => {
    const action = planOrderSync(
      trade(),
      order({ status: "filled", filledAvgPrice: 400, filledQty: 10 }),
    );
    expect(action).toEqual({ kind: "status", orderStatus: "filled" });
  });

  it("does nothing when the matching status is already recorded", () => {
    const action = planOrderSync(
      trade({ brokerOrderStatus: "filled" }),
      order({ status: "filled", filledAvgPrice: 400, filledQty: 10 }),
    );
    expect(action).toEqual({ kind: "none" });
  });

  it("tracks a partial fill (non-terminal, keeps polling)", () => {
    const action = planOrderSync(
      trade(),
      order({ status: "partially_filled", filledAvgPrice: 400.1, filledQty: 4 }),
    );
    expect(action).toEqual({
      kind: "fill",
      orderStatus: "partially_filled",
      entryPrice: 400.1,
      shares: 4,
    });
    expect(TERMINAL_ORDER_STATUSES.has("partially_filled")).toBe(false);
  });

  it.each(["canceled", "expired", "rejected"])(
    "cancels the phantom trade when the order is %s with nothing filled",
    (status) => {
      const action = planOrderSync(trade(), order({ status, filledQty: 0 }));
      expect(action).toEqual({ kind: "cancel", orderStatus: status });
      expect(TERMINAL_ORDER_STATUSES.has(status)).toBe(true);
    },
  );

  it("keeps the filled portion when a partially-filled order is canceled", () => {
    const action = planOrderSync(
      trade(),
      order({ status: "canceled", filledAvgPrice: 399.9, filledQty: 6 }),
    );
    expect(action).toEqual({ kind: "fill", orderStatus: "canceled", entryPrice: 399.9, shares: 6 });
  });

  it("flags a replaced order for manual follow-up (fills can't be tracked)", () => {
    const action = planOrderSync(
      trade(),
      order({ status: "replaced", filledAvgPrice: 401, filledQty: 10 }),
    );
    expect(action).toEqual({ kind: "orphaned", orderStatus: "replaced" });
    expect(TERMINAL_ORDER_STATUSES.has("replaced")).toBe(true);
  });

  it("records a working status once, then stays quiet until it changes", () => {
    expect(planOrderSync(trade(), order({ status: "accepted" }))).toEqual({
      kind: "status",
      orderStatus: "accepted",
    });
    expect(planOrderSync(trade({ brokerOrderStatus: "accepted" }), order({ status: "accepted" }))).toEqual(
      { kind: "none" },
    );
  });

  it("falls back to recording the status when a filled order carries no fill data", () => {
    // Shouldn't happen per the API, but must not crash or invent numbers.
    const action = planOrderSync(trade(), order({ status: "filled" }));
    expect(action).toEqual({ kind: "status", orderStatus: "filled" });
  });

  describe("bracket exit legs", () => {
    const filledParent = (legs: AlpacaOrder[]) =>
      order({ status: "filled", filledAvgPrice: 400, filledQty: 10, orderClass: "bracket", legs });

    it("closes the trade when the stop-loss leg fills", () => {
      const action = planOrderSync(
        trade({ brokerOrderStatus: "filled" }),
        filledParent([
          order({ id: "leg-tp", type: "limit", status: "canceled", filledAvgPrice: null }),
          order({ id: "leg-sl", type: "stop", status: "filled", filledAvgPrice: 380.25, filledQty: 10 }),
        ]),
      );
      expect(action).toEqual({ kind: "close", exitPrice: 380.25, legType: "stop_loss" });
    });

    it("closes the trade when the take-profit leg fills", () => {
      const action = planOrderSync(
        trade({ brokerOrderStatus: "filled" }),
        filledParent([
          order({ id: "leg-tp", type: "limit", status: "filled", filledAvgPrice: 440.5, filledQty: 10 }),
          order({ id: "leg-sl", type: "stop", status: "new", filledAvgPrice: null }),
        ]),
      );
      expect(action).toEqual({ kind: "close", exitPrice: 440.5, legType: "take_profit" });
    });

    it("stays quiet while exit legs are still working", () => {
      const action = planOrderSync(
        trade({ brokerOrderStatus: "filled" }),
        filledParent([
          order({ id: "leg-tp", type: "limit", status: "new" }),
          order({ id: "leg-sl", type: "stop", status: "held" }),
        ]),
      );
      expect(action).toEqual({ kind: "none" });
    });

    it("reconciles the entry fill before acting on a filled leg", () => {
      // Entry correction takes priority; the close happens on the next poll.
      const action = planOrderSync(
        trade(),
        order({
          status: "filled",
          filledAvgPrice: 399.5,
          filledQty: 10,
          orderClass: "bracket",
          legs: [order({ id: "leg-sl", type: "stop", status: "filled", filledAvgPrice: 380, filledQty: 10 })],
        }),
      );
      expect(action).toEqual({ kind: "fill", orderStatus: "filled", entryPrice: 399.5, shares: 10 });
    });
  });
});
