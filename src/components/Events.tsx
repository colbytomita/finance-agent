"use client";

import { useState, type FormEvent } from "react";
import { Pct } from "@/components/badges";
import { fmtNum } from "@/lib/format";
import { formValues, useApiAction } from "./useApiAction";

// Client widgets for the Catalyst Edge (event-study) page: a collapsible form to
// add a mention, and an on-demand per-entity edge analyzer that calls the
// analyze API (which may backfill historical bars, so it can take a moment).

const field = "flex flex-col gap-0.5";

interface IngestResult {
  fetched: number;
  extracted: number;
  persisted: number;
  catalystsAdded: number;
  skipped: number;
  skippedItems: { title: string; reason: string }[];
  bySource: Record<string, number>;
  errors: string[];
  generatedBy: "llm" | "rules" | "mixed" | "none";
}

export function IngestButton() {
  const { call, busy, error } = useApiAction();
  const [result, setResult] = useState<IngestResult | null>(null);

  function ingest() {
    setResult(null);
    void call<IngestResult>("/api/events/ingest", {
      errorText: "ingestion failed",
      onSuccess: setResult,
    });
  }

  return (
    <div className="flex max-w-xl flex-col items-end gap-1">
      <button
        className="btn"
        onClick={ingest}
        disabled={busy}
        title="Pull real-world events from enabled sources and extract mentions"
      >
        {busy ? "Ingesting…" : "Run ingestion"}
      </button>
      {error && <span className="text-xs text-red-400">{error}</span>}
      {result && (
        <div className="w-full rounded border border-zinc-800 bg-zinc-950/80 p-2 text-left text-[11px] text-zinc-500">
          <div className="flex flex-wrap gap-x-3 gap-y-1">
            <span>Fetched <span className="text-zinc-300">{result.fetched}</span></span>
            <span>Extracted <span className="text-zinc-300">{result.extracted}</span></span>
            <span>Added <span className="text-zinc-300">{result.persisted}</span></span>
            <span>Skipped <span className="text-zinc-300">{result.skipped}</span></span>
            <span>Mode <span className="text-zinc-300">{result.generatedBy}</span></span>
            {result.catalystsAdded > 0 && (
              <span>Catalysts <span className="text-zinc-300">{result.catalystsAdded}</span></span>
            )}
          </div>
          {Object.keys(result.bySource).length > 0 && (
            <div className="mt-1">
              <span className="text-zinc-400">Sources:</span>{" "}
              {Object.entries(result.bySource)
                .map(([source, count]) => `${source} ${count}`)
                .join(" · ")}
            </div>
          )}
          {result.skippedItems?.length > 0 && (
            <details className="mt-1">
              <summary className="cursor-pointer text-zinc-400">
                Why {result.skipped} skipped
                {result.skipped > result.skippedItems.length
                  ? ` (first ${result.skippedItems.length})`
                  : ""}
              </summary>
              <ul className="mt-1 list-disc space-y-0.5 pl-4">
                {result.skippedItems.map((s, i) => (
                  <li key={i}>
                    <span className="text-zinc-400">{s.title}</span> — {s.reason}
                  </li>
                ))}
              </ul>
            </details>
          )}
          {result.errors.length > 0 && (
            <details className="mt-1">
              <summary className="cursor-pointer text-amber-400/90">
                {result.errors.length} source/extraction error{result.errors.length === 1 ? "" : "s"}
              </summary>
              <ul className="mt-1 list-disc space-y-0.5 pl-4 text-amber-300/80">
                {result.errors.map((err, i) => (
                  <li key={i}>{err}</li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </div>
  );
}

export function ApplyEdgeButton() {
  const { call, busy, msg, error } = useApiAction();

  const apply = () =>
    call<{ catalystsWritten: number; entitiesProcessed: number; tickersRecomputed?: number }>(
      "/api/events/apply-edge",
      {
        errorText: "apply failed",
        message: (d) =>
          `Wrote ${d.catalystsWritten} edge catalyst(s) across ${d.entitiesProcessed} entit${
            d.entitiesProcessed === 1 ? "y" : "ies"
          }` + (d.tickersRecomputed ? `, recomputed ${d.tickersRecomputed} score(s)` : ""),
      },
    );

  return (
    <span className="inline-flex items-center gap-2">
      <button
        className="btn"
        onClick={apply}
        disabled={busy}
        title="Turn each entity's measured edge into catalysts that feed stock scoring"
      >
        {busy ? "Applying…" : "Apply edge to scoring"}
      </button>
      {(msg ?? error) && <span className="text-xs text-zinc-500">{msg ?? error}</span>}
    </span>
  );
}

export function AddMentionForm() {
  const [open, setOpen] = useState(false);
  const { call, busy, msg, error } = useApiAction();

  async function submit(e: FormEvent<HTMLFormElement>) {
    const form = e.currentTarget;
    const ok = await call<{ duplicate?: boolean }>("/api/events", {
      body: formValues(e),
      message: (d) =>
        d.duplicate
          ? "Already recorded — that entity/ticker/day mention exists, nothing was added."
          : "Mention added.",
      errorText: "Validation failed — check the fields.",
    });
    if (ok && !ok.duplicate) form.reset();
  }

  return (
    <div>
      <button type="button" className="btn" onClick={() => setOpen((o) => !o)}>
        {open ? "▾ " : "▸ "}Add a mention
      </button>
      {open && (
        <div className="card mt-2">
          <form className="flex flex-wrap items-end gap-3" onSubmit={submit}>
            <div className={field}>
              <label>Entity *</label>
              <input name="entity" required className="w-44" placeholder="Donald Trump" />
            </div>
            <div className={field}>
              <label>Ticker *</label>
              <input name="ticker" required className="w-24 uppercase" placeholder="DJT" />
            </div>
            <div className={field}>
              <label>Event date *</label>
              <input name="eventDate" type="date" required />
            </div>
            <div className={field}>
              <label>Direction</label>
              <select name="direction" defaultValue="unknown">
                <option value="bullish">bullish</option>
                <option value="bearish">bearish</option>
                <option value="neutral">neutral</option>
                <option value="unknown">unknown</option>
              </select>
            </div>
            <div className={field}>
              <label>Claim</label>
              <input name="claim" className="w-72" placeholder="What was said" />
            </div>
            <div className={field}>
              <label>Source name</label>
              <input name="sourceName" className="w-40" placeholder="Reuters" />
            </div>
            <div className={field}>
              <label>Source URL</label>
              <input name="sourceUrl" className="w-64" placeholder="https://…" />
            </div>
            <button className="btn btn-primary" disabled={busy}>
              {busy ? "Saving…" : "Save"}
            </button>
            {msg && <span className="text-xs text-amber-300">{msg}</span>}
            {error && <span className="text-xs text-red-400">{error}</span>}
          </form>
        </div>
      )}
    </div>
  );
}

interface WindowEdge {
  key: string;
  label: string;
  n: number;
  meanAbnormalReturnPct: number | null;
  hitRate: number | null;
  stdDev: number | null;
  tStat: number | null;
}

interface PerEvent {
  id: number;
  ticker: string;
  direction: string;
  eventDate: string;
  resolvedEventDate: string;
  windows: Record<string, { abnormalReturnPct: number | null }>;
}

interface Analysis {
  entity: string;
  totalMentions: number;
  analyzed: number;
  summary: { totalEvents: number; windows: WindowEdge[] };
  perEvent: PerEvent[];
  skipped: { id: number; ticker: string; eventDate: string; reason: string }[];
}

export function EntityAnalyzer({
  entities,
  watched = [],
}: {
  entities: { entity: string; count: number }[];
  watched?: string[];
}) {
  const [entity, setEntity] = useState(entities[0]?.entity ?? "");
  const { call, busy, error } = useApiAction();
  const watchAction = useApiAction();
  const [data, setData] = useState<Analysis | null>(null);
  const [watchedSet, setWatchedSet] = useState<Set<string>>(
    () => new Set(watched.map((w) => w.toLowerCase())),
  );
  const isWatched = entity ? watchedSet.has(entity.toLowerCase()) : false;

  function analyze() {
    if (!entity) return;
    void call<Analysis>(`/api/events/analyze?entity=${encodeURIComponent(entity)}`, {
      method: "GET",
      refresh: false, // pure read — nothing server-rendered changes
      errorText: "analysis failed",
      onSuccess: setData,
    });
  }

  function toggleWatch() {
    if (!entity) return;
    const next = !isWatched;
    void watchAction.call("/api/events/watch", {
      body: { entity, watched: next },
      refresh: false,
      errorText: "could not update watch",
      onSuccess: () =>
        setWatchedSet((prev) => {
          const s = new Set(prev);
          if (next) s.add(entity.toLowerCase());
          else s.delete(entity.toLowerCase());
          return s;
        }),
    });
  }

  return (
    <section className="card space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="card-title mb-0">Per-entity edge</h2>
        <select
          value={entity}
          onChange={(e) => setEntity(e.target.value)}
          className="min-w-44"
          disabled={entities.length === 0}
        >
          {entities.length === 0 && <option value="">No entities yet</option>}
          {entities.map((e) => (
            <option key={e.entity} value={e.entity}>
              {e.entity} ({e.count})
            </option>
          ))}
        </select>
        <button className="btn btn-primary" onClick={analyze} disabled={busy || !entity}>
          {busy ? "Analyzing…" : "Analyze"}
        </button>
        <button
          type="button"
          onClick={toggleWatch}
          disabled={watchAction.busy || !entity}
          title={
            isWatched
              ? "Watching — you'll be alerted when ingestion finds new mentions. Click to stop."
              : "Watch — get an alert when event ingestion finds new mentions of this entity."
          }
          className={`rounded border px-2 py-1 text-xs ${
            isWatched
              ? "border-amber-700 bg-amber-950/60 text-amber-300"
              : "border-zinc-700 text-zinc-400 hover:text-zinc-100"
          }`}
        >
          {isWatched ? "★ Watching" : "☆ Watch"}
        </button>
        {error && <span className="text-xs text-red-400">{error}</span>}
      </div>

      {data && (
        <div className="space-y-3">
          <p className="text-xs text-zinc-400">
            Pooled <span className="text-zinc-200">{data.analyzed}</span> of{" "}
            {data.totalMentions} mention{data.totalMentions === 1 ? "" : "s"} for{" "}
            <span className="text-zinc-200">{data.entity}</span>. Abnormal return = stock return −
            SPY return over the same window.
          </p>

          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Window</th>
                  <th>n</th>
                  <th>Mean abnormal</th>
                  <th>Hit rate</th>
                  <th>Std dev</th>
                  <th>t-stat</th>
                </tr>
              </thead>
              <tbody>
                {data.summary.windows.map((w) => (
                  <tr key={w.key}>
                    <td className="font-medium text-zinc-300">{w.label}</td>
                    <td className="tabular-nums">{w.n}</td>
                    <td><Pct value={w.meanAbnormalReturnPct} /></td>
                    <td className="tabular-nums text-zinc-300">
                      {w.hitRate == null ? "—" : `${w.hitRate.toFixed(0)}%`}
                    </td>
                    <td className="tabular-nums text-zinc-400">{fmtNum(w.stdDev, 2)}</td>
                    <td className="tabular-nums text-zinc-400">{fmtNum(w.tStat, 2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {data.perEvent.length > 0 && (
            <details className="text-xs">
              <summary className="cursor-pointer text-zinc-400 hover:text-zinc-200">
                Per-event detail ({data.perEvent.length})
              </summary>
              <table className="data-table mt-2">
                <thead>
                  <tr>
                    <th>Ticker</th>
                    <th>Event date</th>
                    <th>Resolved</th>
                    <th>Direction</th>
                    <th>Abn. [0,+1]</th>
                    <th>Abn. [0,+5]</th>
                    <th>Abn. [0,+20]</th>
                  </tr>
                </thead>
                <tbody>
                  {data.perEvent.map((p) => (
                    <tr key={p.id}>
                      <td className="font-semibold text-zinc-300">{p.ticker}</td>
                      <td className="tabular-nums text-zinc-400">{p.eventDate}</td>
                      <td className="tabular-nums text-zinc-500">{p.resolvedEventDate}</td>
                      <td className="text-zinc-400">{p.direction}</td>
                      <td><Pct value={p.windows.post1?.abnormalReturnPct ?? null} /></td>
                      <td><Pct value={p.windows.post5?.abnormalReturnPct ?? null} /></td>
                      <td><Pct value={p.windows.post20?.abnormalReturnPct ?? null} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          )}

          {data.skipped.length > 0 && (
            <p className="text-[11px] text-amber-400/80">
              Skipped {data.skipped.length}:{" "}
              {data.skipped.map((s) => `${s.ticker} (${s.eventDate}) — ${s.reason}`).join("; ")}
            </p>
          )}

          <p className="text-[11px] text-zinc-600">
            Historical correlation across {data.analyzed} event
            {data.analyzed === 1 ? "" : "s"} — not advice or a prediction. Small samples, selection
            bias, and correlation ≠ causation all apply; a past pattern does not guarantee a forward
            edge.
          </p>
        </div>
      )}
    </section>
  );
}
