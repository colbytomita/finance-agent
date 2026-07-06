import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { nowIso } from "@/lib/util";

// Shared trade-close path: record the exit on the trade row and auto-create
// the journal entry. Used by the manual close action (trades API) and by the
// broker order sync when a bracket exit leg fills.

export type ActiveTrade = typeof schema.activeTrades.$inferSelect;

export interface CloseTradeOptions {
  /** Actual exit price; falls back to current price, then entry. */
  exitPrice?: number | null;
  exitReason?: string | null;
  lessons?: string | null;
  mistakes?: string | null;
  thesisPlayedOut?: boolean | null;
}

export interface CloseTradeResult {
  exitPrice: number;
  profitLoss: number;
  profitLossPercent: number | null;
}

/** Close a trade: update the row and pre-fill its journal entry. */
export function closeTrade(trade: ActiveTrade, opts: CloseTradeOptions = {}): CloseTradeResult {
  const db = getDb();
  const now = nowIso();
  const exitPrice = opts.exitPrice ?? trade.currentPrice ?? trade.entryPrice;
  const dirMult = trade.direction === "short" ? -1 : 1;
  const profitLoss = (exitPrice - trade.entryPrice) * trade.shares * dirMult;
  const profitLossPercent =
    trade.entryPrice > 0 ? ((exitPrice - trade.entryPrice) / trade.entryPrice) * 100 * dirMult : null;
  const holdingDays = (Date.now() - new Date(trade.entryDate).getTime()) / 86400000;

  db.update(schema.activeTrades)
    .set({
      status: "closed",
      closedAt: now,
      exitPrice,
      currentPrice: exitPrice,
      unrealizedGainLoss: profitLoss,
      unrealizedGainLossPercent: profitLossPercent,
      updatedAt: now,
    })
    .where(eq(schema.activeTrades.id, trade.id))
    .run();

  db.insert(schema.tradeJournalEntries)
    .values({
      tradeId: trade.id,
      ticker: trade.ticker,
      entryReason: trade.thesis,
      entryScore: null,
      exitReason: opts.exitReason ?? null,
      exitScore: trade.tradeScore,
      profitLoss,
      profitLossPercent,
      holdingPeriodDays: Math.round(holdingDays * 10) / 10,
      mistakes: opts.mistakes ?? null,
      lessons: opts.lessons ?? null,
      catalystImpact: null,
      thesisPlayedOut: opts.thesisPlayedOut ?? null,
      createdAt: now,
    })
    .run();

  return { exitPrice, profitLoss, profitLossPercent };
}
