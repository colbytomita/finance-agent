import { loadConfig } from "@/lib/config";
import {
  activeSetups,
  allWatchlist,
  latestDrawdown,
  openTrades,
  upcomingEarningsCalendar,
} from "@/lib/queries";
import { getMarketRegime } from "./marketRegime";
import { emitAlert } from "./alerts";
import { sendDirectNotification, shouldNotify } from "./notifications";

// Opt-in daily morning brief (roadmap #39): the Summary page condensed into
// one message — market regime, earnings inside the avoid window, trades
// flagged Exit/Trim/weak, watchlist names in their buy zone, and fresh
// quality setups. Emitted once per day (the date in the message makes the
// alert dedupe idempotent) after the 08:00 maintenance refresh, and pushed
// through the notification channels directly — enabling the toggle is the
// opt-in, so the severity gate doesn't apply (the master notifyEnabled
// switch still does). Decision support, not advice.

export interface MorningBrief {
  lines: string[];
  message: string;
}

/** Compose today's brief from current DB state. Empty sections are omitted. */
export function buildMorningBrief(now = new Date()): MorningBrief {
  const cfg = loadConfig();
  const lines: string[] = [];

  lines.push(getMarketRegime().headline);

  const attention = openTrades().filter(
    (t) => t.recommendation === "Exit" || t.recommendation === "Trim" || (t.tradeScore ?? 10) < 5,
  );
  if (attention.length > 0)
    lines.push(
      "Needs attention: " +
        attention
          .map((t) => `${t.ticker} ${t.recommendation ?? "weak"} (score ${t.tradeScore?.toFixed(1) ?? "—"})`)
          .join(", "),
    );

  const earnings = upcomingEarningsCalendar(Math.max(cfg.avoidEarningsWithinDays, 1));
  if (earnings.length > 0)
    lines.push("Earnings soon: " + earnings.map((e) => `${e.ticker} in ${e.daysUntil}d`).join(", "));

  const inZone = allWatchlist().filter(
    (w) => latestDrawdown(w.ticker)?.buyZoneStatus === "In Buy Zone",
  );
  if (inZone.length > 0) lines.push("In buy zone: " + inZone.map((w) => w.ticker).join(", "));

  const setups = activeSetups()
    .filter((s) => s.setupQualityScore >= 7)
    .slice(0, 5);
  if (setups.length > 0)
    lines.push(
      "Setups: " +
        setups
          .map((s) => `${s.ticker} ${s.setupType.replace(/_/g, " ")} (q${s.setupQualityScore.toFixed(1)})`)
          .join(", "),
    );

  const date = now.toISOString().slice(0, 10);
  return { lines, message: `Morning brief ${date} — ${lines.join(" | ")}` };
}

export interface MorningBriefResult {
  sent: boolean;
  reason: "disabled" | "already-sent-today" | "sent";
}

/**
 * Emit today's brief as an info alert (idempotent per day via the alert
 * dedupe) and, when it's new and notifications are on, push it through the
 * channels directly.
 */
export async function sendMorningBrief(now = new Date()): Promise<MorningBriefResult> {
  const cfg = loadConfig();
  if (!cfg.morningBriefEnabled) return { sent: false, reason: "disabled" };
  const brief = buildMorningBrief(now);
  const isNew = emitAlert("morning_brief", "info", brief.message, null);
  if (!isNew) return { sent: false, reason: "already-sent-today" };
  // emitAlert already queued a notification if the severity gate lets info
  // through; only send directly when the gate would have suppressed it, so
  // the brief arrives exactly once either way.
  if (cfg.notifyEnabled && !shouldNotify("info", cfg)) {
    await sendDirectNotification("info", brief.lines.join("\n"), "Morning brief", cfg).catch(
      () => {},
    );
  }
  return { sent: true, reason: "sent" };
}
