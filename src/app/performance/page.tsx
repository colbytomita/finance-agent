import { readCachedReport } from "@/services/signalPerformance";
import { closedTrades, getTradePerformance, journalEntries } from "@/lib/queries";
import { PerformanceView } from "@/components/performance/PerformanceView";

export const dynamic = "force-dynamic";

export default function PerformancePage() {
  // Trade rows are projected down to just what the realized-trade stats need —
  // the client re-summarizes them whenever the date range is narrowed.
  const trades = closedTrades().map((t) => ({
    id: t.id,
    direction: t.direction,
    entryPrice: t.entryPrice,
    exitPrice: t.exitPrice,
    stopLoss: t.stopLoss,
    entryDate: t.entryDate,
    closedAt: t.closedAt,
    unrealizedGainLoss: t.unrealizedGainLoss,
    unrealizedGainLossPercent: t.unrealizedGainLossPercent,
  }));
  const journal = journalEntries().map((j) => ({
    tradeId: j.tradeId,
    profitLossPercent: j.profitLossPercent,
    holdingPeriodDays: j.holdingPeriodDays,
    thesisPlayedOut: j.thesisPlayedOut,
  }));

  return (
    <PerformanceView
      report={readCachedReport()}
      trades={getTradePerformance()}
      closedTrades={trades}
      journal={journal}
    />
  );
}
