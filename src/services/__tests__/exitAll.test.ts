import { describe, expect, it, vi } from "vitest";
import { exitAllPositions, type BulkExitTarget } from "../exitAll";

const target = (over: Partial<BulkExitTarget> = {}): BulkExitTarget => ({
  id: 1,
  ticker: "QBTS",
  direction: "long",
  shares: 97,
  stopLoss: 15.13,
  broker: "alpaca-paper",
  ...over,
});

/** A stub whose per-ticker behaviour is scripted by the caller. */
function stubExit(script: Record<string, { ok: boolean; exitPrice?: number; reason?: string }>) {
  return vi.fn(async (_svc: unknown, t: BulkExitTarget) => {
    const r = script[t.ticker] ?? { ok: true, exitPrice: 1 };
    return r.ok
      ? { ok: true, exitPrice: r.exitPrice ?? 1, legsCancelled: 1 }
      : { ok: false, reason: r.reason ?? "rejected", stopRestored: false };
  });
}

describe("exitAllPositions", () => {
  it("refuses entirely when the market is closed, before touching anything", async () => {
    const exitOne = stubExit({});
    const res = await exitAllPositions({} as never, [target()], {
      marketOpen: false,
      exitOne,
      onAlert: vi.fn(),
    });
    expect(res.refused).toBe(true);
    expect(exitOne).not.toHaveBeenCalled();
    expect(res.results).toEqual([]);
  });

  it("keeps going after a failure instead of aborting the batch", async () => {
    // The whole point of a bulk exit: one rejected sell must not strand the
    // remaining positions half-exited.
    const exitOne = stubExit({
      QBTS: { ok: true, exitPrice: 21.1 },
      CVX: { ok: false, reason: "insufficient quantity" },
      BAC: { ok: true, exitPrice: 64.5 },
    });
    const res = await exitAllPositions(
      {} as never,
      [target(), target({ id: 2, ticker: "CVX", shares: 16 }), target({ id: 3, ticker: "BAC", shares: 20 })],
      { marketOpen: true, exitOne, onAlert: vi.fn() },
    );
    expect(exitOne).toHaveBeenCalledTimes(3);
    expect(res.succeeded).toBe(2);
    expect(res.failed).toBe(1);
    expect(res.results.find((r) => r.ticker === "CVX")).toMatchObject({ ok: false, reason: "insufficient quantity" });
  });

  it("reports every position individually, in order", async () => {
    const exitOne = stubExit({});
    const res = await exitAllPositions(
      {} as never,
      [target({ ticker: "AAA" }), target({ id: 2, ticker: "BBB" })],
      { marketOpen: true, exitOne, onAlert: vi.fn() },
    );
    expect(res.results.map((r) => r.ticker)).toEqual(["AAA", "BBB"]);
  });

  it("runs sequentially — never fires overlapping orders at the broker", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const exitOne = vi.fn(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return { ok: true, exitPrice: 1, legsCancelled: 0 };
    });
    await exitAllPositions(
      {} as never,
      [target({ ticker: "A" }), target({ id: 2, ticker: "B" }), target({ id: 3, ticker: "C" })],
      { marketOpen: true, exitOne, onAlert: vi.fn() },
    );
    expect(maxInFlight).toBe(1);
  });

  it("raises one summary alert when any position failed to exit", async () => {
    const onAlert = vi.fn();
    const exitOne = stubExit({ CVX: { ok: false, reason: "rejected" } });
    await exitAllPositions({} as never, [target({ id: 2, ticker: "CVX" })], {
      marketOpen: true,
      exitOne,
      onAlert,
    });
    expect(onAlert).toHaveBeenCalledWith("critical", expect.stringContaining("CVX"));
  });

  it("does not alert when everything exited cleanly", async () => {
    const onAlert = vi.fn();
    await exitAllPositions({} as never, [target()], { marketOpen: true, exitOne: stubExit({}), onAlert });
    expect(onAlert).not.toHaveBeenCalled();
  });

  it("skips trades with no shares rather than sending a zero-quantity order", async () => {
    const exitOne = stubExit({});
    const res = await exitAllPositions({} as never, [target({ shares: 0 })], {
      marketOpen: true,
      exitOne,
      onAlert: vi.fn(),
    });
    expect(exitOne).not.toHaveBeenCalled();
    expect(res.results[0]).toMatchObject({ ok: false, skipped: true });
  });
});
