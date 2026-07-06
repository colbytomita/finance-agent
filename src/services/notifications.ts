// Outbound alert notifications (roadmap #9): the alerts feed only shows when
// you look at it, so high-severity alerts (stop-loss proximity, exit
// recommendations) are also pushed out-of-app. Two zero-to-low-setup channels:
//   - desktop: native macOS notification via osascript (no setup at all)
//   - ntfy:    POST to https://ntfy.sh/<topic>; subscribe on your phone/browser
// Both are best-effort and never throw — a notification failure must never
// break alert generation. emitAlert() calls notifyAlert() on every new insert.

import { execFile } from "node:child_process";
import { loadConfig, type AppConfig } from "@/lib/config";
import type { AlertSeverity } from "./alerts";

const SEVERITY_RANK: Record<AlertSeverity, number> = { info: 0, warning: 1, critical: 2 };

/** Pure gate: does this severity clear the configured notification bar? */
export function shouldNotify(
  severity: AlertSeverity,
  cfg: Pick<AppConfig, "notifyEnabled" | "notifyMinSeverity">,
): boolean {
  return cfg.notifyEnabled && SEVERITY_RANK[severity] >= SEVERITY_RANK[cfg.notifyMinSeverity];
}

/** Self-hosted ntfy servers work too: NTFY_SERVER=https://ntfy.example.com */
const ntfyServer = () => (process.env.NTFY_SERVER ?? "https://ntfy.sh").replace(/\/$/, "");

async function sendNtfy(
  cfg: AppConfig,
  severity: AlertSeverity,
  message: string,
  ticker: string | null,
): Promise<boolean> {
  if (!cfg.ntfyTopic) return false;
  try {
    const res = await fetch(`${ntfyServer()}/${encodeURIComponent(cfg.ntfyTopic)}`, {
      method: "POST",
      body: message,
      headers: {
        // HTTP header values must be Latin-1 (the body is fine as UTF-8).
        Title: `Finance Agent${ticker ? ` - ${ticker}` : ""}`.replace(/[^\x20-\xff]/g, "?"),
        Priority: severity === "critical" ? "urgent" : severity === "warning" ? "high" : "default",
        Tags: severity === "critical" ? "rotating_light" : severity === "warning" ? "warning" : "information_source",
      },
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function sendDesktop(severity: AlertSeverity, message: string, ticker: string | null): boolean {
  if (process.platform !== "darwin") return false;
  // JSON.stringify gives AppleScript-compatible quoting for quotes/backslashes.
  const script =
    `display notification ${JSON.stringify(message)} ` +
    `with title "Finance Agent" subtitle ${JSON.stringify(`${severity.toUpperCase()}${ticker ? ` · ${ticker}` : ""}`)}` +
    (severity === "critical" ? ` sound name "Sosumi"` : "");
  execFile("osascript", ["-e", script], () => {
    /* best effort */
  });
  return true;
}

/**
 * Push one alert through every configured channel. Fire-and-forget from
 * emitAlert (sync insert path) — never throws, never blocks.
 */
export async function notifyAlert(
  severity: AlertSeverity,
  message: string,
  ticker: string | null = null,
  cfg: AppConfig = loadConfig(),
): Promise<{ desktop: boolean; ntfy: boolean }> {
  if (!shouldNotify(severity, cfg)) return { desktop: false, ntfy: false };
  const desktop = sendDesktop(severity, message, ticker);
  const ntfy = await sendNtfy(cfg, severity, message, ticker);
  return { desktop, ntfy };
}
