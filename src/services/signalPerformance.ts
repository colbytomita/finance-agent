import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import type { Bar } from "@/lib/types";
import { nowIso } from "@/lib/util";
import { AlpacaService } from "./alpaca";
import { ensureBarsCover } from "./entityMentions";
import { getBars, saveBars } from "./bars";
import {
  eventStudy,
  aggregateEventStudies,
  type EventStudyResult,
  type EventWindowKey,
  type WindowEdge,
} from "./eventStudy";
import { stockRecommendationLabel } from "./scoring";
import { runSetupPerformance, type SetupPerformance } from "./setupPerformance";
import type { StockRecommendationLabel } from "@/lib/types";

// Signal-performance ("does any of this actually work?") backtest.
//
// The app appends a stock_scores row on every recompute and records every
// discovery/sector pick, so we already have a time-series of its own calls. We
// treat each as an "event" and reuse the Catalyst-Edge event-study engine
// (forward abnormal return vs SPY over [0,+1]/[0,+5]/[0,+20]) to measure what
// those tickers actually did next — pooled by recommendation band (score
// calibration) and by source (pick performance). Closed-trade realized stats
// live in tradePerformance.ts.
//
// Historical correlation across the app's own past calls — not a prediction and
// not advice. Pure aggregation (bucketAndAggregate / poolBySource /
// calibrationVerdict) is unit-tested; the run* functions add the DB/network IO.

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

export interface PerformanceReport {
  generatedAt: string;
  score: ScoreCalibration;
  picks: PickPerformance;
  setups?: SetupPerformance; // optional so an older cached report still parses
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

const CACHE_KEY = "performance_report_v2";

export function readCachedReport(): PerformanceReport | null {
  const row = getDb()
    .select()
    .from(schema.appSettings)
    .where(eq(schema.appSettings.key, CACHE_KEY))
    .get();
  if (!row) return null;
  try {
    return JSON.parse(row.value) as PerformanceReport;
  } catch {
    return null;
  }
}

function writeCachedReport(report: PerformanceReport): void {
  const db = getDb();
  const value = JSON.stringify(report);
  db.insert(schema.appSettings)
    .values({ key: CACHE_KEY, value, updatedAt: report.generatedAt })
    .onConflictDoUpdate({ target: schema.appSettings.key, set: { value, updatedAt: report.generatedAt } })
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

interface SignalEvent {
  ticker: string;
  day: string; // YYYY-MM-DD
  key: string; // band label or pick source — the primary pooling key
  groups?: string[]; // optional secondary pooling keys (e.g. a pick's industries)
}

interface StudiedEvents {
  studies: { key: string; groups?: string[]; study: EventStudyResult }[];
  sampledEvents: number;
  analyzed: number;
  tickers: number;
  spyAvailable: boolean;
  earliest: string | null;
  latest: string | null;
  lastBarDay: string | null;
}

/**
 * Shared event-study core: run each (ticker, day) event through the forward
 * abnormal-return engine vs a freshly-benchmarked SPY, loading/backfilling each
 * ticker's bars only once. Returns the resolved studies tagged with their
 * pooling key plus coverage metadata for diagnostics.
 */
async function studyEvents(
  events: SignalEvent[],
  alpaca: AlpacaService | null,
): Promise<StudiedEvents> {
  if (events.length === 0) {
    return {
      studies: [],
      sampledEvents: 0,
      analyzed: 0,
      tickers: 0,
      spyAvailable: false,
      earliest: null,
      latest: null,
      lastBarDay: null,
    };
  }

  const earliest = events.reduce((min, e) => (e.day < min ? e.day : min), events[0].day);
  const latest = events.reduce((max, e) => (e.day > max ? e.day : max), events[0].day);
  const spyBars = await ensureFreshSpy(earliest, alpaca);
  const lastBarDay = spyBars.length > 0 ? spyBars[spyBars.length - 1].date.slice(0, 10) : null;

  const byTicker = new Map<string, SignalEvent[]>();
  for (const e of events) {
    const list = byTicker.get(e.ticker) ?? [];
    list.push(e);
    byTicker.set(e.ticker, list);
  }

  const studies: { key: string; groups?: string[]; study: EventStudyResult }[] = [];
  for (const [ticker, list] of byTicker) {
    const earliestForTicker = list.reduce((min, e) => (e.day < min ? e.day : min), list[0].day);
    const bars = await ensureBarsCover(ticker, earliestForTicker, alpaca).catch(() => []);
    if (bars.length === 0) continue;
    for (const e of list) {
      const study = eventStudy(bars, spyBars, e.day);
      if (study) studies.push({ key: e.key, groups: e.groups, study });
    }
  }

  return {
    studies,
    sampledEvents: events.length,
    analyzed: studies.length,
    tickers: byTicker.size,
    spyAvailable: spyBars.length > 0,
    earliest,
    latest,
    lastBarDay,
  };
}

/** Maturity/coverage note shared by the score and pick backtests. */
function coverageNote(s: StudiedEvents, primaryN: number, label: string): string | null {
  if (s.analyzed === 0) {
    return s.lastBarDay != null && s.earliest != null && s.lastBarDay < s.earliest
      ? `No daily bars on/after the earliest ${label} (${s.earliest}); latest bar is ${s.lastBarDay}. Refresh daily bars, then re-run.`
      : `No ${label}s resolved to a forward window yet.`;
  }
  if (primaryN === 0) {
    return s.lastBarDay != null && s.latest != null && s.lastBarDay < s.latest
      ? `Latest daily bar (${s.lastBarDay}) predates the newest ${label} (${s.latest}) — +5d/+20d windows can't be measured until daily bars advance (run the daily price refresh / npm run jobs).`
      : `${label}s are too recent for a matured +5d window — figures populate as history ages.`;
  }
  if (primaryN < 20) return "Small sample — treat these figures as indicative only.";
  return null;
}

/** Build deduped score events (one per ticker per day, latest score that day). */
function buildScoreEvents(): { events: SignalEvent[]; totalRows: number } {
  const rows = getDb()
    .select({
      ticker: schema.stockScores.ticker,
      overallScore: schema.stockScores.overallScore,
      calculatedAt: schema.stockScores.calculatedAt,
    })
    .from(schema.stockScores)
    .all();
  const byKey = new Map<string, { e: SignalEvent; at: string }>();
  for (const r of rows) {
    if (!r.calculatedAt) continue;
    const day = r.calculatedAt.slice(0, 10);
    const k = `${r.ticker}|${day}`;
    const prev = byKey.get(k);
    if (!prev || r.calculatedAt > prev.at) {
      byKey.set(k, { e: { ticker: r.ticker, day, key: stockRecommendationLabel(r.overallScore) }, at: r.calculatedAt });
    }
  }
  return { events: [...byKey.values()].map((v) => v.e), totalRows: rows.length };
}

async function runScoreCalibration(alpaca: AlpacaService | null): Promise<ScoreCalibration> {
  const { events, totalRows } = buildScoreEvents();
  const studied = await studyEvents(events, alpaca);
  const buckets = bucketAndAggregate(
    studied.studies.map((s) => ({ bucket: s.key as StockRecommendationLabel, study: s.study })),
  );
  const calibration = calibrationVerdict(buckets, PRIMARY_WINDOW);
  const primaryN = buckets.reduce(
    (n, b) => n + (b.windows.find((w) => w.key === PRIMARY_WINDOW)?.n ?? 0),
    0,
  );
  const notes: string[] = [];
  if (events.length === 0) notes.push("No stored stock scores yet — refresh some tracked tickers, then re-run.");
  if (studied.earliest && studied.latest) notes.push(`Score history spans ${studied.earliest} → ${studied.latest}.`);
  if (events.length > 0 && !studied.spyAvailable) notes.push("SPY benchmark unavailable — abnormal returns can't be computed.");
  const cn = events.length > 0 ? coverageNote(studied, primaryN, "score") : null;
  if (cn) notes.push(cn);

  return {
    totalScoreRows: totalRows,
    sampledEvents: studied.sampledEvents,
    analyzed: studied.analyzed,
    tickers: studied.tickers,
    spyAvailable: studied.spyAvailable,
    primaryWindow: PRIMARY_WINDOW,
    calibration,
    buckets,
    notes,
  };
}

/** Build deduped pick events from Agent Picks + Sector Scout (one per source/ticker/day). */
function buildPickEvents(): SignalEvent[] {
  const db = getDb();
  const out: SignalEvent[] = [];
  const seen = new Set<string>();
  const add = (ticker: string | null, at: string | null, source: string, groups?: string[]) => {
    if (!ticker || !at) return;
    const day = at.slice(0, 10);
    const k = `${source}|${ticker}|${day}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ ticker, day, key: source, groups });
  };
  for (const r of db
    .select({ ticker: schema.agentCandidates.ticker, at: schema.agentCandidates.proposedAt })
    .from(schema.agentCandidates)
    .all())
    add(r.ticker, r.at, "Agent Picks");
  // Sector Scout: one event per ticker/day for the source pool, tagged with every
  // industry that surfaced it that day so the per-industry breakdown can fan out
  // (the same ticker can be a pick under more than one industry).
  const sectorByKey = new Map<string, { ticker: string; at: string; industries: Set<string> }>();
  for (const r of db
    .select({
      ticker: schema.sectorScoutPicks.ticker,
      at: schema.sectorScoutPicks.scannedAt,
      industry: schema.sectorScoutPicks.industry,
    })
    .from(schema.sectorScoutPicks)
    .all()) {
    if (!r.ticker || !r.at) continue;
    const day = r.at.slice(0, 10);
    const k = `${r.ticker}|${day}`;
    let entry = sectorByKey.get(k);
    if (!entry) {
      entry = { ticker: r.ticker, at: r.at, industries: new Set() };
      sectorByKey.set(k, entry);
    }
    if (r.industry) entry.industries.add(r.industry);
  }
  for (const entry of sectorByKey.values())
    add(entry.ticker, entry.at, "Sector Scout", [...entry.industries]);
  return out;
}

async function runPickPerformance(alpaca: AlpacaService | null): Promise<PickPerformance> {
  const events = buildPickEvents();
  const studied = await studyEvents(events, alpaca);
  const sources = poolBySource(
    studied.studies.map((s) => ({ source: s.key, study: s.study })),
    PICK_SOURCES,
  );
  const byIndustry = poolByIndustry(studied.studies);
  const primaryN = sources.reduce(
    (n, s) => n + (s.windows.find((w) => w.key === PRIMARY_WINDOW)?.n ?? 0),
    0,
  );
  const notes: string[] = [];
  if (events.length === 0) notes.push("No Agent Picks or Sector Scout picks recorded yet.");
  const cn = events.length > 0 ? coverageNote(studied, primaryN, "pick") : null;
  if (cn) notes.push(cn);

  return {
    sampledEvents: studied.sampledEvents,
    analyzed: studied.analyzed,
    spyAvailable: studied.spyAvailable,
    sources,
    byIndustry,
    notes,
  };
}

/** Run all backtests (score calibration + pick + setup performance) and cache the report. */
export async function runPerformanceBacktest(): Promise<PerformanceReport> {
  const alpaca = AlpacaService.fromEnv();
  const score = await runScoreCalibration(alpaca);
  const picks = await runPickPerformance(alpaca);
  const setups = await runSetupPerformance(alpaca);
  const report: PerformanceReport = {
    generatedAt: nowIso(),
    score,
    picks,
    setups,
  };
  writeCachedReport(report);
  return report;
}
