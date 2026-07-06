import { describe, expect, it } from "vitest";
import { buildDigest, shouldNotify, type QueuedAlert } from "../notifications";

describe("shouldNotify", () => {
  it("is off when notifications are disabled", () => {
    expect(shouldNotify("critical", { notifyEnabled: false, notifyMinSeverity: "info" })).toBe(false);
  });

  it("gates by minimum severity", () => {
    const cfg = { notifyEnabled: true, notifyMinSeverity: "warning" as const };
    expect(shouldNotify("info", cfg)).toBe(false);
    expect(shouldNotify("warning", cfg)).toBe(true);
    expect(shouldNotify("critical", cfg)).toBe(true);
  });

  it("critical-only default lets only critical through", () => {
    const cfg = { notifyEnabled: true, notifyMinSeverity: "critical" as const };
    expect(shouldNotify("info", cfg)).toBe(false);
    expect(shouldNotify("warning", cfg)).toBe(false);
    expect(shouldNotify("critical", cfg)).toBe(true);
  });
});

describe("buildDigest", () => {
  const q = (severity: QueuedAlert["severity"], ticker: string, message: string): QueuedAlert => ({
    severity,
    ticker,
    message,
  });

  it("uses the worst severity and counts criticals", () => {
    const d = buildDigest([
      q("warning", "MSFT", "near stop"),
      q("critical", "NVDA", "stop hit"),
      q("info", "AAPL", "target reached"),
    ]);
    expect(d.severity).toBe("critical");
    expect(d.titleSuffix).toBe("3 alerts");
    expect(d.subtitle).toBe("3 alerts · 1 critical");
    expect(d.body.split("\n")).toEqual([
      "[warning] MSFT: near stop",
      "[critical] NVDA: stop hit",
      "[info] AAPL: target reached",
    ]);
  });

  it("caps the body and summarizes the overflow", () => {
    const items = Array.from({ length: 12 }, (_, i) => q("warning", `T${i}`, `alert ${i}`));
    const d = buildDigest(items);
    const lines = d.body.split("\n");
    expect(lines).toHaveLength(9); // 8 alerts + overflow line
    expect(lines.at(-1)).toBe("…and 4 more");
    expect(d.subtitle).toBe("12 alerts");
  });
});
