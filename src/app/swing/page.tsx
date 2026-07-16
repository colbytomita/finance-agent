import Link from "next/link";
import {
  activeSetups,
  journalStats,
  journalEntries,
  openTrades,
  latestSnapshot,
} from "@/lib/queries";
import { effectiveConfig } from "@/lib/config";
import { integrationsStatus } from "@/services/integrations";
import { currentAccountValue, daysToNextEarnings } from "@/services/marketData";
import { suggestPositionSize } from "@/services/riskManagement";
import { fmtDate, fmtMoney, fmtNum, fmtPct } from "@/lib/format";
import { EarningsBadge, Freshness, Pct } from "@/components/badges";
import { MarketRegimeBanner } from "@/components/MarketRegimeBanner";
import { SetupInsight, TradeScoreInsight } from "@/components/insights";
import { AddTradeForm, CloseTradeButton } from "@/components/forms";
import { RefreshButton } from "@/components/RefreshButton";
import { PlaceOrderButton } from "@/components/TradeOrder";
import { listArchivedSetups } from "@/services/setupArchive";
import { ArchiveSetupButton, UnarchiveButton, ArchiveNoteInput } from "@/components/SetupArchive";

export const dynamic = "force-dynamic";

export default function SwingPage() {
  const cfg = effectiveConfig();
  const setups = activeSetups();
  const trades = openTrades();
  const stats = journalStats();
  const journal = journalEntries().slice(0, 25);
  const accountValue = currentAccountValue();
  const archived = listArchivedSetups();

  const integrations = integrationsStatus();
  const alpacaConfigured = integrations.alpacaConfigured;
  const alpacaMode = alpacaConfigured ? integrations.alpacaMode : null;

  const exitWatch = trades.filter((t) => {
    const price = t.currentPrice;
    if (t.recommendation === "Exit" || t.recommendation === "Trim") return true;
    if ((t.tradeScore ?? 10) < 5) return true;
    if (price != null && t.stopLoss != null) {
      const distPct = Math.abs((price - t.stopLoss) / price) * 100;
      if (distPct <= cfg.stopLossWarningPercent * 2) return true;
    }
    return false;
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <h1 className="text-lg font-bold">Swing Trading</h1>
        <span className="text-xs text-zinc-500">
          Risk profile: {cfg.riskProfile} · {cfg.riskPerTradePercent}% risk/trade · min R/R{" "}
          {cfg.minRiskReward}:1 · account {fmtMoney(accountValue, 0)}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <a href="/api/trades/export" download className="btn text-xs" title="Download closed trades + journal as CSV">
            Export CSV
          </a>
          <RefreshButton />
        </div>
      </div>

      <MarketRegimeBanner />

      <AddTradeForm />

      {/* Recommended trades */}
      <section>
        <h2 className="card-title">Recommended trades (detected setups)</h2>
        <div className="overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th>Ticker</th>
                <th>Price</th>
                <th>Setup</th>
                <th>Entry range</th>
                <th>Stop</th>
                <th>Target 1</th>
                <th>Target 2</th>
                <th>R/R</th>
                <th>Quality</th>
                <th>Suggested size</th>
                <th>Max loss</th>
                <th>Invalidation / note</th>
                <th>Order</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {setups.length === 0 && (
                <tr>
                  <td colSpan={14} className="py-4 text-center text-zinc-500">
                    No active setups detected. Setups need daily price history (Alpaca) and a refresh.
                  </td>
                </tr>
              )}
              {setups.map((s) => {
                const mid = (s.entryRangeLow + s.entryRangeHigh) / 2;
                const size = suggestPositionSize({
                  accountValue,
                  riskPerTradePercent: cfg.riskPerTradePercent,
                  entryPrice: mid,
                  stopLoss: s.stopLoss,
                  maxPositionWeightPercent: cfg.maxPortfolioConcentrationPercent,
                });
                const belowMin = s.riskRewardRatio < cfg.minRiskReward;
                const snap = latestSnapshot(s.ticker);
                const price = snap?.regularPrice ?? null;
                const inZone = price != null && price >= s.entryRangeLow && price <= s.entryRangeHigh;
                const belowStop = price != null && price <= s.stopLoss;
                const priceCls = belowStop
                  ? "text-red-300"
                  : inZone
                    ? "text-emerald-300"
                    : "text-zinc-200";
                return (
                  <tr key={s.id} className={belowMin ? "opacity-50" : ""}>
                    <td>
                      <Link href={`/stock/${s.ticker}`} className="font-semibold text-sky-300 hover:underline">
                        {s.ticker}
                      </Link>
                    </td>
                    <td className="tabular-nums">
                      {price != null ? (
                        <span className="inline-flex items-center gap-1">
                          <span className={priceCls}>{fmtMoney(price)}</span>
                          <Freshness capturedAt={snap?.capturedAt} staleMinutes={cfg.staleDataMinutes} />
                        </span>
                      ) : (
                        <span className="text-zinc-600">—</span>
                      )}
                      {inZone && <span className="block text-[10px] text-emerald-400">in entry zone</span>}
                    </td>
                    <td className="text-zinc-300">{s.setupType.replace(/_/g, " ")}</td>
                    <td className="tabular-nums">
                      {fmtMoney(s.entryRangeLow)}–{fmtMoney(s.entryRangeHigh)}
                    </td>
                    <td className="tabular-nums text-red-300">{fmtMoney(s.stopLoss)}</td>
                    <td className="tabular-nums text-emerald-300">{fmtMoney(s.targetPrice1)}</td>
                    <td className="tabular-nums">{fmtMoney(s.targetPrice2)}</td>
                    <td className="tabular-nums">
                      {s.riskRewardRatio.toFixed(1)}:1{belowMin && <span className="text-[10px] text-amber-400"> below min</span>}
                    </td>
                    <td><SetupInsight setup={s} /></td>
                    <td className="text-xs tabular-nums">
                      {size.shares > 0 ? `${size.shares} sh ≈ ${fmtMoney(size.positionValue, 0)}` : "—"}
                    </td>
                    <td className="text-xs tabular-nums text-red-300/80">
                      {size.shares > 0 ? fmtMoney(size.maxLossIfStopped, 0) : "—"}
                    </td>
                    <td className="max-w-72 truncate text-xs text-zinc-500" title={s.invalidationCondition ?? ""}>
                      {s.invalidationCondition ?? "—"}
                    </td>
                    <td>
                      <PlaceOrderButton
                        ticker={s.ticker}
                        direction="long"
                        suggestedShares={size.shares > 0 ? size.shares : undefined}
                        entryPrice={mid}
                        stopLoss={s.stopLoss}
                        targetPrice1={s.targetPrice1}
                        mode={alpacaMode}
                        risk={{
                          minRiskReward: cfg.minRiskReward,
                          riskPerTradePercent: cfg.riskPerTradePercent,
                          accountValue,
                          maxPositionWeightPercent: cfg.maxPortfolioConcentrationPercent,
                        }}
                      />
                    </td>
                    <td><ArchiveSetupButton setupId={s.id} ticker={s.ticker} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="mt-1 text-[11px] text-zinc-600">
          Setups are heuristic pattern detections. Sizing assumes {cfg.riskPerTradePercent}% account risk and your{" "}
          {cfg.maxPortfolioConcentrationPercent}% concentration cap.{" "}
          {alpacaMode
            ? `The Trade button sends a user-confirmed order to Alpaca (${alpacaMode}) and logs it as an open trade — nothing is placed automatically.`
            : "Connect Alpaca in .env to enable the Trade button."}
        </p>

        <details className="mt-2">
          <summary className="cursor-pointer text-sm text-zinc-400 hover:text-zinc-200">
            Archived recommendations ({archived.length})
          </summary>
          {archived.length === 0 ? (
            <p className="mt-2 text-sm text-zinc-500">
              Nothing archived. The Archive button on a recommendation keeps a snapshot here and
              hides it from the list above while the setup lasts.
            </p>
          ) : (
            <div className="mt-2 overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Ticker</th>
                    <th>Setup</th>
                    <th>Archived</th>
                    <th>Entry range</th>
                    <th>Stop</th>
                    <th>Target 1</th>
                    <th>Target 2</th>
                    <th>R/R</th>
                    <th>Quality</th>
                    <th>Current price</th>
                    <th>Note</th>
                    <th>Order</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {archived.map((a) => {
                    const snap = latestSnapshot(a.ticker);
                    const mid = (a.entryRangeLow + a.entryRangeHigh) / 2;
                    return (
                      <tr key={a.id} className={a.suppressing ? "" : "opacity-60"}>
                        <td>
                          <Link href={`/stock/${a.ticker}`} className="font-semibold text-sky-300 hover:underline">
                            {a.ticker}
                          </Link>
                          {!a.suppressing && (
                            <span
                              className="block text-[10px] text-zinc-600"
                              title="The setup episode this was archived from has ended — this row is history."
                            >
                              episode ended
                            </span>
                          )}
                        </td>
                        <td className="text-zinc-300">{a.setupType.replace(/_/g, " ")}</td>
                        <td className="text-xs">{fmtDate(a.archivedAt)}</td>
                        <td className="tabular-nums">
                          {fmtMoney(a.entryRangeLow)}–{fmtMoney(a.entryRangeHigh)}
                        </td>
                        <td className="tabular-nums text-red-300">{fmtMoney(a.stopLoss)}</td>
                        <td className="tabular-nums text-emerald-300">{fmtMoney(a.targetPrice1)}</td>
                        <td className="tabular-nums">{fmtMoney(a.targetPrice2)}</td>
                        <td className="tabular-nums">{a.riskRewardRatio.toFixed(1)}:1</td>
                        <td className="tabular-nums">{a.setupQualityScore.toFixed(1)}</td>
                        <td className="tabular-nums">
                          {snap?.regularPrice != null ? (
                            <span className="inline-flex items-center gap-1">
                              {fmtMoney(snap.regularPrice)}
                              <Freshness capturedAt={snap.capturedAt} staleMinutes={cfg.staleDataMinutes} />
                            </span>
                          ) : (
                            <span className="text-zinc-600">—</span>
                          )}
                        </td>
                        <td><ArchiveNoteInput id={a.id} initial={a.note} /></td>
                        <td>
                          <PlaceOrderButton
                            ticker={a.ticker}
                            direction="long"
                            entryPrice={mid}
                            stopLoss={a.stopLoss}
                            targetPrice1={a.targetPrice1}
                            mode={alpacaMode}
                            risk={{
                              minRiskReward: cfg.minRiskReward,
                              riskPerTradePercent: cfg.riskPerTradePercent,
                              accountValue,
                              maxPositionWeightPercent: cfg.maxPortfolioConcentrationPercent,
                            }}
                          />
                        </td>
                        <td><UnarchiveButton id={a.id} ticker={a.ticker} /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <p className="mt-1 text-[11px] text-zinc-600">
                Archived numbers are a snapshot from when you archived — the entry range and stop
                may no longer be valid. Re-check the chart before placing an order.
              </p>
            </div>
          )}
        </details>
      </section>

      {/* Open trades */}
      <section>
        <h2 className="card-title">Open trades</h2>
        <div className="overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th>Ticker</th>
                <th>Dir</th>
                <th>Entry</th>
                <th>Current</th>
                <th>P/L</th>
                <th>Score</th>
                <th>Action</th>
                <th>Stop</th>
                <th>Target</th>
                <th>Held</th>
                <th>Thesis</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {trades.length === 0 && (
                <tr>
                  <td colSpan={12} className="py-4 text-center text-zinc-500">No open trades.</td>
                </tr>
              )}
              {trades.map((t) => {
                const heldDays = Math.floor(
                  (Date.now() - new Date(t.entryDate).getTime()) / 86400000,
                );
                return (
                  <tr key={t.id}>
                    <td>
                      <Link href={`/stock/${t.ticker}`} className="font-semibold text-sky-300 hover:underline">
                        {t.ticker}
                      </Link>
                      {/* Broker order not (fully) filled yet — the entry shown is the
                          intended price, not an execution. Cleared once it fills. */}
                      {t.brokerOrderId && t.brokerOrderStatus !== "filled" && (
                        <span
                          className="ml-1 text-[10px] text-amber-400/90"
                          title="The broker order hasn't fully filled — entry price/size are the intended values until it does."
                        >
                          order {t.brokerOrderStatus ?? "working"}
                        </span>
                      )}
                      {(() => {
                        const dte = daysToNextEarnings(t.ticker);
                        return dte != null ? (
                          <div className="mt-0.5">
                            <EarningsBadge days={dte} avoidWithinDays={cfg.avoidEarningsWithinDays} />
                          </div>
                        ) : null;
                      })()}
                    </td>
                    <td className="text-xs text-zinc-400">{t.direction}</td>
                    <td className="tabular-nums">{fmtMoney(t.entryPrice)}</td>
                    <td className="tabular-nums">{fmtMoney(t.currentPrice)}</td>
                    <td>
                      <Pct value={t.unrealizedGainLossPercent} />{" "}
                      <span className="muted text-xs">{fmtMoney(t.unrealizedGainLoss, 0)}</span>
                    </td>
                    <td><TradeScoreInsight trade={t} kind="score" /></td>
                    <td><TradeScoreInsight trade={t} kind="rec" /></td>
                    <td className="tabular-nums text-red-300">{fmtMoney(t.stopLoss)}</td>
                    <td className="tabular-nums text-emerald-300">{fmtMoney(t.targetPrice1)}</td>
                    <td className="text-xs tabular-nums">{heldDays}d</td>
                    <td className="max-w-56 truncate text-xs text-zinc-500" title={t.thesis ?? ""}>
                      {t.thesis ?? "—"}
                    </td>
                    <td><CloseTradeButton tradeId={t.id} ticker={t.ticker} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {/* Exit watch */}
      <section className="card">
        <h2 className="card-title">Exit watch</h2>
        {exitWatch.length === 0 ? (
          <p className="text-sm text-zinc-500">No trades near stops, weak scores, or exit conditions.</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {exitWatch.map((t) => {
              const stopDist =
                t.currentPrice != null && t.stopLoss != null
                  ? Math.abs((t.currentPrice - t.stopLoss) / t.currentPrice) * 100
                  : null;
              return (
                <li key={t.id} className="flex flex-wrap items-center gap-2">
                  <TradeScoreInsight trade={t} kind="rec" />
                  <Link href={`/stock/${t.ticker}`} className="font-semibold hover:underline">{t.ticker}</Link>
                  <TradeScoreInsight trade={t} kind="score" />
                  {stopDist != null && (
                    <span className="text-xs text-amber-300">{fmtNum(stopDist, 1)}% from stop</span>
                  )}
                  {t.invalidationReason && (
                    <span className="text-xs text-red-300">thesis: {t.invalidationReason}</span>
                  )}
                  <span className="muted text-xs">P/L {fmtPct(t.unrealizedGainLossPercent)}</span>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* Journal */}
      <section>
        <div className="mb-2 flex flex-wrap items-center gap-4">
          <h2 className="card-title mb-0">Trade journal</h2>
          <span className="text-xs text-zinc-400">
            {stats.totalTrades} closed · win rate {stats.winRate != null ? `${stats.winRate.toFixed(0)}%` : "—"} ·
            avg gain {fmtPct(stats.avgGainPercent)} · avg loss {fmtPct(stats.avgLossPercent)} ·
            avg hold {stats.avgHoldingDays != null ? `${stats.avgHoldingDays.toFixed(1)}d` : "—"} ·
            profit factor {stats.profitFactor != null && isFinite(stats.profitFactor) ? stats.profitFactor.toFixed(2) : "—"}
          </span>
        </div>
        <div className="overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th>Closed</th>
                <th>Ticker</th>
                <th>P/L</th>
                <th>P/L %</th>
                <th>Held</th>
                <th>Exit reason</th>
                <th>Lessons</th>
                <th>Thesis played out</th>
              </tr>
            </thead>
            <tbody>
              {journal.length === 0 && (
                <tr>
                  <td colSpan={8} className="py-4 text-center text-zinc-500">No closed trades yet.</td>
                </tr>
              )}
              {journal.map((j) => (
                <tr key={j.id}>
                  <td className="text-xs">{fmtDate(j.createdAt)}</td>
                  <td className="font-semibold">{j.ticker}</td>
                  <td className={(j.profitLoss ?? 0) >= 0 ? "pos" : "neg"}>{fmtMoney(j.profitLoss, 0)}</td>
                  <td><Pct value={j.profitLossPercent} /></td>
                  <td className="text-xs tabular-nums">{j.holdingPeriodDays != null ? `${j.holdingPeriodDays}d` : "—"}</td>
                  <td className="max-w-48 truncate text-xs text-zinc-400">{j.exitReason ?? "—"}</td>
                  <td className="max-w-48 truncate text-xs text-zinc-400">{j.lessons ?? "—"}</td>
                  <td className="text-xs">{j.thesisPlayedOut == null ? "—" : j.thesisPlayedOut ? "yes" : "no"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
