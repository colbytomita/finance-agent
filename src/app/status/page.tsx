import { loadConfig } from "@/lib/config";
import { getStatusReport } from "@/services/status";
import { HEARTBEAT_STALE_MINUTES } from "@/services/jobHealth";

export const dynamic = "force-dynamic";

const fmtBytes = (b: number) =>
  b >= 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${(b / 1024).toFixed(0)} KB`;

const fmtWhen = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString() : "—";

function OnOff({ on, onText = "connected", offText = "not configured" }: { on: boolean; onText?: string; offText?: string }) {
  return on ? <span className="pos">{onText}</span> : <span className="text-amber-400">{offText}</span>;
}

export default function StatusPage() {
  const cfg = loadConfig();
  const s = getStatusReport(cfg.yahooBrowserEnabled);
  const totalRows = s.db.tables.reduce((n, t) => n + t.rows, 0);

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-bold">Status</h1>

      <div className="grid gap-4 md:grid-cols-2">
        <section className="card">
          <h2 className="card-title">Integrations</h2>
          <ul className="space-y-1 text-sm">
            <li>Alpaca: <OnOff on={s.integrations.alpacaConfigured} onText={`connected (${s.integrations.alpacaMode})`} /></li>
            <li>LLM research agent: <OnOff on={s.integrations.llmConfigured} offText="no API key — rule-based fallbacks" /></li>
            <li>Yahoo browser connector: <OnOff on={s.integrations.yahooBrowserEnabled} onText="enabled" offText="disabled" /></li>
          </ul>
        </section>

        <section className="card">
          <h2 className="card-title">Background jobs</h2>
          {s.jobs.jobs.length === 0 ? (
            <p className="text-sm text-amber-400">
              No job runs recorded — is <code>npm run jobs</code> running?
            </p>
          ) : (
            <table className="data-table">
              <thead>
                <tr><th>Job</th><th>Last run</th><th>Status</th></tr>
              </thead>
              <tbody>
                {s.jobs.jobs.map((j) => (
                  <tr key={j.job}>
                    <td>{j.job}</td>
                    <td>{fmtWhen(j.lastRunAt)}</td>
                    <td>
                      {j.status === "ok" ? (
                        <span className="pos">ok</span>
                      ) : (
                        <span className="text-red-400" title={j.message ?? undefined}>error</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="mt-2 text-[11px] text-zinc-600">
            The heartbeat ticks every minute while the runner is alive; the header badge turns red
            after {HEARTBEAT_STALE_MINUTES} minutes of silence.
          </p>
        </section>

        <section className="card">
          <h2 className="card-title">Database</h2>
          <p className="text-sm text-zinc-300">
            {fmtBytes(s.db.bytes)} · {totalRows.toLocaleString()} rows
          </p>
          <p className="mb-2 text-[11px] text-zinc-600">{s.db.path}</p>
          <div className="max-h-56 overflow-y-auto">
            <table className="data-table">
              <thead>
                <tr><th>Table</th><th className="text-right">Rows</th></tr>
              </thead>
              <tbody>
                {[...s.db.tables]
                  .sort((a, b) => b.rows - a.rows)
                  .map((t) => (
                    <tr key={t.name}>
                      <td>{t.name}</td>
                      <td className="text-right tabular-nums">{t.rows.toLocaleString()}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="card">
          <h2 className="card-title">Backups</h2>
          {s.backups.length === 0 ? (
            <p className="text-sm text-zinc-500">
              No backups yet — daily maintenance writes one per day to data/backups (keeps 7).
            </p>
          ) : (
            <table className="data-table">
              <thead>
                <tr><th>File</th><th>Size</th><th>Written</th></tr>
              </thead>
              <tbody>
                {s.backups.map((b) => (
                  <tr key={b.file}>
                    <td>{b.file}</td>
                    <td>{fmtBytes(b.bytes)}</td>
                    <td>{fmtWhen(b.modifiedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>

      <section className="card">
        <h2 className="card-title">Price-bar coverage</h2>
        {s.barCoverage.length === 0 ? (
          <p className="text-sm text-zinc-500">No price bars stored yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr><th>Ticker</th><th>Tracked</th><th className="text-right">Bars</th><th>First day</th><th>Last day</th></tr>
              </thead>
              <tbody>
                {s.barCoverage.map((c) => (
                  <tr key={c.ticker}>
                    <td className="font-semibold">{c.ticker}</td>
                    <td>{c.tracked ? "yes" : <span className="text-zinc-600">no</span>}</td>
                    <td className="text-right tabular-nums">
                      {c.bars === 0 ? <span className="text-amber-400">0</span> : c.bars.toLocaleString()}
                    </td>
                    <td className="tabular-nums">{c.firstDay ?? "—"}</td>
                    <td className="tabular-nums">{c.lastDay ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
