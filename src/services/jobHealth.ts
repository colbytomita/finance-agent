// Scheduler heartbeat plumbing. The job runner records a row per job name on
// every tick/run; the dashboard header polls getJobHealth() to show "jobs last
// ran X min ago" and turn red when the heartbeat stops (dead `npm run jobs`).

import { getDb, schema } from "@/db";
import { nowIso } from "@/lib/util";

export type JobName = "heartbeat" | "refresh" | "daily_maintenance" | "catalyst_scan";

/** The refresh loop ticks every minute; past this the runner is presumed dead. */
export const HEARTBEAT_STALE_MINUTES = 5;

/** Upsert the heartbeat row for `job`. Never throws — health tracking must not break jobs. */
export function recordJobRun(job: JobName, status: "ok" | "error" = "ok", message?: string): void {
  try {
    getDb()
      .insert(schema.jobRuns)
      .values({ job, lastRunAt: nowIso(), status, message: message ?? null })
      .onConflictDoUpdate({
        target: schema.jobRuns.job,
        set: { lastRunAt: nowIso(), status, message: message ?? null },
      })
      .run();
  } catch {
    // Best effort.
  }
}

export interface JobHealth {
  jobs: (typeof schema.jobRuns.$inferSelect)[];
  /** Minutes since the scheduler's last heartbeat tick; null = never ran. */
  heartbeatAgeMinutes: number | null;
  /** True when the runner has never reported or its heartbeat is too old. */
  stale: boolean;
}

/** Local calendar date key (YYYY-MM-DD) — lexicographic order == date order. */
const localDateKey = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/**
 * Is the daily maintenance due now? (roadmap #52) Anchored to the local
 * calendar day: due once past `dueHour` local until a run COMPLETES with
 * today's local date. The old ">20h since last run" anchor drifted later
 * every time a catch-up ran late (a 17:18 catch-up pushed the next due-time
 * to 13:18, past the machine's bedtime — 2026-07-12 was silently skipped).
 * A run killed mid-flight keeps yesterday's stamp, so it self-heals at the
 * next tick. An `error` completion stamps today, so a failing maintenance
 * retries tomorrow, not every minute (unchanged from #48). Pure.
 */
export function isMaintenanceDue(
  lastRunAt: string | null | undefined,
  now = new Date(),
  dueHour = 8,
): boolean {
  if (now.getHours() < dueHour) return false;
  if (!lastRunAt) return true;
  const t = new Date(lastRunAt);
  if (isNaN(t.getTime())) return true;
  return localDateKey(t) < localDateKey(now);
}

/**
 * Is the 4-hourly catalyst scan due now? (roadmap #52) The old cron (every
 * 4th hour, weekdays) only fired when the machine was awake at those exact
 * minutes and had no catch-up — it last ran Friday evening and then missed
 * a whole Monday. Interval-anchored: weekdays only, due when never run or
 * the last run is older than `intervalHours`. Pure.
 */
export function isCatalystScanDue(
  lastRunAt: string | null | undefined,
  now = new Date(),
  intervalHours = 4,
): boolean {
  const day = now.getDay();
  if (day === 0 || day === 6) return false;
  if (!lastRunAt) return true;
  const t = new Date(lastRunAt).getTime();
  return isNaN(t) || now.getTime() - t > intervalHours * 3600_000;
}

export function getJobHealth(): JobHealth {
  const jobs = getDb().select().from(schema.jobRuns).all();
  const hb = jobs.find((j) => j.job === "heartbeat");
  const heartbeatAgeMinutes = hb
    ? Math.max(0, Math.round((Date.now() - new Date(hb.lastRunAt).getTime()) / 60_000))
    : null;
  return {
    jobs,
    heartbeatAgeMinutes,
    stale: heartbeatAgeMinutes == null || heartbeatAgeMinutes > HEARTBEAT_STALE_MINUTES,
  };
}
