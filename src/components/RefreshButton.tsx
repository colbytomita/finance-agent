"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function RefreshButton() {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const router = useRouter();

  async function refresh() {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/refresh", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "refresh failed");
      const failed = (data.prices ?? []).filter((p: { ok: boolean }) => !p.ok).length;
      setMsg(failed > 0 ? `Done — ${failed} ticker(s) had no data source` : "Refreshed");
      router.refresh();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "refresh failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex items-center gap-2">
      <button className="btn btn-primary" onClick={refresh} disabled={busy}>
        {busy ? "Refreshing…" : "Refresh data"}
      </button>
      {msg && <span className="text-xs text-zinc-500">{msg}</span>}
    </span>
  );
}
