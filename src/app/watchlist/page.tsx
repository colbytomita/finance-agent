import Link from "next/link";
import {
  activeSetups,
  allWatchlist,
  latestDrawdown,
  latestScore,
  latestSnapshot,
} from "@/lib/queries";
import { loadConfig } from "@/lib/config";
import { portfolioWatchlistRecommendations } from "@/services/portfolioRecommendations";
import { fmtMoney } from "@/lib/format";
import { Freshness, Pct, RecBadge, ScoreBadge } from "@/components/badges";
import { AddWatchlistForm, DeleteButton } from "@/components/forms";
import { PortfolioRecActions } from "@/components/PortfolioRecActions";
import { RefreshButton } from "@/components/RefreshButton";

export const dynamic = "force-dynamic";

export default function WatchlistPage() {
  const cfg = loadConfig();
  const items = allWatchlist();
  const recs = portfolioWatchlistRecommendations(cfg.portfolioWatchlistRecLimit);
  const setups = activeSetups();
  const rows = items.map((w) => ({
    w,
    snap: latestSnapshot(w.ticker),
    score: latestScore(w.ticker),
    dd: latestDrawdown(w.ticker),
    setup: setups.find((s) => s.ticker === w.ticker) ?? null,
  }));

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <h1 className="text-lg font-bold">Watchlist</h1>
        <div className="ml-auto">
          <RefreshButton />
        </div>
      </div>
      <AddWatchlistForm />
      {recs.length > 0 && (
        <section className="card">
          <h2 className="card-title">From your portfolio — not yet watched</h2>
          <p className="mb-2 text-xs text-zinc-500">
            Holdings you own that aren’t on your watchlist. Add one to track its buy zone and scores,
            or dismiss to hide it. Showing up to {cfg.portfolioWatchlistRecLimit} (change in{" "}
            <Link href="/settings" className="text-sky-300 hover:underline">Settings</Link>).
          </p>
          <ul className="space-y-1.5 text-sm">
            {recs.map((r) => (
              <li key={r.ticker} className="flex items-center gap-3">
                <Link
                  href={`/stock/${r.ticker}`}
                  className="w-16 font-semibold text-sky-300 hover:underline"
                >
                  {r.ticker}
                </Link>
                <span className="min-w-0 flex-1 truncate text-zinc-400">{r.companyName ?? "—"}</span>
                <span className="tabular-nums">{fmtMoney(r.currentPrice)}</span>
                <span className="w-20 text-right"><Pct value={r.unrealizedGainLossPercent} /></span>
                <PortfolioRecActions ticker={r.ticker} companyName={r.companyName} />
              </li>
            ))}
          </ul>
        </section>
      )}
      <div className="overflow-x-auto">
        <table className="data-table">
          <thead>
            <tr>
              <th>Ticker</th>
              <th>Company</th>
              <th>Price</th>
              <th>Pre/AH</th>
              <th>52w high/low</th>
              <th>DD from 52w</th>
              <th>Buy zone</th>
              <th>Zone status</th>
              <th>Setup</th>
              <th>Catalyst</th>
              <th>Risk</th>
              <th>Stock score</th>
              <th>Setup score</th>
              <th>Rec</th>
              <th>Updated</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={16} className="py-6 text-center text-zinc-500">
                  Watchlist is empty — add a ticker above.
                </td>
              </tr>
            )}
            {rows.map(({ w, snap, score, dd, setup }) => (
              <tr key={w.id}>
                <td>
                  <Link href={`/stock/${w.ticker}`} className="font-semibold text-sky-300 hover:underline">
                    {w.ticker}
                  </Link>
                </td>
                <td className="max-w-40 truncate text-zinc-400">{w.companyName ?? "—"}</td>
                <td>{fmtMoney(snap?.regularPrice ?? dd?.currentPrice ?? null)}</td>
                <td className="text-xs">
                  {snap?.preMarketPrice != null && <span className="text-sky-300">pre {fmtMoney(snap.preMarketPrice)}</span>}
                  {snap?.afterHoursPrice != null && <span className="text-violet-300"> AH {fmtMoney(snap.afterHoursPrice)}</span>}
                  {snap?.preMarketPrice == null && snap?.afterHoursPrice == null && <span className="text-zinc-600">—</span>}
                </td>
                <td className="text-xs tabular-nums text-zinc-400">
                  {fmtMoney(dd?.fiftyTwoWeekHigh)} / {fmtMoney(dd?.fiftyTwoWeekLow)}
                </td>
                <td><Pct value={dd?.drawdownPercent} /></td>
                <td className="text-xs tabular-nums text-zinc-400">
                  {w.targetBuyLow != null || w.targetBuyHigh != null
                    ? `${fmtMoney(w.targetBuyLow)}–${fmtMoney(w.targetBuyHigh)}`
                    : "—"}
                </td>
                <td className="text-xs text-zinc-400">{dd?.buyZoneStatus ?? "—"}</td>
                <td className="text-xs text-zinc-300">
                  {setup ? setup.setupType.replace(/_/g, " ") : "—"}
                </td>
                <td><ScoreBadge score={score?.catalystScore} /></td>
                <td><ScoreBadge score={score?.riskScore} /></td>
                <td><ScoreBadge score={score?.overallScore} /></td>
                <td><ScoreBadge score={setup?.setupQualityScore} /></td>
                <td><RecBadge rec={score?.recommendation} /></td>
                <td><Freshness capturedAt={snap?.capturedAt} staleMinutes={cfg.staleDataMinutes} /></td>
                <td><DeleteButton url={`/api/watchlist/${w.id}`} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-[11px] text-zinc-600">
        Risk score: 10 = low risk. Catalyst/setup columns are model interpretation; price columns are raw data.
      </p>
    </div>
  );
}
