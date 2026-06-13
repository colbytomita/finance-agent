"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function SyncPortfolioButton() {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const router = useRouter();

  async function sync() {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/portfolio/sync", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "sync failed");
      setMsg(`Synced ${data.synced} position(s)`);
      router.refresh();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "sync failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex items-center gap-2">
      <button className="btn" onClick={sync} disabled={busy}>
        {busy ? "Syncing…" : "Sync from Alpaca"}
      </button>
      {msg && <span className="text-xs text-zinc-500">{msg}</span>}
    </span>
  );
}
