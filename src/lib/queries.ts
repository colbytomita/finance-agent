import { desc, eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { loadConfig } from "@/lib/config";
import { isCatalystStale } from "@/services/catalysts";

// Read-side helpers used by server components and services. Latest-row
// lookups per ticker, plus the tracked-ticker set.

/** Every ticker the app tracks: holdings ∪ watchlist ∪ open trades. */
export function getTrackedTickers(): string[] {
  const db = getDb();
  const set = new Set<string>();
  for (const r of db.select({ t: schema.portfolioHoldings.ticker }).from(schema.portfolioHoldings).all())
    set.add(r.t);
  for (const r of db.select({ t: schema.watchlistItems.ticker }).from(schema.watchlistItems).all())
    set.add(r.t);
  for (const r of db
    .select({ t: schema.activeTrades.ticker })
    .from(schema.activeTrades)
    .where(eq(schema.activeTrades.status, "open"))
    .all())
    set.add(r.t);
  return [...set].sort();
}

export function latestScore(ticker: string) {
  return (
    getDb()
      .select()
      .from(schema.stockScores)
      .where(eq(schema.stockScores.ticker, ticker))
      .orderBy(desc(schema.stockScores.calculatedAt))
      .limit(1)
      .get() ?? null
  );
}

export function latestSnapshot(ticker: string) {
  return (
    getDb()
      .select()
      .from(schema.marketPriceSnapshots)
      .where(eq(schema.marketPriceSnapshots.ticker, ticker))
      .orderBy(desc(schema.marketPriceSnapshots.capturedAt))
      .limit(1)
      .get() ?? null
  );
}

export function latestDrawdown(ticker: string) {
  return (
    getDb()
      .select()
      .from(schema.drawdownMetrics)
      .where(eq(schema.drawdownMetrics.ticker, ticker))
      .orderBy(desc(schema.drawdownMetrics.calculatedAt))
      .limit(1)
      .get() ?? null
  );
}

export function tickerCatalysts(ticker: string, limit = 20) {
  return getDb()
    .select()
    .from(schema.catalysts)
    .where(eq(schema.catalysts.ticker, ticker))
    .orderBy(desc(schema.catalysts.discoveredAt))
    .limit(limit)
    .all();
}

/** Highest-|impact| current (non-expired, non-stale) catalyst, split into best positive / worst negative. */
export function topCatalystAndRisk(ticker: string): {
  topCatalyst: string | null;
  topRisk: string | null;
} {
  const freshnessDays = loadConfig().catalystFreshnessDays;
  const now = Date.now();
  const rows = tickerCatalysts(ticker, 50).filter(
    (c) => c.status !== "expired" && !isCatalystStale(c, freshnessDays, now),
  );
  const positive = rows.filter((c) => c.impactScore > 0).sort((a, b) => b.impactScore - a.impactScore);
  const negative = rows.filter((c) => c.impactScore < 0).sort((a, b) => a.impactScore - b.impactScore);
  return {
    topCatalyst: positive[0]?.title ?? null,
    topRisk: negative[0]?.title ?? null,
  };
}

export function activeSetups() {
  return getDb()
    .select()
    .from(schema.tradeSetups)
    .where(eq(schema.tradeSetups.status, "active"))
    .orderBy(desc(schema.tradeSetups.setupQualityScore))
    .all();
}

export function openTrades() {
  return getDb()
    .select()
    .from(schema.activeTrades)
    .where(eq(schema.activeTrades.status, "open"))
    .orderBy(desc(schema.activeTrades.updatedAt))
    .all();
}

export function closedTrades() {
  return getDb()
    .select()
    .from(schema.activeTrades)
    .where(eq(schema.activeTrades.status, "closed"))
    .orderBy(desc(schema.activeTrades.closedAt))
    .all();
}

export function journalEntries() {
  return getDb()
    .select()
    .from(schema.tradeJournalEntries)
    .orderBy(desc(schema.tradeJournalEntries.createdAt))
    .all();
}

export function recentScoreChanges(limit = 15) {
  return getDb()
    .select()
    .from(schema.scoreHistory)
    .orderBy(desc(schema.scoreHistory.recordedAt))
    .limit(limit)
    .all();
}

export function unackedAlerts(limit = 30) {
  return getDb()
    .select()
    .from(schema.alerts)
    .where(eq(schema.alerts.acknowledged, false))
    .orderBy(desc(schema.alerts.createdAt))
    .limit(limit)
    .all();
}

export function allWatchlist() {
  return getDb().select().from(schema.watchlistItems).orderBy(schema.watchlistItems.ticker).all();
}

export function allHoldings() {
  return getDb()
    .select()
    .from(schema.portfolioHoldings)
    .orderBy(schema.portfolioHoldings.ticker)
    .all();
}

export function allCatalysts() {
  return getDb().select().from(schema.catalysts).orderBy(desc(schema.catalysts.discoveredAt)).all();
}

export function tickerBars(ticker: string, limit = 250) {
  const rows = getDb()
    .select()
    .from(schema.priceBars)
    .where(eq(schema.priceBars.ticker, ticker))
    .orderBy(desc(schema.priceBars.barDate))
    .limit(limit)
    .all();
  return rows.reverse();
}

export interface JournalStats {
  totalTrades: number;
  winRate: number | null;
  avgGainPercent: number | null;
  avgLossPercent: number | null;
  avgHoldingDays: number | null;
  profitFactor: number | null;
}

export function journalStats(): JournalStats {
  const entries = journalEntries().filter((e) => e.profitLossPercent != null);
  if (entries.length === 0) {
    return {
      totalTrades: 0,
      winRate: null,
      avgGainPercent: null,
      avgLossPercent: null,
      avgHoldingDays: null,
      profitFactor: null,
    };
  }
  const wins = entries.filter((e) => (e.profitLoss ?? 0) > 0);
  const losses = entries.filter((e) => (e.profitLoss ?? 0) < 0);
  const grossWin = wins.reduce((a, e) => a + (e.profitLoss ?? 0), 0);
  const grossLoss = Math.abs(losses.reduce((a, e) => a + (e.profitLoss ?? 0), 0));
  const avg = (xs: number[]) => (xs.length > 0 ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  return {
    totalTrades: entries.length,
    winRate: (wins.length / entries.length) * 100,
    avgGainPercent: avg(wins.map((e) => e.profitLossPercent ?? 0)),
    avgLossPercent: avg(losses.map((e) => e.profitLossPercent ?? 0)),
    avgHoldingDays: avg(entries.map((e) => e.holdingPeriodDays ?? 0)),
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : null,
  };
}
