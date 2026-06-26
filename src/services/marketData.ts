import { and, desc, eq, inArray } from "drizzle-orm";
import { getDb, schema } from "@/db";
import type { Bar, MarketState, Quote } from "@/lib/types";
import { effectiveConfig, loadConfig } from "@/lib/config";
import { AlpacaService } from "./alpaca";
import { getYahooService } from "./yahooFinanceBrowser";
import { computeIndicators, type IndicatorSnapshot } from "./indicators";
import { computeDrawdown, evaluateBuyZone } from "./buyZone";
import { scoreStock, type CatalystInput } from "./scoring";
import { evaluateTrade } from "./tradeScoring";
import { detectSetups } from "./setupDetection";
import { isCatalystStale } from "./catalysts";
import { earningsSignalForTicker } from "./earnings";

// Orchestrates: fetch prices/bars -> persist snapshots -> recompute
// drawdowns, stock scores, trade scores, setups. All steps tolerate partial
// data; failures are logged and surfaced as stale data, never crashes.

const nowIso = () => new Date().toISOString();

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

export function getLatestSnapshot(ticker: string) {
  const db = getDb();
  return (
    db
      .select()
      .from(schema.marketPriceSnapshots)
      .where(eq(schema.marketPriceSnapshots.ticker, ticker))
      .orderBy(desc(schema.marketPriceSnapshots.capturedAt))
      .limit(1)
      .get() ?? null
  );
}

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

/** Run `fn` over `items` with at most `limit` in flight; preserves input order. */
async function mapPool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const idx = next++;
      results[idx] = await fn(items[idx]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  );
  return results;
}

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
  const wantYahoo = (opts.useYahoo ?? cfg.yahooBrowserEnabled) && marketState !== "REGULAR";
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
        error = `alpaca: ${e instanceof Error ? e.message : String(e)}`;
      }
    }

    // Yahoo for extended-hours data (or as the only source without Alpaca), but
    // only while we're within the time budget so the phase stays bounded.
    if ((wantYahoo || !quote) && Date.now() < yahooDeadline) {
      try {
        const yahoo = getYahooService();
        const fields = await yahoo.getSummaryFields(ticker);
        if (fields) {
          const yq = yahoo.toQuote(fields);
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
        error = `${error ? error + "; " : ""}yahoo: ${e instanceof Error ? e.message : String(e)}`;
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

/** Fetch + persist daily bars (needs Alpaca). */
export async function refreshBars(tickers?: string[]): Promise<void> {
  const alpaca = AlpacaService.fromEnv();
  if (!alpaca) return;
  const list = [...new Set([...(tickers ?? getTrackedTickers()), "SPY"])];
  await mapPool(list, PRICE_REFRESH_CONCURRENCY, async (ticker) => {
    try {
      const bars = await alpaca.getHistoricalBars(ticker, "1Day", 400);
      saveBars(ticker, bars);
    } catch (e) {
      console.error(`[bars] ${ticker}:`, e instanceof Error ? e.message : e);
    }
  });
}

/** Sync Alpaca positions into portfolio_holdings. */
export async function syncPortfolio(): Promise<{ synced: number } | { error: string }> {
  const alpaca = AlpacaService.fromEnv();
  if (!alpaca) return { error: "Alpaca credentials not configured" };
  const db = getDb();
  try {
    const positions = await alpaca.getPositions();
    for (const p of positions) {
      const values = {
        ticker: p.ticker,
        shares: p.qty,
        averageCost: p.avgEntryPrice,
        currentPrice: p.currentPrice,
        marketValue: p.marketValue,
        unrealizedGainLoss: p.unrealizedPl,
        unrealizedGainLossPercent: p.unrealizedPlPercent,
        source: "alpaca" as const,
        updatedAt: nowIso(),
      };
      db.insert(schema.portfolioHoldings)
        .values(values)
        .onConflictDoUpdate({ target: schema.portfolioHoldings.ticker, set: values })
        .run();
    }
    return { synced: positions.length };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

export function getCatalystInputs(ticker: string): CatalystInput[] {
  const db = getDb();
  const freshnessDays = loadConfig().catalystFreshnessDays;
  const now = Date.now();
  const rows = db
    .select()
    .from(schema.catalysts)
    .where(eq(schema.catalysts.ticker, ticker))
    .all();
  // Drop expired and stale catalysts entirely so old events never sway any score
  // component — including sentiment, which otherwise averages every catalyst.
  return rows
    .filter((c) => c.status !== "expired" && !isCatalystStale(c, freshnessDays, now))
    .map((c) => ({
      impactScore: c.impactScore,
      confidence: (c.confidence as CatalystInput["confidence"]) ?? "low",
      status: c.status,
      title: c.title,
    }));
}

export function daysToNextEarnings(ticker: string): number | null {
  const db = getDb();
  const rows = db
    .select()
    .from(schema.catalysts)
    .where(
      and(
        eq(schema.catalysts.ticker, ticker),
        eq(schema.catalysts.catalystType, "earnings"),
        eq(schema.catalysts.status, "upcoming"),
      ),
    )
    .all();
  let min: number | null = null;
  for (const r of rows) {
    if (!r.eventDate) continue;
    const days = (new Date(r.eventDate).getTime() - Date.now()) / 86400000;
    if (days >= 0 && (min == null || days < min)) min = Math.floor(days);
  }
  return min;
}

export interface TickerAnalysis {
  ticker: string;
  indicators: IndicatorSnapshot | null;
  drawdown: ReturnType<typeof computeDrawdown> | null;
  buyZone: ReturnType<typeof evaluateBuyZone> | null;
  stockScore: ReturnType<typeof scoreStock> | null;
}

/** Recompute drawdown metrics + stock score for one ticker, persist both. */
export function recomputeStockAnalysis(ticker: string): TickerAnalysis {
  const db = getDb();
  const cfg = loadConfig();
  const bars = getBars(ticker);
  const snap = getLatestSnapshot(ticker);
  const price =
    snap?.regularPrice ??
    snap?.afterHoursPrice ??
    snap?.preMarketPrice ??
    (bars.length > 0 ? bars[bars.length - 1].close : null);

  const indicators = bars.length > 0 ? computeIndicators(bars) : null;
  const watchItem = db
    .select()
    .from(schema.watchlistItems)
    .where(eq(schema.watchlistItems.ticker, ticker))
    .get();
  const holding = db
    .select()
    .from(schema.portfolioHoldings)
    .where(eq(schema.portfolioHoldings.ticker, ticker))
    .get();

  const drawdown =
    price != null && bars.length > 0
      ? computeDrawdown(bars, price, holding?.averageCost)
      : null;
  const catalystInputs = getCatalystInputs(ticker);
  const catalystsFavorable =
    catalystInputs.filter((c) => c.status !== "expired" && c.impactScore > 0).length >
    catalystInputs.filter((c) => c.status !== "expired" && c.impactScore < 0).length;

  const buyZone =
    price != null
      ? evaluateBuyZone(
          price,
          {
            targetBuyLow: watchItem?.targetBuyLow ?? null,
            targetBuyHigh: watchItem?.targetBuyHigh ?? null,
            reinvestAbovePrice: watchItem?.reinvestAbovePrice ?? null,
            maxRiskPrice: watchItem?.maxRiskPrice ?? null,
          },
          { catalystsFavorable },
        )
      : null;

  const earningsSig = earningsSignalForTicker(ticker, {
    freshnessDays: cfg.catalystFreshnessDays,
  });
  const stockScore = scoreStock({
    indicators,
    drawdown,
    catalysts: catalystInputs,
    weights: {
      valuation: cfg.stockScoreWeights.valuation,
      momentum: cfg.stockScoreWeights.momentum,
      catalyst: cfg.stockScoreWeights.catalyst,
      risk: cfg.stockScoreWeights.risk,
      sentiment: cfg.stockScoreWeights.sentiment,
    },
    earnings: earningsSig
      ? { impact: earningsSig.impactScore, reason: earningsSig.title ?? "Earnings surprise" }
      : null,
  });

  // Persist drawdown metrics.
  if (drawdown && price != null) {
    db.insert(schema.drawdownMetrics)
      .values({
        ticker,
        currentPrice: price,
        highWaterMark: drawdown.fiftyTwoWeekHigh,
        drawdownPercent: drawdown.drawdownFrom52wHighPercent,
        fiftyTwoWeekHigh: drawdown.fiftyTwoWeekHigh,
        fiftyTwoWeekLow: drawdown.fiftyTwoWeekLow,
        thirtyDayHigh: drawdown.thirtyDayHigh,
        drawdownFrom30dHighPercent: drawdown.drawdownFrom30dHighPercent,
        distanceFromBuyZonePercent: buyZone?.distanceFromBuyZonePercent ?? null,
        buyZoneStatus: buyZone?.status ?? null,
        calculatedAt: nowIso(),
      })
      .run();
  }

  // Persist stock score + history when it changed.
  const prev = db
    .select()
    .from(schema.stockScores)
    .where(eq(schema.stockScores.ticker, ticker))
    .orderBy(desc(schema.stockScores.calculatedAt))
    .limit(1)
    .get();
  db.insert(schema.stockScores)
    .values({
      ticker,
      overallScore: stockScore.overallScore,
      valuationScore: stockScore.components.valuationScore,
      momentumScore: stockScore.components.momentumScore,
      catalystScore: stockScore.components.catalystScore,
      riskScore: stockScore.components.riskScore,
      technicalScore: null,
      sentimentScore: stockScore.components.sentimentScore,
      recommendation: stockScore.recommendation,
      confidence: stockScore.confidence,
      reasoningJson: JSON.stringify({
        ...stockScore.reasoning,
        weightsUsed: stockScore.weightsUsed,
      }),
      calculatedAt: nowIso(),
    })
    .run();
  if (prev && Math.abs(prev.overallScore - stockScore.overallScore) >= 0.5) {
    db.insert(schema.scoreHistory)
      .values({
        ticker,
        scoreType: "stock",
        score: stockScore.overallScore,
        previousScore: prev.overallScore,
        changeReason: summarizeScoreChange(prev, stockScore),
        recordedAt: nowIso(),
      })
      .run();
  }

  return { ticker, indicators, drawdown, buyZone, stockScore };
}

function summarizeScoreChange(
  prev: { momentumScore: number; catalystScore: number; riskScore: number; valuationScore: number; sentimentScore: number },
  next: ReturnType<typeof scoreStock>,
): string {
  const deltas: [string, number][] = [
    ["momentum", next.components.momentumScore - prev.momentumScore],
    ["catalysts", next.components.catalystScore - prev.catalystScore],
    ["risk", next.components.riskScore - prev.riskScore],
    ["valuation", next.components.valuationScore - prev.valuationScore],
    ["sentiment", next.components.sentimentScore - prev.sentimentScore],
  ];
  deltas.sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
  const [name, delta] = deltas[0];
  if (Math.abs(delta) < 0.1) return "Minor recalculation drift.";
  return `${name} component ${delta > 0 ? "improved" : "weakened"} by ${Math.abs(delta).toFixed(1)}.`;
}

/** Recompute trade scores + recommendations for all open trades. */
export function recomputeTradeScores(): void {
  const db = getDb();
  const cfg = effectiveConfig();
  const trades = db
    .select()
    .from(schema.activeTrades)
    .where(eq(schema.activeTrades.status, "open"))
    .all();
  if (trades.length === 0) return;

  const spyBars = getBars("SPY");
  const marketIndicators = spyBars.length > 0 ? computeIndicators(spyBars) : null;
  const accountValue = currentAccountValue();

  for (const t of trades) {
    const bars = getBars(t.ticker);
    const indicators = bars.length > 0 ? computeIndicators(bars) : null;
    const price = t.currentPrice ?? indicators?.price ?? t.entryPrice;
    const catalystInputs = getCatalystInputs(t.ticker);
    const positionWeight =
      accountValue > 0 && t.currentPrice != null
        ? ((t.shares * t.currentPrice) / accountValue) * 100
        : null;

    const evaluation = evaluateTrade({
      trade: {
        direction: (t.direction as "long" | "short") ?? "long",
        entryPrice: t.entryPrice,
        currentPrice: price,
        stopLoss: t.stopLoss,
        targetPrice1: t.targetPrice1,
        targetPrice2: t.targetPrice2,
        thesis: t.thesis,
        thesisInvalidated: Boolean(t.invalidationReason),
        daysHeld: (Date.now() - new Date(t.entryDate).getTime()) / 86400000,
        daysToEarnings: daysToNextEarnings(t.ticker),
        positionWeightPercent: positionWeight,
      },
      indicators,
      marketIndicators,
      catalysts: catalystInputs,
      weights: cfg.tradeScoreWeights,
      previousScore: t.tradeScore,
      avoidEarningsWithinDays: cfg.avoidEarningsWithinDays,
      maxPositionWeightPercent: cfg.maxPortfolioConcentrationPercent,
    });

    db.update(schema.activeTrades)
      .set({
        tradeScore: evaluation.tradeScore,
        recommendation: evaluation.action,
        reasoningJson: JSON.stringify({
          components: evaluation.components,
          reasons: evaluation.reasons,
          exit: evaluation.hardRulesTriggered,
          trim: evaluation.trimReasons,
        }),
        updatedAt: nowIso(),
      })
      .where(eq(schema.activeTrades.id, t.id))
      .run();

    if (t.tradeScore != null && Math.abs(t.tradeScore - evaluation.tradeScore) >= 0.5) {
      db.insert(schema.scoreHistory)
        .values({
          ticker: t.ticker,
          scoreType: "trade",
          score: evaluation.tradeScore,
          previousScore: t.tradeScore,
          changeReason:
            evaluation.hardRulesTriggered[0] ??
            evaluation.trimReasons[0] ??
            evaluation.reasons[0] ??
            "Recalculated.",
          recordedAt: nowIso(),
        })
        .run();
    }
  }
}

export function currentAccountValue(): number {
  const db = getDb();
  const cfg = loadConfig();
  const holdings = db.select().from(schema.portfolioHoldings).all();
  const total = holdings.reduce((a, h) => a + (h.marketValue ?? 0), 0);
  return total > 0 ? total : cfg.accountValue;
}

/** Run setup detection across watchlist tickers, persist active setups. */
export function scanForSetups(): number {
  const db = getDb();
  const tickers = getTrackedTickers();
  let found = 0;
  // Expire previous active setups before re-scanning.
  db.update(schema.tradeSetups)
    .set({ status: "expired" })
    .where(eq(schema.tradeSetups.status, "active"))
    .run();
  for (const ticker of tickers) {
    const bars = getBars(ticker);
    if (bars.length < 30) continue;
    for (const setup of detectSetups(bars)) {
      db.insert(schema.tradeSetups)
        .values({
          ticker,
          setupType: setup.setupType,
          setupQualityScore: setup.setupQualityScore,
          entryRangeLow: setup.entryRangeLow,
          entryRangeHigh: setup.entryRangeHigh,
          stopLoss: setup.stopLoss,
          targetPrice1: setup.targetPrice1,
          targetPrice2: setup.targetPrice2,
          riskRewardRatio: setup.riskRewardRatio,
          invalidationCondition: `${setup.invalidationCondition} ${setup.explanation}`,
          detectedAt: nowIso(),
          status: "active",
        })
        .run();
      found++;
    }
  }
  return found;
}

/** Full refresh pipeline. */
export async function fullRefresh(): Promise<{
  prices: RefreshResult[];
  scoresRecomputed: number;
}> {
  const prices = await refreshPrices();
  await refreshBars();
  const tickers = getTrackedTickers();
  for (const t of tickers) {
    try {
      recomputeStockAnalysis(t);
    } catch (e) {
      console.error(`[score] ${t}:`, e instanceof Error ? e.message : e);
    }
  }
  recomputeTradeScores();
  scanForSetups();
  return { prices, scoresRecomputed: tickers.length };
}
