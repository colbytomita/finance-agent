import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import type { Bar } from "@/lib/types";
import { AlpacaService } from "./alpaca";
import { ensureBarsCover } from "./entityMentions";
import { getBars, saveBars } from "./marketData";
import {
  eventStudy,
  aggregateEventStudies,
  type EventStudyResult,
  type EventWindowKey,
  type WindowEdge,
} from "./eventStudy";
import { stockRecommendationLabel } from "./scoring";
import type { StockRecommendationLabel } from "@/lib/types";

// Signal-performance ("does the score actually work?") backtest.
//
// The app appends a stock_scores row every time it recomputes a ticker, so we
// already have a time-series of every score it has ever produced. Here we treat
// each historical score as an "event" and reuse the Catalyst-Edge event-study
// engine (forward abnormal return vs SPY over [0,+1]/[0,+5]/[0,+20]) to measure,
// per recommendation band, what those tickers actually did next. If the score is
// calibrated, higher bands should show higher forward abnormal returns.
//
// This is historical correlation across the app's own past calls — not a
// prediction and not advice. Pure aggregation lives in `bucketAndAggregate`
// (unit-tested); `runSignalBacktest` adds the DB/network IO.

/** Recommendation bands, best → worst, with their score ranges (see scoring.ts). */
export const SCORE_BANDS: { label: StockRecommendationLabel; range: string }[] = [
  { label: "Strong Buy Candidate", range: "9–10" },
  { label: "Buy Candidate", range: "7–9" },
  { label: "Watch / Hold", range: "5–7" },
  { label: "Avoid / Risk Elevated", range: "3–5" },
  { label: "Strong Avoid", range: "1–3" },
];

export interface SignalBucketResult {
  bucket: StockRecommendationLabel;
  scoreRange: string;
  totalEvents: number;
  windows: WindowEdge[];
}

export interface SignalBacktestSummary {
  generatedAt: string;
  totalScoreRows: number; // stock_scores rows read
  sampledEvents: number; // distinct (ticker, day) scores after de-duplication
  analyzed: number; // events that resolved to a forward study
  tickers: number; // distinct tickers analyzed
  spyAvailable: boolean;
  primaryWindow: EventWindowKey; // the window the calibration verdict uses
  calibration: "improves" | "mixed" | "inverts" | "n/a"; // do higher bands → higher returns?
  buckets: SignalBucketResult[];
  notes: string[];
}

/**
 * Pool score "events" into per-band forward-return summaries. Pure (no IO): each
 * event carries its recommendation band and a resolved event study. Always
 * returns all five bands (empty bands report n = 0) so the table is complete.
 */
export function bucketAndAggregate(
  events: { bucket: StockRecommendationLabel; study: EventStudyResult }[],
): SignalBucketResult[] {
  return SCORE_BANDS.map(({ label, range }) => {
    const studies = events.filter((e) => e.bucket === label).map((e) => e.study);
    const summary = aggregateEventStudies(studies);
    return { bucket: label, scoreRange: range, totalEvents: summary.totalEvents, windows: summary.windows };
  });
}

/** Mean forward abnormal return for a band's window, or null if no samples. */
function bandMean(b: SignalBucketResult, window: EventWindowKey): number | null {
  return b.windows.find((w) => w.key === window)?.meanAbnormalReturnPct ?? null;
}

/**
 * Verdict: do mean forward abnormal returns rise as the band improves? Compares
 * the ordered (best → worst) band means for `window`, ignoring empty bands.
 * "improves" = strictly higher for better bands, "inverts" = strictly lower,
 * "mixed" = neither, "n/a" = fewer than two populated bands.
 */
export function calibrationVerdict(
  buckets: SignalBucketResult[],
  window: EventWindowKey,
): SignalBacktestSummary["calibration"] {
  const means = buckets
    .map((b) => bandMean(b, window))
    .filter((v): v is number => v != null && isFinite(v));
  if (means.length < 2) return "n/a";
  let up = true;
  let down = true;
  for (let i = 1; i < means.length; i++) {
    // means[] is best→worst; "improves" means earlier (better) > later (worse).
    if (!(means[i - 1] > means[i])) up = false;
    if (!(means[i - 1] < means[i])) down = false;
  }
  if (up) return "improves";
  if (down) return "inverts";
  return "mixed";
}

const CACHE_KEY = "signal_perf_summary";

export function readCachedBacktest(): SignalBacktestSummary | null {
  const row = getDb()
    .select()
    .from(schema.appSettings)
    .where(eq(schema.appSettings.key, CACHE_KEY))
    .get();
  if (!row) return null;
  try {
    return JSON.parse(row.value) as SignalBacktestSummary;
  } catch {
    return null;
  }
}

function writeCachedBacktest(summary: SignalBacktestSummary): void {
  const db = getDb();
  const value = JSON.stringify(summary);
  db.insert(schema.appSettings)
    .values({ key: CACHE_KEY, value, updatedAt: summary.generatedAt })
    .onConflictDoUpdate({ target: schema.appSettings.key, set: { value, updatedAt: summary.generatedAt } })
    .run();
}

const PRIMARY_WINDOW: EventWindowKey = "post5";

/**
 * Load SPY bars that reach back to `earliest` AND forward to ~today. The benchmark
 * isn't a tracked ticker, so its bars otherwise lag — and `ensureBarsCover` only
 * backfills *older* history, never the recent bars the forward windows need.
 * getHistoricalBars returns the most-recent `limit` daily bars (ending ~today),
 * so a large-enough limit covers both ends.
 */
async function ensureFreshSpy(earliest: string, alpaca: AlpacaService | null): Promise<Bar[]> {
  let bars = getBars("SPY");
  const last = bars.length > 0 ? bars[bars.length - 1].date.slice(0, 10) : null;
  const reachesBack = bars.length > 0 && bars[0].date.slice(0, 10) <= earliest;
  // Forward-stale if the newest bar is >4 days old (covers a long weekend).
  const forwardStale = last == null || Date.now() - Date.parse(last) > 4 * 86400000;
  if (alpaca && (bars.length === 0 || forwardStale || !reachesBack)) {
    const daysBack = Math.max(0, (Date.now() - Date.parse(earliest)) / 86400000) + 45;
    const limit = Math.min(10000, Math.max(400, Math.ceil(daysBack / 1.5) + 30));
    const fetched = await alpaca.getHistoricalBars("SPY", "1Day", limit).catch(() => [] as Bar[]);
    if (fetched.length > 0) {
      saveBars("SPY", fetched);
      bars = getBars("SPY");
    }
  }
  return bars;
}

/**
 * Run the backtest over the app's stored stock scores and cache the summary.
 * De-duplicates to one score per (ticker, calendar day) to avoid over-sampling
 * the same day's intraday recomputes (and the overlapping-window noise that
 * causes). Each window reports its own sample size, so the short windows
 * naturally have more samples than +20d.
 */
export async function runSignalBacktest(
  opts: { sinceDays?: number } = {},
): Promise<SignalBacktestSummary> {
  const db = getDb();
  const rows = db
    .select({
      ticker: schema.stockScores.ticker,
      overallScore: schema.stockScores.overallScore,
      calculatedAt: schema.stockScores.calculatedAt,
    })
    .from(schema.stockScores)
    .all();

  // De-duplicate to the latest score per (ticker, day).
  const cutoffMs = opts.sinceDays ? Date.now() - opts.sinceDays * 86400000 : 0;
  const byKey = new Map<string, { ticker: string; score: number; day: string; at: string }>();
  for (const r of rows) {
    if (!r.calculatedAt) continue;
    if (cutoffMs && Date.parse(r.calculatedAt) < cutoffMs) continue;
    const day = r.calculatedAt.slice(0, 10);
    const key = `${r.ticker}|${day}`;
    const prev = byKey.get(key);
    if (!prev || r.calculatedAt > prev.at) {
      byKey.set(key, { ticker: r.ticker, score: r.overallScore, day, at: r.calculatedAt });
    }
  }
  const events = [...byKey.values()];

  const summary: SignalBacktestSummary = {
    generatedAt: new Date().toISOString(),
    totalScoreRows: rows.length,
    sampledEvents: events.length,
    analyzed: 0,
    tickers: 0,
    spyAvailable: false,
    primaryWindow: PRIMARY_WINDOW,
    calibration: "n/a",
    buckets: bucketAndAggregate([]),
    notes: [],
  };

  if (events.length === 0) {
    summary.notes.push("No stored stock scores yet — refresh some tracked tickers, then re-run.");
    writeCachedBacktest(summary);
    return summary;
  }

  const alpaca = AlpacaService.fromEnv();

  // SPY benchmark once, covering the earliest event across all tickers and kept
  // current to today so the forward windows have market data to subtract.
  const earliest = events.reduce((min, e) => (e.day < min ? e.day : min), events[0].day);
  const latest = events.reduce((max, e) => (e.day > max ? e.day : max), events[0].day);
  const spyBars = await ensureFreshSpy(earliest, alpaca);
  summary.spyAvailable = spyBars.length > 0;
  summary.notes.push(`Score history spans ${earliest} → ${latest}.`);
  if (!summary.spyAvailable) {
    summary.notes.push("SPY benchmark bars unavailable — abnormal returns can't be computed without it.");
  }

  // Group by ticker so we load/backfill each ticker's bars only once.
  const byTicker = new Map<string, typeof events>();
  for (const e of events) {
    const list = byTicker.get(e.ticker) ?? [];
    list.push(e);
    byTicker.set(e.ticker, list);
  }

  const bucketed: { bucket: StockRecommendationLabel; study: EventStudyResult }[] = [];
  for (const [ticker, list] of byTicker) {
    const earliestForTicker = list.reduce((min, e) => (e.day < min ? e.day : min), list[0].day);
    const bars = await ensureBarsCover(ticker, earliestForTicker, alpaca).catch(() => []);
    if (bars.length === 0) continue;
    for (const e of list) {
      const study = eventStudy(bars, spyBars, e.day);
      if (study) bucketed.push({ bucket: stockRecommendationLabel(e.score), study });
    }
  }

  summary.analyzed = bucketed.length;
  summary.tickers = byTicker.size;
  summary.buckets = bucketAndAggregate(bucketed);
  summary.calibration = calibrationVerdict(summary.buckets, PRIMARY_WINDOW);

  const primaryN = summary.buckets.reduce(
    (s, b) => s + (b.windows.find((w) => w.key === PRIMARY_WINDOW)?.n ?? 0),
    0,
  );
  const lastBarDay = spyBars.length > 0 ? spyBars[spyBars.length - 1].date.slice(0, 10) : null;
  const barsLagScores = lastBarDay != null && lastBarDay < latest;
  if (summary.analyzed === 0) {
    summary.notes.push(
      lastBarDay != null && lastBarDay < earliest
        ? `No daily bars on/after your earliest score (${earliest}); latest bar is ${lastBarDay}. Refresh daily bars, then re-run.`
        : "No scores resolved to a forward window yet.",
    );
  } else if (primaryN === 0) {
    summary.notes.push(
      barsLagScores
        ? `Latest daily bar (${lastBarDay}) predates your newest scores (${latest}) — +5d/+20d windows can't be measured until daily bars advance past the score dates (run the daily price refresh / npm run jobs).`
        : "Scores are too recent for a matured +5d window — figures populate as the score history ages.",
    );
  } else if (primaryN < 20) {
    summary.notes.push("Small sample — treat the per-band figures as indicative only.");
  }

  writeCachedBacktest(summary);
  return summary;
}
