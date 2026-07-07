import { readCachedReport } from "@/services/signalPerformance";
import { getTradePerformance } from "@/services/tradePerformance";
import type { WindowEdge, EventWindowKey } from "@/services/eventStudy";
import { fmtDateTime, fmtMoney } from "@/lib/format";
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

function WindowCells({ windows }: { windows: WindowEdge[] }) {
  return (
    <>
      {WINDOWS.map((w) => {
        const edge = windows.find((x) => x.key === w.key);
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
    </>
  );
}

function Notes({ notes }: { notes: string[] }) {
  if (notes.length === 0) return null;
  return (
    <ul className="space-y-1 text-xs text-amber-400/90">
      {notes.map((n, i) => (
        <li key={i}>• {n}</li>
      ))}
    </ul>
  );
}

function Stat({ label, value, cls }: { label: string; value: string; cls?: string }) {
  return (
    <div className="rounded border border-zinc-800 px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-zinc-500">{label}</div>
      <div className={`text-sm font-semibold tabular-nums ${cls ?? "text-zinc-200"}`}>{value}</div>
    </div>
  );
}

const pct = (v: number | null, digits = 1) => (v == null ? "—" : `${v >= 0 ? "" : ""}${v.toFixed(digits)}%`);

export default function PerformancePage() {
  const report = readCachedReport();
  const trades = getTradePerformance();
  const score = report?.score;
  const picks = report?.picks;
  const setups = report?.setups;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-bold">Signal Performance</h1>
        <div className="ml-auto flex items-center gap-3">
          {report && <span className="text-[11px] text-zinc-500">Last run {fmtDateTime(report.generatedAt)}</span>}
          <RunBacktestButton />
        </div>
      </div>

      <p className="text-xs text-zinc-500">
        Does any of this actually work? This backtests the app&apos;s own calls against what happened next —
        stock scores (by recommendation band) and discovery picks (by source) measured as forward return vs SPY
        over 1 / 5 / 20 trading days, the realized results of your closed trades, and whether detected swing
        setups reached their target before their stop. Historical correlation across past calls —{" "}
        <span className="text-zinc-400">not a prediction and not advice</span>.
      </p>

      {/* 1. Score calibration */}
      <section className="space-y-2">
        <h2 className="text-sm font-bold text-zinc-200">Score calibration</h2>
        {!score ? (
          <p className="py-6 text-center text-sm text-zinc-500">
            No backtest yet — click <span className="text-zinc-300">Run backtest</span>.
          </p>
        ) : (
          <>
            <div className="card flex flex-wrap items-center gap-x-6 gap-y-1 text-xs">
              <span>
                Verdict ({WINDOWS.find((w) => w.key === score.primaryWindow)?.label ?? score.primaryWindow}):{" "}
                <span className={VERDICT[score.calibration]?.cls ?? "text-zinc-400"}>
                  {VERDICT[score.calibration]?.text ?? score.calibration}
                </span>
              </span>
              <span className="text-zinc-500">
                {score.analyzed} analyzed · {score.sampledEvents} scored days · {score.tickers} tickers ·{" "}
                {score.totalScoreRows} raw rows
              </span>
              {!score.spyAvailable && <span className="text-amber-400">SPY benchmark missing</span>}
            </div>
            <div className="overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Recommendation band</th>
                    <th>Score</th>
                    {WINDOWS.map((w) => (
                      <th key={w.key} className="text-right">Mean abn. return {w.label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {score.buckets.map((b) => (
                    <tr key={b.bucket}>
                      <td className="font-semibold text-zinc-200">{b.bucket}</td>
                      <td className="tabular-nums text-zinc-500">{b.scoreRange}</td>
                      <WindowCells windows={b.windows} />
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Notes notes={score.notes} />
          </>
        )}
      </section>

      {/* 2. Pick performance */}
      <section className="space-y-2">
        <h2 className="text-sm font-bold text-zinc-200">Pick performance</h2>
        <p className="text-[11px] text-zinc-500">
          How the names surfaced by Agent Picks and Sector Scout actually moved vs SPY after they were proposed.
        </p>
        {!picks ? (
          <p className="py-4 text-center text-sm text-zinc-500">Run the backtest to evaluate picks.</p>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Source</th>
                    {WINDOWS.map((w) => (
                      <th key={w.key} className="text-right">Mean abn. return {w.label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {picks.sources.map((s) => (
                    <tr key={s.source}>
                      <td className="font-semibold text-zinc-200">
                        {s.source} <span className="text-[10px] text-zinc-500">({s.totalEvents})</span>
                      </td>
                      <WindowCells windows={s.windows} />
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {picks.byIndustry && picks.byIndustry.length > 0 && (
              <div className="space-y-1">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
                  Sector Scout — by industry
                </h3>
                <p className="text-[11px] text-zinc-600">
                  Which themes have actually panned out. A name that surfaced under more than one industry counts
                  once per industry. Most-sampled first.
                </p>
                <div className="overflow-x-auto">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Industry</th>
                        {WINDOWS.map((w) => (
                          <th key={w.key} className="text-right">Mean abn. return {w.label}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {picks.byIndustry.map((r) => (
                        <tr key={r.industry}>
                          <td className="font-semibold capitalize text-zinc-200">
                            {r.industry} <span className="text-[10px] text-zinc-500">({r.totalEvents})</span>
                          </td>
                          <WindowCells windows={r.windows} />
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            <Notes notes={picks.notes} />
          </>
        )}
      </section>

      {/* 3. Realized trades */}
      <section className="space-y-2">
        <h2 className="text-sm font-bold text-zinc-200">Realized trades</h2>
        {trades.closed === 0 ? (
          <p className="py-4 text-center text-sm text-zinc-500">
            No closed trades yet — close a trade to start tracking realized performance.
          </p>
        ) : (
          <>
            <p className="text-[11px] text-zinc-500">
              {trades.closed} closed · {trades.wins}W / {trades.losses}L
              {trades.breakeven ? ` / ${trades.breakeven} BE` : ""}
            </p>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
              <Stat label="Win rate" value={pct(trades.winRate, 0)} cls={trades.winRate != null && trades.winRate >= 50 ? "pos" : "text-zinc-200"} />
              <Stat label="Avg return / trade" value={pct(trades.avgReturnPct)} cls={(trades.avgReturnPct ?? 0) > 0 ? "pos" : (trades.avgReturnPct ?? 0) < 0 ? "neg" : "text-zinc-200"} />
              <Stat label="Avg R multiple" value={trades.avgRMultiple == null ? "—" : `${trades.avgRMultiple.toFixed(2)}R`} cls={(trades.avgRMultiple ?? 0) > 0 ? "pos" : (trades.avgRMultiple ?? 0) < 0 ? "neg" : "text-zinc-200"} />
              <Stat label="Profit factor" value={trades.profitFactor == null ? "—" : trades.profitFactor.toFixed(2)} />
              <Stat label="Avg win" value={pct(trades.avgWinPct)} cls="pos" />
              <Stat label="Avg loss" value={pct(trades.avgLossPct)} cls="neg" />
              <Stat label="Avg hold" value={trades.avgHoldingDays == null ? "—" : `${trades.avgHoldingDays.toFixed(1)}d`} />
              <Stat label="Total P/L" value={trades.totalPnl == null ? "—" : fmtMoney(trades.totalPnl)} cls={(trades.totalPnl ?? 0) > 0 ? "pos" : (trades.totalPnl ?? 0) < 0 ? "neg" : "text-zinc-200"} />
              <Stat label="Best / worst" value={`${pct(trades.bestPct, 0)} / ${pct(trades.worstPct, 0)}`} />
              {trades.thesisPlayedOutRate != null && (
                <Stat label="Thesis played out" value={pct(trades.thesisPlayedOutRate, 0)} />
              )}
            </div>
          </>
        )}
      </section>

      {/* 4. Setup outcomes */}
      <section className="space-y-2">
        <h2 className="text-sm font-bold text-zinc-200">Setup outcomes</h2>
        <p className="text-[11px] text-zinc-500">
          Did detected swing setups reach their target before their stop? Each detection is walked forward over{" "}
          {setups?.horizonDays ?? 20} trading days: the trade only counts if price actually traded into its entry
          zone (else &quot;no fill&quot;), then target-first is a win, stop-first a loss, neither an expired
          (mark-to-market) outcome. R = reward in units of the initial entry→stop risk.
        </p>
        {!setups ? (
          <p className="py-4 text-center text-sm text-zinc-500">
            Run the backtest to evaluate detected setups.
          </p>
        ) : setups.overall.triggered === 0 ? (
          <>
            <p className="py-4 text-center text-sm text-zinc-500">
              {setups.totalSetups === 0
                ? "No setups detected yet."
                : `No triggered setups yet (${setups.pending} pending${setups.overall.noFill ? `, ${setups.overall.noFill} no-fill` : ""}).`}
            </p>
            <Notes notes={setups.notes} />
          </>
        ) : (
          <>
            <p className="text-[11px] text-zinc-500">
              {setups.overall.triggered} triggered · {setups.overall.wins}W / {setups.overall.losses}L
              {setups.overall.expired ? ` / ${setups.overall.expired} expired` : ""}
              {setups.overall.noFill ? ` · ${setups.overall.noFill} no-fill` : ""}
              {setups.pending ? ` · ${setups.pending} pending` : ""}
            </p>
            <div className="overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Setup type</th>
                    <th className="text-right">Triggered</th>
                    <th className="text-right">Win rate</th>
                    <th className="text-right">Avg R (expectancy)</th>
                    <th className="text-right">W / L / exp.</th>
                    <th className="text-right">No-fill</th>
                  </tr>
                </thead>
                <tbody>
                  {[...setups.byType, setups.overall].map((s, i) => (
                    <tr key={s.setupType} className={i === setups.byType.length ? "border-t border-zinc-700" : ""}>
                      <td className="font-semibold capitalize text-zinc-200">
                        {s.setupType.replace(/_/g, " ")}
                      </td>
                      <td className="text-right tabular-nums">{s.triggered}</td>
                      <td className="text-right tabular-nums">
                        {s.winRate == null ? "—" : `${s.winRate.toFixed(0)}%`}
                      </td>
                      <td className={`text-right tabular-nums ${(s.avgR ?? 0) > 0 ? "pos" : (s.avgR ?? 0) < 0 ? "neg" : "text-zinc-400"}`}>
                        {s.avgR == null ? "—" : `${s.avgR > 0 ? "+" : ""}${s.avgR.toFixed(2)}R`}
                      </td>
                      <td className="text-right tabular-nums text-zinc-500">
                        {s.wins} / {s.losses} / {s.expired}
                      </td>
                      <td className="text-right tabular-nums text-zinc-600">{s.noFill}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Notes notes={setups.notes} />
          </>
        )}
      </section>

      <p className="text-[11px] text-zinc-600">
        Abnormal return = the ticker&apos;s return minus SPY&apos;s over the same window. Score/pick figures are a
        calibration check (overlapping windows, finite samples), not a tradeable backtest. Realized-trade and
        setup-outcome stats are historical results of past calls, conservatively scored (same-bar stop+target
        counts as a stop). Past behavior never guarantees future results.
      </p>
    </div>
  );
}
