"use client";

import { useMemo, useState } from "react";
import type { UniverseRow, UniverseSection } from "@/lib/catalystUniverse";
import { useApiAction } from "./useApiAction";

// Client widgets for the Catalyst Research Universe page: a searchable/section-
// switchable view over the three ranked tables, and a button that applies the
// curated monitoring queries to the GDELT ingestion config.

const SECTION_LABELS: Record<UniverseSection, string> = {
  people: "People & Orgs",
  events: "Events",
  sources: "Sources",
};

const DIR_CLS: Record<string, string> = {
  positive: "pos",
  negative: "neg",
  mixed: "text-amber-400",
};

function matches(row: UniverseRow, q: string): boolean {
  if (!q) return true;
  const hay = [
    row.name,
    row.category,
    row.marketArea,
    row.tickers,
    row.why,
    row.impactExample,
    row.queries,
    row.bestMonitor,
  ]
    .join(" ")
    .toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((term) => hay.includes(term));
}

function RowLinks({ links }: { links: UniverseRow["links"] }) {
  if (links.length === 0) return <span className="text-zinc-600">—</span>;
  return (
    <span className="flex flex-col gap-0.5">
      {links.map((l, i) => (
        <a
          key={i}
          href={l.url}
          target="_blank"
          rel="noreferrer"
          className="text-sky-300 hover:underline"
        >
          {l.label || "link"}
        </a>
      ))}
    </span>
  );
}

export function UniverseTables({
  people,
  events,
  sources,
}: Record<UniverseSection, UniverseRow[]>) {
  const [section, setSection] = useState<UniverseSection>("people");
  const [query, setQuery] = useState("");

  const data: Record<UniverseSection, UniverseRow[]> = useMemo(
    () => ({ people, events, sources }),
    [people, events, sources],
  );
  const rows = useMemo(
    () => data[section].filter((r) => matches(r, query)),
    [data, section, query],
  );

  const nameHeader =
    section === "people" ? "Name" : section === "events" ? "Event" : "Source";

  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex gap-1">
          {(Object.keys(SECTION_LABELS) as UniverseSection[]).map((s) => (
            <button
              key={s}
              className={`btn ${section === s ? "btn-primary" : ""}`}
              onClick={() => setSection(s)}
            >
              {SECTION_LABELS[s]}{" "}
              <span className="text-[11px] opacity-70">({data[s].length})</span>
            </button>
          ))}
        </div>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter by name, ticker, theme…"
          className="ml-auto w-64"
        />
        <span className="text-[11px] text-zinc-500">
          {rows.length} of {data[section].length}
        </span>
      </div>

      <div className="overflow-x-auto">
        <table className="data-table" style={{ minWidth: 1500 }}>
          <thead>
            <tr>
              <th>#</th>
              <th>{nameHeader}</th>
              <th>Category</th>
              <th>Market area</th>
              <th>Tickers / exposure</th>
              <th>Why useful</th>
              <th>Impact example</th>
              <th>Scores</th>
              <th>Frequency</th>
              <th>Best monitor</th>
              <th>Search / alerts</th>
              <th>Links</th>
              <th>Bias / limits</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={13} className="py-6 text-center text-zinc-500">
                  No rows match “{query}”.
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <tr key={`${section}-${r.rank}-${r.name}`}>
                <td className="tabular-nums font-semibold text-sky-300">{r.rank}</td>
                <td className="font-medium wrap text-zinc-100 min-w-44">{r.name}</td>
                <td className="wrap text-zinc-400 min-w-32">{r.category}</td>
                <td className="wrap text-zinc-400 min-w-36">{r.marketArea}</td>
                <td className="wrap text-zinc-300 min-w-36">{r.tickers}</td>
                <td className="wrap text-zinc-300 min-w-64">{r.why}</td>
                <td className={`wrap min-w-64 ${DIR_CLS[r.impactDirection ?? ""] ?? "text-zinc-400"}`}>
                  {r.impactExample}
                </td>
                <td className="whitespace-nowrap text-zinc-300">{r.scores}</td>
                <td className="wrap text-zinc-400 min-w-28">{r.frequency}</td>
                <td className="wrap text-zinc-400 min-w-40">{r.bestMonitor}</td>
                <td className="wrap min-w-64 text-[11px] text-zinc-400">
                  {r.queries ? <code className="text-emerald-300/90">{r.queries}</code> : "—"}
                </td>
                <td className="min-w-28 text-xs">
                  <RowLinks links={r.links} />
                </td>
                <td className="wrap text-zinc-500 min-w-48">{r.limitations}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function ApplyQueriesButton({ count }: { count: number }) {
  const { call, busy, msg, error } = useApiAction();

  const apply = () =>
    call<{ appliedQueries: number }>("/api/universe/queries", {
      refresh: false, // settings change; nothing on this page re-renders
      message: (d) =>
        `Applied ${d.appliedQueries} monitoring quer${d.appliedQueries === 1 ? "y" : "ies"} — GDELT source and event ingestion enabled. Run ingestion from Catalyst Edge.`,
    });

  return (
    <span className="inline-flex items-center gap-2">
      <button
        className="btn btn-primary"
        onClick={apply}
        disabled={busy}
        title="Save these monitoring queries as the GDELT ingestion queries and enable the source"
      >
        {busy ? "Applying…" : `Use ${count} queries for ingestion`}
      </button>
      {(msg ?? error) && <span className="text-xs text-zinc-500">{msg ?? error}</span>}
    </span>
  );
}
