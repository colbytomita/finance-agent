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

/**
 * Should a startup catch-up run of a daily job happen now? (roadmap #43)
 * A cron only fires while the runner is alive at that moment — an ad-hoc
 * terminal runner misses it routinely (observed: zero daily_maintenance
 * completions ever, and no backups). Due when the job has never completed
 * or its last run is older than `maxAgeHours`. Pure.
 */
export function isDailyJobDue(
  lastRunAt: string | null | undefined,
  now = Date.now(),
  maxAgeHours = 20,
): boolean {
  if (!lastRunAt) return true;
  const t = new Date(lastRunAt).getTime();
  return isNaN(t) || now - t > maxAgeHours * 3600_000;
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
