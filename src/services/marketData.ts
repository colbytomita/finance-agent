import { and, desc, eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { effectiveConfig, loadConfig } from "@/lib/config";
import { AlpacaService } from "./alpaca";
import { refreshPrices, type RefreshResult } from "./quotes";
import { getBars, refreshBars } from "./bars";
import { computeIndicators, type IndicatorSnapshot } from "./indicators";
import { computeDrawdown, evaluateBuyZone } from "./buyZone";
import { scoreStock, scoreRowValues, type CatalystInput } from "./scoring";
import { evaluateTrade } from "./tradeScoring";
import { detectSetups } from "./setupDetection";
import { clearEndedSuppressions, pairKey } from "./setupArchive";
import { isCatalystStale, EARNINGS_CALENDAR_SOURCE } from "./catalysts";
import { earningsSignalForTicker } from "./earnings";
import { upsertPortfolioSnapshot } from "./portfolioHistory";
import { errorMessage, nowIso } from "@/lib/util";
import { getTrackedTickers, latestSnapshot } from "@/lib/queries";

// Analysis orchestration: recompute drawdowns, stock scores, trade scores,
// and setups from stored quotes/bars, plus the full refresh pipeline. The
// quote fetch lives in ./quotes and the bar store in ./bars (roadmap #26).
// All steps tolerate partial data; failures are logged and surfaced as stale
// data, never crashes.

// Tracked-ticker plumbing and latest-row lookups live in @/lib/queries;
// re-exported here for the callers that reach them through the market-data
// service.
export { getTrackedTickers };
export { latestSnapshot as getLatestSnapshot };

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
    return { error: errorMessage(e) };
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
  // Also drop auto-fetched upcoming-earnings *date* markers: a future date with
  // unknown direction is a schedule signal for the proximity guard, not a
  // directional catalyst, and would otherwise re-activate the neutral
  // catalyst/sentiment components on every tracked ticker.
  return rows
    .filter(
      (c) =>
        c.status !== "expired" &&
        c.sourceName !== EARNINGS_CALENDAR_SOURCE &&
        !isCatalystStale(c, freshnessDays, now),
    )
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
  const snap = latestSnapshot(ticker);
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
      ...scoreRowValues(stockScore),
      technicalScore: null,
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
  const detected = new Set<string>();
  // Expire previous active setups before re-scanning.
  db.update(schema.tradeSetups)
    .set({ status: "expired" })
    .where(eq(schema.tradeSetups.status, "active"))
    .run();
  for (const ticker of tickers) {
    const bars = getBars(ticker);
    if (bars.length < 30) continue;
    for (const setup of detectSetups(bars)) {
      detected.add(pairKey(ticker, setup.setupType));
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
  // Archived pairs the scan no longer detects have finished their episode —
  // stop hiding them so a future NEW episode lists normally (spec 2026-07-16).
  clearEndedSuppressions(detected);
  return found;
}

/** Full refresh pipeline. */
export async function fullRefresh(): Promise<{
  prices: RefreshResult[];
  scoresRecomputed: number;
}> {
  const prices = await refreshPrices();
  upsertPortfolioSnapshot(); // holdings just repriced — record today's account value
  await refreshBars();
  const tickers = getTrackedTickers();
  for (const t of tickers) {
    try {
      recomputeStockAnalysis(t);
    } catch (e) {
      console.error(`[score] ${t}:`, errorMessage(e));
    }
  }
  recomputeTradeScores();
  scanForSetups();
  return { prices, scoresRecomputed: tickers.length };
}
