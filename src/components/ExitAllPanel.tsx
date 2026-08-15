"use client";

import { useState } from "react";
import { useApiAction } from "./useApiAction";

// One reviewed action that closes every open tracked trade (roadmap #76). The
// review table and the typed confirmation are the whole point: this sends a real
// order per position, so it must never be a single stray click.

const CONFIRM_PHRASE = "EXIT ALL";

export interface ExitAllRow {
  tradeId: number;
  ticker: string;
  shares: number;
  entryPrice: number;
  currentPrice: number | null;
  unrealizedPct: number | null;
  isLive: boolean;
}

interface ResultRow {
  ticker: string;
  ok: boolean;
  exitPrice?: number;
  reason?: string;
  skipped?: boolean;
}

export function ExitAllPanel({ rows }: { rows: ExitAllRow[] }) {
  const { call, busy, error } = useApiAction();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [reason, setReason] = useState("");
  const [thesis, setThesis] = useState("");
  const [results, setResults] = useState<ResultRow[] | null>(null);

  if (rows.length === 0) return null;
  const isLive = rows.some((r) => r.isLive);
  const totalPct =
    rows.length > 0
      ? rows.reduce((a, r) => a + (r.unrealizedPct ?? 0), 0) / rows.length
      : 0;

  if (results) {
    const failed = results.filter((r) => !r.ok);
    return (
      <section className="card border-zinc-700">
        <h2 className="card-title">Bulk exit — results</h2>
        <table className="w-full text-sm">
          <tbody>
            {results.map((r) => (
              <tr key={r.ticker} className="border-t border-zinc-800">
                <td className="font-semibold">{r.ticker}</td>
                <td className={r.ok ? "text-emerald-300" : "text-red-400"}>
                  {r.ok ? `exited @ ${r.exitPrice}` : r.skipped ? "skipped" : `FAILED — ${r.reason}`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {failed.length > 0 && (
          <p className="mt-2 text-xs text-red-400">
            {failed.length} position(s) did not exit. Their bracket legs may already be cancelled — check these
            at your broker before doing anything else.
          </p>
        )}
        <button className="btn mt-3" onClick={() => { setResults(null); setOpen(false); setTyped(""); }}>
          Done
        </button>
      </section>
    );
  }

  if (!open) {
    return (
      <button className="btn border-amber-500/60 text-amber-300" onClick={() => setOpen(true)}>
        Exit all {rows.length} positions…
      </button>
    );
  }

  return (
    <section className="card border-amber-500/40">
      <h2 className="card-title text-amber-300">Exit all positions ({rows.length})</h2>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-zinc-500">
              <th>Ticker</th><th>Shares</th><th>Entry</th><th>Now</th><th>P/L</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.tradeId} className="border-t border-zinc-800">
                <td className="font-semibold">{r.ticker}</td>
                <td className="tabular-nums">{r.shares}</td>
                <td className="tabular-nums">{r.entryPrice.toFixed(2)}</td>
                <td className="tabular-nums">{r.currentPrice?.toFixed(2) ?? "—"}</td>
                <td className={`tabular-nums ${(r.unrealizedPct ?? 0) >= 0 ? "text-emerald-300" : "text-red-300"}`}>
                  {r.unrealizedPct != null ? `${r.unrealizedPct >= 0 ? "+" : ""}${r.unrealizedPct.toFixed(1)}%` : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <label className="text-xs">
          Exit reason (recorded on every journal entry)
          <input
            className="mt-1 w-full"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Closing the book to redeploy"
          />
        </label>
        <label className="text-xs">
          Did the thesis play out?
          <select className="mt-1 w-full" value={thesis} onChange={(e) => setThesis(e.target.value)}>
            <option value="">not recorded</option>
            <option value="yes">yes</option>
            <option value="no">no</option>
          </select>
        </label>
      </div>

      <p className="mt-3 text-xs text-zinc-400">
        This sells all {rows.length} positions at market{isLive ? " on a LIVE account" : " (paper)"}, cancelling
        each one&apos;s resting stop/target legs first, and records each close at its actual fill.
        Average unrealized P/L across these positions is{" "}
        <span className={totalPct >= 0 ? "text-emerald-300" : "text-red-300"}>
          {totalPct >= 0 ? "+" : ""}{totalPct.toFixed(1)}%
        </span>.
      </p>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <input
          className="w-44"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder={`type ${CONFIRM_PHRASE}`}
          aria-label={`Type ${CONFIRM_PHRASE} to confirm`}
        />
        <button
          className="btn btn-danger"
          disabled={busy || typed !== CONFIRM_PHRASE}
          onClick={async () => {
            const res = await call<{ results: ResultRow[] }>("/api/trades/exit-all", {
              method: "POST",
              body: { confirm: typed, confirmLive: isLive, exitReason: reason || null, thesisPlayedOut: thesis || null },
              errorText: "Bulk exit failed.",
            });
            if (res && Array.isArray(res.results)) setResults(res.results);
          }}
        >
          {busy ? "Exiting…" : `Exit all ${rows.length}`}
        </button>
        <button type="button" className="btn" onClick={() => { setOpen(false); setTyped(""); }} disabled={busy}>
          Cancel
        </button>
      </div>
      {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
    </section>
  );
}
