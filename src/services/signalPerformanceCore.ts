import { aggregateEventStudies, type EventStudyResult, type EventWindowKey, type WindowEdge } from "./eventStudy";
import type { PerformanceSetupEvent, SetupPerformance } from "./setupPerformance";
import type { StockRecommendationLabel } from "@/lib/types";

// Pure Signal-Performance types + pooling math. NO IO here — the same reason
// eventStudy.ts is split from entityMentions.ts: it keeps this unit-testable, and
// it lets the browser import it. The Signal Performance page filters by date in
// the client (performanceFilter.ts), so anything it touches must stay free of the
// DB/Alpaca/Playwright chain that signalPerformance.ts pulls in.

/** Recommendation bands, best → worst, with their score ranges (see scoring.ts). */
export const SCORE_BANDS: { label: StockRecommendationLabel; range: string }[] = [
  { label: "Strong Buy Candidate", range: "9–10" },
  { label: "Buy Candidate", range: "7–9" },
  { label: "Watch / Hold", range: "5–7" },
  { label: "Avoid / Risk Elevated", range: "3–5" },
  { label: "Strong Avoid", range: "1–3" },
];

export const PICK_SOURCES = ["Agent Picks", "Sector Scout"] as const;

export interface SignalBucketResult {
  bucket: StockRecommendationLabel;
  scoreRange: string;
  totalEvents: number;
  windows: WindowEdge[];
}

export interface PickSourceResult {
  source: string;
  totalEvents: number;
  windows: WindowEdge[];
}

export interface IndustryPerformanceResult {
  industry: string;
  totalEvents: number;
  windows: WindowEdge[];
}

export interface ScoreCalibration {
  totalScoreRows: number;
  sampledEvents: number;
  analyzed: number;
  tickers: number;
  spyAvailable: boolean;
  primaryWindow: EventWindowKey;
  calibration: "improves" | "mixed" | "inverts" | "n/a";
  buckets: SignalBucketResult[];
  notes: string[];
}

export interface PickPerformance {
  sampledEvents: number;
  analyzed: number;
  spyAvailable: boolean;
  sources: PickSourceResult[];
  byIndustry: IndustryPerformanceResult[];
  notes: string[];
}

/**
 * Per-event abnormal returns, kept for the three windows the UI renders (pre5 is
 * never displayed). Rounded to 4dp: the page shows one decimal, so this is lossless
 * on screen while roughly halving the stored payload.
 */
export interface PerformanceAbn {
  post1: number | null;
  post5: number | null;
  post20: number | null;
}

export interface PerformanceScoreEvent {
  ticker: string;
  day: string; // YYYY-MM-DD
  band: StockRecommendationLabel;
  abn: PerformanceAbn;
}

export interface PerformancePickEvent {
  ticker: string;
  day: string;
  source: string;
  industries?: string[];
  abn: PerformanceAbn;
}

/**
 * The per-event rows behind the pooled aggregates. Retained so the Signal
 * Performance page can re-pool any date range through the SAME aggregators the
 * backtest used (see performanceFilter.ts) instead of re-running it — a re-run
 * backfills bars over the network and takes minutes.
 */
export interface PerformanceEvents {
  scores: PerformanceScoreEvent[];
  picks: PerformancePickEvent[];
  setups: PerformanceSetupEvent[];
  /** Raw stock_scores row counts per day, so the "raw rows" stat survives filtering. */
  scoreRowsByDay: Record<string, number>;
  /**
   * Deduped score events *submitted* per day. Only events that resolved to a
   * forward window survive into `scores`, so without this a filtered view would
   * report every scored day as analyzed and hide the events that never resolved.
   * Optional: a report cached before this field existed falls back to the
   * analyzed count rather than crashing.
   */
  scoreSampledByDay?: Record<string, number>;
}

export interface PerformanceReport {
  generatedAt: string;
  score: ScoreCalibration;
  picks: PickPerformance;
  setups?: SetupPerformance; // optional so an older cached report still parses
  events?: PerformanceEvents; // optional for the same reason — no slider without it
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

/**
 * Pool pick "events" by source (e.g. Agent Picks vs Sector Scout). Pure. Returns
 * one row per requested source, in order, empty sources reporting n = 0.
 */
export function poolBySource(
  events: { source: string; study: EventStudyResult }[],
  sources: readonly string[],
): PickSourceResult[] {
  return sources.map((source) => {
    const studies = events.filter((e) => e.source === source).map((e) => e.study);
    const summary = aggregateEventStudies(studies);
    return { source, totalEvents: summary.totalEvents, windows: summary.windows };
  });
}

/**
 * Per-industry forward-return rows for picks that carry industry tags. Pure: each
 * studied event fans out to every industry in its `groups`, so a pick that
 * surfaced under multiple industries on the same day counts once per industry.
 * Rows are ordered most-sampled first, then alphabetically. Studies without
 * industries (e.g. Agent Picks) are ignored.
 */
export function poolByIndustry(
  studies: { groups?: string[]; study: EventStudyResult }[],
): IndustryPerformanceResult[] {
  const fanned: { source: string; study: EventStudyResult }[] = [];
  for (const s of studies) {
    for (const industry of s.groups ?? []) fanned.push({ source: industry, study: s.study });
  }
  const industries = [...new Set(fanned.map((f) => f.source))];
  return poolBySource(fanned, industries)
    .map((r) => ({ industry: r.source, totalEvents: r.totalEvents, windows: r.windows }))
    .sort((a, b) => b.totalEvents - a.totalEvents || a.industry.localeCompare(b.industry));
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
): ScoreCalibration["calibration"] {
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
