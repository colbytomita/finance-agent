"use client";

import { useApiAction } from "./useApiAction";

export function SyncPortfolioButton() {
  const { call, busy, msg, error } = useApiAction();

  const sync = () =>
    call<{ synced: number }>("/api/portfolio/sync", {
      errorText: "sync failed",
      message: (d) => `Synced ${d.synced} position(s)`,
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
