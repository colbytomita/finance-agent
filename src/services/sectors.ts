import { eq, isNull } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { fetchQuoteSummary } from "./yahooHttp";
import { errorMessage, mapPool, nowIso } from "@/lib/util";

// Holding sector backfill (roadmap #37): Yahoo's assetProfile module carries
// the company sector; daily maintenance fills it for any holding that lacks
// one, which turns on the sector half of the concentration warnings and the
// portfolio breakdown. Real data only — unresolved tickers stay null.

/** Extract the sector from a quoteSummary assetProfile payload. Pure. */
export function sectorFromAssetProfile(json: unknown): string | null {
  const result = (
    json as {
      quoteSummary?: { result?: { assetProfile?: { sector?: unknown } }[] };
    }
  )?.quoteSummary?.result?.[0];
  const sector = result?.assetProfile?.sector;
  return typeof sector === "string" && sector.trim() !== "" ? sector.trim() : null;
}

/** Fetch one ticker's sector over the crumb session; null when unavailable. */
export async function getYahooSector(ticker: string): Promise<string | null> {
  try {
    return sectorFromAssetProfile(await fetchQuoteSummary(ticker, "assetProfile"));
  } catch {
    return null;
  }
}

const SECTOR_FETCH_CONCURRENCY = 4;

/**
 * Fill `sector` on every holding that doesn't have one yet. Idempotent and
 * incremental — already-filled rows are never re-fetched. The fetcher is
 * injectable for tests.
 */
export async function backfillHoldingSectors(
  fetchSector: (ticker: string) => Promise<string | null> = getYahooSector,
): Promise<{ checked: number; filled: number }> {
  const db = getDb();
  const missing = db
    .select()
    .from(schema.portfolioHoldings)
    .where(isNull(schema.portfolioHoldings.sector))
    .all();
  let filled = 0;
  await mapPool(missing, SECTOR_FETCH_CONCURRENCY, async (h) => {
    try {
      const sector = await fetchSector(h.ticker);
      if (sector) {
        db.update(schema.portfolioHoldings)
          .set({ sector, updatedAt: nowIso() })
          .where(eq(schema.portfolioHoldings.id, h.id))
          .run();
        filled++;
      }
    } catch (e) {
      console.error(`[sector] ${h.ticker}:`, errorMessage(e));
    }
  });
  return { checked: missing.length, filled };
}
