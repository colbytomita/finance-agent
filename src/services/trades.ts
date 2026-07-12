import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { nowIso } from "@/lib/util";
import { loadConfig } from "@/lib/config";
import { validateProposedTrade } from "./riskManagement";
import { daysToNextEarnings } from "./marketData";
import { ackTradeConditionAlerts } from "./alerts";

// Shared trade-close path: record the exit on the trade row and auto-create
// the journal entry. Used by the manual close action (trades API) and by the
// broker order sync when a bracket exit leg fills.

/**
 * Pre-trade risk gate (roadmap #29): run the pure `validateProposedTrade`
 * checks with the user's configured thresholds and the ticker's next
 * earnings date. Shared by the order-placement and manual-log routes. The
 * caller decides what to do with the problems — the app never hard-blocks a
 * user-initiated trade, it asks for explicit acknowledgement instead.
 */
export function pretradeRiskProblems(input: {
  ticker: string;
  direction: "long" | "short";
  entry: number;
  stop: number | null;
  target: number | null;
}): string[] {
  const cfg = loadConfig();
  return validateProposedTrade({
    entry: input.entry,
    stop: input.stop,
    target: input.target,
    direction: input.direction,
    minRiskReward: cfg.minRiskReward,
    daysToEarnings: daysToNextEarnings(input.ticker.toUpperCase()),
    avoidEarningsWithinDays: cfg.avoidEarningsWithinDays,
  });
}

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

  // The trade's condition alerts (stop hit, exit recommended, …) are moot now
  // (roadmap #49). If another open trade on the ticker still has a condition,
  // the next scan re-emits it — acking re-arms #45's once-while-unacked gate.
  ackTradeConditionAlerts(trade.ticker);

  return { exitPrice, profitLoss, profitLossPercent };
}
