import { describe, expect, it, vi } from "vitest";
import { exitOrderRequest, planExit, type ExitableTrade } from "../tradeExit";

const longTrade: ExitableTrade = {
  id: 1,
  ticker: "MSFT",
  direction: "long",
  shares: 6,
  stopLoss: 366.76,
  targetPrice1: 442.1,
  broker: "alpaca-paper",
  brokerOrderId: "entry-1",
};

describe("exitOrderRequest", () => {
  it("closes a long by selling the trade's share count at market", () => {
    const req = exitOrderRequest(longTrade);
    expect(req).toMatchObject({ symbol: "MSFT", side: "sell", qty: 6, type: "market" });
  });

  it("closes a short by buying back", () => {
    const req = exitOrderRequest({ ...longTrade, direction: "short" });
    expect(req.side).toBe("buy");
  });

  it("never attaches protective legs to the closing order", () => {
    // A bracket on the exit would open a NEW protected position in the opposite
    // direction rather than flattening the existing one.
    const req = exitOrderRequest(longTrade);
    expect(req.stopLoss).toBeNull();
    expect(req.takeProfit).toBeNull();
  });
});

describe("planExit", () => {
  it("refuses when the market is closed — a market order would queue unfilled", () => {
    const plan = planExit(longTrade, { marketOpen: false });
    expect(plan.ok).toBe(false);
    expect(plan.reason).toMatch(/market is closed/i);
  });

  it("refuses a trade that is not broker-linked", () => {
    const plan = planExit({ ...longTrade, broker: null, brokerOrderId: null }, { marketOpen: true });
    expect(plan.ok).toBe(false);
    expect(plan.reason).toMatch(/not linked/i);
  });

  it("refuses a non-positive share count", () => {
    const plan = planExit({ ...longTrade, shares: 0 }, { marketOpen: true });
    expect(plan.ok).toBe(false);
  });

  it("allows a well-formed exit while the market is open", () => {
    expect(planExit(longTrade, { marketOpen: true }).ok).toBe(true);
  });
});

// The dangerous window: legs are cancelled, then the sell fails. The position is
// then sitting with no protective stop, which is strictly worse than before the
// user pressed the button. It must be restored and surfaced loudly.
describe("exitTradeAtBroker — failure recovery", () => {
  it("re-places the protective stop and alerts when the sell fails after cancelling", async () => {
    const { exitTradeAtBroker } = await import("../tradeExit");
    const cancelOrder = vi.fn(async () => {});
    const placeOrder = vi
      .fn()
      .mockRejectedValueOnce(new Error("insufficient buying power")) // the exit sell
      .mockResolvedValueOnce({ id: "restored-stop", status: "new" }); // the restored stop
    const onAlert = vi.fn();

    const svc = {
      cancelOrder,
      placeOrder,
      openOrdersFor: vi.fn(async () => [{ id: "leg-1" }, { id: "leg-2" }]),
      getOrder: vi.fn(),
      getMarketClock: vi.fn(async () => ({ isOpen: true })),
    };

    const result = await exitTradeAtBroker(svc as never, longTrade, { onAlert, closeTradeFn: vi.fn() });

    expect(result.ok).toBe(false);
    // Both resting legs cancelled before attempting the sell.
    expect(cancelOrder).toHaveBeenCalledTimes(2);
    // A replacement protective stop was submitted.
    expect(placeOrder).toHaveBeenCalledTimes(2);
    expect(placeOrder.mock.calls[1][0]).toMatchObject({ symbol: "MSFT", side: "sell", type: "stop" });
    // And the user was told, at critical severity.
    expect(onAlert).toHaveBeenCalled();
    expect(onAlert.mock.calls[0][0]).toBe("critical");
    expect(result.stopRestored).toBe(true);
  });

  it("closes the trade at the ACTUAL fill price on success", async () => {
    const { exitTradeAtBroker } = await import("../tradeExit");
    const closeTradeFn = vi.fn(() => ({ exitPrice: 443.91, profitLoss: 352, profitLossPercent: 15.2 }));
    const svc = {
      cancelOrder: vi.fn(async () => {}),
      openOrdersFor: vi.fn(async () => [{ id: "leg-1" }]),
      placeOrder: vi.fn(async () => ({ id: "exit-1", status: "accepted" })),
      // First poll still working, second poll filled — proves it waits.
      getOrder: vi
        .fn()
        .mockResolvedValueOnce({ id: "exit-1", status: "new", filledAvgPrice: null })
        .mockResolvedValueOnce({ id: "exit-1", status: "filled", filledAvgPrice: 443.91 }),
      getMarketClock: vi.fn(async () => ({ isOpen: true })),
    };

    const result = await exitTradeAtBroker(svc as never, longTrade, {
      closeTradeFn,
      onAlert: vi.fn(),
      sleepFn: async () => {},
    });

    expect(result.ok).toBe(true);
    expect(result.exitPrice).toBe(443.91);
    expect(closeTradeFn).toHaveBeenCalledWith(expect.objectContaining({ exitPrice: 443.91 }));
  });

  it("does not close the trade when the sell never reaches a terminal state", async () => {
    const { exitTradeAtBroker } = await import("../tradeExit");
    const closeTradeFn = vi.fn();
    const svc = {
      cancelOrder: vi.fn(async () => {}),
      openOrdersFor: vi.fn(async () => []),
      placeOrder: vi.fn(async () => ({ id: "exit-1", status: "accepted" })),
      getOrder: vi.fn(async () => ({ id: "exit-1", status: "new", filledAvgPrice: null })),
      getMarketClock: vi.fn(async () => ({ isOpen: true })),
    };

    const result = await exitTradeAtBroker(svc as never, longTrade, {
      closeTradeFn,
      onAlert: vi.fn(),
      sleepFn: async () => {},
      maxPolls: 3,
    });

    // Closing on an unfilled order would record a fictional exit price.
    expect(closeTradeFn).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.pending).toBe(true);
  });
});
