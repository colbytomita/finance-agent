import Link from "next/link";
import {
  activeSetups,
  allWatchlist,
  latestDrawdown,
  latestScore,
  latestSnapshot,
} from "@/lib/queries";
import { effectiveConfig, loadConfig } from "@/lib/config";
import { integrationsStatus } from "@/services/integrations";
import { currentAccountValue, daysToNextEarnings } from "@/services/marketData";
import { portfolioWatchlistRecommendations } from "@/services/portfolioRecommendations";
import { fmtMoney } from "@/lib/format";
import { EarningsBadge, Freshness, Pct } from "@/components/badges";
import {
  BuyZoneInsight,
  DrawdownInsight,
  RecommendationInsight,
  SetupInsight,
  StockComponentInsight,
  StockScoreInsight,
} from "@/components/insights";
import { AddWatchlistForm, BulkImportWatchlistForm, DeleteButton } from "@/components/forms";
import { PortfolioRecActions } from "@/components/PortfolioRecActions";
import { RefreshButton } from "@/components/RefreshButton";
import { PlaceOrderButton } from "@/components/TradeOrder";

export const dynamic = "force-dynamic";

export default function WatchlistPage() {
  const cfg = loadConfig();
  const accountValue = currentAccountValue();
  const items = allWatchlist();
  const integrations = integrationsStatus();
  const alpacaConfigured = integrations.alpacaConfigured;
  const alpacaMode = alpacaConfigured ? integrations.alpacaMode : null;
  const recs = portfolioWatchlistRecommendations(cfg.portfolioWatchlistRecLimit);
  const setups = activeSetups();
  const avoidEarningsWithin = effectiveConfig(cfg).avoidEarningsWithinDays;
  const rows = items.map((w) => ({
    w,
    snap: latestSnapshot(w.ticker),
    score: latestScore(w.ticker),
    dd: latestDrawdown(w.ticker),
    setup: setups.find((s) => s.ticker === w.ticker) ?? null,
    daysToEarnings: daysToNextEarnings(w.ticker),
  }));

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <h1 className="text-lg font-bold">Watchlist</h1>
        <div className="ml-auto">
          <RefreshButton />
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <AddWatchlistForm />
        <BulkImportWatchlistForm />
      </div>
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
              <th>Order</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={17} className="py-6 text-center text-zinc-500">
                  Watchlist is empty — add a ticker above.
                </td>
              </tr>
            )}
            {rows.map(({ w, snap, score, dd, setup, daysToEarnings }) => (
              <tr key={w.id}>
                <td>
                  <Link href={`/stock/${w.ticker}`} className="font-semibold text-sky-300 hover:underline">
                    {w.ticker}
                  </Link>
                  {daysToEarnings != null && (
                    <div className="mt-0.5">
                      <EarningsBadge days={daysToEarnings} avoidWithinDays={avoidEarningsWithin} />
                    </div>
                  )}
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
                <td>
                  <DrawdownInsight
                    pct={dd?.drawdownPercent}
                    currentPrice={dd?.currentPrice}
                    high52={dd?.fiftyTwoWeekHigh}
                  >
                    <Pct value={dd?.drawdownPercent} />
                  </DrawdownInsight>
                </td>
                <td className="text-xs tabular-nums text-zinc-400">
                  {w.targetBuyLow != null || w.targetBuyHigh != null
                    ? `${fmtMoney(w.targetBuyLow)}–${fmtMoney(w.targetBuyHigh)}`
                    : "—"}
                </td>
                <td className="text-xs text-zinc-400">
                  <BuyZoneInsight status={dd?.buyZoneStatus} distancePct={dd?.distanceFromBuyZonePercent} />
                </td>
                <td className="text-xs text-zinc-300">
                  {setup ? <SetupInsight setup={setup}>{setup.setupType.replace(/_/g, " ")}</SetupInsight> : "—"}
                </td>
                <td><StockComponentInsight score={score} component="catalyst" /></td>
                <td><StockComponentInsight score={score} component="risk" /></td>
                <td><StockScoreInsight score={score} weights={cfg.stockScoreWeights} /></td>
                <td><SetupInsight setup={setup} /></td>
                <td><RecommendationInsight score={score} /></td>
                <td><Freshness capturedAt={snap?.capturedAt} staleMinutes={cfg.staleDataMinutes} /></td>
                <td>
                  <PlaceOrderButton
                    ticker={w.ticker}
                    direction="long"
                    entryPrice={snap?.regularPrice ?? dd?.currentPrice ?? undefined}
                    stopLoss={w.maxRiskPrice}
                    mode={alpacaMode}
                    risk={{
                      minRiskReward: cfg.minRiskReward,
                      riskPerTradePercent: cfg.riskPerTradePercent,
                      accountValue,
                      maxPositionWeightPercent: cfg.maxPortfolioConcentrationPercent,
                    }}
                  />
                </td>
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
