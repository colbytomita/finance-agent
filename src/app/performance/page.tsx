import { readCachedBacktest } from "@/services/signalPerformance";
import type { EventWindowKey } from "@/services/eventStudy";
import { fmtDateTime } from "@/lib/format";
import { Pct } from "@/components/badges";
import { RunBacktestButton } from "@/components/SignalPerformance";

export const dynamic = "force-dynamic";

const WINDOWS: { key: EventWindowKey; label: string }[] = [
  { key: "post1", label: "+1 day" },
  { key: "post5", label: "+5 days" },
  { key: "post20", label: "+20 days" },
];

const VERDICT: Record<string, { text: string; cls: string }> = {
  improves: { text: "Higher score bands → higher forward returns (calibrated)", cls: "pos" },
  inverts: { text: "Higher score bands → LOWER forward returns (inverted!)", cls: "neg" },
  mixed: { text: "No clean ordering between bands (mixed)", cls: "text-amber-400" },
  "n/a": { text: "Not enough data yet to judge calibration", cls: "text-zinc-500" },
};

export default function PerformancePage() {
  const summary = readCachedBacktest();

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-bold">Signal Performance</h1>
        <div className="ml-auto flex items-center gap-3">
          {summary && <span className="text-[11px] text-zinc-500">Last run {fmtDateTime(summary.generatedAt)}</span>}
          <RunBacktestButton />
        </div>
      </div>

      <p className="text-xs text-zinc-500">
        Backtests the app&apos;s own stock scores against what actually happened. Every stored score becomes
        an event; we measure each ticker&apos;s forward return vs SPY over the next 1 / 5 / 20 trading days and
        pool the results by recommendation band. If the score is calibrated, the higher bands should show
        higher forward abnormal returns. This is historical correlation across past calls —{" "}
        <span className="text-zinc-400">not a prediction and not advice</span>.
      </p>

      {!summary ? (
        <p className="py-10 text-center text-sm text-zinc-500">
          No backtest yet. Click <span className="text-zinc-300">Run backtest</span> to evaluate your stored
          scores.
        </p>
      ) : (
        <>
          <div className="card flex flex-wrap items-center gap-x-6 gap-y-1 text-xs">
            <span>
              Verdict ({WINDOWS.find((w) => w.key === summary.primaryWindow)?.label ?? summary.primaryWindow}):{" "}
              <span className={VERDICT[summary.calibration]?.cls ?? "text-zinc-400"}>
                {VERDICT[summary.calibration]?.text ?? summary.calibration}
              </span>
            </span>
            <span className="text-zinc-500">
              {summary.analyzed} analyzed · {summary.sampledEvents} scored days · {summary.tickers} tickers ·{" "}
              {summary.totalScoreRows} raw score rows
            </span>
            {!summary.spyAvailable && <span className="text-amber-400">SPY benchmark missing</span>}
          </div>

          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Recommendation band</th>
                  <th>Score</th>
                  {WINDOWS.map((w) => (
                    <th key={w.key} className="text-right">
                      Mean abn. return {w.label}
                    </th>
                  ))}
                  <th className="text-right">Samples</th>
                </tr>
              </thead>
              <tbody>
                {summary.buckets.map((b) => {
                  const maxN = Math.max(0, ...b.windows.map((w) => w.n));
                  return (
                    <tr key={b.bucket}>
                      <td className="font-semibold text-zinc-200">{b.bucket}</td>
                      <td className="tabular-nums text-zinc-500">{b.scoreRange}</td>
                      {WINDOWS.map((w) => {
                        const edge = b.windows.find((x) => x.key === w.key);
                        return (
                          <td key={w.key} className="text-right">
                            {edge && edge.n > 0 ? (
                              <span>
                                <Pct value={edge.meanAbnormalReturnPct} />
                                <span className="ml-1 text-[10px] text-zinc-600">
                                  hit {edge.hitRate?.toFixed(0)}% · n={edge.n}
                                </span>
                              </span>
                            ) : (
                              <span className="text-zinc-600">—</span>
                            )}
                          </td>
                        );
                      })}
                      <td className="text-right tabular-nums text-zinc-500">{maxN || "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {summary.notes.length > 0 && (
            <ul className="space-y-1 text-xs text-amber-400/90">
              {summary.notes.map((n, i) => (
                <li key={i}>• {n}</li>
              ))}
            </ul>
          )}
        </>
      )}

      <p className="text-[11px] text-zinc-600">
        Abnormal return = the ticker&apos;s return minus SPY&apos;s over the same window. Bands are scored from
        the same engine that drives the dashboard. Overlapping windows and a finite sample mean these figures
        are a calibration check, not a tradeable backtest — and past behavior never guarantees future results.
      </p>
    </div>
  );
}
