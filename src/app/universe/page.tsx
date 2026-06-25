import {
  getCatalystUniverse,
  universeMonitoringQueries,
} from "@/lib/catalystUniverse";
import { UniverseTables, ApplyQueriesButton } from "@/components/Universe";

export const dynamic = "force-dynamic";

export default function UniversePage() {
  const u = getCatalystUniverse();
  const queryCount = universeMonitoringQueries().length;

  const metrics = [
    { label: "People & orgs", value: u.summary.people },
    { label: "Events", value: u.summary.events },
    { label: "Sources", value: u.summary.sources },
    { label: "Ranked rows", value: u.summary.total },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-bold">Catalyst Research Universe</h1>
        <span className="text-[11px] text-zinc-500">
          {u.summary.total} ranked rows · {u.monitoringQueries.length} query groups
        </span>
        <div className="ml-auto">
          <ApplyQueriesButton count={queryCount} />
        </div>
      </div>

      <p className="text-xs text-zinc-500">{u.note}</p>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {metrics.map((m) => (
          <div key={m.label} className="card">
            <div className="text-2xl font-bold tabular-nums text-zinc-100">{m.value}</div>
            <div className="card-title mb-0">{m.label}</div>
          </div>
        ))}
      </div>

      <UniverseTables people={u.people} events={u.events} sources={u.sources} />

      <section className="space-y-2">
        <h2 className="card-title">Recommended monitoring queries & alerts</h2>
        <p className="text-[11px] text-zinc-600">{u.priorityAlertNote}</p>
        <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
          {u.monitoringQueries.map((g) => (
            <div key={g.category} className="card space-y-1.5">
              <div className="card-title mb-0">{g.category}</div>
              <ul className="space-y-1">
                {g.queries.map((q) => (
                  <li key={q} className="text-[11px] leading-snug">
                    <code className="text-emerald-300/90">{q}</code>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <p className="text-[11px] text-zinc-600">
          <span className="text-zinc-400">Use … queries for ingestion</span> (top right) saves
          these as the GDELT search queries and enables the source, so the universe drives{" "}
          <a href="/events" className="text-sky-300 hover:underline">Catalyst Edge</a> ingestion.
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="card-title">How to use this universe</h2>
        <p className="text-xs text-zinc-300">{u.playbookNote}</p>
        <ul className="ml-4 list-disc space-y-1 text-xs text-zinc-400">
          {u.guidance.map((g) => (
            <li key={g}>{g}</li>
          ))}
        </ul>
      </section>

      <p className="text-[11px] text-zinc-600">
        Decision support only · Not financial advice · No auto-trading. This is a curated catalyst
        radar, not a buy/sell list; impact examples are historical and not predictions.
      </p>
    </div>
  );
}
