// Outbound alert notifications (roadmap #9): the alerts feed only shows when
// you look at it, so high-severity alerts (stop-loss proximity, exit
// recommendations) are also pushed out-of-app. Two zero-to-low-setup channels:
//   - desktop: native notification — macOS via osascript, Windows via a
//     PowerShell WinRT toast (roadmap #15); no setup on either
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
  titleSuffix: string | null,
): Promise<boolean> {
  if (!cfg.ntfyTopic) return false;
  try {
    const res = await fetch(`${ntfyServer()}/${encodeURIComponent(cfg.ntfyTopic)}`, {
      method: "POST",
      body: message,
      headers: {
        // HTTP header values must be Latin-1 (the body is fine as UTF-8).
        Title: `Finance Agent${titleSuffix ? ` - ${titleSuffix}` : ""}`.replace(/[^\x20-\xff]/g, "?"),
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

/** XML-escape text bound for a toast <text> node (also strips PS-quote hazards). */
const xmlEscape = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

// An AppUserModelID that exists on every Windows install (powershell.exe's
// Start-Menu entry) — toasts need a registered AUMID to display, and reusing
// this one avoids any per-app registration. The toast shows as "Windows
// PowerShell"; the first <text> line carries the real app name.
const WINDOWS_TOAST_APP_ID =
  "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe";

export interface DesktopCommand {
  file: string;
  args: string[];
}

/**
 * Build the platform-native desktop-notification command, or null when the
 * platform has none. Pure — unit-tested; sendDesktop just executes the result.
 */
export function desktopCommandFor(
  platform: NodeJS.Platform,
  severity: AlertSeverity,
  message: string,
  subtitle: string,
): DesktopCommand | null {
  if (platform === "darwin") {
    // JSON.stringify gives AppleScript-compatible quoting for quotes/backslashes.
    const script =
      `display notification ${JSON.stringify(message)} ` +
      `with title "Finance Agent" subtitle ${JSON.stringify(subtitle)}` +
      (severity === "critical" ? ` sound name "Sosumi"` : "");
    return { file: "osascript", args: ["-e", script] };
  }
  if (platform === "win32") {
    // Windows PowerShell 5.1 (always present) — pwsh 7 dropped the WinRT
    // projection this relies on. All dynamic text is XML-escaped, which leaves
    // no quote characters, so the single-quoted PS string below can't be broken
    // out of; -EncodedCommand sidesteps shell quoting entirely.
    const toastXml =
      `<toast><visual><binding template="ToastGeneric">` +
      `<text>Finance Agent</text>` +
      `<text>${xmlEscape(subtitle)}</text>` +
      `<text>${xmlEscape(message)}</text>` +
      `</binding></visual>` +
      (severity === "critical"
        ? `<audio src="ms-winsoundevent:Notification.Default"/>`
        : `<audio silent="true"/>`) +
      `</toast>`;
    const script = [
      `[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null`,
      `[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null`,
      `$xml = New-Object Windows.Data.Xml.Dom.XmlDocument`,
      `$xml.LoadXml('${toastXml}')`,
      `$toast = New-Object Windows.UI.Notifications.ToastNotification $xml`,
      `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${WINDOWS_TOAST_APP_ID}').Show($toast)`,
    ].join("; ");
    return {
      file: "powershell.exe",
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-WindowStyle",
        "Hidden",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
    };
  }
  return null;
}

function sendDesktop(severity: AlertSeverity, message: string, subtitle: string): boolean {
  const cmd = desktopCommandFor(process.platform, severity, message, subtitle);
  if (!cmd) return false;
  execFile(cmd.file, cmd.args, () => {
    /* best effort — a missing binary or WinRT failure must never surface */
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
  const desktop = sendDesktop(severity, message, `${severity.toUpperCase()}${ticker ? ` · ${ticker}` : ""}`);
  const ntfy = await sendNtfy(cfg, severity, message, ticker);
  return { desktop, ntfy };
}

// --- Burst digest ------------------------------------------------------------
// One refresh/maintenance cycle can insert several alerts back-to-back (every
// open trade near its stop, plus catalysts, in one pass). Queued alerts are
// collected for a short window and delivered as a single notification instead
// of a rapid-fire series of pings.

export interface QueuedAlert {
  severity: AlertSeverity;
  message: string;
  ticker: string | null;
}

const DIGEST_WINDOW_MS = 3000;
/** Digest body lists at most this many alerts; the rest are summarized. */
const DIGEST_MAX_LINES = 8;

let pending: QueuedAlert[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

const worstSeverity = (items: QueuedAlert[]): AlertSeverity =>
  items.reduce<AlertSeverity>(
    (worst, i) => (SEVERITY_RANK[i.severity] > SEVERITY_RANK[worst] ? i.severity : worst),
    "info",
  );

/** Collapse a burst into one notification's parts. Pure — unit-tested. */
export function buildDigest(items: QueuedAlert[]): {
  severity: AlertSeverity;
  titleSuffix: string;
  subtitle: string;
  body: string;
} {
  const severity = worstSeverity(items);
  const critical = items.filter((i) => i.severity === "critical").length;
  const lines = items.slice(0, DIGEST_MAX_LINES).map((i) => {
    // Alert messages conventionally lead with "TICKER: …" — don't repeat it.
    const prefix = i.ticker && !i.message.startsWith(`${i.ticker}:`) ? `${i.ticker}: ` : "";
    return `[${i.severity}] ${prefix}${i.message}`;
  });
  if (items.length > DIGEST_MAX_LINES) lines.push(`…and ${items.length - DIGEST_MAX_LINES} more`);
  return {
    severity,
    titleSuffix: `${items.length} alerts`,
    subtitle: `${items.length} alerts${critical > 0 ? ` · ${critical} critical` : ""}`,
    body: lines.join("\n"),
  };
}

async function flushPending(): Promise<void> {
  const items = pending;
  pending = [];
  if (items.length === 0) return;
  if (items.length === 1) {
    const { severity, message, ticker } = items[0];
    // The gate already passed at queue time; send unconditionally.
    const cfg = loadConfig();
    sendDesktop(severity, message, `${severity.toUpperCase()}${ticker ? ` · ${ticker}` : ""}`);
    await sendNtfy(cfg, severity, message, ticker);
    return;
  }
  const d = buildDigest(items);
  const cfg = loadConfig();
  sendDesktop(d.severity, d.body, d.subtitle);
  await sendNtfy(cfg, d.severity, d.body, d.titleSuffix);
}

/**
 * Queue an alert for the burst digest. Alerts arriving within a few seconds of
 * each other are delivered as one notification. Never throws; the flush timer
 * is unref'd so short-lived processes still exit cleanly.
 */
export function queueAlertNotification(
  severity: AlertSeverity,
  message: string,
  ticker: string | null = null,
  cfg: AppConfig = loadConfig(),
): void {
  if (!shouldNotify(severity, cfg)) return;
  pending.push({ severity, message, ticker });
  if (!flushTimer) {
    flushTimer = setTimeout(() => {
      flushTimer = null;
      void flushPending().catch(() => {});
    }, DIGEST_WINDOW_MS);
    flushTimer.unref?.();
  }
}

/** Test/shutdown hook: deliver anything queued right now. */
export async function flushQueuedNotifications(): Promise<void> {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  await flushPending();
}
