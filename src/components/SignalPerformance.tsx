"use client";

import { useApiAction } from "./useApiAction";

export function RunBacktestButton() {
  const { call, busy, msg, error } = useApiAction();

  const run = () =>
    call<{
      score?: { analyzed?: number };
      picks?: { analyzed?: number };
      trades?: { closed?: number };
    }>("/api/performance", {
      errorText: "backtest failed",
      message: (d) =>
        `Scores: ${d.score?.analyzed ?? 0} analyzed · Picks: ${d.picks?.analyzed ?? 0} · Trades: ${d.trades?.closed ?? 0} closed`,
    });

  return (
    <span className="inline-flex items-center gap-2">
      <button className="btn btn-primary" onClick={run} disabled={busy}>
        {busy ? "Running…" : "Run backtest"}
      </button>
      {(msg ?? error) && <span className="text-xs text-zinc-500">{msg ?? error}</span>}
    </span>
  );
}
