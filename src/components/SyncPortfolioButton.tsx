"use client";

import { useApiAction } from "./useApiAction";

export function SyncPortfolioButton() {
  const { call, busy, msg, error } = useApiAction();

  const sync = () =>
    call<{ synced: number; removed: number }>("/api/portfolio/sync", {
      errorText: "sync failed",
      // Name the removals explicitly: a sync that drops a closed position is
      // the one case where the table shrinks, and silence there reads as a bug.
      message: (d) =>
        d.removed > 0
          ? `Synced ${d.synced} position(s), removed ${d.removed} closed`
          : `Synced ${d.synced} position(s)`,
    });

  return (
    <span className="inline-flex items-center gap-2">
      <button className="btn" onClick={sync} disabled={busy}>
        {busy ? "Syncing…" : "Sync from Alpaca"}
      </button>
      {(msg ?? error) && <span className="text-xs text-zinc-500">{msg ?? error}</span>}
    </span>
  );
}
