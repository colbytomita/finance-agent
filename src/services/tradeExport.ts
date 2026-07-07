import { closedTrades, journalEntries } from "@/lib/queries";
import { toCsvRow } from "@/lib/util";
import { tradeRMultiple } from "./tradePerformance";

// CSV export of closed trades joined with their journal entries (roadmap #22):
// the user's realized record — one row per closed trade — for taxes/bookkeeping,
// since the only way out otherwise is the raw SQLite file. Hand-rolled CSV via
// the shared toCsvRow (no deps); the row shape is pure and unit-testable.

const HEADER = [
  "ticker",
  "direction",
  "entry_date",
  "entry_price",
  "exit_date",
  "exit_price",
  "shares",
  "stop_loss",
  "pnl",
  "pnl_percent",
  "r_multiple",
  "holding_days",
  "thesis_played_out",
  "entry_reason",
  "exit_reason",
  "lessons",
] as const;

type Trade = ReturnType<typeof closedTrades>[number];
type Journal = ReturnType<typeof journalEntries>[number];

const round = (v: number | null | undefined, d = 2): number | null =>
  v == null || !isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d;

/** One CSV data row for a closed trade + its journal entry. Pure. */
export function tradeCsvRow(t: Trade, j: Journal | undefined): string {
  const r = tradeRMultiple(t.entryPrice, t.exitPrice, t.stopLoss, t.direction);
  return toCsvRow([
    t.ticker,
    t.direction,
    t.entryDate,
    round(t.entryPrice),
    t.closedAt,
    round(t.exitPrice),
    t.shares,
    round(t.stopLoss),
    round(t.unrealizedGainLoss ?? j?.profitLoss),
    round(t.unrealizedGainLossPercent ?? j?.profitLossPercent),
    round(r),
    round(j?.holdingPeriodDays, 1),
    j?.thesisPlayedOut == null ? "" : j.thesisPlayedOut ? "yes" : "no",
    j?.entryReason ?? t.thesis,
    j?.exitReason,
    j?.lessons,
  ]);
}

/** Build the full CSV (header + one row per closed trade, newest first). */
export function buildClosedTradesCsv(): string {
  const trades = closedTrades();
  const journalByTrade = new Map<number, Journal>();
  for (const j of journalEntries()) if (j.tradeId != null) journalByTrade.set(j.tradeId, j);
  const rows = trades.map((t) => tradeCsvRow(t, journalByTrade.get(t.id)));
  return [toCsvRow([...HEADER]), ...rows].join("\r\n") + "\r\n";
}
