import { and, eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import type { Bar } from "@/lib/types";
import { AlpacaService } from "./alpaca";
import { getYahooDailyBars } from "./yahooHttp";
import { errorMessage, mapPool } from "@/lib/util";
import { getTrackedTickers } from "@/lib/queries";

// Daily-bar store: read, persist, and refresh OHLCV bars. Split out of
// marketData.ts (roadmap #26); analysis orchestration stays there.

const BAR_REFRESH_CONCURRENCY = 5;

export function getBars(ticker: string, timeframe = "1Day"): Bar[] {
  const db = getDb();
  const rows = db
    .select()
    .from(schema.priceBars)
    .where(and(eq(schema.priceBars.ticker, ticker), eq(schema.priceBars.timeframe, timeframe)))
    .orderBy(schema.priceBars.barDate)
    .all();
  return rows.map((r) => ({
    date: r.barDate,
    open: r.open,
    high: r.high,
    low: r.low,
    close: r.close,
    volume: r.volume,
  }));
}

/** Persist daily bars for one ticker (idempotent; existing rows are kept). */
export function saveBars(ticker: string, bars: Bar[], timeframe = "1Day", source = "alpaca"): void {
  const db = getDb();
  for (const b of bars) {
    db.insert(schema.priceBars)
      .values({
        ticker,
        timeframe,
        barDate: b.date,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
        volume: b.volume,
        source,
      })
      .onConflictDoNothing()
      .run();
  }
}

/** Fetch + persist daily bars — Alpaca when configured, Yahoo's chart endpoint otherwise. */
export async function refreshBars(tickers?: string[]): Promise<void> {
  const alpaca = AlpacaService.fromEnv();
  const list = [...new Set([...(tickers ?? getTrackedTickers()), "SPY"])];
  await mapPool(list, BAR_REFRESH_CONCURRENCY, async (ticker) => {
    try {
      let bars = alpaca ? await alpaca.getHistoricalBars(ticker, "1Day", 400) : [];
      let source = "alpaca";
      if (bars.length === 0) {
        bars = await getYahooDailyBars(ticker, 400);
        source = "yahoo";
      }
      if (bars.length > 0) saveBars(ticker, bars, "1Day", source);
    } catch (e) {
      console.error(`[bars] ${ticker}:`, errorMessage(e));
    }
  });
}
