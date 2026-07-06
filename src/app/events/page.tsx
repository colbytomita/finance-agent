import { listMentions, distinctEntities } from "@/services/entityMentions";
import { listIngestionRuns } from "@/services/eventIngestion";
import { fmtDate, fmtDateTime } from "@/lib/format";
import { DeleteButton } from "@/components/forms";
import { AddMentionForm, EntityAnalyzer, IngestButton, ApplyEdgeButton } from "@/components/Events";

export const dynamic = "force-dynamic";

const DIRECTION_CLS: Record<string, string> = {
  bullish: "pos",
  bearish: "neg",
  neutral: "text-zinc-400",
  unknown: "text-zinc-500",
};

/** "sec-edgar 5 · gdelt 12" from the stored bySource JSON (empty string if none). */
function bySourceSummary(json: string | null): string {
  if (!json) return "";
  try {
    const obj = JSON.parse(json) as Record<string, number>;
    return Object.entries(obj)
      .filter(([, n]) => n > 0)
      .map(([src, n]) => `${src} ${n}`)
      .join(" · ");
  } catch {
    return "";
  }
}

/** Per-item skip reasons stored with the run (empty for pre-upgrade rows). */
function skippedItems(json: string | null): { title: string; reason: string }[] {
  if (!json) return [];
  try {
    const arr = JSON.parse(json) as { title?: unknown; reason?: unknown }[];
    return Array.isArray(arr)
      ? arr.map((s) => ({ title: String(s.title ?? ""), reason: String(s.reason ?? "") }))
      : [];
  } catch {
    return [];
  }
}

export default function EventsPage() {
  const mentions = listMentions();
  const entities = distinctEntities();
  const runs = listIngestionRuns();

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-bold">Catalyst Edge</h1>
        <span className="text-[11px] text-zinc-500">
          {mentions.length} mention{mentions.length === 1 ? "" : "s"} · {entities.length} entit
          {entities.length === 1 ? "y" : "ies"}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <ApplyEdgeButton />
          <IngestButton />
        </div>
      </div>

      <p className="text-xs text-zinc-500">
        Record real-world statements — who (an entity, e.g. a public figure or executive) said
        something about which ticker, and when — then run an{" "}
        <span className="text-zinc-300">event study</span>: for a given entity, measure how each
        referenced stock moved before and after the statement, pooled across all of that entity&apos;s
        prior mentions and benchmarked against SPY. This is historical correlation on public
        information, not advice or a prediction.
      </p>

      <p className="text-[11px] text-zinc-600">
        <span className="text-zinc-400">Run ingestion</span> pulls real-world events from enabled
        sources (SEC EDGAR 8-K filings by default; optional GDELT news coverage and company IR
        feeds), extracts structured mentions with an LLM (with a rule-based fallback), and stores any
        that resolve to a known ticker. Configure sources, the item cap, and minimum confidence in{" "}
        <a href="/settings" className="text-sky-300 hover:underline">Settings</a>. Social platforms
        (e.g. X / Truth Social) aren&apos;t scraped directly — news coverage of those statements is
        ingested instead.
      </p>

      <p className="text-[11px] text-zinc-600">
        <span className="text-zinc-400">Apply edge to scoring</span>{" "}turns each entity&apos;s
        measured edge into catalysts on the tickers they&apos;ve mentioned (impact scaled by the historical
        effect size, confidence by sample size) and recomputes affected scores — so a repeatable
        entity edge flows into the stock score, the catalysts view, and Agent Picks. Always shown with
        sample size and the historical-correlation caveat.
      </p>

      {runs.length > 0 && (
        <section className="card">
          <h2 className="card-title">Recent ingestion runs</h2>
          <ul className="space-y-1 text-xs">
            {runs.map((r) => {
              const sources = bySourceSummary(r.bySource);
              const skips = skippedItems(r.skippedJson);
              return (
                <li key={r.id} className="flex flex-wrap items-center gap-2">
                  <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-zinc-400">
                    {r.trigger}
                  </span>
                  <span className="text-zinc-200">
                    {r.persisted} added{r.catalystsAdded > 0 ? ` · ${r.catalystsAdded} catalyst(s)` : ""}
                  </span>
                  <span className="text-zinc-500">
                    {r.fetched} fetched · {r.extracted} extracted ·{" "}
                    {skips.length > 0 ? (
                      <span
                        className="cursor-help underline decoration-dotted"
                        title={skips.map((s) => `${s.title} — ${s.reason}`).join("\n")}
                      >
                        {r.skipped} skipped
                      </span>
                    ) : (
                      `${r.skipped} skipped`
                    )}{" "}
                    · {r.generatedBy}
                  </span>
                  {sources && <span className="text-zinc-600">{sources}</span>}
                  {r.errorCount > 0 && <span className="text-amber-400">{r.errorCount} error(s)</span>}
                  <span className="ml-auto text-zinc-600">{fmtDateTime(r.ranAt)}</span>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <AddMentionForm />

      <EntityAnalyzer entities={entities} />

      <section className="space-y-2">
        <h2 className="card-title">Mentions</h2>
        <div className="overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th>Entity</th>
                <th>Ticker</th>
                <th>Direction</th>
                <th>Event date</th>
                <th>Claim</th>
                <th>Source</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {mentions.length === 0 && (
                <tr>
                  <td colSpan={7} className="py-6 text-center text-zinc-500">
                    No mentions yet. Use <span className="text-zinc-300">Add a mention</span> to
                    record one (real, dated public statements only — no demo data).
                  </td>
                </tr>
              )}
              {mentions.map((m) => (
                <tr key={m.id}>
                  <td className="font-medium text-zinc-200">{m.entity}</td>
                  <td className="font-semibold text-sky-300">{m.ticker}</td>
                  <td className={`text-xs ${DIRECTION_CLS[m.direction] ?? "text-zinc-500"}`}>
                    {m.direction}
                  </td>
                  <td className="tabular-nums text-zinc-400">{fmtDate(m.eventDate)}</td>
                  <td className="max-w-80 truncate text-zinc-300">{m.claim ?? "—"}</td>
                  <td className="max-w-40 truncate text-xs text-zinc-500">
                    {m.sourceUrl ? (
                      <a
                        href={m.sourceUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="text-sky-300 hover:underline"
                      >
                        {m.sourceName ?? "link"}
                      </a>
                    ) : (
                      (m.sourceName ?? "—")
                    )}
                  </td>
                  <td>
                    <DeleteButton url={`/api/events/${m.id}`} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <p className="text-[11px] text-zinc-600">
        Decision support only · Not financial advice · No auto-trading. Event-study figures are
        historical correlations across small samples and can reflect selection bias; correlation is
        not causation and a past pattern does not guarantee a forward edge.
      </p>
    </div>
  );
}
