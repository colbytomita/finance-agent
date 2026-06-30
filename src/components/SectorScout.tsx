"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { IndustryGuide } from "@/services/sectorScout";

/** Normalize a label the same way the server does, for favorite comparisons. */
function normLabel(s: string): string {
  return s.trim().replace(/\s+/g, " ").toLowerCase();
}

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

/**
 * Browse the industries you've scanned: pick one from the dropdown to read what
 * kinds of companies surface there and exactly how the scout decides a ticker
 * fits, re-scan it on demand, or pin it for daily auto-scan. Selecting an
 * industry also filters the picks list below (via the ?industry= URL param, so
 * the server re-renders the filtered set). Descriptions are computed
 * server-side from the real scan pipeline.
 */
export function IndustryExplorer({
  guides,
  selected,
  favorites,
  autoScanEnabled,
}: {
  guides: IndustryGuide[];
  selected: string; // "" = all industries (no focus)
  favorites: string[];
  autoScanEnabled: boolean;
}) {
  const router = useRouter();
  const [navigating, startNav] = useTransition();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const guide = selected ? guides.find((g) => g.industry === selected) ?? null : null;
  const isPinned = guide ? favorites.some((f) => normLabel(f) === guide.industry) : false;

  function navTo(value: string) {
    setMsg(null);
    startNav(() => {
      const qs = value ? `?industry=${encodeURIComponent(value)}` : "";
      router.push(`/sector-scout${qs}`, { scroll: false });
    });
  }

  async function rescan() {
    if (!guide || busy) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/sector-scout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ industry: guide.industry }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "scan failed");
      setMsg(
        `${data.scanned} scored · ${data.proposed} pick(s)` +
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

  async function togglePin() {
    if (!guide || busy) return;
    setBusy(true);
    setMsg(null);
    const next = isPinned
      ? favorites.filter((f) => normLabel(f) !== guide.industry)
      : [...favorites, guide.industry];
    try {
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sectorScoutIndustries: next }),
      });
      if (!res.ok) throw new Error("failed to update favorites");
      setMsg(isPinned ? "Unpinned from daily auto-scan" : "Pinned to daily auto-scan");
      router.refresh();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "failed to update favorites");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="card-title mb-0">Industries</h2>
        <label className="flex items-center gap-1 text-xs text-zinc-500">
          <span className="sr-only">Select an industry</span>
          <select
            value={selected}
            onChange={(e) => navTo(e.target.value)}
            disabled={navigating}
            className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm capitalize text-zinc-100 focus:border-sky-600 focus:outline-none disabled:opacity-60"
          >
            <option value="">All industries</option>
            {guides.map((g) => (
              <option key={g.industry} value={g.industry}>
                {g.industry} ({g.pickCount} pick{g.pickCount === 1 ? "" : "s"})
              </option>
            ))}
          </select>
        </label>

        {guide && (
          <span className="ml-auto inline-flex items-center gap-2 text-xs text-zinc-500">
            {guide.expansionMode === "llm" ? (
              <span className="text-violet-300" title="Candidate tickers expanded with the configured LLM">
                AI-expanded
              </span>
            ) : (
              <span title="Candidate tickers from the built-in curated theme map">Curated</span>
            )}
            <span className="text-zinc-700">·</span>
            <span>
              {guide.pickCount} pick{guide.pickCount === 1 ? "" : "s"} shown below
            </span>
          </span>
        )}
      </div>

      {!guide ? (
        <p className="text-xs text-zinc-500">
          Select an industry to see what surfaces there and how a ticker qualifies — and to re-scan it or pin it for
          daily auto-scan. Picking one also filters the picks below to that industry.
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <button
              className="btn btn-primary"
              disabled={busy}
              onClick={rescan}
              title={`Re-scan “${guide.industry}” now`}
            >
              {busy ? "Working…" : "Re-scan now"}
            </button>
            <button
              className="btn"
              disabled={busy}
              onClick={togglePin}
              title="Add or remove this industry from the daily auto-scan list"
            >
              {isPinned ? "★ Pinned to auto-scan" : "☆ Pin to daily auto-scan"}
            </button>
            {isPinned && !autoScanEnabled && (
              <span className="text-[11px] text-amber-400">
                daily auto-scan is off —{" "}
                <Link href="/settings" className="underline hover:text-amber-300">
                  enable in Settings
                </Link>
              </span>
            )}
            {msg && <span className="text-xs text-zinc-500">{msg}</span>}
          </div>

          <div>
            <div className="text-[11px] font-semibold uppercase tracking-wide text-sky-300">What shows up here</div>
            <p className="mt-1 text-sm text-zinc-200">{guide.whatShowsUp}</p>
          </div>

          <div>
            <div className="text-[11px] font-semibold uppercase tracking-wide text-sky-300">
              How a ticker qualifies for “{guide.industry}”
            </div>
            <ol className="mt-1 list-decimal space-y-1 pl-5 text-xs text-zinc-300">
              {guide.fitCriteria.map((c, i) => (
                <li key={i}>{c}</li>
              ))}
            </ol>
          </div>

          {guide.curatedExamples.length > 0 && (
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
                {guide.expansionMode === "llm"
                  ? "Curated starter names (gap-fillers)"
                  : "Starter names from the curated map"}
              </div>
              <div className="mt-1 flex flex-wrap gap-1">
                {guide.curatedExamples.slice(0, 16).map((t) => (
                  <span
                    key={t}
                    className="rounded border border-zinc-700 bg-zinc-900 px-1.5 py-0.5 text-[11px] tabular-nums text-zinc-300"
                  >
                    {t}
                  </span>
                ))}
              </div>
              <p className="mt-1 text-[11px] text-zinc-600">
                Examples only — each is still validated against real price data and scored before it can surface; names
                that fail are dropped.
              </p>
            </div>
          )}
        </>
      )}
    </section>
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
