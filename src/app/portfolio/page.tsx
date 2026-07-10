import Link from "next/link";
import {
  allHoldings,
  latestDrawdown,
  latestScore,
  latestSnapshot,
  topCatalystAndRisk,
} from "@/lib/queries";
import { loadConfig } from "@/lib/config";
import { fmtMoney, fmtPct } from "@/lib/format";
import { Freshness, Pct } from "@/components/badges";
import {
  BuyZoneInsight,
  DrawdownInsight,
  RecommendationInsight,
  StockScoreInsight,
} from "@/components/insights";
import { AddHoldingForm, DeleteButton } from "@/components/forms";
import { SyncPortfolioButton } from "@/components/SyncPortfolioButton";
import { RefreshButton } from "@/components/RefreshButton";
import { EquityCurve } from "@/components/EquityCurve";

export const dynamic = "force-dynamic";

export default function PortfolioPage() {
  const cfg = loadConfig();
  const holdings = allHoldings();
  const rows = holdings.map((h) => ({
    h,
    snap: latestSnapshot(h.ticker),
    score: latestScore(h.ticker),
    dd: latestDrawdown(h.ticker),
    cat: topCatalystAndRisk(h.ticker),
  }));
  const totalValue = holdings.reduce((a, h) => a + (h.marketValue ?? 0), 0);
  const totalPL = holdings.reduce((a, h) => a + (h.unrealizedGainLoss ?? 0), 0);

  // Sector weights (roadmap #37) from the Yahoo-backfilled sector column;
  // holdings still missing one are grouped as "Unclassified".
  const sectorWeights =
    totalValue > 0
      ? [...holdings
          .reduce((m, h) => {
            const key = h.sector ?? "Unclassified";
            m.set(key, (m.get(key) ?? 0) + (h.marketValue ?? 0));
            return m;
          }, new Map<string, number>())]
          .map(([sector, value]) => ({ sector, pct: (value / totalValue) * 100 }))
          .sort((a, b) => b.pct - a.pct)
      : [];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-bold">Portfolio</h1>
        <span className="text-sm text-zinc-400">
          {fmtMoney(totalValue)} · unrealized <Pct value={totalValue - totalPL > 0 ? (totalPL / (totalValue - totalPL)) * 100 : null} />
        </span>
        <div className="ml-auto flex gap-2">
          <SyncPortfolioButton />
          <RefreshButton />
        </div>
      </div>
      {sectorWeights.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
          <span className="text-zinc-500">Sectors:</span>
          {sectorWeights.map(({ sector, pct }) => {
            const over = sector !== "Unclassified" && pct > cfg.maxSectorConcentrationPercent;
            return (
              <span
                key={sector}
                className={`rounded border px-1.5 py-0.5 tabular-nums ${
                  over
                    ? "border-amber-800 bg-amber-950 text-amber-300"
                    : "border-zinc-700 bg-zinc-900 text-zinc-400"
                }`}
                title={
                  over
                    ? `Above your ${cfg.maxSectorConcentrationPercent}% sector cap`
                    : sector === "Unclassified"
                      ? "No sector data yet — filled by daily maintenance via Yahoo"
                      : undefined
                }
              >
                {sector} {pct.toFixed(0)}%
              </span>
            );
          })}
        </div>
      )}
      <EquityCurve />
      <AddHoldingForm />
      <div className="overflow-x-auto">
        <table className="data-table">
          <thead>
            <tr>
              <th>Ticker</th>
              <th>Company</th>
              <th>Price</th>
              <th>Day</th>
              <th>Pre/AH</th>
              <th>Shares</th>
              <th>Avg cost</th>
              <th>Value</th>
              <th>Unrealized</th>
              <th>DD from high</th>
              <th>Buy zone</th>
              <th>Score</th>
              <th>Rec</th>
              <th>Top catalyst</th>
              <th>Top risk</th>
              <th>Updated</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={17} className="py-6 text-center text-zinc-500">
                  No holdings. Add one above or sync from Alpaca.
                </td>
              </tr>
            )}
            {rows.map(({ h, snap, score, dd, cat }) => (
              <tr key={h.id}>
                <td>
                  <Link href={`/stock/${h.ticker}`} className="font-semibold text-sky-300 hover:underline">
                    {h.ticker}
                  </Link>
                  {h.source === "alpaca" && <span className="ml-1 text-[10px] text-zinc-600">alpaca</span>}
                </td>
                <td className="max-w-40 truncate text-zinc-400">{h.companyName ?? "—"}</td>
                <td>{fmtMoney(h.currentPrice)}</td>
                <td><Pct value={snap?.dayChangePercent} /></td>
                <td className="text-xs">
                  {snap?.preMarketPrice != null && <span className="text-sky-300">pre {fmtMoney(snap.preMarketPrice)}</span>}
                  {snap?.afterHoursPrice != null && <span className="text-violet-300">AH {fmtMoney(snap.afterHoursPrice)}</span>}
                  {snap?.preMarketPrice == null && snap?.afterHoursPrice == null && <span className="text-zinc-600">—</span>}
                </td>
                <td className="tabular-nums">{h.shares}</td>
                <td>{fmtMoney(h.averageCost)}</td>
                <td>{fmtMoney(h.marketValue)}</td>
                <td>
                  <Pct value={h.unrealizedGainLossPercent} />{" "}
                  <span className="muted text-xs">{fmtMoney(h.unrealizedGainLoss, 0)}</span>
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
                <td className="text-xs text-zinc-400">
                  <BuyZoneInsight status={dd?.buyZoneStatus} distancePct={dd?.distanceFromBuyZonePercent}>
                    <span>{dd?.buyZoneStatus ?? "—"}</span>
                  </BuyZoneInsight>
                  {dd?.distanceFromBuyZonePercent != null && dd.distanceFromBuyZonePercent !== 0 && (
                    <span className="muted"> ({fmtPct(dd.distanceFromBuyZonePercent, 0)})</span>
                  )}
                </td>
                <td><StockScoreInsight score={score} weights={cfg.stockScoreWeights} /></td>
                <td><RecommendationInsight score={score} /></td>
                <td className="max-w-48 truncate text-xs text-emerald-300/80" title={cat.topCatalyst ?? ""}>
                  {cat.topCatalyst ?? "—"}
                </td>
                <td className="max-w-48 truncate text-xs text-red-300/80" title={cat.topRisk ?? ""}>
                  {cat.topRisk ?? "—"}
                </td>
                <td><Freshness capturedAt={snap?.capturedAt ?? h.updatedAt} staleMinutes={cfg.staleDataMinutes} /></td>
                <td><DeleteButton url={`/api/portfolio/${h.id}`} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-[11px] text-zinc-600">
        Scores/recommendations are model-generated interpretation. Prices are raw data from the listed source.
      </p>
    </div>
  );
}
