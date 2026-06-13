import Link from "next/link";
import {
  activeSetups,
  allWatchlist,
  latestDrawdown,
  latestScore,
  latestSnapshot,
  openTrades,
  recentScoreChanges,
  unackedAlerts,
} from "@/lib/queries";
import { loadConfig } from "@/lib/config";
import { fmtMoney, fmtPct, fmtScore } from "@/lib/format";
import { Freshness, Pct, RecBadge, ScoreBadge, SeverityDot } from "@/components/badges";
import { RefreshButton } from "@/components/RefreshButton";

export const dynamic = "force-dynamic";

export default function SummaryPage() {
  const cfg = loadConfig();
  const trades = openTrades();
  const setups = activeSetups().slice(0, 6);
  const watch = allWatchlist();
  const alerts = unackedAlerts(12);
  const scoreChanges = recentScoreChanges(8);

  const tradesNeedingAttention = trades.filter(
    (t) => t.recommendation === "Exit" || t.recommendation === "Trim" || (t.tradeScore ?? 10) < 5,
  );
  const exitWarnings = alerts.filter((a) => a.severity === "critical");

  const nearBuyZone = watch
    .map((w) => ({ w, dd: latestDrawdown(w.ticker) }))
    .filter(
      ({ dd }) =>
        dd?.buyZoneStatus === "In Buy Zone" ||
        (dd?.distanceFromBuyZonePercent != null && Math.abs(dd.distanceFromBuyZonePercent) <= 5),
    );

  const newestSnapshot = [...trades.map((t) => t.ticker), ...watch.map((w) => w.ticker)]
    .map((t) => latestSnapshot(t)?.capturedAt ?? null)
    .filter(Boolean)
    .sort()
    .pop() as string | null;

  const empty = trades.length === 0 && watch.length === 0;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-4">
        <h1 className="text-lg font-bold">Today</h1>
        <RefreshButton />
        <span className="ml-auto flex items-center gap-2 text-xs text-zinc-500">
          Data freshness: <Freshness capturedAt={newestSnapshot} staleMinutes={cfg.staleDataMinutes} />
        </span>
      </div>

      {empty && (
        <div className="card text-sm text-zinc-400">
          <p className="mb-2 font-semibold text-zinc-200">Get started</p>
          <ol className="list-decimal space-y-1 pl-5">
            <li>
              Add tickers on the <Link className="text-sky-400 underline" href="/watchlist">Watchlist</Link> page
              (with buy zones) or holdings on <Link className="text-sky-400 underline" href="/portfolio">Portfolio</Link>.
            </li>
            <li>Configure Alpaca keys in <code>.env</code> for price history (see .env.example).</li>
            <li>Click <em>Refresh data</em> to pull prices and compute scores.</li>
          </ol>
        </div>
      )}

      <div className="grid gap-3 lg:grid-cols-3">
        {/* Exit warnings + attention */}
        <section className="card lg:col-span-1">
          <h2 className="card-title">Needs attention</h2>
          {tradesNeedingAttention.length === 0 && exitWarnings.length === 0 ? (
            <p className="text-sm text-zinc-500">No exit warnings or weak trades right now.</p>
          ) : (
            <ul className="space-y-1.5 text-sm">
              {tradesNeedingAttention.map((t) => (
                <li key={t.id} className="flex items-center gap-2">
                  <RecBadge rec={t.recommendation ?? "—"} />
                  <Link href={`/stock/${t.ticker}`} className="font-semibold hover:underline">
                    {t.ticker}
                  </Link>
                  <ScoreBadge score={t.tradeScore} />
                  <span className="muted text-xs">P/L {fmtPct(t.unrealizedGainLossPercent)}</span>
                </li>
              ))}
              {exitWarnings.map((a) => (
                <li key={`a${a.id}`} className="flex items-center gap-2 text-xs text-red-300">
                  <SeverityDot severity={a.severity} /> {a.message}
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Best opportunities */}
        <section className="card lg:col-span-1">
          <h2 className="card-title">Best trade opportunities</h2>
          {setups.length === 0 ? (
            <p className="text-sm text-zinc-500">
              No active setups. Refresh after adding watchlist tickers (needs price history).
            </p>
          ) : (
            <ul className="space-y-1.5 text-sm">
              {setups.map((s) => (
                <li key={s.id} className="flex items-center gap-2">
                  <ScoreBadge score={s.setupQualityScore} />
                  <Link href={`/stock/${s.ticker}`} className="font-semibold hover:underline">
                    {s.ticker}
                  </Link>
                  <span className="text-zinc-400">{s.setupType.replace(/_/g, " ")}</span>
                  <span className="muted text-xs">
                    entry {fmtMoney(s.entryRangeLow, 2)}–{fmtMoney(s.entryRangeHigh, 2)} · R/R{" "}
                    {s.riskRewardRatio.toFixed(1)}:1
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Buy zone */}
        <section className="card lg:col-span-1">
          <h2 className="card-title">Near / in buy zone</h2>
          {nearBuyZone.length === 0 ? (
            <p className="text-sm text-zinc-500">Nothing near a configured buy zone.</p>
          ) : (
            <ul className="space-y-1.5 text-sm">
              {nearBuyZone.map(({ w, dd }) => (
                <li key={w.id} className="flex items-center gap-2">
                  <Link href={`/stock/${w.ticker}`} className="font-semibold hover:underline">
                    {w.ticker}
                  </Link>
                  <span className="text-xs text-zinc-400">{dd?.buyZoneStatus}</span>
                  <span className="muted text-xs">
                    {fmtMoney(dd?.currentPrice ?? null)} · zone {fmtMoney(w.targetBuyLow)}–
                    {fmtMoney(w.targetBuyHigh)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Score changes */}
        <section className="card lg:col-span-1">
          <h2 className="card-title">Score changes</h2>
          {scoreChanges.length === 0 ? (
            <p className="text-sm text-zinc-500">No material score changes recorded.</p>
          ) : (
            <ul className="space-y-1.5 text-xs">
              {scoreChanges.map((c) => (
                <li key={c.id}>
                  <span className="font-semibold text-zinc-200">{c.ticker}</span>{" "}
                  <span className="text-zinc-500">({c.scoreType})</span>{" "}
                  <span className={c.score > (c.previousScore ?? c.score) ? "pos" : "neg"}>
                    {c.previousScore?.toFixed(1)} → {c.score.toFixed(1)}
                  </span>{" "}
                  <span className="text-zinc-500">{c.changeReason}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Open trades snapshot */}
        <section className="card lg:col-span-1">
          <h2 className="card-title">Open trades</h2>
          {trades.length === 0 ? (
            <p className="text-sm text-zinc-500">
              No open trades. Log one on the <Link href="/swing" className="text-sky-400 underline">Swing Trading</Link> page.
            </p>
          ) : (
            <ul className="space-y-1.5 text-sm">
              {trades.map((t) => (
                <li key={t.id} className="flex items-center gap-2">
                  <Link href={`/stock/${t.ticker}`} className="font-semibold hover:underline">
                    {t.ticker}
                  </Link>
                  <ScoreBadge score={t.tradeScore} />
                  <RecBadge rec={t.recommendation} />
                  <Pct value={t.unrealizedGainLossPercent} />
                  <span className="muted text-xs">score {fmtScore(t.tradeScore)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Alerts */}
        <section className="card lg:col-span-1">
          <h2 className="card-title">Recent alerts</h2>
          {alerts.length === 0 ? (
            <p className="text-sm text-zinc-500">No unacknowledged alerts.</p>
          ) : (
            <ul className="space-y-1.5 text-xs">
              {alerts.map((a) => (
                <li key={a.id} className="flex items-start gap-2">
                  <span className="mt-1">
                    <SeverityDot severity={a.severity} />
                  </span>
                  <span className="text-zinc-300">{a.message}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <p className="text-[11px] leading-relaxed text-zinc-600">
        All scores and recommendations are model-generated decision support based on the data shown,
        not financial advice and not a guarantee of returns. Raw market data and model interpretation
        are labelled separately; verify before acting. This app never places trades.
      </p>
    </div>
  );
}
