import Link from "next/link";
import { notFound } from "next/navigation";
import {
  latestDrawdown,
  latestScore,
  latestSnapshot,
  openTrades,
  tickerBars,
  tickerCatalysts,
} from "@/lib/queries";
import { getLatestNote } from "@/services/researchAgent";
import { isCatalystStale } from "@/services/catalysts";
import { edgeCatalystsForTicker } from "@/services/catalystEdge";
import { listEarnings, classifySurprise } from "@/services/earnings";
import { listMentions } from "@/services/entityMentions";
import { computeIndicators } from "@/services/indicators";
import { daysToNextEarnings } from "@/services/marketData";
import { effectiveConfig, loadConfig } from "@/lib/config";
import { fmtDate, fmtMoney, fmtNum, fmtScore } from "@/lib/format";
import { EarningsBadge, Freshness, Pct, RecBadge, ScoreBadge } from "@/components/badges";
import { PriceChart, type ChartEvent } from "@/components/PriceChart";
import { ScoreSparkline } from "@/components/ScoreSparkline";
import { GenerateBriefButton } from "@/components/GenerateBriefButton";
import { RefreshButton } from "@/components/RefreshButton";
import { AddEarningsForm, FetchEarningsButton, DeleteButton } from "@/components/forms";

export const dynamic = "force-dynamic";

export default async function StockDetailPage({
  params,
}: {
  params: Promise<{ ticker: string }>;
}) {
  const { ticker: raw } = await params;
  if (!/^[A-Za-z.-]{1,10}$/.test(raw)) notFound();
  const ticker = raw.toUpperCase();

  const cfg = loadConfig();
  const snap = latestSnapshot(ticker);
  const score = latestScore(ticker);
  const dd = latestDrawdown(ticker);
  const barsRows = tickerBars(ticker);
  const bars = barsRows.map((b) => ({
    date: b.barDate,
    open: b.open,
    high: b.high,
    low: b.low,
    close: b.close,
    volume: b.volume,
  }));
  const ind = bars.length > 0 ? computeIndicators(bars) : null;
  const catalysts = tickerCatalysts(ticker);
  const edges = edgeCatalystsForTicker(ticker);
  const earnings = listEarnings(ticker, 6);
  const mentions = listMentions({ ticker });
  const daysToEarnings = daysToNextEarnings(ticker);

  // Event markers for the price chart: earnings, catalysts, and entity mentions.
  const chartEvents: ChartEvent[] = [
    ...earnings
      .filter((e) => e.reportDate)
      .map((e) => ({
        date: e.reportDate,
        type: "earnings" as const,
        title: `${e.fiscalPeriod ?? "Earnings"}${e.surprisePercent != null ? ` (${e.surprisePercent >= 0 ? "+" : ""}${e.surprisePercent.toFixed(1)}% surprise)` : ""}`,
      })),
    ...catalysts
      .filter((c) => c.eventDate ?? c.discoveredAt)
      .map((c) => ({ date: (c.eventDate ?? c.discoveredAt) as string, type: "catalyst" as const, title: c.title })),
    ...mentions
      .filter((mn) => mn.eventDate)
      .map((mn) => ({ date: mn.eventDate as string, type: "mention" as const, title: `${mn.entity}: ${mn.claim ?? "mentioned"}` })),
  ];
  const note = getLatestNote(ticker);
  const trade = openTrades().find((t) => t.ticker === ticker) ?? null;
  const reasoning: Record<string, unknown> = score?.reasoningJson
    ? JSON.parse(score.reasoningJson)
    : {};
  // reasoningJson holds per-component string[] plus a non-reason `weightsUsed`
  // object — only keep the array entries for the "Why these scores" list.
  const reasonEntries = Object.entries(reasoning).filter(
    (e): e is [string, string[]] => Array.isArray(e[1]),
  );

  const price = snap?.regularPrice ?? ind?.price ?? null;
  const levels = [
    ind?.support != null && { value: ind.support, label: "support", color: "#38bdf8" },
    ind?.resistance != null && { value: ind.resistance, label: "resistance", color: "#a78bfa" },
    trade?.stopLoss != null && { value: trade.stopLoss, label: "stop", color: "#f87171" },
    trade?.targetPrice1 != null && { value: trade.targetPrice1, label: "target 1", color: "#34d399" },
  ].filter(Boolean) as { value: number; label: string; color: string }[];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-bold">{ticker}</h1>
        <span className="text-xl tabular-nums">{fmtMoney(price)}</span>
        <Pct value={snap?.dayChangePercent} />
        {snap?.preMarketPrice != null && (
          <span className="text-sm text-sky-300">pre-market {fmtMoney(snap.preMarketPrice)}</span>
        )}
        {snap?.afterHoursPrice != null && (
          <span className="text-sm text-violet-300">after-hours {fmtMoney(snap.afterHoursPrice)}</span>
        )}
        <Freshness capturedAt={snap?.capturedAt} staleMinutes={cfg.staleDataMinutes} />
        <EarningsBadge days={daysToEarnings} avoidWithinDays={effectiveConfig(cfg).avoidEarningsWithinDays} />
        {snap?.source && <span className="text-[10px] text-zinc-600">source: {snap.source}</span>}
        <div className="ml-auto flex gap-2">
          <GenerateBriefButton ticker={ticker} />
          <RefreshButton />
        </div>
      </div>

      <div className="grid gap-3 lg:grid-cols-3">
        <div className="lg:col-span-2 space-y-3">
          <PriceChart
            closes={bars.map((b) => b.close)}
            dates={bars.map((b) => b.date)}
            levels={levels}
            volumes={bars.map((b) => b.volume)}
            events={chartEvents}
          />

          {/* Technicals (raw data) */}
          <section className="card">
            <h2 className="card-title">Technical snapshot (raw data)</h2>
            {!ind ? (
              <p className="text-sm text-zinc-500">
                No price history. Configure Alpaca and refresh to enable indicators, setups, and scoring detail.
              </p>
            ) : (
              <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-4">
                <span className="muted">SMA 20</span><span className="tabular-nums">{fmtNum(ind.sma20)}</span>
                <span className="muted">SMA 50</span><span className="tabular-nums">{fmtNum(ind.sma50)}</span>
                <span className="muted">SMA 200</span><span className="tabular-nums">{fmtNum(ind.sma200)}</span>
                <span className="muted">EMA 8 / 21</span>
                <span className="tabular-nums">{fmtNum(ind.ema8)} / {fmtNum(ind.ema21)}</span>
                <span className="muted">RSI 14</span><span className="tabular-nums">{fmtNum(ind.rsi14, 0)}</span>
                <span className="muted">MACD hist</span>
                <span className="tabular-nums">{fmtNum(ind.macd?.histogram ?? null, 3)}</span>
                <span className="muted">ATR 14</span><span className="tabular-nums">{fmtNum(ind.atr14)}</span>
                <span className="muted">Rel. volume</span>
                <span className="tabular-nums">{ind.relativeVolume != null ? `${ind.relativeVolume.toFixed(1)}x` : "—"}</span>
                <span className="muted">Support</span><span className="tabular-nums text-sky-300">{fmtNum(ind.support)}</span>
                <span className="muted">Resistance</span><span className="tabular-nums text-violet-300">{fmtNum(ind.resistance)}</span>
                <span className="muted">52w high/low</span>
                <span className="tabular-nums">{fmtNum(ind.fiftyTwoWeekHigh)} / {fmtNum(ind.fiftyTwoWeekLow)}</span>
                <span className="muted">VWAP 20d</span><span className="tabular-nums">{fmtNum(ind.vwap)}</span>
              </div>
            )}
          </section>

          {/* Catalyst timeline */}
          <section className="card">
            <h2 className="card-title">Catalyst timeline</h2>
            {catalysts.length === 0 ? (
              <p className="text-sm text-zinc-500">
                No catalysts tracked. Add one on the <Link href="/catalysts" className="text-sky-400 underline">Catalysts</Link> page.
              </p>
            ) : (
              <ul className="space-y-1.5 text-sm">
                {catalysts.slice(0, 15).map((c) => {
                  // Match the scoring engine's freshness window: stale items stay
                  // visible as history but are dimmed and labeled, since they no
                  // longer count toward the catalyst/sentiment components.
                  const stale = isCatalystStale(c, cfg.catalystFreshnessDays);
                  return (
                    <li key={c.id} className={`flex items-start gap-2 ${stale ? "opacity-50" : ""}`}>
                      <span className="w-20 shrink-0 text-xs tabular-nums text-zinc-500">
                        {fmtDate(c.eventDate ?? c.discoveredAt)}
                      </span>
                      <span
                        className={`shrink-0 text-xs font-semibold tabular-nums ${
                          c.impactScore > 0 ? "pos" : c.impactScore < 0 ? "neg" : "text-zinc-500"
                        }`}
                      >
                        {c.impactScore > 0 ? "+" : ""}{c.impactScore}
                      </span>
                      <span className="text-zinc-300">
                        {c.title}
                        <span className="muted text-xs"> · {c.catalystType.replace(/_/g, " ")} · {c.status}</span>
                        {stale && (
                          <span
                            className="ml-1.5 rounded border border-zinc-700 px-1 text-[10px] uppercase tracking-wide text-zinc-500"
                            title={`Older than the ${cfg.catalystFreshnessDays}-day freshness window — no longer weighs into scores.`}
                          >
                            stale
                          </span>
                        )}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          {/* Earnings — beat / meet / miss */}
          <section className="card">
            <div className="mb-2 flex flex-wrap items-center gap-3">
              <h2 className="card-title mb-0">Earnings — beat / meet / miss</h2>
              <FetchEarningsButton ticker={ticker} />
            </div>
            <AddEarningsForm ticker={ticker} />
            {earnings.length === 0 ? (
              <p className="mt-2 text-sm text-zinc-500">
                No earnings recorded. Log a quarterly result above — a recent beat or miss weighs into the
                stock score (recency-decayed; ±2% counts as in line).
              </p>
            ) : (
              <div className="mt-2 overflow-x-auto">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Period</th>
                      <th>Reported</th>
                      <th>EPS est</th>
                      <th>EPS actual</th>
                      <th>Surprise</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {earnings.map((e) => {
                      const cls = classifySurprise(e.surprisePercent);
                      const color = cls === "beat" ? "pos" : cls === "miss" ? "neg" : "text-zinc-400";
                      return (
                        <tr key={e.id}>
                          <td className="text-zinc-300">{e.fiscalPeriod ?? "—"}</td>
                          <td className="text-xs tabular-nums text-zinc-400">{fmtDate(e.reportDate)}</td>
                          <td className="tabular-nums">{e.epsEstimate ?? "—"}</td>
                          <td className="tabular-nums">{e.epsActual ?? "—"}</td>
                          <td className={`tabular-nums font-semibold ${color}`}>
                            {e.surprisePercent != null
                              ? `${e.surprisePercent >= 0 ? "+" : ""}${e.surprisePercent.toFixed(1)}% ${cls}`
                              : "—"}
                          </td>
                          <td>
                            <DeleteButton url={`/api/earnings/${e.id}`} />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* Entity catalyst edge */}
          {edges.length > 0 && (
            <section className="card">
              <h2 className="card-title">Entity catalyst edge</h2>
              <ul className="space-y-2 text-sm">
                {edges.map((e) => (
                  <li key={e.id} className="flex items-start gap-2">
                    <span
                      className={`shrink-0 text-xs font-semibold tabular-nums ${
                        e.impactScore > 0 ? "pos" : e.impactScore < 0 ? "neg" : "text-zinc-500"
                      }`}
                    >
                      {e.impactScore > 0 ? "+" : ""}
                      {e.impactScore}
                    </span>
                    <span>
                      <span className="text-zinc-200">{e.title}</span>
                      <span className="muted text-xs"> · confidence {e.confidence}</span>
                      {e.summary && <p className="text-xs text-zinc-500">{e.summary}</p>}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-[10px] text-zinc-600">
                Derived from the <Link href="/events" className="text-sky-400 underline">Catalyst Edge</Link>{" "}
                event study — historical correlation across a small sample, not advice or a prediction.
              </p>
            </section>
          )}
        </div>

        <div className="space-y-3">
          {/* Scores (model interpretation) */}
          <section className="card">
            <h2 className="card-title">Scores (model interpretation)</h2>
            {!score ? (
              <p className="text-sm text-zinc-500">Not scored yet — refresh data first.</p>
            ) : (
              <div className="space-y-2 text-sm">
                <div className="flex items-center gap-2">
                  <span className="text-2xl font-bold tabular-nums">{score.overallScore.toFixed(1)}</span>
                  <span className="muted">/10</span>
                  <RecBadge rec={score.recommendation} />
                  <span className="muted text-xs">confidence: {score.confidence}</span>
                </div>
                <div className="grid grid-cols-2 gap-1 text-xs">
                  <span className="muted">Valuation</span><ScoreBadge score={score.valuationScore} />
                  <span className="muted">Momentum</span><ScoreBadge score={score.momentumScore} />
                  <span className="muted">Catalysts</span><ScoreBadge score={score.catalystScore} />
                  <span className="muted">Risk (10=low)</span><ScoreBadge score={score.riskScore} />
                  <span className="muted">Sentiment</span><ScoreBadge score={score.sentimentScore} />
                </div>
                <ScoreSparkline ticker={ticker} />
                {trade && (
                  <div className="border-t border-zinc-800 pt-2">
                    <span className="muted text-xs">Open trade</span>
                    <div className="flex items-center gap-2">
                      <span className="font-semibold tabular-nums">{fmtScore(trade.tradeScore)}</span>
                      <RecBadge rec={trade.recommendation} />
                      <Pct value={trade.unrealizedGainLossPercent} />
                    </div>
                  </div>
                )}
                <p className="text-[10px] text-zinc-600">
                  Scored {fmtDate(score.calculatedAt)} · heuristic model output, not advice.
                </p>
              </div>
            )}
          </section>

          {/* Why */}
          {reasonEntries.length > 0 && (
            <section className="card">
              <h2 className="card-title">Why these scores</h2>
              <div className="space-y-2 text-xs">
                {reasonEntries.map(([component, reasons]) => (
                  <div key={component}>
                    <span className="font-semibold capitalize text-zinc-300">{component}</span>
                    <ul className="ml-3 list-disc text-zinc-400">
                      {reasons.map((r, i) => (
                        <li key={i}>{r}</li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Drawdown / buy zone */}
          <section className="card">
            <h2 className="card-title">Drawdown & buy zone</h2>
            {!dd ? (
              <p className="text-sm text-zinc-500">No drawdown data yet.</p>
            ) : (
              <div className="grid grid-cols-2 gap-y-1 text-sm">
                <span className="muted">From 52w high</span><Pct value={dd.drawdownPercent} />
                <span className="muted">From 30d high</span><Pct value={dd.drawdownFrom30dHighPercent} />
                <span className="muted">52w range</span>
                <span className="tabular-nums text-xs">{fmtMoney(dd.fiftyTwoWeekLow)}–{fmtMoney(dd.fiftyTwoWeekHigh)}</span>
                <span className="muted">Zone status</span>
                <span className="text-xs">{dd.buyZoneStatus ?? "—"}</span>
              </div>
            )}
          </section>

          {/* Research brief */}
          <section className="card">
            <h2 className="card-title">
              Research brief {note && <span className="lowercase text-zinc-600">({note.generatedBy}-generated)</span>}
            </h2>
            {!note ? (
              <p className="text-sm text-zinc-500">
                No brief yet — use “Generate research brief” above. Works without an LLM key (rule-based).
              </p>
            ) : (
              <div className="space-y-2 text-sm">
                <p className="text-zinc-200">{note.summary}</p>
                <div>
                  <span className="text-xs font-semibold text-emerald-300">Bull case</span>
                  <p className="text-xs text-zinc-400">{note.bullCase}</p>
                </div>
                <div>
                  <span className="text-xs font-semibold text-red-300">Bear case</span>
                  <p className="text-xs text-zinc-400">{note.bearCase}</p>
                </div>
                {note.risks && (
                  <div>
                    <span className="text-xs font-semibold text-amber-300">Risks</span>
                    <p className="text-xs text-zinc-400">{note.risks}</p>
                  </div>
                )}
                <p className="text-[10px] text-zinc-600">
                  {fmtDate(note.createdAt)} · model-generated interpretation — verify before acting.
                </p>
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
