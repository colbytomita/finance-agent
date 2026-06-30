"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function SectorScanForm({ defaultMinScore }: { defaultMinScore: number }) {
  const [industry, setIndustry] = useState("");
  const [minScore, setMinScore] = useState(String(defaultMinScore));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const router = useRouter();

  async function scan(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = industry.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setMsg(null);
    try {
      const min = parseFloat(minScore);
      const res = await fetch("/api/sector-scout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          industry: trimmed,
          ...(isFinite(min) ? { minScore: min } : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "scan failed");
      setMsg(
        `“${data.industry}”: ${data.considered} considered · ${data.scanned} scored · ${data.proposed} pick(s)` +
          (data.thesisReports ? ` · ${data.thesisReports} thesis report(s)` : "") +
          (data.expandedBy === "rules" ? " · curated list" : "") +
          (data.errors?.length ? ` · ${data.errors.length} error(s)` : ""),
      );
      router.refresh();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "scan failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={scan} className="flex flex-wrap items-center gap-2">
      <input
        value={industry}
        onChange={(e) => setIndustry(e.target.value)}
        placeholder="Industry or theme — e.g. space, energy, nuclear fusion"
        className="w-72 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-sky-600 focus:outline-none"
        disabled={busy}
      />
      <label className="flex items-center gap-1 text-xs text-zinc-500">
        min score
        <input
          type="number"
          min={1}
          max={10}
          step={0.5}
          value={minScore}
          onChange={(e) => setMinScore(e.target.value)}
          className="w-16 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm tabular-nums text-zinc-100 focus:border-sky-600 focus:outline-none"
          disabled={busy}
        />
      </label>
      <button type="submit" className="btn btn-primary" disabled={busy || !industry.trim()}>
        {busy ? "Scanning…" : "Scan industry"}
      </button>
      {msg && <span className="text-xs text-zinc-500">{msg}</span>}
    </form>
  );
}

export function SectorPickActions({ id, added }: { id: number; added: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  async function act(action: "accept" | "dismiss") {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/sector-scout/${id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(typeof data.error === "string" ? data.error : "failed");
      }
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed");
      setBusy(false);
    }
  }

  if (added) {
    return (
      <span className="inline-flex items-center gap-2 text-xs">
        <span className="pos">✓ on watchlist</span>
        <button className="btn" disabled={busy} onClick={() => act("dismiss")} title="Hide this pick">
          Hide
        </button>
        {error && <span className="text-red-400">{error}</span>}
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-2">
      <button
        className="btn btn-primary"
        disabled={busy}
        onClick={() => act("accept")}
        title="Add to your watchlist"
      >
        Add to watchlist
      </button>
      <button className="btn" disabled={busy} onClick={() => act("dismiss")} title="Dismiss this pick">
        Dismiss
      </button>
      {error && <span className="text-xs text-red-400">{error}</span>}
    </span>
  );
}
