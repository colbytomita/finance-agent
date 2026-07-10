"use client";

// Header chip polling the unacked-alert count (roadmap #42): links to the
// filtered /alerts view; red when anything critical is waiting, otherwise
// muted. Hidden entirely at zero — the quiet state should look quiet.

import Link from "next/link";
import { useEffect, useState } from "react";

interface Counts {
  count: number;
  critical: number;
}

const POLL_MS = 60_000;

export function AlertsBadge() {
  const [counts, setCounts] = useState<Counts | null>(null);

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const res = await fetch("/api/alerts/unacked-count");
        if (res.ok && alive) setCounts((await res.json()) as Counts);
      } catch {
        // Keep the last known state; the next poll retries.
      }
    };
    void poll();
    const id = setInterval(() => void poll(), POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  if (!counts || counts.count === 0) return null;

  const hasCritical = counts.critical > 0;
  return (
    <Link
      href="/alerts?ack=unacked"
      title={
        hasCritical
          ? `${counts.count} unacknowledged alert(s), ${counts.critical} critical`
          : `${counts.count} unacknowledged alert(s)`
      }
      className={`flex items-center gap-1.5 text-[11px] hover:text-zinc-100 ${
        hasCritical ? "text-red-400" : "text-zinc-500"
      }`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${hasCritical ? "bg-red-500" : "bg-amber-500"}`} />
      {counts.count} alert{counts.count === 1 ? "" : "s"}
    </Link>
  );
}
