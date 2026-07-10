import { describe, expect, it, vi } from "vitest";
import {
  buildDigest,
  desktopCommandFor,
  sendTestNotification,
  shouldNotify,
  type QueuedAlert,
} from "../notifications";
import type { AppConfig } from "@/lib/config";

// Keep the channel test from firing a real OS toast during the suite.
vi.mock("node:child_process", () => ({ execFile: vi.fn() }));

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

describe("desktopCommandFor", () => {
  const decodeEncodedCommand = (args: string[]): string => {
    const b64 = args[args.indexOf("-EncodedCommand") + 1];
    return Buffer.from(b64, "base64").toString("utf16le");
  };

  it("darwin: osascript with quoted message, sound only when critical", () => {
    const cmd = desktopCommandFor("darwin", "critical", 'stop "hit"', "CRITICAL · MSFT");
    expect(cmd?.file).toBe("osascript");
    expect(cmd?.args[1]).toContain('display notification "stop \\"hit\\""');
    expect(cmd?.args[1]).toContain("Sosumi");
    expect(desktopCommandFor("darwin", "warning", "near stop", "s")?.args[1]).not.toContain("Sosumi");
  });

  it("win32: powershell toast with all dynamic text XML-escaped", () => {
    const hostile = `<b>&'break"out`;
    const cmd = desktopCommandFor("win32", "warning", hostile, "WARNING · NVDA");
    expect(cmd?.file).toBe("powershell.exe");
    expect(cmd?.args).toContain("-EncodedCommand");
    const script = decodeEncodedCommand(cmd!.args);
    expect(script).toContain("ToastNotificationManager");
    expect(script).toContain("&lt;b&gt;&amp;&apos;break&quot;out");
    expect(script).not.toContain(hostile); // raw text never lands in the script
    expect(script).toContain('<audio silent="true"/>'); // no sound below critical
  });

  it("win32: critical toast plays a sound", () => {
    const script = decodeEncodedCommand(desktopCommandFor("win32", "critical", "stop hit", "CRITICAL")!.args);
    expect(script).toContain("ms-winsoundevent:Notification.Default");
    expect(script).not.toContain('silent="true"');
  });

  it("returns null on platforms without a desktop channel", () => {
    expect(desktopCommandFor("linux", "critical", "m", "s")).toBeNull();
  });
});

describe("sendTestNotification (roadmap #34)", () => {
  it("skips ntfy without a topic and reports the desktop channel per platform", async () => {
    const cfg = { ntfyTopic: "" } as AppConfig; // only ntfyTopic is read
    const r = await sendTestNotification(cfg);
    expect(r.ntfy.attempted).toBe(false);
    expect(r.ntfy.ok).toBe(false);
    expect(r.ntfy.detail).toMatch(/no ntfy topic/i);
    const hasDesktop = process.platform === "win32" || process.platform === "darwin";
    expect(r.desktop.attempted).toBe(hasDesktop);
    expect(r.desktop.ok).toBe(hasDesktop); // execFile is mocked — dispatch only
  });
});
