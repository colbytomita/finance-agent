import { getDb, schema } from "@/db";
import { loadConfig } from "@/lib/config";
import { errorMessage, mapPool } from "@/lib/util";
import { AlpacaService } from "./alpaca";
import { analyzeTicker, suggestBuyZone } from "./discoveryAgent";
import { parseTickerList } from "./sectorScout";
import { upsertWatchlistItem } from "./watchlist";

// Watchlist bulk import: paste a comma/newline/space-separated ticker list and
// every symbol is validated against real market data (same path Sector Scout
// uses — no bars/price means rejected, never guessed) before it's added with a
// suggested buy zone. Tickers already on the watchlist are skipped so a
// re-import never clobbers hand-tuned zones or notes.

/** Per-request cap: bulk import is interactive, not a data-load pipeline. */
const MAX_IMPORT_TICKERS = 50;
const IMPORT_CONCURRENCY = 5;

export interface BulkImportResult {
  requested: number;
  added: { ticker: string; companyName: string | null }[];
  skipped: { ticker: string; reason: string }[];
}

export async function bulkImportWatchlist(raw: string): Promise<BulkImportResult> {
  const all = parseTickerList(raw);
  const result: BulkImportResult = { requested: all.length, added: [], skipped: [] };
  if (all.length === 0) return result;
  const tickers = all.slice(0, MAX_IMPORT_TICKERS);
  for (const t of all.slice(MAX_IMPORT_TICKERS))
    result.skipped.push({ ticker: t, reason: `over the ${MAX_IMPORT_TICKERS}-ticker limit` });

  const watched = new Set(
    getDb()
      .select({ ticker: schema.watchlistItems.ticker })
      .from(schema.watchlistItems)
      .all()
      .map((r) => r.ticker.toUpperCase()),
  );

  const cfg = loadConfig();
  const alpaca = AlpacaService.fromEnv();
  await mapPool(tickers, IMPORT_CONCURRENCY, async (ticker) => {
    if (watched.has(ticker)) {
      result.skipped.push({ ticker, reason: "already on watchlist" });
      return;
    }
    try {
      const a = await analyzeTicker(ticker, alpaca, cfg);
      if (!a) {
        result.skipped.push({ ticker, reason: "no real market data found" });
        return;
      }
      const { low, high } = suggestBuyZone(a);
      upsertWatchlistItem({
        ticker,
        companyName: a.companyName,
        targetBuyLow: low,
        targetBuyHigh: high,
        notes: "Added via bulk import",
      });
      result.added.push({ ticker, companyName: a.companyName });
    } catch (e) {
      result.skipped.push({ ticker, reason: errorMessage(e) });
    }
  });

  // mapPool completion order is nondeterministic; report in input order.
  const order = new Map(all.map((t, i) => [t, i]));
  result.added.sort((a, b) => (order.get(a.ticker) ?? 0) - (order.get(b.ticker) ?? 0));
  result.skipped.sort((a, b) => (order.get(a.ticker) ?? 0) - (order.get(b.ticker) ?? 0));
  return result;
}
