"use client";

// Header badge polling /api/jobs: green "Jobs 1m ago" while the scheduler
// heartbeat is fresh, red "Jobs stalled/not running" when it stops — the only
// place the UI says anything when `npm run jobs` dies.

import { useEffect, useState } from "react";

interface JobRow {
  job: string;
  lastRunAt: string;
  status: string;
  message: string | null;
}

interface Health {
  jobs: JobRow[];
  heartbeatAgeMinutes: number | null;
  stale: boolean;
}

const POLL_MS = 60_000;

const ago = (min: number) =>
  min < 1 ? "just now" : min < 60 ? `${min}m ago` : `${Math.round(min / 6) / 10}h ago`;

export function JobHealthBadge() {
  const [health, setHealth] = useState<Health | null>(null);

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const res = await fetch("/api/jobs");
        if (res.ok && alive) setHealth((await res.json()) as Health);
      } catch {
        // Leave the last known state; the next poll retries.
      }
    };
    void poll();
    const id = setInterval(() => void poll(), POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  if (!health) return null;

  const { heartbeatAgeMinutes: age, stale } = health;
  const label =
    age == null ? "Jobs not running" : stale ? `Jobs stalled ${ago(age)}` : `Jobs ${ago(age)}`;
  const detail = health.jobs
    .map((j) => `${j.job}: ${new Date(j.lastRunAt).toLocaleString()} (${j.status})`)
    .join("\n");

  return (
    <span
      title={detail || "The background job runner (npm run jobs) has never reported."}
      className={`flex items-center gap-1.5 text-[11px] ${stale ? "text-red-400" : "text-zinc-500"}`}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${stale ? "bg-red-500" : "bg-emerald-500"}`}
      />
      {label}
    </span>
  );
}
