import { and, eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import type { MarketState, Quote } from "@/lib/types";
import { loadConfig } from "@/lib/config";
import { AlpacaService } from "./alpaca";
import { quoteFromSummaryFields } from "./yahooFinanceBrowser";
import { getYahooSummaryFields } from "./yahooHttp";
import { errorMessage, mapPool, nowIso } from "@/lib/util";
import { getTrackedTickers } from "@/lib/queries";

// Live-quote refresh: fetch snapshots (Alpaca first, Yahoo for extended
// hours), persist them, and push the latest price into holdings and open
// trades. Split out of marketData.ts (roadmap #26); analysis orchestration
// stays there.

export function saveSnapshot(q: Quote): void {
  const db = getDb();
  db.insert(schema.marketPriceSnapshots)
    .values({
      ticker: q.ticker,
      regularPrice: q.regularPrice,
      preMarketPrice: q.preMarketPrice,
      afterHoursPrice: q.afterHoursPrice,
      dayChangePercent: q.dayChangePercent,
      marketState: q.marketState,
      source: q.source,
      capturedAt: q.capturedAt,
    })
    .run();
}

export interface RefreshResult {
  ticker: string;
  ok: boolean;
  source: string | null;
  error?: string;
}

/** Refresh price snapshots for all tracked tickers. Alpaca first, Yahoo for extended hours. */
// The Yahoo connector drives a headless browser, so it's far slower than the
// Alpaca REST snapshot. To keep a manual refresh responsive (and stop it hanging
// for minutes when the market is closed and every ticker needs Yahoo), we scrape
// with bounded concurrency and an overall time budget. Alpaca already supplies
// the regular price, so any ticker the budget can't reach simply goes without
// extended-hours data this round rather than blocking the whole refresh.
const PRICE_REFRESH_CONCURRENCY = 5;
const YAHOO_PHASE_BUDGET_MS = 75_000;

export async function refreshPrices(opts: { useYahoo?: boolean } = {}): Promise<RefreshResult[]> {
  const cfg = loadConfig();
  const tickers = getTrackedTickers();
  if (tickers.length === 0) return [];
  const alpaca = AlpacaService.fromEnv();

  // Determine market state once (Alpaca clock if available).
  let marketState: MarketState = "UNKNOWN";
  if (alpaca) {
    try {
      const clock = await alpaca.getMarketClock();
      marketState = clock.isOpen ? "REGULAR" : "CLOSED";
    } catch {
      /* keep UNKNOWN */
    }
  }
  // Yahoo adds extended-hours data — useful any time the market isn't in
  // regular session (pre, post, closed, or unknown state).
  const wantYahoo = (opts.useYahoo ?? cfg.yahooEnabled) && marketState !== "REGULAR";
  const yahooDeadline = Date.now() + YAHOO_PHASE_BUDGET_MS;

  const fetchOne = async (ticker: string): Promise<RefreshResult> => {
    let quote: Quote | null = null;
    let error: string | undefined;

    if (alpaca) {
      try {
        const snap = await alpaca.getSnapshot(ticker);
        if (snap.latestPrice != null) {
          quote = {
            ticker,
            regularPrice: snap.latestPrice,
            preMarketPrice: null,
            afterHoursPrice: null,
            dayChangePercent: snap.dailyChangePercent,
            marketState,
            source: "alpaca",
            capturedAt: nowIso(),
          };
        }
      } catch (e) {
        error = `alpaca: ${errorMessage(e)}`;
      }
    }

    // Yahoo for extended-hours data (or as the only source without Alpaca), but
    // only while we're within the time budget so the phase stays bounded.
    if ((wantYahoo || !quote) && Date.now() < yahooDeadline) {
      try {
        const fields = await getYahooSummaryFields(ticker);
        if (fields) {
          const yq = quoteFromSummaryFields(fields);
          if (quote) {
            quote = {
              ...quote,
              preMarketPrice: yq.preMarketPrice,
              afterHoursPrice: yq.afterHoursPrice,
              marketState: yq.marketState !== "UNKNOWN" ? yq.marketState : quote.marketState,
            };
          } else {
            quote = yq;
          }
        }
      } catch (e) {
        error = `${error ? error + "; " : ""}yahoo: ${errorMessage(e)}`;
      }
    }

    if (quote) {
      saveSnapshot(quote);
      updateCurrentPrices(ticker, quote);
      return { ticker, ok: true, source: quote.source };
    }
    return { ticker, ok: false, source: null, error: error ?? "no data source available" };
  };

  return mapPool(tickers, PRICE_REFRESH_CONCURRENCY, fetchOne);
}

/** Push latest price into holdings and open trades for the ticker. */
function updateCurrentPrices(ticker: string, q: Quote): void {
  const db = getDb();
  const price = q.regularPrice ?? q.afterHoursPrice ?? q.preMarketPrice;
  if (price == null) return;

  const holding = db
    .select()
    .from(schema.portfolioHoldings)
    .where(eq(schema.portfolioHoldings.ticker, ticker))
    .get();
  if (holding) {
    const marketValue = holding.shares * price;
    const cost = holding.shares * holding.averageCost;
    db.update(schema.portfolioHoldings)
      .set({
        currentPrice: price,
        marketValue,
        unrealizedGainLoss: marketValue - cost,
        unrealizedGainLossPercent: cost > 0 ? ((marketValue - cost) / cost) * 100 : null,
        updatedAt: nowIso(),
      })
      .where(eq(schema.portfolioHoldings.id, holding.id))
      .run();
  }

  const trades = db
    .select()
    .from(schema.activeTrades)
    .where(and(eq(schema.activeTrades.ticker, ticker), eq(schema.activeTrades.status, "open")))
    .all();
  for (const t of trades) {
    const gain = (price - t.entryPrice) * t.shares * (t.direction === "short" ? -1 : 1);
    const gainPct =
      t.entryPrice > 0
        ? ((price - t.entryPrice) / t.entryPrice) * 100 * (t.direction === "short" ? -1 : 1)
        : null;
    db.update(schema.activeTrades)
      .set({
        currentPrice: price,
        unrealizedGainLoss: gain,
        unrealizedGainLossPercent: gainPct,
        maxGainPercent:
          gainPct != null ? Math.max(t.maxGainPercent ?? -Infinity, gainPct) : t.maxGainPercent,
        maxDrawdownPercent:
          gainPct != null
            ? Math.min(t.maxDrawdownPercent ?? Infinity, gainPct)
            : t.maxDrawdownPercent,
        updatedAt: nowIso(),
      })
      .where(eq(schema.activeTrades.id, t.id))
      .run();
  }
}
