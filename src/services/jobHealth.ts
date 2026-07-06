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
