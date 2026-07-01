import { getDb, schema } from "@/db";
import { nowIso } from "@/lib/util";

// Watchlist write helpers shared by the discovery agents. Promotion into the
// watchlist is always user-initiated (Accept / Add to watchlist) — no agent
// calls this on its own.

export interface WatchlistUpsert {
  ticker: string;
  companyName?: string | null;
  targetBuyLow?: number | null;
  targetBuyHigh?: number | null;
  notes?: string | null;
}

/** Insert-or-update a watchlist row by ticker, preserving createdAt on update. */
export function upsertWatchlistItem(item: WatchlistUpsert): void {
  const now = nowIso();
  const values = {
    ticker: item.ticker.toUpperCase(),
    companyName: item.companyName ?? null,
    targetBuyLow: item.targetBuyLow ?? null,
    targetBuyHigh: item.targetBuyHigh ?? null,
    notes: item.notes?.slice(0, 500) ?? null,
    updatedAt: now,
  };
  getDb()
    .insert(schema.watchlistItems)
    .values({ ...values, createdAt: now })
    .onConflictDoUpdate({ target: schema.watchlistItems.ticker, set: values })
    .run();
}
