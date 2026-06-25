import Link from "next/link";
import { allCatalysts } from "@/lib/queries";
import { loadConfig } from "@/lib/config";
import { isCatalystStale, catalystEffectiveTime } from "@/services/catalysts";
import { fmtDate } from "@/lib/format";
import { AddCatalystForm, DeleteButton } from "@/components/forms";

export const dynamic = "force-dynamic";

type CatalystRow = ReturnType<typeof allCatalysts>[number];

function ImpactBadge({ score, direction }: { score: number; direction: string }) {
  const color =
    score >= 2
      ? "text-emerald-300"
      : score > 0
        ? "text-emerald-400/70"
        : score <= -2
          ? "text-red-300"
          : score < 0
            ? "text-red-400/70"
            : "text-zinc-400";
  return (
    <span className={`text-xs font-semibold tabular-nums ${color}`}>
      {score > 0 ? "+" : ""}
      {score}
      {direction !== "unknown" ? ` · ${direction}` : ""}
    </span>
  );
}

function CatalystTable({ rows, title }: { rows: CatalystRow[]; title: string }) {
  return (
    <section>
      <h2 className="card-title">{title}</h2>
      <div className="overflow-x-auto">
        <table className="data-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Ticker / Industry</th>
              <th>Type</th>
              <th>Title</th>
              <th>Impact</th>
              <th>Confidence</th>
              <th>Source</th>
              <th>Trade?</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={9} className="py-4 text-center text-zinc-500">None.</td>
              </tr>
            )}
            {rows.map((c) => (
              <tr key={c.id}>
                <td className="text-xs tabular-nums">{fmtDate(c.eventDate ?? c.discoveredAt)}</td>
                <td>
                  {c.ticker ? (
                    <Link href={`/stock/${c.ticker}`} className="font-semibold text-sky-300 hover:underline">
                      {c.ticker}
                    </Link>
                  ) : (
                    <span className="text-zinc-400">{c.industry ?? "Market"}</span>
                  )}
                </td>
                <td className="text-xs text-zinc-400">{c.catalystType.replace(/_/g, " ")}</td>
                <td className="wrap text-xs text-zinc-200">
                  <div className="max-w-md">
                    {c.title}
                    {c.summary && <span className="muted"> — {c.summary}</span>}
                  </div>
                </td>
                <td><ImpactBadge score={c.impactScore} direction={c.impactDirection} /></td>
                <td className="text-xs text-zinc-500">{c.confidence}</td>
                <td className="text-xs">
                  {c.sourceUrl ? (
                    <a href={c.sourceUrl} target="_blank" rel="noreferrer" className="text-sky-400 hover:underline">
                      {c.sourceName}
                    </a>
                  ) : (
                    <span className="text-zinc-500">{c.sourceName}</span>
                  )}
                </td>
                <td className="text-xs">
                  {c.affectsActiveTrade ? <span className="text-amber-300">active trade</span> : "—"}
                </td>
                <td><DeleteButton url={`/api/catalysts/${c.id}`} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export default function CatalystsPage() {
  const cfg = loadConfig();
  const now = Date.now();
  const catalysts = allCatalysts();
  const upcoming = catalysts
    .filter((c) => c.status === "upcoming")
    .sort((a, b) => (a.eventDate ?? "9999").localeCompare(b.eventDate ?? "9999"));
  // "Recent" = genuinely recent, non-expired events, newest event first. Stale
  // catalysts (e.g. an entity mention from years ago) are dropped so the feed
  // reflects what's actually current.
  const recent = catalysts
    .filter(
      (c) =>
        c.status !== "upcoming" &&
        c.status !== "expired" &&
        !isCatalystStale(c, cfg.catalystFreshnessDays, now),
    )
    .sort((a, b) => catalystEffectiveTime(b) - catalystEffectiveTime(a))
    .slice(0, 50);

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-bold">Catalyst Calendar</h1>
      <AddCatalystForm />
      <CatalystTable rows={upcoming} title="Upcoming" />
      <CatalystTable rows={recent} title={`Recent / occurred (last ${cfg.catalystFreshnessDays} days)`} />
      <p className="text-[11px] text-zinc-600">
        Impact scores and classifications are keyword/model heuristics with stated confidence — verify with
        the linked source before acting. Events older than {cfg.catalystFreshnessDays} days are hidden here and
        no longer counted as current drivers.
      </p>
    </div>
  );
}
