"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { useApiAction } from "./useApiAction";

// Controls + acknowledge for the /alerts history page (roadmap #27).

export function AlertFilters({
  severity,
  ticker,
  ack,
  tickers,
}: {
  severity: string;
  ticker: string;
  ack: string;
  tickers: string[];
}) {
  const router = useRouter();
  const [navigating, startNav] = useTransition();

  function setParam(key: string, value: string) {
    const params = new URLSearchParams({ severity, ticker, ack });
    if (value) params.set(key, value);
    else params.delete(key);
    // Drop empty params for a clean URL.
    for (const k of ["severity", "ticker", "ack"]) if (!params.get(k)) params.delete(k);
    startNav(() => router.push(`/alerts${params.toString() ? `?${params}` : ""}`));
  }

  const sel = "rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs";
  return (
    <div className="flex flex-wrap items-center gap-2" aria-busy={navigating}>
      <select className={sel} value={severity} onChange={(e) => setParam("severity", e.target.value)}>
        <option value="">All severities</option>
        <option value="critical">Critical</option>
        <option value="warning">Warning</option>
        <option value="info">Info</option>
      </select>
      <select className={sel} value={ack} onChange={(e) => setParam("ack", e.target.value)}>
        <option value="">All</option>
        <option value="unacked">Unacknowledged</option>
        <option value="acked">Acknowledged</option>
      </select>
      <select className={sel} value={ticker} onChange={(e) => setParam("ticker", e.target.value)}>
        <option value="">All tickers</option>
        {tickers.map((t) => (
          <option key={t} value={t}>
            {t}
          </option>
        ))}
      </select>
    </div>
  );
}

/** Bulk-ack every unacked alert matching the page's current filters (roadmap #35). */
export function AckAllButton({
  severity,
  ticker,
  count,
}: {
  severity: string;
  ticker: string;
  count: number;
}) {
  const { call, busy } = useApiAction();
  if (count === 0) return null;
  return (
    <button
      type="button"
      className="rounded border border-zinc-700 px-2 py-0.5 text-[11px] text-zinc-400 hover:text-zinc-100"
      disabled={busy}
      onClick={() =>
        call("/api/alerts/ack-all", {
          body: {
            ...(severity ? { severity } : {}),
            ...(ticker ? { ticker } : {}),
          },
        })
      }
      title="Acknowledge every unacknowledged alert matching the current filters"
    >
      {busy ? "…" : `Acknowledge all shown (${count})`}
    </button>
  );
}

export function AckAlertButton({ id }: { id: number }) {
  const { call, busy } = useApiAction();
  return (
    <button
      type="button"
      className="rounded border border-zinc-700 px-2 py-0.5 text-[11px] text-zinc-400 hover:text-zinc-100"
      disabled={busy}
      onClick={() => call("/api/alerts", { method: "PATCH", body: { id } })}
      title="Acknowledge this alert"
    >
      {busy ? "…" : "Ack"}
    </button>
  );
}
