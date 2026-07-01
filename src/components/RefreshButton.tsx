"use client";

import { useApiAction } from "./useApiAction";

export function RefreshButton() {
  const { call, busy, msg, error } = useApiAction();

  const refresh = () =>
    call<{ prices?: { ok: boolean }[] }>("/api/refresh", {
      errorText: "refresh failed",
      message: (d) => {
        const failed = (d.prices ?? []).filter((p) => !p.ok).length;
        return failed > 0 ? `Done — ${failed} ticker(s) had no data source` : "Refreshed";
      },
    });

  return (
    <span className="inline-flex items-center gap-2">
      <button className="btn btn-primary" onClick={refresh} disabled={busy}>
        {busy ? "Refreshing…" : "Refresh data"}
      </button>
      {(msg ?? error) && <span className="text-xs text-zinc-500">{msg ?? error}</span>}
    </span>
  );
}
