import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { loadConfig } from "@/lib/config";
import { nowIso } from "@/lib/util";

// "Add to watchlist" suggestions derived from your portfolio: holdings you own
// that aren't on the watchlist yet. Accepting one promotes it into the
// watchlist; dismissing one hides it so it stops occupying a suggestion slot.
//
// Dismissals are persisted in app_settings (no schema migration) as a JSON
// array of tickers, so a holding you never want watched stays hidden.

const DISMISSED_KEY = "portfolio_watchlist_dismissed";
export interface PortfolioRecommendation {
  ticker: string;
  companyName: string | null;
  currentPrice: number | null;
  unrealizedGainLossPercent: number | null;
  marketValue: number | null;
}

/**
 * Pure selection core: holdings not on the watchlist and not dismissed, ordered
 * largest position first, capped at `limit`. No IO, so it is unit-testable.
 */
export function selectRecommendations(
  holdings: PortfolioRecommendation[],
  watchTickers: Iterable<string>,
  dismissed: Iterable<string>,
  limit: number,
): PortfolioRecommendation[] {
  const watch = new Set([...watchTickers].map((t) => t.toUpperCase()));
  const skip = new Set([...dismissed].map((t) => t.toUpperCase()));
  const recs = holdings
    .filter((h) => !watch.has(h.ticker.toUpperCase()) && !skip.has(h.ticker.toUpperCase()))
    .sort(
      (a, b) =>
        (b.marketValue ?? 0) - (a.marketValue ?? 0) || a.ticker.localeCompare(b.ticker),
    );
  return recs.slice(0, Math.max(0, limit));
}

function getDismissed(): Set<string> {
  const row = getDb()
    .select()
    .from(schema.appSettings)
    .where(eq(schema.appSettings.key, DISMISSED_KEY))
    .get();
  if (!row) return new Set();
  try {
    const arr = JSON.parse(row.value) as unknown;
    return new Set(Array.isArray(arr) ? arr.map((t) => String(t).toUpperCase()) : []);
  } catch {
    return new Set();
  }
}

function saveDismissed(set: Set<string>): void {
  const value = JSON.stringify([...set]);
  const now = nowIso();
  getDb()
    .insert(schema.appSettings)
    .values({ key: DISMISSED_KEY, value, updatedAt: now })
    .onConflictDoUpdate({ target: schema.appSettings.key, set: { value, updatedAt: now } })
    .run();
}

/** Holdings worth adding to the watchlist, capped at the configured limit. */
export function portfolioWatchlistRecommendations(
  limit: number = loadConfig().portfolioWatchlistRecLimit,
): PortfolioRecommendation[] {
  const db = getDb();
  const holdings: PortfolioRecommendation[] = db
    .select()
    .from(schema.portfolioHoldings)
    .all()
    .map((h) => ({
      ticker: h.ticker,
      companyName: h.companyName,
      currentPrice: h.currentPrice,
      unrealizedGainLossPercent: h.unrealizedGainLossPercent,
      marketValue: h.marketValue,
    }));
  const watch = db
    .select({ t: schema.watchlistItems.ticker })
    .from(schema.watchlistItems)
    .all()
    .map((r) => r.t);
  return selectRecommendations(holdings, watch, getDismissed(), limit);
}

/** Promote a holding into the watchlist. Idempotent. */
export function acceptRecommendation(
  ticker: string,
  companyName?: string | null,
): { ok: true; ticker: string } {
  const t = ticker.toUpperCase();
  const now = nowIso();
  getDb()
    .insert(schema.watchlistItems)
    .values({ ticker: t, companyName: companyName ?? null, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({ target: schema.watchlistItems.ticker, set: { updatedAt: now } })
    .run();
  // If it had been dismissed before, clear that so state stays consistent.
  const dismissed = getDismissed();
  if (dismissed.delete(t)) saveDismissed(dismissed);
  return { ok: true, ticker: t };
}

/** Hide a holding from future suggestions. */
export function dismissRecommendation(ticker: string): { ok: true; ticker: string } {
  const t = ticker.toUpperCase();
  const dismissed = getDismissed();
  dismissed.add(t);
  saveDismissed(dismissed);
  return { ok: true, ticker: t };
}
