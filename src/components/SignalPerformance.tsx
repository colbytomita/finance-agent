"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function RunBacktestButton() {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const router = useRouter();

  async function run() {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/performance", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "backtest failed");
      setMsg(
        `Analyzed ${data.analyzed} of ${data.sampledEvents} scored day(s) across ${data.tickers} ticker(s)`,
      );
      router.refresh();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "backtest failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex items-center gap-2">
      <button className="btn btn-primary" onClick={run} disabled={busy}>
        {busy ? "Running…" : "Run backtest"}
      </button>
      {msg && <span className="text-xs text-zinc-500">{msg}</span>}
    </span>
  );
}
