import { describe, expect, it } from "vitest";
import { findStopGaps, restoreStopRequest, type CoverageTrade } from "../stopCoverage";

const trade = (over: Partial<CoverageTrade> = {}): CoverageTrade => ({
  id: 1,
  ticker: "QBTS",
  direction: "long",
  shares: 97,
  stopLoss: 15.13,
  broker: "alpaca-paper",
  ...over,
});

const liveStop = { type: "stop", side: "sell", status: "held" };
const liveTarget = { type: "limit", side: "sell", status: "new" };

describe("findStopGaps", () => {
  it("flags a trade whose recorded stop has no live order at the broker", () => {
    // The QBTS case: both bracket legs were cancelled broker-side on 2026-07-27
    // with neither filled, leaving 97 shares completely unprotected.
    const gaps = findStopGaps([trade()], new Map([["QBTS", []]]));
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({ ticker: "QBTS", kind: "missing_at_broker", recordedStop: 15.13 });
  });

  it("does NOT flag a stop that is resting in `held`", () => {
    // A bracket's protective stop waits in `held` until it is triggered. That is
    // live protection, not a gap — treating it as one would cry wolf on the
    // majority of healthy positions.
    expect(findStopGaps([trade({ ticker: "AVGO" })], new Map([["AVGO", [liveStop, liveTarget]]]))).toEqual([]);
  });

  it("does not count a take-profit limit as protection", () => {
    // LLY has a live sell limit at 1329.86 and no stop — a target is not a stop.
    const gaps = findStopGaps([trade({ ticker: "LLY", stopLoss: 1039.45 })], new Map([["LLY", [liveTarget]]]));
    expect(gaps).toHaveLength(1);
    expect(gaps[0].kind).toBe("missing_at_broker");
  });

  it("reports a trade with no stop recorded separately — nothing to restore", () => {
    const gaps = findStopGaps([trade({ ticker: "UPS", stopLoss: null })], new Map([["UPS", []]]));
    expect(gaps[0]).toMatchObject({ ticker: "UPS", kind: "no_stop_defined", recordedStop: null });
  });

  it("ignores trades that were never placed through a broker", () => {
    // A manually logged trade has no broker orders by definition; flagging it
    // would be noise the user can do nothing about.
    expect(findStopGaps([trade({ broker: null })], new Map())).toEqual([]);
  });

  it("treats a filled or cancelled stop as absent", () => {
    const dead = [
      { type: "stop", side: "sell", status: "canceled" },
      { type: "stop", side: "sell", status: "filled" },
    ];
    expect(findStopGaps([trade()], new Map([["QBTS", dead]]))).toHaveLength(1);
  });

  it("matches the protective side for a short (a short is stopped by buying)", () => {
    const shortTrade = trade({ direction: "short", ticker: "XYZ" });
    const buyStop = [{ type: "stop", side: "buy", status: "held" }];
    expect(findStopGaps([shortTrade], new Map([["XYZ", buyStop]]))).toEqual([]);
    // A sell stop would not protect a short position.
    expect(findStopGaps([shortTrade], new Map([["XYZ", [liveStop]]]))).toHaveLength(1);
  });
});

describe("restoreStopRequest", () => {
  it("builds a standalone GTC stop for the full position on the closing side", () => {
    const req = restoreStopRequest(trade());
    expect(req).toMatchObject({
      symbol: "QBTS",
      qty: 97,
      side: "sell",
      type: "stop",
      stopPrice: 15.13,
      timeInForce: "gtc",
    });
    // Never a bracket — that would attach new protective legs to a protective order.
    expect(req.stopLoss).toBeNull();
    expect(req.takeProfit).toBeNull();
  });

  it("refuses to build a request with no recorded stop", () => {
    expect(() => restoreStopRequest(trade({ stopLoss: null }))).toThrow(/no recorded stop/i);
  });
});
