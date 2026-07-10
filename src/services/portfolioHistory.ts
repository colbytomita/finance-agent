import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { nowIso } from "@/lib/util";

// Daily account-value snapshots (roadmap #31): one upserted row per calendar
// day, written on every refresh, so the equity curve reflects the last
// refresh of each day. Real data only — nothing is backfilled or fabricated.

/** Local calendar date (YYYY-MM-DD) — the snapshot key. */
export function localSnapshotDate(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}

/**
 * Record today's account value: holdings, plus open trades whose ticker the
 * holdings table doesn't already carry (a broker-synced position already
 * includes a swing trade's shares — summing both would double-count).
 * Returns null (and writes nothing) when there's nothing tracked or no
 * priced value yet, so empty databases never accumulate zero rows.
 */
export function upsertPortfolioSnapshot(
  date = localSnapshotDate(),
): { date: string; totalValue: number } | null {
  const db = getDb();
  const holdings = db.select().from(schema.portfolioHoldings).all();
  const trades = db
    .select()
    .from(schema.activeTrades)
    .where(eq(schema.activeTrades.status, "open"))
    .all();
  const held = new Set(holdings.map((h) => h.ticker));
  const holdingsValue = holdings.reduce((a, h) => a + (h.marketValue ?? 0), 0);
  const openTradesValue = trades
    .filter((t) => !held.has(t.ticker) && t.currentPrice != null)
    .reduce((a, t) => a + t.shares * (t.currentPrice as number), 0);
  const totalValue = holdingsValue + openTradesValue;
  if (totalValue <= 0) return null;

  const values = {
    snapshotDate: date,
    holdingsValue,
    openTradesValue,
    totalValue,
    holdingCount: holdings.length,
    capturedAt: nowIso(),
  };
  db.insert(schema.portfolioSnapshots)
    .values(values)
    .onConflictDoUpdate({ target: schema.portfolioSnapshots.snapshotDate, set: values })
    .run();
  return { date, totalValue };
}

/** Snapshot history, oldest first (bounded to the most recent `limit` days). */
export function portfolioHistory(limit = 365) {
  const db = getDb();
  const rows = db
    .select()
    .from(schema.portfolioSnapshots)
    .orderBy(schema.portfolioSnapshots.snapshotDate)
    .all();
  return rows.slice(-limit);
}
