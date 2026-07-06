import { describe, expect, it } from "vitest";
import { shouldNotify } from "../notifications";

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
