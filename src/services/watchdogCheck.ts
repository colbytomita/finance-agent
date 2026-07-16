// Pure decision core for the dead-runner watchdog (roadmap #55). Every other
// liveness surface (header badge, /status, alerts, ntfy pushes) is served by
// the very processes that are dead when the answer matters — observed
// 2026-07-13: runner down all market session, zero notice anywhere. A tiny
// scheduled task runs this check from outside the app.

export interface WatchdogDecision {
  notify: boolean;
  /** True when the heartbeat is healthy again — the state file should be wiped. */
  clearState: boolean;
  message: string | null;
}

export function decideWatchdogAction(opts: {
  heartbeatAt: string | null;
  /** From data/watchdog-state.json — when we last nagged, null = never. */
  lastNotifiedAt: string | null;
  now?: Date;
  staleMinutes?: number;
  renotifyHours?: number;
}): WatchdogDecision {
  const now = opts.now ?? new Date();
  const staleMinutes = opts.staleMinutes ?? 10;
  const renotifyHours = opts.renotifyHours ?? 6;

  // Never ran at all: a fresh install, not an outage — don't nag.
  if (opts.heartbeatAt == null) return { notify: false, clearState: false, message: null };

  const hb = new Date(opts.heartbeatAt).getTime();
  const ageMin = isNaN(hb) ? Infinity : (now.getTime() - hb) / 60_000;
  if (ageMin <= staleMinutes) return { notify: false, clearState: true, message: null };

  const lastNotified = opts.lastNotifiedAt ? new Date(opts.lastNotifiedAt).getTime() : NaN;
  const sinceNotifyH = isNaN(lastNotified) ? Infinity : (now.getTime() - lastNotified) / 3600_000;
  if (sinceNotifyH < renotifyHours) return { notify: false, clearState: false, message: null };

  const ageText = Number.isFinite(ageMin)
    ? ageMin >= 120
      ? `${Math.round(ageMin / 60)} hours`
      : `${Math.round(ageMin)} minutes`
    : "unreadably";
  return {
    notify: true,
    clearState: false,
    message:
      `Job runner heartbeat is ${ageText} old — background refreshes, alerts, and maintenance are DOWN. ` +
      `Start it: Start-ScheduledTask -TaskName FinanceAgentJobs (or npm run jobs).`,
  };
}
